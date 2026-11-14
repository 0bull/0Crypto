import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { http, HttpResponse } from "msw";
import { base58, base64 } from "@scure/base";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, numberToHex, parseTransaction, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { confirmFields } from "./helpers";
import { clearChainIdMemo } from "../../src/chains/evm/config";
import { ASSOCIATED_TOKEN_PROGRAM, findAta, TOKEN_PROGRAM } from "../../src/chains/solana/pda";
import { USDC_MINT } from "../../src/chains/solana/sweeptx";
import { accountFromSeed, deriveUtxoAddress } from "../../src/chains/utxo/derive";
import { scriptAddress } from "../../src/chains/utxo/spend";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env, WebhookJob } from "../../src/env";
import { allowedDestination } from "../../src/routing/guard";
import { BAD_ASSERTION, NEEDS_JS, type ConfirmAction } from "../../src/admin/confirm";
import { getAsset } from "../../src/core/assets";
import { createRefund, reapproveRefund, REFUND_WARNING, TRON_REFUNDS_REFUSED, type RefundRow } from "../../src/routing/refund";
import { handleWebhookBatch } from "../../src/webhooks/consumer";
import { acquireRouterLock, releaseRouterLock, runRouter } from "../../src/routing/router";
import { routableInputs } from "../../src/routing/swap";
import { hotAccount } from "../../src/signing/evmkeys";
import { solDepositKey, solHotKey } from "../../src/signing/keys";
import { offline } from "../offline";
import { putPrice } from "../prices/seed";

// The real Solana signer, with a switch that makes it throw (a failure after the refund proof was minted).
const sol = vi.hoisted(() => ({ fail: false }));
vi.mock("../../src/signing/solana", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/signing/solana")>();
  return {
    ...real,
    signSolanaTx: async (...a: Parameters<typeof real.signSolanaTx>) => {
      if (sol.fail) throw new Error("boom");
      return real.signSolanaTx(...a);
    },
  };
});

const e = env as unknown as Env;
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
const SOL = "https://sol.test/rpc";
const ESP = "https://mempool.space/api";
const BASE_RPC = "https://base.test/rpc";
const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const CUSTOMER_SOL = solDepositKey(OTHER, 0).address;
const CUSTOMER_BTC = deriveUtxoAddress(accountFromSeed(OTHER, "btc"), "btc", 0);
const CUSTOMER_EVM = "0x1111111111111111111111111111111111111111";
const HOT_SOL = solHotKey(e.MASTER_SEED!).address;
const HOT_EVM = hotAccount(e).address.toLowerCase();
const BASE_USDC = getAsset("base:usdc").contract!.toLowerCase();
const XMR_A = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
let sim: {
  solSends: string[];
  lamports: bigint;
  hotUsdc: bigint;
  btcUtxos: Record<string, { txid: string; vout: number; value: number }[]>;
  btcSent: string[];
  btcFail?: boolean;
  btcKnown: string[];
  evmSent: Hex[];
  evmBalance: bigint;
  evmUsdc: bigint;
  evmFail?: boolean;
  /** Runs when the Solana RPC is asked for a blockhash (a test acts mid-send). */
  onBlockhash?: () => Promise<void>;
};
const saved = { SOLANA_RPC_URL: e.SOLANA_RPC_URL, EVM_RPC_BASE: e.EVM_RPC_BASE };

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
  Object.assign(e, { SOLANA_RPC_URL: SOL, EVM_RPC_BASE: BASE_RPC });
  await insertInvoice(e.DB, {
    id: "inv_rf", created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 1n, currency: "USD", order_id: null, metadata: null, success_url: null, allowed_assets: null,
    status: "paid", late: false, overpaid: false, paid_minor: 1n,
  });
  // An invoice that expired 8 days ago: past the sweep window (7 days and an hour), its watcher has given up.
  await insertInvoice(e.DB, {
    id: "inv_old", created_at: Date.now() - 9 * 86_400_000, expires_at: Date.now() - 8 * 86_400_000, price_minor: 100n, currency: "USD", order_id: null, metadata: null, success_url: null,
    allowed_assets: null, status: "partially_paid", late: false, overpaid: false, paid_minor: 1n,
  });
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  for (const t of ["refunds", "payments", "routing_actions", "router_lock", "route_batches", "own_addresses", "derivation_counters"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  await e.DB.prepare("DELETE FROM alerts").run();
  await e.DB.prepare("DELETE FROM events WHERE type='refund.approved'").run();
  sol.fail = false;
  clearChainIdMemo();
  sim = { solSends: [], lamports: 5_000_000_000n, hotUsdc: 0n, btcUtxos: {}, btcSent: [], btcKnown: [], evmSent: [], evmBalance: 10n ** 18n, evmUsdc: 0n };
  network.use(solRpc(), ...esplora(), evmRpc(), ...offline());
});

