import { base32 } from "@scure/base";
import { Hono } from "hono";
import { enabledAssets, usableAssets } from "../config";
import { atomicFromFiatMinor, fiatMinorFromAtomic, formatDecimal, parseDecimal } from "../core/money";
import { getAsset } from "../core/assets";
import { rateKeyIp } from "../core/ip";
import { reservedMetadataError } from "../core/metadata";
import type { AssetId } from "../core/types";
import {
  allocateIndex,
  getInvoice,
  insertInvoiceWithEvent,
  insertPayment,
  listPayments,
  type EventRow,
  type InvoiceRow,
  type PaymentRow,
} from "../db/repo";
import type { Env } from "../env";
import { lightningAdapter, roundUpToSat } from "../chains/lightning/adapter";
import { NwcError, NwcTimeout } from "../chains/lightning/nwc";
import { counterKey, getAdapter, startIndex } from "../chains/registry";
import { newSolReference } from "../chains/solana/adapter";
import { getPriceE8, PriceUnavailable } from "../prices/cache";
import type { Currency } from "../prices/kraken";
import { toTarget } from "../watcher/PaymentWatcher";
import { enqueueEvents } from "../webhooks/outbox";
import { requireApiKey } from "./auth";
import { parseSuccessHosts, validSuccessUrl } from "./success-url";
import { apiError, type ApiErrorCode } from "./errors";
import { serializeInvoice } from "./serialize";

const MIN = 60_000;
const MAX_PRICE_MINOR = 100_000_000n; // 1,000,000.00
const newId = (prefix: string) => prefix + base32.encode(crypto.getRandomValues(new Uint8Array(16))).toLowerCase().replaceAll("=", "");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

type Parsed = { ok: true; inv: InvoiceRow } | { ok: false; message: string };

/** Exported for the subscription cron, which reuses this validation with a longer maximum expiry. */
export function parseInvoiceBody(body: unknown, env: Env, now: number, maxTtlSec = 86400): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  if (!isPlainObject(body)) return bad("body must be a JSON object");

  if (typeof body.price_amount !== "string") return bad("price_amount must be a decimal string");
  let price: bigint;
  try {
    price = parseDecimal(body.price_amount, 2);
  } catch {
    return bad("price_amount must be a decimal with at most 2 fraction digits");
  }
  if (price <= 0n || price > MAX_PRICE_MINOR) return bad("price_amount must be > 0 and <= 1000000.00");

  if (body.price_currency !== "USD" && body.price_currency !== "EUR") return bad("price_currency must be USD or EUR");

  const { order_id, metadata, success_url, allowed_assets, expires_in_sec } = body;
  if (order_id !== undefined && (typeof order_id !== "string" || order_id.length > 128)) return bad("order_id must be a string of at most 128 chars");
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) return bad("metadata must be an object");
    if (new TextEncoder().encode(JSON.stringify(metadata)).length > 4096) return bad("metadata must be at most 4096 bytes");
  }
  if (success_url !== undefined) {
    let hosts: string[] = [];
    try {
      hosts = parseSuccessHosts(env.SUCCESS_URL_HOSTS ?? "");
    } catch {
      /* a stored list is validated on save; an unreadable one fails closed below */
      return bad("success_url must be an https URL on one of SUCCESS_URL_HOSTS");
    }
    if (typeof success_url !== "string" || !validSuccessUrl(success_url, hosts))
      return bad(hosts.length > 0 ? "success_url must be an https URL on one of SUCCESS_URL_HOSTS" : "success_url must be an https URL of at most 2048 chars");
  }
  if (allowed_assets !== undefined) {
    const enabled = new Set(enabledAssets(env).map((a) => a.id));
    if (!Array.isArray(allowed_assets) || allowed_assets.length === 0 || !allowed_assets.every((a) => typeof a === "string" && enabled.has(a)))
      return bad("allowed_assets must be a non-empty list of enabled assets");
  }
  let ttl = 3600;
  if (expires_in_sec !== undefined) {
    if (typeof expires_in_sec !== "number" || !Number.isInteger(expires_in_sec) || expires_in_sec < 300 || expires_in_sec > maxTtlSec)
      return bad(`expires_in_sec must be an integer between 300 and ${maxTtlSec}`);
    ttl = expires_in_sec;
  }

  return {
    ok: true,
    inv: {
      id: newId("inv_"),
      created_at: now,
      expires_at: now + ttl * 1000,
      price_minor: price,
      currency: body.price_currency,
      order_id: (order_id as string | undefined) ?? null,
      metadata: (metadata as Record<string, unknown> | undefined) ?? null,
      success_url: (success_url as string | undefined) ?? null,
      allowed_assets: (allowed_assets as AssetId[] | undefined) ?? null,
      status: "open",
      late: false,
      overpaid: false,
      paid_minor: 0n,
    },
  };
}

