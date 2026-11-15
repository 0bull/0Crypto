import type { AssetInfo, ChainAdapter, DepositTarget, Observation } from "../../core/types";
import { recordAlert } from "../../db/alerts";
import type { Env } from "../../env";
import { nwcClientPubkey, parseNwcUri, type NwcConn } from "../../signing/nostr";
import { bolt11Summary, nwcEncryption, nwcRequest, NwcError, type NwcOptions, type SocketFactory } from "./nwc";

/*
 * Lightning (ln:btc, 11 decimals = msat) through the merchant's hosted wallet over NWC. Funds stay in that wallet: the
 * gateway never routes, sweeps or refunds them, and never pays anything (receive-only, see nwc.ts).
 *
 * A payment is one fixed-amount BOLT11 invoice: `payments.address` holds the bolt11, `payments.reference` its payment
 * hash, `rate_locked_until` its expiry (capped at the rate lock and the invoice's own expiry). Under- and overpayment
 * cannot happen: a BOLT11 with an amount is paid exactly or not at all. An expired bolt11 cannot be paid (the wallet
 * refuses it), but if the wallet ever reports it settled it is credited.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const CAPS_OK_TTL_SEC = 86_400;
/** Every relay round of one createInvoice (capability check, info lookup, make_invoice) ends by this. */
const CREATE_DEADLINE_MS = 25_000;
/** A refused connection is asked again after this long, so a fixed NWC_URI recovers without a redeploy. */
const CAPS_REFUSED_TTL_SEC = 600;
/** One verdict per connection: the wallet AND the client key, so a replacement NWC_URI for the same wallet is checked afresh. */
const capsKey = async (c: NwcConn) => `nwc:caps:${c.walletPubkey}:${await nwcClientPubkey(c)}`;