function solRpc() {
  return http.post(SOL, async ({ request }) => {
    const { method, params } = (await request.json()) as { method: string; params: unknown[] };
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id: 1, result });
    const ctx = { context: { slot: 1 } };
    switch (method) {
      case "getGenesisHash":
        return ok("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      case "getAccountInfo":
        return ok({ ...ctx, value: null });
      case "getLatestBlockhash":
        if (sim.onBlockhash) await sim.onBlockhash();
        return ok({ ...ctx, value: { blockhash: BH, lastValidBlockHeight: 1000 } });
      case "getBalance":
        return ok({ ...ctx, value: Number(params[0] === HOT_SOL ? sim.lamports : 0n) });
      case "getTokenAccountsByOwner": {
        const owner = params[0] as string;
        return ok({ ...ctx, value: owner === HOT_SOL ? [{ pubkey: findAta(owner, USDC_MINT)[0], account: { owner: TOKEN_PROGRAM, data: { parsed: { type: "account", info: { mint: USDC_MINT, owner, state: "initialized", tokenAmount: { amount: sim.hotUsdc.toString() } } } } } }] : [] });
      }
      case "sendTransaction":
        sim.solSends.push(params[0] as string);
        return ok("sig");
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    }
  });
}
function esplora() {
  return [
    http.get(`${ESP}/address/:a/utxo`, ({ params }) => HttpResponse.json((sim.btcUtxos[params.a as string] ?? []).map((u) => ({ ...u, status: { confirmed: true, block_height: 800_000, block_time: 1 } })))),
    http.get(`${ESP}/v1/fees/recommended`, () => HttpResponse.json({ fastestFee: 10, halfHourFee: 5, hourFee: 1 })),
    http.get(`${ESP}/tx/:txid/status`, ({ params }) => (sim.btcKnown.includes(params.txid as string) ? HttpResponse.json({ confirmed: false }) : new HttpResponse("Transaction not found", { status: 404 }))),
    http.post(`${ESP}/tx`, async ({ request }) => {
      const hex = await request.text();
      if (sim.btcFail) return new HttpResponse("bad-txns", { status: 400 });
      sim.btcSent.push(hex);
      return HttpResponse.text(Transaction.fromRaw(hexToBytes(hex)).id);
    }),
  ];
}
function evmRpc() {
  return http.post(BASE_RPC, async ({ request }) => {
    const { id, method, params } = (await request.json()) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "eth_chainId":
        return ok(numberToHex(8453));
      case "eth_getBalance":
        return ok(numberToHex((params[0] as string).toLowerCase() === HOT_EVM ? sim.evmBalance : 0n));
      case "eth_estimateGas":
        return ok(numberToHex(21_000n));
      case "eth_call": {
        const call = params[0] as { to: string; data: Hex };
        const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (call.to.toLowerCase() === BASE_USDC && functionName === "balanceOf" && (args[0] as string).toLowerCase() === HOT_EVM) return ok(encodeAbiParameters([{ type: "uint256" }], [sim.evmUsdc]));
        return ok(encodeAbiParameters([{ type: "uint256" }], [0n]));
      }
      case "eth_getTransactionCount":
        return ok(numberToHex(4));
      case "eth_maxPriorityFeePerGas":
        return ok(numberToHex(1_000_000n));
      case "eth_getBlockByNumber":
        return ok({ number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x1", transactions: [], baseFeePerGas: numberToHex(5_000_000n) });
      case "eth_sendRawTransaction":
        if (sim.evmFail) return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream error" } });
        sim.evmSent.push(params[0] as Hex);
        return ok(keccak256(params[0] as Hex));
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unmocked ${method}` } });
    }
  });
}

let seq = 0;
async function payment(
  asset: string,
  chain: PaymentRow["chain"],
  final: bigint,
  o: { address?: string; index?: number; routedAt?: number; status?: PaymentRow["status"]; invoice?: string } = {},
): Promise<PaymentRow> {
  const status = o.status ?? "confirmed";
  const p: PaymentRow = {
    id: `pay_rf${seq++}`, invoice_id: o.invoice ?? "inv_rf", asset, chain, address: o.address ?? `addr_${seq}_${chain}`, derivation_index: o.index ?? 100 + seq, reference: null, expected: final * 2n, price_e8: 1n,
    rate_locked_until: 0, received: final, final, txids: [], status, created_at: Date.now(), detected_at: Date.now(), confirmed_at: status === "confirmed" ? Date.now() : null, credited_minor: 1n, credit_price_e8: 1n, unexpected: null,
  };
  await insertPayment(e.DB, p);
  if (o.routedAt) await e.DB.prepare("UPDATE payments SET routed_at=? WHERE id=?").bind(o.routedAt, p.id).run();
  return p;
}

const headers = async () => S.headers;
const get = async (path: string) => exports.default.fetch(BASE + path, { headers: await headers(), redirect: "manual" });
const post = async (path: string, form: Record<string, string>) =>
  exports.default.fetch(BASE + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(await headers()) }, body: new URLSearchParams({ csrf: CSRF, ...form }), redirect: "manual" });
/** The passkey-confirmation action a path's POST needs (src/admin/confirm.ts). */
const actionOf = (path: string): ConfirmAction =>
  path.startsWith("/admin/privacy/") ? "routing" : path.endsWith("/reapprove") ? "refund.reapprove" : "refund";
/** POST with a fresh passkey assertion for exactly this path and these fields. */
const cpost = async (path: string, form: Record<string, string>) => post(path, { ...form, assertion: await S.confirm(actionOf(path), path, form) });
const refunds = async () => (await e.DB.prepare("SELECT * FROM refunds ORDER BY created_at, id").all<RefundRow>()).results;

describe("refund form", () => {
  it("shows the warning, the refundable amount and the form", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const r = await get(`/admin/payments/${p.id}/refund`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("This refund links the gateway&#39;s hot wallet to this customer on-chain.");
    expect(REFUND_WARNING).toBe("This refund links the gateway's hot wallet to this customer on-chain.");
    expect(html).toContain('name="address"');
    // The passkey binds exactly these fields (plus _path); restyling the form must not change them.
    expect(confirmFields(html, `/admin/payments/${p.id}/refund`)).toEqual(["address", "amount"]);
    expect(html).toContain('name="amount"');
    expect(html).toContain('data-passkey-confirm="refund"');
    expect(html).toContain('name="assertion"');
    expect(html).not.toContain('name="code"');
    // Privacy routing is the current page; the warning is a note.
    const nav = /<nav\b[^>]*aria-label="Main"[^>]*>[\s\S]*?<\/nav>/.exec(html)![0];
    expect(nav).toMatch(/<a\b[^>]*href="\/admin\/privacy"[^>]*aria-current="page"|<a\b[^>]*aria-current="page"[^>]*href="\/admin\/privacy"/);
    expect(html).toMatch(/role="note"[^>]*>\s*<strong>This refund links the gateway&#39;s hot wallet/);
    expect(html).toContain("Refunds of this payment");
    expect(html).toContain("No refunds yet");
    // The slot public/admin-passkey.js writes errors into: an alert, empty and hidden until it has one.
    const form = new RegExp(`<form[^>]*action="/admin/payments/${p.id}/refund"[^>]*>[\\s\\S]*?</form>`).exec(html)![0];
    expect(form).toMatch(/<p\b[^>]*role="alert"[^>]*data-passkey-error[^>]*hidden[^>]*><\/p>/);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  it("without a passkey confirmation: 403 and nothing recorded (missing, wrong, replayed); without CSRF: 403", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const path = `/admin/payments/${p.id}/refund`;
    const form = { address: CUSTOMER_SOL, amount: "0.5" };
    const missing = await post(path, form);
    expect(missing.status).toBe(403);
    // Without JavaScript the message shows in an alert, and the form still carries its (noscript) note.
    const missingHtml = await missing.text();
    expect(missingHtml).toMatch(new RegExp(`role="alert"[^>]*>\\s*${NEEDS_JS}`));
    expect(missingHtml).toMatch(new RegExp(`<noscript><p\\b[^>]*>${NEEDS_JS}</p></noscript>`));
    const wrong = await post(path, { ...form, assertion: await S.confirm("refund", path, { ...form, amount: "0.4" }) });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain(BAD_ASSERTION);
    const noCsrf = await exports.default.fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(await headers()) },
      body: new URLSearchParams({ ...form, assertion: await S.confirm("refund", path, form) }),
      redirect: "manual",
    });
    expect(noCsrf.status).toBe(403);
    expect(await refunds()).toEqual([]);
    expect(sim.solSends).toEqual([]);
  });

  it("with a passkey confirmation: approved, sent from the hot wallet once; the guard allows that address only once; a second refund within the hour is 429", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    const [row] = await refunds();
    expect(row).toMatchObject({ payment_id: p.id, to_address: CUSTOMER_SOL, amount: "250000000", error: null });
    expect(row!.approved_at).not.toBeNull();
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.sent_at).not.toBeNull();
    expect(row!.tx).toBeTruthy();
    expect(sim.solSends).toHaveLength(1);
    // Consumed: the refund's address is never allowed again.
    await expect(allowedDestination(e, "sol", CUSTOMER_SOL, { refundId: row!.id })).rejects.toThrow(/not a hot wallet/);
    // The hourly slot is taken: the refunds table itself (D1) refuses; nothing is kept in KV.
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(429);
    expect(await refunds()).toHaveLength(1);
    expect(sim.solSends).toHaveLength(1);
    const audit = await e.DB.prepare("SELECT action FROM routing_actions ORDER BY created_at, action").all<{ action: string }>();
    expect(audit.results.map((a) => a.action).sort()).toEqual(["refund_approve", "refund_send"]);
  });

  it("amount bounds: > 0, at most the credited amount minus earlier refunds", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const H = 3_600_000;
    const T = Date.now();
    for (const bad of ["0", "-1", "1.0000000001", "abc", "1.000000001"]) await expect(createRefund(e, p.id, CUSTOMER_SOL, bad, T)).rejects.toMatchObject({ code: 400 });
    expect((await createRefund(e, p.id, CUSTOMER_SOL, "0.6", T)).amount).toBe("600000000");
    await expect(createRefund(e, p.id, CUSTOMER_SOL, "0.400000001", T + 2 * H)).rejects.toThrow(/more than what can still be refunded/);
    expect((await createRefund(e, p.id, CUSTOMER_SOL, "0.4", T + 2 * H)).amount).toBe("400000000");
    await expect(createRefund(e, p.id, CUSTOMER_SOL, "0.000000001", T + 4 * H)).rejects.toThrow(/more than what can still be refunded/);
    // Over HTTP: 400, nothing recorded, the hourly slot not used.
    const q = await payment("sol:sol", "sol", 1_000n);
    expect((await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_SOL, amount: "0.000001001" })).status).toBe(400);
    expect((await refunds()).filter((r) => r.consumed_at !== null)).toEqual([]);
  });

  it("address checks: the payment's chain only, never the gateway's own addresses; Tron refused with an explanation", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    for (const a of [CUSTOMER_EVM, CUSTOMER_BTC, "not-an-address", HOT_SOL, p.address]) {
      const r = await cpost(`/admin/payments/${p.id}/refund`, { address: a, amount: "0.1" });
      expect(r.status, a).toBe(400);
    }
    const t = await payment("tron:usdt", "tron", 1_000_000n);
    const r = await cpost(`/admin/payments/${t.id}/refund`, { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", amount: "1" });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain(TRON_REFUNDS_REFUSED.slice(0, 40));
    expect(await refunds()).toEqual([]);
  });

  it("consumed, unsent: a failure after the proof was minted is shown, and only a passkey-confirmed re-approval sends it", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sol.fail = true;
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=unsent`);
    let [row] = await refunds();
    expect(row).toMatchObject({ tx: null, claim: null });
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.error).toMatch(/^consumed, unsent: re-approve/);
    expect(sim.solSends).toEqual([]);
    const page = await (await get(`/admin/payments/${p.id}/refund`)).text();
    expect(page).toContain("consumed, unsent: re-approve");
    expect(page).toContain(`/admin/refunds/${row!.id}/reapprove`);
    // Each confirm form binds exactly the fields it did before the restyle (none beyond csrf/assertion).
    expect(confirmFields(page, `/admin/refunds/${row!.id}/reapprove`)).toEqual([]);
    expect(confirmFields(page, `/admin/refunds/${row!.id}/cancel`)).toEqual([]);
    sol.fail = false;
    expect((await post(`/admin/refunds/${row!.id}/reapprove`, {})).status).toBe(403);
    expect((await refunds())[0]!.tx).toBeNull();
    const ok = await cpost(`/admin/refunds/${row!.id}/reapprove`, {});
    expect(ok.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    [row] = await refunds();
    expect(row!.tx).toBeTruthy();
    expect(row!.sent_at).not.toBeNull();
    expect(sim.solSends).toHaveLength(1);
    // A sent refund is never re-approved.
    expect((await cpost(`/admin/refunds/${row!.id}/reapprove`, {})).status).toBe(409);
    expect(sim.solSends).toHaveLength(1);
  });
});