export interface PaymentBody {
  payment_id: string;
  address: string;
  amount: string;
  uri: string;
  rate_locked_until: string;
  asset: AssetId;
}
export type ApiError = { code: ApiErrorCode; message: string };
export type PaymentResult = { status: 200 | 201; body: PaymentBody } | { error: ApiError };

/**
 * Shared by the JSON API and the checkout form: rate limit, validate, reuse an in-flight or
 * still-locked payment, or price and create a new one. Throws PriceUnavailable when no rate exists, and
 * NwcError / NwcTimeout when the Lightning wallet cannot make an invoice (lightningUnavailable).
 */
export async function createOrReusePayment(env: Env, invoiceId: string, assetId: AssetId, clientIp: string): Promise<PaymentResult> {
  const fail = (code: ApiErrorCode, message: string): { error: ApiError } => ({ error: { code, message } });
  const { success } = await env.API_RATE.limit({ key: "pay:" + rateKeyIp(clientIp) }); // an IPv6 /64 is one client
  if (!success) return fail("rate_limited", "too many requests");

  const inv = await getInvoice(env.DB, invoiceId);
  if (!inv) return fail("not_found", "invoice not found");
  const now = Date.now();
  if (now > inv.expires_at || inv.status === "paid") return fail("invoice_closed", "invoice is no longer payable");

  // 1. Pure configuration: the asset must be enabled and allowed for this invoice.
  if (!enabledAssets(env).some((a) => a.id === assetId) || (inv.allowed_assets && !inv.allowed_assets.includes(assetId)))
    return fail("asset_not_allowed", "asset not accepted for this invoice");
  const asset = getAsset(assetId);
  const adapter = getAdapter(env, asset.chain);
  const watcher = env.WATCHER.get(env.WATCHER.idFromName(inv.id));

  const respond = (p: PaymentRow, status: 200 | 201): PaymentResult => ({
    status,
    body: {
      payment_id: p.id,
      address: p.address,
      amount: formatDecimal(p.expected, asset.decimals),
      uri: adapter.paymentUri(toTarget(p), asset, p.expected),
      rate_locked_until: new Date(p.rate_locked_until).toISOString(),
      asset: p.asset,
    },
  });
  // Idempotent; re-arms the watcher in case an earlier start() failed after the insert.
  const reuse = async (p: PaymentRow) => {
    await watcher.start(inv.id, p.id);
    return respond(p, 200);
  };

  const payments = await listPayments(env.DB, inv.id);

  // A same-asset payment with funds in flight is always returned so the customer sees its progress.
  const inFlight = payments.find((p) => p.asset === assetId && ["detected", "confirming", "partial"].includes(p.status));
  if (inFlight) return reuse(inFlight);

  // New payments need a usable chain (EVM: factory deployed). Funds already in flight were returned above regardless.
  if (!(await usableAssets(env)).some((a) => a.id === assetId)) return fail("asset_not_allowed", "asset not accepted for this invoice");

  // Unconfirmed funds on other payments (received but not yet final) count against what is still owed.
  let remaining = inv.price_minor - inv.paid_minor;
  if (remaining <= 0n) return fail("invoice_closed", "invoice is no longer payable");
  for (const p of payments) {
    if (p.status !== "detected" && p.status !== "confirming" && p.status !== "partial") continue;
    remaining -= fiatMinorFromAtomic(p.received - p.final, getAsset(p.asset).decimals, p.credit_price_e8 ?? p.price_e8);
  }
  if (remaining <= 0n) return fail("payment_in_progress", "a payment covering this invoice is awaiting confirmation");

  // Reuse a still-locked quote only if it asks for no more than is owed (one cent of rounding slack);
  // after a coin switch with funds in flight, a fresh, smaller quote avoids an overpayment.
  const existing = payments.find(
    (p) =>
      p.asset === assetId &&
      p.status === "awaiting" &&
      p.rate_locked_until > now &&
      fiatMinorFromAtomic(p.expected, asset.decimals, p.price_e8) <= remaining + 1n,
  );
  if (existing) return reuse(existing);

  const priceE8 = await getPriceE8(env, asset.priceSymbol, inv.currency as Currency);
  let expected = atomicFromFiatMinor(remaining, asset.decimals, priceE8);
  let address: string;
  let index: number;
  let reference: string | null;
  let lockedUntil = now + 20 * MIN;
  const paymentId = newId("pay_");
  if (asset.chain === "ln") {
    // Lightning: the merchant's wallet makes a fixed-amount BOLT11 (no derivation counter; index -1). The bolt11 is the
    // address, its payment hash the reference. It expires with the rate lock, never after the invoice; the lock ends
    // with the bolt11. Its description is the payment id only (never the invoice id or order data: it ends up in the
    // payer's wallet history); the admin maps it to its invoice. An expired one is never reused (rate_locked_until).
    expected = roundUpToSat(expected);
    const lockUntil = Math.min(lockedUntil, inv.expires_at);
    const ln = await lightningAdapter(env).createInvoice(expected, paymentId, Math.max(1, Math.floor((lockUntil - now) / 1000)));
    address = ln.bolt11;
    reference = ln.paymentHash;
    index = -1;
    lockedUntil = Math.min(lockUntil, ln.expiresAt);
  } else {
    index = await allocateIndex(env.DB, counterKey(asset.chain), startIndex(env, asset.chain));
    address = await adapter.deriveAddress(index);
    reference = asset.chain === "sol" ? newSolReference() : null; // Solana Pay reference (chain-scoped)
  }
  const payment: PaymentRow = {
    id: paymentId,
    invoice_id: inv.id,
    asset: assetId,
    chain: asset.chain,
    address,
    derivation_index: index,
    reference,
    expected,
    price_e8: priceE8,
    rate_locked_until: lockedUntil,
    received: 0n,
    final: 0n,
    txids: [],
    status: "awaiting",
    created_at: now,
    detected_at: null,
    confirmed_at: null,
    credited_minor: 0n,
    credit_price_e8: null,
    unexpected: null,
  };
  await insertPayment(env.DB, payment);
  await watcher.start(inv.id, payment.id); // only after the row is committed
  return respond(payment, 201);
}