export interface LightningInvoice {
  bolt11: string;
  paymentHash: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface LightningAdapter extends ChainAdapter {
  createInvoice(amountMsat: bigint, description: string, expirySec?: number): Promise<LightningInvoice>;
}

interface Caps {
  /** make_invoice and lookup_invoice are allowed. */
  ok: boolean;
  /** The connection also allows a spending method: it should be replaced by a receive-only one. */
  spend: boolean;
  /** The wallet's node id (get_info pubkey, compressed secp256k1 hex), when it reports one: every invoice names it. */
  node?: string;
}

/** Whole sats, rounded up: every NWC wallet accepts them (some refuse msat precision). */
export const roundUpToSat = (msat: bigint): bigint => ((msat + 999n) / 1000n) * 1000n;

/**
 * Test-only hook for code paths that build the adapter themselves (getAdapter: the watcher, payment creation): a fake
 * relay assigned to `env.NWC_TEST_SOCKET_FACTORY`. Honoured only when it is a function; a deployed Worker's vars and
 * secrets are strings, so production always uses the real WebSocket.
 */
export function testSocketFactory(env: Pick<Env, "NWC_TEST_SOCKET_FACTORY">): SocketFactory | undefined {
  const f = env.NWC_TEST_SOCKET_FACTORY;
  return typeof f === "function" ? (f as SocketFactory) : undefined;
}

const conns = new Map<string, NwcConn>();
function connOf(env: Pick<Env, "NWC_URI">): NwcConn {
  const uri = env.NWC_URI ?? "";
  let c = conns.get(uri);
  if (!c) {
    c = parseNwcUri(uri);
    conns.set(uri, c);
  }
  return c;
}

async function readCaps(env: Env, c: NwcConn): Promise<Caps | null> {
  const v = await env.KV.get<Caps>(await capsKey(c), "json").catch(() => null);
  return v && typeof v.ok === "boolean" && typeof v.spend === "boolean" ? v : null;
}

/**
 * What the NWC connection allows, from get_info (cached in KV: 24 h, or 10 min when refused). A connection without
 * make_invoice and lookup_invoice is refused with a deduplicated `lightning.config_error` alert; one that also lists a
 * spending method works but raises `lightning.spend_permission` (create a receive-only connection instead).
 */
export async function lightningCapabilities(env: Env, opts: NwcOptions = {}): Promise<Caps> {
  const c = connOf(env);
  const cached = await readCaps(env, c);
  if (cached) return cached;
  const encryption = await nwcEncryption(env.KV, c, opts);
  const info = await nwcRequest(c, "get_info", {}, { ...opts, encryption });
  const methods = info.methods;
  if (!Array.isArray(methods) || !methods.every((m) => typeof m === "string")) throw new NwcError("INVALID_RESPONSE", "get_info has no method list");
  const node = typeof info.pubkey === "string" && /^0[23][0-9a-f]{64}$/i.test(info.pubkey) ? info.pubkey.toLowerCase() : undefined;
  const caps: Caps = { ok: methods.includes("make_invoice") && methods.includes("lookup_invoice"), spend: methods.some((m) => /^(pay_|multi_)/.test(m)), ...(node ? { node } : {}) };
  await env.KV.put(await capsKey(c), JSON.stringify(caps), { expirationTtl: caps.ok ? CAPS_OK_TTL_SEC : CAPS_REFUSED_TTL_SEC }).catch(() => {});
  if (!caps.ok)
    await recordAlert(env.DB, "lightning.config_error", "ln", "The NWC connection (NWC_URI) does not allow make_invoice and lookup_invoice: Lightning is off. Create a receive-only connection with both permissions.");
  if (caps.spend)
    await recordAlert(env.DB, "lightning.spend_permission", "ln", "The NWC connection (NWC_URI) also allows payments. The gateway never uses them, but a leaked NWC_URI could spend: replace it with a receive-only connection (get_info, make_invoice, lookup_invoice).");
  return caps;
}

/** The cached verdict only (no relay call): true when get_info last showed the connection cannot receive. */
export async function lightningRefused(env: Env): Promise<boolean> {
  try {
    return (await readCaps(env, connOf(env)))?.ok === false;
  } catch {
    return false;
  }
}

/**
 * The node id the wallet reported at the last check (cached only, no relay call), or null when unknown. A customer can
 * read it from any invoice they are shown and look it up on a Lightning explorer.
 */
export async function lightningNode(env: Env): Promise<string | null> {
  try {
    return (await readCaps(env, connOf(env)))?.node ?? null;
  } catch {
    return null;
  }
}

/** The cron check's overall deadline, across the info lookup, get_info and every relay. */
export const LIGHTNING_CHECK_DEADLINE_MS = 20_000;

/** Cron: refreshes the capability check (and its alerts) when the cache has lapsed, within one deadline. Never throws. */
export async function checkLightning(env: Env, deadlineMs = LIGHTNING_CHECK_DEADLINE_MS): Promise<void> {
  await lightningCapabilities(env, { socketFactory: testSocketFactory(env), deadlineAt: Date.now() + deadlineMs }).catch((e) =>
    console.warn(`0crypto: lightning check failed: ${e instanceof Error ? e.name : "Error"}`),
  );
}

const invalid = (why: string) => new NwcError("INVALID_RESPONSE", why);

export function lightningAdapter(env: Env, o: { socketFactory?: SocketFactory } = {}): LightningAdapter {
  const net: NwcOptions = { socketFactory: o.socketFactory ?? testSocketFactory(env) };
  return {
    chain: "ln",

    async deriveAddress(): Promise<string> {
      throw new Error("Lightning has no deposit addresses: each payment is a make_invoice call");
    },

    async createInvoice(amountMsat, description, expirySec = 1200) {
      if (amountMsat <= 0n || amountMsat % 1000n !== 0n || amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Lightning amount must be a positive whole number of sats");
      const c = connOf(env);
      const within: NwcOptions = { ...net, deadlineAt: Date.now() + CREATE_DEADLINE_MS };
      const caps = await lightningCapabilities(env, within);
      if (!caps.ok) throw new NwcError("UNSUPPORTED", "the NWC connection cannot make and look up invoices");
      const encryption = await nwcEncryption(env.KV, c, within);
      const r = await nwcRequest(c, "make_invoice", { amount: Number(amountMsat), description, expiry: expirySec }, { ...within, encryption });
      if (typeof r.invoice !== "string" || typeof r.payment_hash !== "string") throw invalid("make_invoice: no invoice or payment hash");
      const bolt11 = r.invoice.trim().toLowerCase();
      const paymentHash = r.payment_hash.toLowerCase();
      let sum;
      try {
        sum = bolt11Summary(bolt11);
      } catch {
        throw invalid("make_invoice: not a mainnet BOLT11 invoice");
      }
      // The bolt11 is what the customer's wallet pays: its own amount and hash must be the ones asked for and recorded.
      if (sum.amountMsat !== amountMsat) throw invalid("make_invoice: the bolt11 amount is not the requested amount");
      if (sum.paymentHash !== paymentHash || !HEX64.test(paymentHash)) throw invalid("make_invoice: the payment hash does not match the bolt11");
      if (r.amount !== undefined && r.amount !== Number(amountMsat)) throw invalid("make_invoice: the amount is not the requested amount");
      if (r.expires_at !== undefined && (typeof r.expires_at !== "number" || !Number.isFinite(r.expires_at))) throw invalid("make_invoice: malformed expires_at");
      let expiresAt = (sum.timestamp + sum.expirySec) * 1000;
      if (typeof r.expires_at === "number") expiresAt = Math.min(expiresAt, r.expires_at * 1000);
      if (expiresAt <= Date.now()) throw invalid("make_invoice: the invoice is already expired");
      return { bolt11, paymentHash, expiresAt };
    },

    async observe(t: DepositTarget, _asset: AssetInfo): Promise<Observation> {
      const hash = t.reference ?? "";
      if (!HEX64.test(hash)) throw new Error("Lightning payment has no payment hash");
      const amount = bolt11Summary(t.address).amountMsat;
      if (amount === null) throw new Error("Lightning payment has an amountless bolt11");
      const c = connOf(env);
      const encryption = await nwcEncryption(env.KV, c, net);
      const r = await nwcRequest(c, "lookup_invoice", { payment_hash: hash }, { ...net, encryption });
      if (typeof r.payment_hash !== "string" || r.payment_hash.toLowerCase() !== hash) throw invalid("lookup_invoice: payment hash echo mismatch");
      if (r.type !== undefined && r.type !== "incoming") throw invalid("lookup_invoice: not an incoming invoice");
      if (r.invoice !== undefined && (typeof r.invoice !== "string" || r.invoice.trim().toLowerCase() !== t.address.toLowerCase())) throw invalid("lookup_invoice: another invoice");
      if (typeof r.amount !== "number" || !Number.isSafeInteger(r.amount) || BigInt(r.amount) !== amount) throw invalid("lookup_invoice: amount is not the invoice amount");
      const settled = r.settled_at;
      // Absent, null or 0: not settled.
      if (settled === undefined || settled === null || settled === 0) return { received: 0n, final: 0n, txids: [] };
      if (typeof settled !== "number" || !Number.isFinite(settled) || settled <= 0) throw invalid("lookup_invoice: malformed settled_at");
      // Settle time in ms, clamped to [payment created, now] (a wallet clock can be off); state.ts judges the lock by it.
      const settledAt = Math.min(Math.max(Math.floor(settled * 1000), t.createdAt), Date.now());
      return { received: amount, final: amount, txids: [hash], settledAt };
    },

    paymentUri(t: DepositTarget): string {
      return `lightning:${t.address}`;
    },
  };
}