describe("refund sends per chain", () => {
  it("EVM: a native transfer from the hot wallet of exactly the amount, its hash recorded", async () => {
    const p = await payment("base:eth", "base", 10n ** 16n);
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    expect(sim.evmSent).toHaveLength(1);
    const t = parseTransaction(sim.evmSent[0]!);
    expect(t).toMatchObject({ chainId: 8453, nonce: 4, to: CUSTOMER_EVM, value: 4n * 10n ** 15n });
    expect((await refunds())[0]!.tx).toBe(keccak256(sim.evmSent[0]!));
  });

  it("EVM: a hot wallet short of gas sends nothing and leaves the refund approved, not consumed", async () => {
    const p = await payment("base:eth", "base", 10n ** 16n);
    sim.evmBalance = 10n ** 15n;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    const [row] = await refunds();
    expect(row).toMatchObject({ tx: null, consumed_at: null });
    expect(row!.error).toMatch(/^not sent: /);
    expect(sim.evmSent).toEqual([]);
  });

  it("BTC: spends the payment's own deposit outputs (unrouted), change to a fresh own address", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 7);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',8)").run();
    const p = await payment("btc:btc", "btc", 500_000n, { address: dep, index: 7 });
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 500_000 }];
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    const t = Transaction.fromRaw(hexToBytes(sim.btcSent[0]!));
    expect(t.inputsLength).toBe(1);
    expect(scriptAddress("btc", t.getOutput(0).script!)).toBe(CUSTOMER_BTC);
    expect(t.getOutput(0).amount).toBe(100_000n);
    const own = await e.DB.prepare("SELECT address, purpose FROM own_addresses").first<{ address: string; purpose: string }>();
    expect(own!.purpose).toBe("change");
    expect(scriptAddress("btc", t.getOutput(1).script!)).toBe(own!.address);
    expect((await refunds())[0]!.tx).toBe(t.id);
  });

  it("BTC: refused once the deposit was routed, or while a route leg holds its outputs", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 9);
    const routed = await payment("btc:btc", "btc", 500_000n, { address: dep, index: 9, routedAt: Date.now() });
    expect((await cpost(`/admin/payments/${routed.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" })).status).toBe(409);
    await e.DB.prepare("UPDATE payments SET routed_at=NULL WHERE id=?").bind(routed.id).run();
    sim.btcUtxos[dep] = [{ txid: "22".repeat(32), vout: 0, value: 500_000 }];
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_x','btc:btc','1','[\"1\"]',?,'executing',0,0,?)")
      .bind(XMR_A, JSON.stringify([{ chunk: 0, step: "traded", amount: "1", createdAt: 0, updatedAt: 0, inputs: [{ txid: "22".repeat(32), vout: 0, value: "500000", index: 9, address: dep }] }]))
      .run();
    await cpost(`/admin/payments/${routed.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: null, error: expect.stringMatching(/^not sent: /) });
    expect(sim.btcSent).toEqual([]);
  });
});