/** The Lightning wallet could not make an invoice (relay down, timeout, refused connection or untrusted answer). */
export const lightningUnavailable = (e: unknown): boolean => e instanceof NwcError || e instanceof NwcTimeout;

export const api = new Hono<{ Bindings: Env }>();

api.onError((e, c) => {
  if (e instanceof PriceUnavailable) return apiError(c, "price_unavailable", "price temporarily unavailable, retry shortly");
  if (lightningUnavailable(e)) return apiError(c, "lightning_unavailable", "the Lightning wallet is unavailable, retry shortly");
  console.error("api error:", e instanceof Error ? e.name : "Error");
  return apiError(c, "internal_error", "internal error");
});

api.get("/assets", async (c) =>
  c.json((await usableAssets(c.env)).map((a) => ({ id: a.id, symbol: a.symbol, chain: a.chain, decimals: a.decimals }))),
);

/**
 * Shared by the JSON API and the admin form: validates a request body, inserts the invoice with its
 * created event, and enqueues the event best-effort (the cron outbox re-sends unmarked events).
 */
export async function createInvoice(env: Env, input: unknown): Promise<{ invoice: InvoiceRow } | { error: string }> {
  const now = Date.now();
  const parsed = parseInvoiceBody(input, env, now);
  if (!parsed.ok) return { error: parsed.message };
  const { inv } = parsed;
  const event: EventRow = {
    id: `invoice.created:${inv.id}:1`,
    created_at: now,
    type: "invoice.created",
    invoice_id: inv.id,
    payload: JSON.stringify({ invoice_id: inv.id, status: inv.status, paid_minor: "0" }),
  };
  await insertInvoiceWithEvent(env.DB, inv, event);
  await enqueueEvents(env, [event]).catch((e) => console.warn("enqueue invoice.created failed:", e instanceof Error ? e.name : "Error"));
  return { invoice: inv };
}

api.post("/invoices", requireApiKey, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_request", "body must be valid JSON");
  }
  // Merchant metadata may not use the gateway's own keys; the built-in sources (POS, links, subscriptions) skip this route.
  const reserved = isPlainObject(body) ? reservedMetadataError(body.metadata) : null;
  if (reserved) return apiError(c, "invalid_request", reserved);
  const r = await createInvoice(c.env, body);
  if ("error" in r) return apiError(c, "invalid_request", r.error);
  return c.json(serializeInvoice(r.invoice, [], c.env.PUBLIC_URL), 201);
});

api.get("/invoices/:id", requireApiKey, async (c) => {
  const inv = await getInvoice(c.env.DB, c.req.param("id"));
  if (!inv) return apiError(c, "not_found", "invoice not found");
  return c.json(serializeInvoice(inv, await listPayments(c.env.DB, inv.id), c.env.PUBLIC_URL));
});

api.post("/invoices/:id/payments", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_request", "body must be valid JSON");
  }
  if (!isPlainObject(body) || typeof body.asset !== "string") return apiError(c, "invalid_request", "asset must be a string");
  // The IP is only a rate-limit key; it is never stored or logged.
  const r = await createOrReusePayment(c.env, c.req.param("id"), body.asset, c.req.header("cf-connecting-ip") ?? "unknown");
  if ("error" in r) return apiError(c, r.error.code, r.error.message);
  return c.json(r.body, r.status);
});