describe("routing dashboard actions", () => {
  it("the release button shows only once the leg's trade has expired", async () => {
    const leg = (expiresAt: number) =>
      JSON.stringify([{ chunk: 0, step: "sending", amount: "1", createdAt: 0, updatedAt: 0, tradeId: "TR", expiresAt, tx: "aa".repeat(32), inputs: [{ txid: "11".repeat(32), vout: 0, value: "2", index: 1, address: "bc1q" }] }]);
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_fut','btc:btc','1','[\"1\"]',?,'executing',?,?,?)").bind(XMR_A, Date.now(), Date.now(), leg(Date.now() + 3_600_000)).run();
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_past','btc:btc','1','[\"1\"]',?,'executing',?,?,?)").bind(XMR_A, Date.now() - 1, Date.now(), leg(Date.now() - 1)).run();
    const html = await (await get("/admin/privacy")).text();
    expect(html).not.toContain("/admin/privacy/rb_fut/legs/0/release");
    expect(html).toContain("/admin/privacy/rb_past/legs/0/release");
    expect(confirmFields(html, "/admin/privacy/rb_past/legs/0/release")).toEqual([]);
  });

  it("multi-value cells keep each value in its own element; a completed batch reads Completed; the resume form binds no fields", async () => {
    const TX = "ab".repeat(32);
    const PAYOUT = "cd".repeat(32);
    const legs = JSON.stringify([{ chunk: 0, step: "sent", amount: "1", createdAt: 0, updatedAt: 0, tradeId: "TR9", provider: "acme", providerTradeId: "P9", tx: TX, hashout: PAYOUT, stuckAt: 1, status: "waiting" }]);
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_multi','btc:btc','1','[\"1\"]',?,'executing',?,?,?)").bind(XMR_A, Date.now(), Date.now(), legs).run();
    const worn = JSON.stringify([0, 1, 2].map(() => ({ chunk: 0, step: "abandoned", amount: "1", createdAt: 0, updatedAt: 0 })));
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_worn','btc:btc','1','[\"1\"]',?,'executing',?,?,?)").bind(XMR_A, Date.now(), Date.now(), worn).run();
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_done','btc:btc','1','[\"1\"]',?,'completed',?,?,'[]')").bind(XMR_A, Date.now(), Date.now()).run();
    const html = await (await get("/admin/privacy")).text();
    expect(html).toContain(`<div>${TX}</div>`);
    expect(html).toContain(`<div class="muted">payout ${PAYOUT}</div>`);
    expect(html).toContain('<div class="error small">stuck</div>');
    expect(html).not.toMatch(/stuck<\/span><span|sent<span/);
    expect(html).toMatch(/pill-paid[^>]*>[\s\S]*?Completed/);
    expect(confirmFields(html, "/admin/privacy/rb_worn/resume")).toEqual([]);
  });

  it("lists batches with the destination masked; mark resolved needs a passkey confirmation and is audited", async () => {
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_dash','btc:btc','1','[\"1\"]',?,'failed',0,0,'[]')").bind(XMR_A).run();
    const html = await (await get("/admin/privacy")).text();
    expect(html).toContain("rb_dash");
    expect(html).toContain(`${XMR_A.slice(0, 6)}…${XMR_A.slice(-6)}`);
    expect(html).not.toContain(XMR_A);
    expect(html).toContain("/admin/privacy/rb_dash/resolve");
    expect(confirmFields(html, "/admin/privacy/rb_dash/resolve")).toEqual([]);
    expect(html).toContain("Moves received funds through private hops before they reach you.");
    expect(html).toContain("Operator actions");
    expect(html).toMatch(new RegExp(`<noscript><p\\b[^>]*>${NEEDS_JS}</p></noscript>`));
    expect((await post("/admin/privacy/rb_dash/resolve", {})).status).toBe(403);
    expect((await post("/admin/privacy/rb_dash/resolve", { assertion: await S.confirm("routing", "/admin/privacy/rb_dash/resume", {}) })).status).toBe(403);
    expect((await e.DB.prepare("SELECT status FROM route_batches WHERE id='rb_dash'").first<{ status: string }>())!.status).toBe("failed");
    const ok = await cpost("/admin/privacy/rb_dash/resolve", {});
    expect(ok.status).toBe(303);
    expect((await e.DB.prepare("SELECT status FROM route_batches WHERE id='rb_dash'").first<{ status: string }>())!.status).toBe("resolved");
    const again = await cpost("/admin/privacy/rb_dash/resolve", {});
    expect(again.status).toBe(409);
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions WHERE action='resolve'").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("refunds and routing share the lease and the balance", () => {
  it("every refund send runs under the router lease: held -> 409, nothing recorded or consumed, the hourly slot not used", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    expect(await acquireRouterLock(e.DB, "router", Date.now())).toBe(true);
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("routing is running, try again in a few minutes");
    expect(await refunds()).toEqual([]);
    // A refund waiting for re-approval is not touched while the lease is held either.
    await releaseRouterLock(e.DB, "router");
    sol.fail = true;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    sol.fail = false;
    const [row] = await refunds();
    expect(await acquireRouterLock(e.DB, "router", Date.now())).toBe(true);
    expect((await cpost(`/admin/refunds/${row!.id}/reapprove`, {})).status).toBe(409);
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: row!.consumed_at });
    await releaseRouterLock(e.DB, "router");
    expect(sim.solSends).toEqual([]);
  });

  it("a lease lost before the mint (expired and taken over) stops the send: nothing consumed or sent", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sim.onBlockhash = async () => {
      await e.DB.prepare("UPDATE router_lock SET holder='router', expires_at=? WHERE id=1").bind(Date.now() + 600_000).run();
    };
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=unsent`);
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: null, error: expect.stringMatching(/lease was lost/) });
    expect(sim.solSends).toEqual([]);
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: "router" });
  });

  it("a UTXO refund while the router runs: 409, nothing spent", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 7);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',8)").run();
    const p = await payment("btc:btc", "btc", 500_000n, { address: dep, index: 7 });
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 500_000 }];
    expect(await acquireRouterLock(e.DB, "router", Date.now())).toBe(true);
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" })).status).toBe(409);
    expect(sim.btcSent).toEqual([]);
    expect(await refunds()).toEqual([]);
  });

  it("funds committed to an executing route batch are not refunded (left unconsumed)", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs) VALUES('rb_c','sol:sol','4900000000','[\"4900000000\"]',?,'executing',0,0,'[]')").bind(XMR_A).run();
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=unsent`);
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: null, error: expect.stringMatching(/^not sent: .*free/) });
    expect(sim.solSends).toEqual([]);
  });

  it("a native EVM refund that would eat into GAS_RESERVE is refused (left unconsumed)", async () => {
    const p = await payment("base:eth", "base", 10n ** 16n);
    sim.evmBalance = 5n * 10n ** 15n; // 0.005 ETH: 0.004 + gas fits, but GAS_RESERVE.base is 0.002 ETH
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: null, error: expect.stringMatching(/^not sent: .*free/) });
    expect(sim.evmSent).toEqual([]);
    expect((await createRefund(e, (await payment("base:eth", "base", 10n ** 16n)).id, CUSTOMER_EVM, "0.001", Date.now() + 2 * 3_600_000)).amount).toBe("1000000000000000");
  });

  it("a UTXO refund marks its deposit in the tx-record transaction: a router run then plans nothing from it", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 7);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',8)").run();
    const p = await payment("btc:btc", "btc", 5_000_000n, { address: dep, index: 7 });
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 5_000_000 }];
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    expect(sim.btcSent).toHaveLength(1);
    const row = await e.DB.prepare("SELECT refunded_at, routed_at FROM payments WHERE id=?").bind(p.id).first<{ refunded_at: number | null; routed_at: number | null }>();
    expect(row!.refunded_at).toBe((await refunds())[0]!.created_at);
    expect(row!.routed_at).toBeNull();
    // The explorer has not caught up (the spent output is still listed): the deposit is still never planned again.
    expect((await routableInputs(e, "btc")).flat().map((i) => i.address)).not.toContain(dep);
    network.use(http.get("https://api.trocador.app/coin", ({ request }) => HttpResponse.json([{ ticker: new URL(request.url).searchParams.get("ticker"), network: "Mainnet", memo: "False", minimum: "0.0005", maximum: "100" }])));
    await putPrice(e, "USD", "BTC", 100_000n * 10n ** 8n);
    const env2 = { ...e, ENABLED_ASSETS: "btc:btc", TROCADOR_LIVE_OK: "1", TROCADOR_API_KEY: "k", XMR_ADDRESS: XMR_A } as Env;
    const r = await runRouter(env2, Date.now(), { rng: () => 0.5 });
    expect(r.planned["btc:btc"]).toBe("wait");
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM route_batches").first()).toEqual({ n: 0 });
    // A second refund of the same deposit (the hourly window over) is refused with the reason.
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run();
    const again = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already spent by a refund");
  });

  it("the amount bound is checked in the INSERT itself: a refund recorded meanwhile makes it fail", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const T = Date.now();
    let raced = false;
    const db = new Proxy(e.DB, {
      get(t, k) {
        if (k !== "prepare") {
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        }
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.startsWith("INSERT INTO refunds(id,payment_id")) return st;
          return {
            bind: (...a: unknown[]) => {
              const b = st.bind(...a);
              return {
                run: async () => {
                  if (!raced) {
                    raced = true;
                    await t.prepare("INSERT INTO refunds(id,payment_id,to_address,amount,approved_at,created_at) VALUES('rf_race',?,?,'600000000',?,?)").bind(p.id, CUSTOMER_SOL, T - 3 * 3_600_000, T - 3 * 3_600_000).run();
                  }
                  return b.run();
                },
              };
            },
          };
        };
      },
    });
    await expect(createRefund({ ...e, DB: db } as Env, p.id, CUSTOMER_SOL, "0.6", T)).rejects.toMatchObject({ code: 409 });
    expect((await refunds()).map((r) => r.id)).toEqual(["rf_race"]);
  });
});

describe("cancel refund", () => {
  const cancel = async (id: string, confirmed = false) => (confirmed ? cpost(`/admin/refunds/${id}/cancel`, {}) : post(`/admin/refunds/${id}/cancel`, {}));
  it("an approved or consumed refund without a tx is cancelled (passkey confirmation, audited); its amount is refundable again; its proof can no longer be minted", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sim.lamports = 10_000_000n; // too little: approved, not sent
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "1" });
    let [row] = await refunds();
    expect(row).toMatchObject({ tx: null, consumed_at: null });
    expect(await (await get(`/admin/payments/${p.id}/refund`)).text()).toContain(`/admin/refunds/${row!.id}/cancel`);
    expect((await cancel(row!.id)).status).toBe(403);
    expect(await acquireRouterLock(e.DB, "router", Date.now())).toBe(true);
    expect((await cancel(row!.id, true)).status).toBe(409);
    await releaseRouterLock(e.DB, "router");
    expect((await cancel(row!.id, true)).status).toBe(303);
    [row] = await refunds();
    expect(row!.cancelled_at).not.toBeNull();
    await expect(allowedDestination(e, "sol", CUSTOMER_SOL, { refundId: row!.id })).rejects.toThrow(/not a hot wallet/);
    expect((await cpost(`/admin/refunds/${row!.id}/reapprove`, {})).status).toBe(409);
    expect((await cancel(row!.id, true)).status).toBe(409);
    expect((await createRefund(e, p.id, CUSTOMER_SOL, "1", Date.now() + 2 * 3_600_000)).amount).toBe("1000000000");
    const audit = await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions WHERE action='refund_cancel'").first<{ n: number }>();
    expect(audit!.n).toBe(1);
    // consumed, unsent: cancellable too
    const q = await payment("sol:sol", "sol", 1_000_000_000n);
    sim.lamports = 5_000_000_000n;
    sol.fail = true;
    await e.DB.prepare("UPDATE refunds SET created_at=0").run();
    await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_SOL, amount: "0.5" });
    const consumed = (await refunds()).find((r) => r.payment_id === q.id)!;
    expect(consumed.consumed_at).not.toBeNull();
    expect((await cancel(consumed.id, true)).status).toBe(303);
  });

  it("UTXO broadcast failed: cancelled only when the explorer does not know the tx and its inputs are unspent; the deposit is routable again", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 7);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',8)").run();
    const p = await payment("btc:btc", "btc", 500_000n, { address: dep, index: 7 });
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 500_000 }];
    sim.btcFail = true;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    const [row] = await refunds();
    expect(row!.tx).toBeTruthy();
    expect(row!.sent_at).toBeNull();
    await e.DB.prepare("UPDATE refunds SET tx_at=? WHERE id=?").bind(Date.now() - 7 * 3_600_000, row!.id).run(); // 7 hours old
    sim.btcKnown.push(row!.tx!);
    expect((await cancel(row!.id, true)).status).toBe(409);
    sim.btcKnown = [];
    sim.btcUtxos[dep] = [];
    expect((await cancel(row!.id, true)).status).toBe(409);
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 500_000 }];
    expect((await cancel(row!.id, true)).status).toBe(303);
    expect((await refunds())[0]!.cancelled_at).not.toBeNull();
    expect((await e.DB.prepare("SELECT refunded_at FROM payments WHERE id=?").bind(p.id).first<{ refunded_at: number | null }>())!.refunded_at).toBeNull();
  });

  it("EVM broadcast failed with a recorded tx: not cancellable from the dashboard (cannot tell it never landed)", async () => {
    const p = await payment("base:eth", "base", 10n ** 16n);
    sim.evmFail = true;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    const [row] = await refunds();
    expect(row!.tx).toBeTruthy();
    expect((await cancel(row!.id, true)).status).toBe(409);
    expect((await refunds())[0]!.cancelled_at).toBeNull();
  });
});

describe("more refund sends", () => {
  it("EVM ERC-20: transfer(customer, amount) to the token contract, no value", async () => {
    const p = await payment("base:usdc", "base", 50_000_000n);
    sim.evmUsdc = 100_000_000n;
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "12.5" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    const t = parseTransaction(sim.evmSent[0]!);
    expect(t.to!.toLowerCase()).toBe(BASE_USDC);
    expect(t.value ?? 0n).toBe(0n);
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: t.data! });
    expect(functionName).toBe("transfer");
    expect([(args[0] as string).toLowerCase(), args[1]]).toEqual([CUSTOMER_EVM, 12_500_000n]);
  });

  it("Solana USDC: creates the customer's USDC account and transfers exactly the amount", async () => {
    const p = await payment("sol:usdc", "sol", 50_000_000n);
    sim.hotUsdc = 100_000_000n;
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "7" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    const wire = base64.decode(sim.solSends[0]!);
    const has = (b58: string) => {
      const k = base58.decode(b58);
      for (let i = 0; i + 32 <= wire.length; i++) if (k.every((x, j) => wire[i + j] === x)) return true;
      return false;
    };
    expect(has(findAta(CUSTOMER_SOL, USDC_MINT)[0])).toBe(true);
    expect(has(ASSOCIATED_TOKEN_PROGRAM)).toBe(true);
    expect(has(USDC_MINT)).toBe(true);
  });
});

describe("partial and expired payments (I2)", () => {
  const H = 3_600_000;
  it("a partial BTC payment is refundable once its invoice expired past the sweep window, up to what its deposit holds", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 11);
    const early = await payment("btc:btc", "btc", 300_000n, { address: dep, index: 11, status: "partial" });
    await expect(createRefund(e, early.id, CUSTOMER_BTC, "0.001", Date.now())).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/7 days/) });
    const dep2 = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 12);
    const p = await payment("btc:btc", "btc", 300_000n, { address: dep2, index: 12, status: "partial", invoice: "inv_old" });
    // The deposit holds a little more than was recorded (a late top-up): the bound is what it holds.
    sim.btcUtxos[dep2] = [{ txid: "33".repeat(32), vout: 0, value: 350_000 }];
    await expect(createRefund(e, p.id, CUSTOMER_BTC, "0.00350001", Date.now())).rejects.toThrow(/more than what can still be refunded/);
    expect((await createRefund(e, p.id, CUSTOMER_BTC, "0.0034", Date.now() + 2 * H)).amount).toBe("340000");
  });

  it("an expired BTC payment with funds at its deposit (nothing recorded) is refundable up to what the deposit holds", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 13);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',14) ON CONFLICT(chain) DO UPDATE SET next=14").run();
    const p = await payment("btc:btc", "btc", 0n, { address: dep, index: 13, status: "expired", invoice: "inv_old" });
    sim.btcUtxos[dep] = [{ txid: "44".repeat(32), vout: 0, value: 500_000 }];
    await expect(createRefund(e, p.id, CUSTOMER_BTC, "0.006", Date.now())).rejects.toThrow(/more than what can still be refunded/);
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.004" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    const t = Transaction.fromRaw(hexToBytes(sim.btcSent[0]!));
    expect(t.getOutput(0).amount).toBe(400_000n);
  });

  it("EVM and Solana: a partial payment is refundable past the window, up to what arrived in its asset; an expired one with nothing in its asset is not", async () => {
    const p = await payment("sol:sol", "sol", 400_000_000n, { status: "partial", invoice: "inv_old" });
    await expect(createRefund(e, p.id, CUSTOMER_SOL, "0.400000001", Date.now())).rejects.toThrow(/more than what can still be refunded/);
    expect((await createRefund(e, p.id, CUSTOMER_SOL, "0.4", Date.now())).amount).toBe("400000000");
    const x = await payment("sol:sol", "sol", 0n, { status: "expired", invoice: "inv_old" });
    await expect(createRefund(e, x.id, CUSTOMER_SOL, "0.1", Date.now() + 2 * H)).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/nothing arrived/) });
  });
});

describe("the EVM hot wallet's nonce lease (I4)", () => {
  it("a sweep holding the chain's lease makes a concurrent EVM refund get 409: nothing recorded, nothing signed", async () => {
    const { acquireHotNonce, releaseHotNonce } = await import("../../src/db/noncelease");
    const p = await payment("base:eth", "base", 10n ** 16n);
    expect(await acquireHotNonce(e.DB, "base", "sweep_x", Date.now())).toBe(true);
    const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.001" });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("the hot wallet is sending another transaction");
    expect(await refunds()).toEqual([]);
    expect(sim.evmSent).toEqual([]);
    // Another chain's lease is not this one: a Solana refund goes ahead meanwhile.
    const s = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${s.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303);
    await releaseHotNonce(e.DB, "base", "sweep_x");
    await e.DB.prepare("DELETE FROM refunds").run();
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.001" })).headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    expect(sim.evmSent).toHaveLength(1);
    expect(await e.DB.prepare("SELECT holder FROM hot_nonce_lease WHERE chain='base'").first()).toEqual({ holder: null });
  });
});

describe("Task 7 deferred minors", () => {
  const cancel = async (id: string, confirmed = false) => (confirmed ? cpost(`/admin/refunds/${id}/cancel`, {}) : post(`/admin/refunds/${id}/cancel`, {}));

  it("m1: a UTXO refund tx recorded less than 6 hours ago is not cancelled, even when the explorer does not know it", async () => {
    const dep = deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", 7);
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',8)").run();
    const p = await payment("btc:btc", "btc", 500_000n, { address: dep, index: 7 });
    sim.btcUtxos[dep] = [{ txid: "11".repeat(32), vout: 0, value: 500_000 }];
    sim.btcFail = true;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_BTC, amount: "0.001" });
    const [row] = await refunds();
    expect(row!.tx).toBeTruthy();
    expect(row!.tx_at).toBeGreaterThan(0);
    const r = await cancel(row!.id, true);
    expect(r.status).toBe(409);
    expect(await r.text()).toMatch(/6 hours/);
    expect((await refunds())[0]!.cancelled_at).toBeNull();
    await e.DB.prepare("UPDATE refunds SET tx_at=? WHERE id=?").bind(Date.now() - 6 * 3_600_000 - 1, row!.id).run();
    expect((await cancel(row!.id, true)).status).toBe(303);
  });

  it("m3: a refund refused at send time (nothing minted or sent) does not hold the hourly window; a minted one does", async () => {
    const p = await payment("base:eth", "base", 10n ** 16n);
    sim.evmBalance = 10n ** 15n; // too little gas: refused before the mint
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    expect((await refunds())[0]).toMatchObject({ tx: null, consumed_at: null });
    sim.evmBalance = 10n ** 18n;
    const q = await payment("base:eth", "base", 10n ** 16n);
    const r = await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" });
    expect(r.headers.get("location")).toBe(`/admin/payments/${q.id}/refund?sent=sent`);
    // That one was minted and sent: the window is taken (the refunds table).
    const s = await payment("base:eth", "base", 10n ** 16n);
    expect((await cpost(`/admin/payments/${s.id}/refund`, { address: CUSTOMER_EVM, amount: "0.004" })).status).toBe(429);
    // Re-approving the refused one within the hour would mint a second refund in the window: 429 too.
    const refused = (await refunds()).find((x) => x.payment_id === p.id)!;
    expect((await cpost(`/admin/refunds/${refused.id}/reapprove`, {})).status).toBe(429);
    expect(sim.evmSent).toHaveLength(1);
  });
});

describe("Plan 9: refund alerts, the refund.approved webhook and the D1-only hourly gate", () => {
  const alerts = async () => (await e.DB.prepare("SELECT * FROM alerts WHERE kind='refund.approved' ORDER BY created_at, id").all<{ id: string; chain: string; detail: string; resolved_at: number | null }>()).results;
  const events = async () =>
    (await e.DB.prepare("SELECT * FROM events WHERE type='refund.approved' ORDER BY created_at, id").all<{ id: string; invoice_id: string; payload: string; enqueued_at: number | null }>()).results;
  const live = async () => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='action'").first<{ n: number }>())!.n;
  const clearKv = async () => {
    for (const k of (await e.KV.list()).keys) await e.KV.delete(k.name);
  };

  it("an approved refund records a refund.approved alert and one webhook event (enqueued after the send); a re-approve records another", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sol.fail = true; // minted, then the signer fails: consumed, unsent
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303);
    const [row] = await refunds();
    expect(row).toMatchObject({ tx: null });
    expect(row!.consumed_at).not.toBeNull();
    let [a] = await alerts();
    expect(a).toMatchObject({ chain: "sol", resolved_at: null });
    expect(a!.detail).toBe(
      `Refund approved: 250000000 sol:sol (atomic units) from payment ${p.id} to ${CUSTOMER_SOL}. If this was not you, sign out every session on Passkeys and cancel it on the refund page.`,
    );
    const [ev] = await events();
    expect(ev).toMatchObject({ id: `refund.approved:${a!.id}`, invoice_id: a!.id });
    expect(JSON.parse(ev!.payload)).toEqual({ refund_id: row!.id, payment_id: p.id, invoice_id: p.invoice_id, asset: "sol:sol", amount: "250000000", to_address: CUSTOMER_SOL });
    expect(ev!.enqueued_at).not.toBeNull(); // the route enqueued it right after the send
    // Delivered: data names the refund.
    const seen: string[] = [];
    network.use(http.post("https://merchant.test/hook", async ({ request }) => (seen.push(await request.text()), new HttpResponse("ok"))));
    const batch = createMessageBatch<WebhookJob>("0crypto-webhooks", [{ id: "m0", timestamp: new Date(), attempts: 1, body: { eventId: ev!.id } }]);
    await handleWebhookBatch(batch, { ...e, WEBHOOK_URL: "https://merchant.test/hook", WEBHOOK_SECRET: "whsec_test" } as Env);
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual(["m0"]);
    const body = JSON.parse(seen[0]!) as { type: string; data: Record<string, unknown> };
    expect(body.type).toBe("refund.approved");
    expect(body.data).toEqual({ object: "refund", id: row!.id, payment_id: p.id, invoice_id: p.invoice_id, asset: "sol:sol", amount: "250000000", to_address: CUSTOMER_SOL, alert_id: a!.id });
    // Re-approved (a new passkey confirmation): a second alert and event, no 6-hour dedupe.
    sol.fail = false;
    expect((await cpost(`/admin/refunds/${row!.id}/reapprove`, {})).headers.get("location")).toBe(`/admin/payments/${p.id}/refund?sent=sent`);
    expect(await alerts()).toHaveLength(2);
    expect(await events()).toHaveLength(2);
    [, a] = await alerts();
    expect((await events()).map((x) => x.id)).toContain(`refund.approved:${a!.id}`);
    // The overview shows it with its title.
    const html = await (await get("/admin")).text();
    expect(html).toContain("A refund was approved");
  });

  it("a second refund within the hour: 429 before the passkey confirmation is spent; the gate is D1 only (KV stays empty)", async () => {
    await clearKv();
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303);
    const q = await payment("sol:sol", "sol", 1_000_000_000n);
    const path = `/admin/payments/${q.id}/refund`;
    const form = { address: CUSTOMER_SOL, amount: "0.25" };
    const assertion = await S.confirm("refund", path, form);
    const n = await live();
    const r = await post(path, { ...form, assertion });
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Only one refund per hour");
    expect(await live()).toBe(n); // the challenge was not spent
    expect(await refunds()).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
    expect((await e.KV.list()).keys.length).toBe(0);
    // The window over (the minted refund aged past it): the same assertion goes through.
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run();
    expect((await post(path, { ...form, assertion })).status).toBe(303);
    expect(sim.solSends).toHaveLength(2);
    expect((await e.KV.list()).keys.length).toBe(0);
  });

  it("re-approving inside another refund's window: 429 before the confirmation is spent, and reapproveRefund's own UPDATE refuses it (nothing changed)", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sol.fail = true;
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    const [a] = await refunds();
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run(); // its window is over
    sol.fail = false;
    const q = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303); // minted now
    const path = `/admin/refunds/${a!.id}/reapprove`;
    const assertion = await S.confirm("refund.reapprove", path, {});
    const n = await live();
    expect((await post(path, { assertion })).status).toBe(429);
    expect(await live()).toBe(n);
    // The function itself (no pre-check): the gate is in the UPDATE.
    await expect(reapproveRefund(e, a!.id, Date.now())).rejects.toMatchObject({ code: 429 });
    expect((await refunds()).find((x) => x.id === a!.id)).toMatchObject({ consumed_at: a!.consumed_at! - 3600001, approved_at: a!.approved_at });
    expect(await alerts()).toHaveLength(2); // the two creates only
  });

  it("two concurrent re-approves of two unsent refunds after a minted one: exactly one is sent", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303);
    // Two refunds of other payments, minted and unsent, from before the window; the sent one's window over too.
    sol.fail = true;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run();
      const q = await payment("sol:sol", "sol", 1_000_000_000n);
      await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
      ids.push((await refunds()).find((x) => x.payment_id === q.id)!.id);
    }
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run();
    sol.fail = false;
    const forms = await Promise.all(ids.map(async (id) => ({ path: `/admin/refunds/${id}/reapprove`, assertion: await S.confirm("refund.reapprove", `/admin/refunds/${id}/reapprove`, {}) })));
    const rs = await Promise.all(forms.map((f) => post(f.path, { assertion: f.assertion })));
    const ok = rs.filter((r) => r.status === 303 && r.headers.get("location")!.endsWith("sent=sent"));
    expect(ok).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409 || r.status === 429)).toHaveLength(1);
    expect(sim.solSends).toHaveLength(2); // the first refund and one re-approved
    // Afterwards the other one is refused by the window (sequentially, too).
    const left = ids.find((id) => !(rs[ids.indexOf(id)]!.status === 303))!;
    await expect(reapproveRefund(e, left, Date.now())).rejects.toMatchObject({ code: 429 });
  });

  it("re-approving a sent or cancelled refund: 409 (not 429) even inside another refund's window, before the confirmation is spent", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303);
    const sent = (await refunds())[0]!;
    expect(sent.tx).not.toBeNull();
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run(); // its window is over
    sol.fail = true;
    const q = await payment("sol:sol", "sol", 1_000_000_000n);
    await cpost(`/admin/payments/${q.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    const cancelled = (await refunds()).find((x) => x.payment_id === q.id)!;
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001, cancelled_at=? WHERE id=?").bind(Date.now(), cancelled.id).run();
    sol.fail = false;
    const r = await payment("sol:sol", "sol", 1_000_000_000n);
    expect((await cpost(`/admin/payments/${r.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" })).status).toBe(303); // minted now: the window is taken
    const sends = sim.solSends.length;
    for (const id of [sent.id, cancelled.id]) {
      const path = `/admin/refunds/${id}/reapprove`;
      const assertion = await S.confirm("refund.reapprove", path, {});
      const n = await live();
      const res = await post(path, { assertion });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("can be re-approved");
      expect(await live()).toBe(n); // the challenge was not spent
      await expect(reapproveRefund(e, id, Date.now())).rejects.toMatchObject({ code: 409 });
    }
    expect(sim.solSends).toHaveLength(sends);
  });

  it("a re-approve whose alert cannot be recorded: 500, the refund stays approved and unsent, nothing claimed or sent", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    sol.fail = true; // minted, then the signer fails: consumed, unsent
    await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
    const [a] = await refunds();
    expect(a).toMatchObject({ tx: null });
    await e.DB.prepare("UPDATE refunds SET consumed_at=consumed_at-3600001").run(); // its window is over
    sol.fail = false;
    const sends = sim.solSends.length;
    const batch = e.DB.batch.bind(e.DB);
    // Only the alert's batch fails: any batch once the re-approve's UPDATE has landed (approved_at moved).
    vi.spyOn(e.DB, "batch").mockImplementation(async (stmts) => {
      const now = await e.DB.prepare("SELECT approved_at FROM refunds WHERE id=?").bind(a!.id).first<{ approved_at: number }>();
      if (now!.approved_at !== a!.approved_at) throw new Error("D1 down");
      return batch(stmts);
    });
    try {
      const r = await cpost(`/admin/refunds/${a!.id}/reapprove`, {});
      expect(r.status).toBe(500);
    } finally {
      vi.restoreAllMocks();
    }
    const row = (await refunds()).find((x) => x.id === a!.id)!;
    expect(row).toMatchObject({ claim: null, claimed_at: null, consumed_at: null, tx: null, cancelled_at: null });
    expect(sim.solSends).toHaveLength(sends);
    expect(await alerts()).toHaveLength(1); // the create's only
  });

  it("the alert cannot be recorded: an error, nothing claimed or sent", async () => {
    const p = await payment("sol:sol", "sol", 1_000_000_000n);
    const batch = e.DB.batch.bind(e.DB);
    // Only the alert's batch fails: the first batch once the refund row exists.
    vi.spyOn(e.DB, "batch").mockImplementation(async (stmts) => {
      if ((await e.DB.prepare("SELECT count(*) AS n FROM refunds").first<{ n: number }>())!.n > 0) throw new Error("D1 down");
      return batch(stmts);
    });
    try {
      const r = await cpost(`/admin/payments/${p.id}/refund`, { address: CUSTOMER_SOL, amount: "0.25" });
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally {
      vi.restoreAllMocks();
    }
    const [row] = await refunds();
    expect(row).toMatchObject({ claim: null, consumed_at: null, tx: null });
    expect(sim.solSends).toEqual([]);
    expect(await alerts()).toEqual([]);
  });
});
