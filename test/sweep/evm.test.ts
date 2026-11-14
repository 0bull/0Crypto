import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from "viem";
import worker from "../../src/index";
import { clearChainIdMemo } from "../../src/chains/evm/config";
import { clearHealthMemo } from "../../src/chains/evm/health";
import { hotAccount } from "../../src/signing/evmkeys";
import { factoryAddress } from "../../src/chains/evm/predict";
import { getAsset } from "../../src/core/assets";
import { recordAlert } from "../../src/db/alerts";
import { step } from "../../src/core/state";
import { getInvoice, getPayment, insertInvoice, insertPayment, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { errText, planEvmSweep, recoverDeposit, runEvmSweep, saltFor } from "../../src/sweep/evm";
import { runSweeps } from "../../src/sweep/cron";
import { emptyState, evmRpc, type RpcState } from "../evm-rpc";
import { offline } from "../offline";
import { putPrice, dropPrice } from "../prices/seed";
import { FACTORY_ABI, GWEI, sweepRpc, sweepState, type SweepRpcState } from "./rpc";

const e = env as unknown as Env;
const URL_OF = { base: "https://rpc.test/base", eth: "https://rpc.test/eth", bsc: "https://rpc.test/bsc", arb: "https://rpc.test/arb", polygon: "https://rpc.test/polygon" } as const;
const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE, EVM_RPC_ETH: e.EVM_RPC_ETH, EVM_RPC_BSC: e.EVM_RPC_BSC, EVM_RPC_ARB: e.EVM_RPC_ARB, EVM_RPC_POLYGON: e.EVM_RPC_POLYGON };
const hot = hotAccount(e).address;
const factory = factoryAddress(hot);
const USDC_BASE = getAsset("base:usdc").contract as Address;
const DAI_BASE = getAsset("base:dai").contract as Address;
const USDC_ARB = getAsset("arb:usdc").contract as Address;
const USDT_ARB = getAsset("arb:usdt").contract as Address;
const DAI_ARB = getAsset("arb:dai").contract as Address;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = () => Date.now();

const network = setupNetwork();
let rpc: Record<keyof typeof URL_OF, RpcState>;
let sw: Record<keyof typeof URL_OF, SweepRpcState>;

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  Object.assign(e, {
    ENABLED_ASSETS: "base:usdc,base:eth,eth:usdc,eth:eth,bsc:usdc,bsc:bnb,arb:usdc,arb:usdt,arb:eth,polygon:usdc,polygon:pol",
    EVM_RPC_BASE: URL_OF.base, EVM_RPC_ETH: URL_OF.eth, EVM_RPC_BSC: URL_OF.bsc, EVM_RPC_ARB: URL_OF.arb, EVM_RPC_POLYGON: URL_OF.polygon,
  });
  await insertInvoice(e.DB, {
    id: "inv_sweep", created_at: Date.now(), expires_at: Date.now() + HOUR, price_minor: 5000n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
  } satisfies InvoiceRow);
  // Partial and expired payments are swept only once the watcher has given up on them: expires_at + 7d + 1h.
  for (const [id, expires] of [["inv_sweep_old", Date.now() - 8 * DAY], ["inv_sweep_recent", Date.now() - 7 * DAY]] as const)
    await insertInvoice(e.DB, {
      id, created_at: expires - HOUR, expires_at: expires, price_minor: 5000n, currency: "USD", order_id: null,
      metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
    });
});
beforeEach(async () => {
  rpc = Object.fromEntries(Object.keys(URL_OF).map((c) => [c, emptyState()])) as typeof rpc;
  sw = Object.fromEntries(Object.keys(URL_OF).map((c) => [c, sweepState()])) as typeof sw;
  await putPrice(e, "USD", "ETH", 2000n * 10n ** 8n);
  for (const c of Object.keys(URL_OF) as (keyof typeof URL_OF)[]) {
    rpc[c].latest = { native: { [hot.toLowerCase()]: 10n ** 18n } };
    network.use(sweepRpc(URL_OF[c], () => sw[c]), evmRpc(URL_OF[c], () => rpc[c]));
    await e.KV.delete(`evm:health:${c}`);
  }
  network.use(...offline());
  clearHealthMemo();
  clearChainIdMemo();
  for (const t of ["payments", "sweeps", "alerts"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => network.resetHandlers());
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});

let seq = 0;
function pay(o: Partial<PaymentRow> = {}): PaymentRow {
  const n = seq++;
  return {
    id: `pay_sw${n}`, invoice_id: "inv_sweep", asset: "base:usdc", chain: "base", address: `0x${n.toString(16).padStart(40, "0")}`, derivation_index: n,
    reference: null, expected: 1_000_000n, price_e8: 10n ** 8n, rate_locked_until: 0, received: 1_000_000n, final: 1_000_000n, txids: [], status: "confirmed",
    created_at: Date.now() - 2 * HOUR, detected_at: null, confirmed_at: Date.now() - HOUR, credited_minor: 100n, credit_price_e8: 10n ** 8n, unexpected: null,
    swept_at: null, sweep_tx: null, sweep_error: null, sweep_retry_at: null, ...o,
  };
}
async function mk(o: Partial<PaymentRow> = {}): Promise<PaymentRow> {
  const p = pay(o);
  await insertPayment(e.DB, p);
  return p;
}
const salt = (i: number): Hex => keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(i)]));
const sweeps = async () => (await e.DB.prepare("SELECT * FROM sweeps ORDER BY created_at, id").all<Record<string, string | number | null>>()).results;
const alerts = async () => (await e.DB.prepare("SELECT * FROM alerts").all<Record<string, string | number | null>>()).results;
/** The signer of a raw tx: deployAndFlush only succeeds when it is the factory's sink, the hot wallet. */
const fromOf = (raw: Hex) => recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
const decodeSent = (raw: Hex) => {
  const tx = parseTransaction(raw);
  const { args } = decodeFunctionData({ abi: FACTORY_ABI, data: tx.data! });
  return { tx, salts: args![0] as Hex[], tokens: args![1] as Address[] };
};

describe("planEvmSweep", () => {
  it("batches confirmed unswept payments of the chain: salts and the distinct token contracts", () => {
    const ps = [pay(), pay(), pay(), pay({ status: "confirming" })];
    const plan = planEvmSweep(ps, "base")!;
    expect(plan.salts).toEqual(ps.slice(0, 3).map((p) => salt(p.derivation_index)));
    expect(plan.tokens).toEqual([USDC_BASE]);
    expect(plan.payments.map((p) => p.id)).toEqual(ps.slice(0, 3).map((p) => p.id));
  });

  it("uses the salt keccak256(abi.encode(uint256(index)))", () => {
    expect(saltFor(0)).toBe(keccak256(`0x${"00".repeat(32)}`));
    expect(saltFor(5)).toBe(salt(5));
  });

  it("takes at most 50 payments, oldest first", () => {
    const ps = Array.from({ length: 60 }, (_, i) => pay({ confirmed_at: 1_000_000 - i }));
    const plan = planEvmSweep(ps, "base")!;
    expect(plan.salts).toHaveLength(50);
    expect(plan.payments[0]!.id).toBe(ps[59]!.id);
  });

  it("skips swept payments, other chains, and payments waiting for their retry time", () => {
    const now = 5_000_000;
    const plan = planEvmSweep(
      [pay({ swept_at: 1 }), pay({ chain: "arb", asset: "arb:usdc" }), pay({ sweep_retry_at: now + 1 }), pay({ sweep_retry_at: now }), pay({ status: "partial" })],
      "base", now,
    )!;
    expect(plan.payments).toHaveLength(1);
    expect(plan.payments[0]!.sweep_retry_at).toBe(now);
  });

  it("adds every registry ERC-20 of the chain named in the unexpected map, enabled or not; never native or another chain's", () => {
    const plan = planEvmSweep(
      [pay({ unexpected: { "base:dai": 5n, "base:eth": 1n, "arb:usdc": 9n } }), pay({ asset: "base:eth", unexpected: { "base:usdc": 3n } })],
      "base",
    )!;
    expect(plan.tokens.sort()).toEqual([USDC_BASE, DAI_BASE].sort());
    // base:dai is not enabled (ENABLED_ASSETS), but an unexpected DAI deposit is still flushed
    expect(planEvmSweep([pay({ unexpected: { "base:dai": 5n } })], "base")!.tokens.sort()).toEqual([USDC_BASE, DAI_BASE].sort());
    expect(planEvmSweep([pay({ unexpected: { "base:nope": 5n } })], "base")!.tokens).toEqual([USDC_BASE]); // unknown ids are ignored
  });

  it("sweeps a partial payment only after the watcher gave up on it: invoice expired more than 7 days + 1 hour ago", () => {
    const now = 30 * DAY;
    const W = 7 * DAY + HOUR;
    const partial = (expires: number) => pay({ status: "partial", invoice_expires_at: expires });
    expect(planEvmSweep([partial(now - 7 * DAY - 1)], "base", now)).toBeNull(); // the watcher may still be polling
    expect(planEvmSweep([partial(now - W + 1)], "base", now)).toBeNull();
    expect(planEvmSweep([partial(now - W - 1)], "base", now)!.payments).toHaveLength(1);
    expect(planEvmSweep([pay({ status: "partial" })], "base", now)).toBeNull(); // unknown expiry: not yet
  });

  it("sweeps an expired payment only when it holds unexpected deposits, after the same window", () => {
    const now = 30 * DAY;
    const W = 7 * DAY + HOUR;
    const expired = (o: Partial<PaymentRow>) => pay({ status: "expired", received: 0n, final: 0n, credited_minor: 0n, ...o });
    expect(planEvmSweep([expired({ invoice_expires_at: now - W - 1 })], "base", now)).toBeNull(); // nothing there
    expect(planEvmSweep([expired({ invoice_expires_at: now - W + 1, unexpected: { "base:dai": 1n } })], "base", now)).toBeNull();
    const plan = planEvmSweep([expired({ invoice_expires_at: now - W - 1, unexpected: { "base:dai": 1n } })], "base", now)!;
    expect(plan.payments).toHaveLength(1);
    expect(plan.tokens.sort()).toEqual([USDC_BASE, DAI_BASE].sort());
  });

  it("always includes the payment's own ERC-20 even when its asset has been disabled since", () => {
    const plan = planEvmSweep([pay({ asset: "base:dai" })], "base")!;
    expect(plan.tokens).toEqual([DAI_BASE]);
    // ...and so is an unexpected registry token that is not enabled
    expect(planEvmSweep([pay({ asset: "base:eth", unexpected: { "base:dai": 1n } })], "base")!.tokens).toEqual([DAI_BASE]);
  });

  it("native-only batches have no tokens, and nothing to sweep is null", () => {
    expect(planEvmSweep([pay({ asset: "base:eth" })], "base")!.tokens).toEqual([]);
    expect(planEvmSweep([pay({ status: "confirming" })], "base")).toBeNull();
    expect(planEvmSweep([], "base")).toBeNull();
  });
});

describe("runEvmSweep", () => {

  it("is idle with nothing to sweep", async () => {
    expect(await runEvmSweep(e, "base", now())).toEqual({ status: "idle", paymentIds: [] });
    expect(sw.base.sent).toHaveLength(0);
  });

  it("skips when the forwarder factory is not deployed", async () => {
    await mk();
    rpc.base.code = "0x";
    const r = await runEvmSweep(e, "base", now());
    expect(r.status).toBe("skipped");
    expect(sw.base.sent).toHaveLength(0);
  });

  it("takes the chain's hot nonce lease for its send: held by another sender (a shield, a refund) -> skipped, nothing signed; released after", async () => {
    const { acquireHotNonce, releaseHotNonce } = await import("../../src/db/noncelease");
    await mk();
    expect(await acquireHotNonce(e.DB, "base", "shield_x", now())).toBe(true);
    const r = await runEvmSweep(e, "base", now());
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/hot wallet is sending another transaction/) });
    expect(sw.base.sent).toHaveLength(0);
    expect(sw.base.nonceTags).toEqual([]);
    await releaseHotNonce(e.DB, "base", "shield_x");
    expect((await runEvmSweep(e, "base", now())).status).toBe("sent");
    expect(await e.DB.prepare("SELECT holder FROM hot_nonce_lease WHERE chain='base'").first()).toEqual({ holder: null });
  });

  it("sends deployAndFlush from the hot wallet with a pending nonce and records a pending sweep row before anything else", async () => {
    const a = await mk();
    const b = await mk({ asset: "base:eth" });
    const t = now();
    const r = await runEvmSweep(e, "base", t);
    expect(r.status).toBe("sent");
    expect(r.paymentIds.sort()).toEqual([a.id, b.id].sort());
    expect(sw.base.sent).toHaveLength(1);
    expect(sw.base.nonceTags).toEqual(["pending"]);
    const { tx, salts, tokens } = decodeSent(sw.base.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(factory.toLowerCase());
    expect(tx.nonce).toBe(7);
    expect(tx.chainId).toBe(8453);
    expect(tx.type).toBe("eip1559");
    expect(tx.maxFeePerGas).toBe(21n * GWEI); // 2 x base fee + priority
    expect(tx.maxPriorityFeePerGas).toBe(GWEI);
    expect(salts).toEqual([salt(a.derivation_index), salt(b.derivation_index)]);
    expect(tokens.map((x) => x.toLowerCase())).toEqual([USDC_BASE.toLowerCase()]);
    expect(sw.base.estimated[0]!.from?.toLowerCase()).toBe(hot.toLowerCase());
    expect(await fromOf(sw.base.sent[0]!)).toBe(hot); // the factory only lets its sink sweep
    const rows = await sweeps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain: "base", status: "pending", tx: r.tx, created_at: t });
    expect(r.tx).toBe(keccak256(sw.base.sent[0]!));
    expect(JSON.parse(rows[0]!.payment_ids as string).sort()).toEqual([a.id, b.id].sort());
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull(); // only marked once finalized
  });

  it("sweeps an unswept partial payment only once its invoice expired more than 7 days + 1 hour ago", async () => {
    const recent = await mk({ status: "partial", invoice_id: "inv_sweep_recent" });
    expect(await runEvmSweep(e, "base", now())).toEqual({ status: "idle", paymentIds: [] });
    const old = await mk({ status: "partial", invoice_id: "inv_sweep_old" });
    const r = await runEvmSweep(e, "base", now());
    expect(r.paymentIds).toEqual([old.id]);
    expect(r.paymentIds).not.toContain(recent.id);
  });

  it("sweeps an expired payment holding an unexpected deposit (a token that is not enabled) once past the window", async () => {
    await mk({ status: "expired", invoice_id: "inv_sweep_recent", received: 0n, final: 0n, credited_minor: 0n, unexpected: { "base:dai": 5n } });
    await mk({ status: "expired", invoice_id: "inv_sweep_old", received: 0n, final: 0n, credited_minor: 0n }); // nothing to move
    expect(await runEvmSweep(e, "base", now())).toEqual({ status: "idle", paymentIds: [] });
    const p = await mk({ status: "expired", invoice_id: "inv_sweep_old", received: 0n, final: 0n, credited_minor: 0n, unexpected: { "base:dai": 5n } });
    const r = await runEvmSweep(e, "base", now());
    expect(r).toMatchObject({ status: "sent", paymentIds: [p.id] });
    expect(decodeSent(sw.base.sent[0]!).tokens.map((x) => x.toLowerCase()).sort()).toEqual([USDC_BASE, DAI_BASE].map((x) => x.toLowerCase()).sort());
  });

  it("still flushes the token of a payment whose asset was disabled after confirmation", async () => {
    await mk({ asset: "base:dai" }); // base:dai is not in ENABLED_ASSETS
    const r = await runEvmSweep(e, "base", now());
    expect(r.status).toBe("sent");
    expect(decodeSent(sw.base.sent[0]!).tokens.map((x) => x.toLowerCase())).toEqual([DAI_BASE.toLowerCase()]);
  });

  it("on Polygon a sweep is final only at min(finalized, head - 64)", async () => {
    const a = await mk({ chain: "polygon", asset: "polygon:usdc" });
    const t = now();
    const sent = await runEvmSweep(e, "polygon", t);
    expect(sent.status).toBe("sent");
    rpc.polygon.head = 1000n;
    rpc.polygon.finalizedNumber = 990n; // target = min(990, 936) = 936
    sw.polygon.receipts[sent.tx!.toLowerCase()] = { status: "success", block: 950n };
    await runEvmSweep(e, "polygon", t + 60_000);
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull();
    sw.polygon.receipts[sent.tx!.toLowerCase()] = { status: "success", block: 936n };
    await runEvmSweep(e, "polygon", t + 120_000);
    expect((await getPayment(e.DB, a.id))!.swept_at).not.toBeNull();
  });

  it("a pending sweep row blocks a second send", async () => {
    await mk();
    expect((await runEvmSweep(e, "base", now())).status).toBe("sent");
    await mk();
    const r = await runEvmSweep(e, "base", now() + 1000);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/pending/);
    expect(sw.base.sent).toHaveLength(1);
  });

  it("marks payments swept once the receipt is successful and at or below the finalized block", async () => {
    const a = await mk();
    const t = now();
    const sent = await runEvmSweep(e, "base", t);
    rpc.base.finalizedNumber = 900n;
    sw.base.receipts[sent.tx!.toLowerCase()] = { status: "success", block: 901n }; // above finalized: not yet
    expect((await runEvmSweep(e, "base", t + 60_000)).status).toBe("skipped");
    expect((await sweeps())[0]!.status).toBe("pending");
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull();

    sw.base.receipts[sent.tx!.toLowerCase()] = { status: "success", block: 900n };
    const later = t + 120_000;
    expect(await runEvmSweep(e, "base", later)).toEqual({ status: "idle", paymentIds: [] });
    const p = (await getPayment(e.DB, a.id))!;
    expect(p.swept_at).toBe(later);
    expect(p.sweep_tx).toBe(sent.tx);
    expect((await sweeps())[0]).toMatchObject({ status: "confirmed" });
    expect(sw.base.sent).toHaveLength(1); // nothing left to send
  });

  it("a reverted receipt marks the sweep failed and leaves the payments unswept", async () => {
    const a = await mk();
    const sent = await runEvmSweep(e, "base", now());
    sw.base.receipts[sent.tx!.toLowerCase()] = { status: "reverted", block: 800n };
    const r = await runEvmSweep(e, "base", now() + 60_000);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "reverted" });
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull();
    expect(r.status).toBe("sent"); // the payment is still due: it goes out again
    expect(sw.base.sent).toHaveLength(2);
  });

  it("a tx with no receipt stays pending (and unchanged) for an hour", async () => {
    await mk();
    const t = now();
    await runEvmSweep(e, "base", t);
    expect((await runEvmSweep(e, "base", t + 59 * 60_000)).status).toBe("skipped");
    expect((await sweeps())[0]).toMatchObject({ status: "pending" });
    expect(sw.base.sent).toHaveLength(1);
  });

  it("after an hour unmined, replaces the tx at the same nonce with fees x1.3 and keeps the row pending", async () => {
    const a = await mk();
    const t = now();
    const first = await runEvmSweep(e, "base", t);
    const r = await runEvmSweep(e, "base", t + HOUR + 1000);
    expect(r.status).toBe("skipped");
    expect(sw.base.sent).toHaveLength(2);
    const [x, y] = sw.base.sent.map((raw) => parseTransaction(raw));
    expect(y!.nonce).toBe(x!.nonce);
    expect(y!.maxFeePerGas).toBe((x!.maxFeePerGas! * 13n) / 10n);
    expect(y!.maxPriorityFeePerGas).toBe((x!.maxPriorityFeePerGas! * 13n) / 10n);
    expect(y!.data).toBe(x!.data);
    expect(await fromOf(sw.base.sent[1]!)).toBe(hot);
    const rows = await sweeps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", nonce: 7 });
    const second = keccak256(sw.base.sent[1]!);
    expect(JSON.parse(rows[0]!.txs as string)).toEqual([first.tx, second]);
    expect(rows[0]!.tx).toBe(second);
    // not again within the hour
    await runEvmSweep(e, "base", t + HOUR + 60_000);
    expect(sw.base.sent).toHaveLength(2);
    // the ORIGINAL mining first still settles the row
    rpc.base.finalizedNumber = 900n;
    sw.base.receipts[first.tx!.toLowerCase()] = { status: "success", block: 800n };
    await runEvmSweep(e, "base", t + 2 * HOUR);
    expect((await sweeps())[0]).toMatchObject({ status: "confirmed" });
    expect((await getPayment(e.DB, a.id))!.sweep_tx).toBe(first.tx);
  });

  it("is dropped (failed, with a sweep.failing alert) only when the nonce was consumed by something else", async () => {
    const a = await mk();
    const t = now();
    await runEvmSweep(e, "base", t);
    sw.base.latestNonce = 8; // our nonce 7 was used by another tx, and no receipt of ours exists
    const r = await runEvmSweep(e, "base", t + HOUR + 1000);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "dropped" });
    expect((await alerts()).map((x) => x.kind)).toContain("sweep.failing");
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull();
    expect(r.status).toBe("sent"); // retried with a new tx
    expect(await sweeps()).toHaveLength(2);
  });

  it("does not drop a sweep while the node still knows any of its tx hashes", async () => {
    await mk();
    const t = now();
    const first = await runEvmSweep(e, "base", t);
    sw.base.latestNonce = 8; // nonce consumed, no receipt...
    sw.base.knownTxs.push(first.tx!.toLowerCase()); // ...but the node still has our tx
    expect((await runEvmSweep(e, "base", t + HOUR + 1000)).status).toBe("skipped");
    expect((await sweeps())[0]).toMatchObject({ status: "pending" });
    expect(sw.base.sent).toHaveLength(1); // not replaced either
    sw.base.knownTxs.length = 0;
    await runEvmSweep(e, "base", t + HOUR + 2000);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "dropped" });
  });

  it("does not drop a tx whose nonce is consumed when one of our hashes has a receipt", async () => {
    const a = await mk();
    const t = now();
    const first = await runEvmSweep(e, "base", t);
    sw.base.latestNonce = 8;
    sw.base.receipts[first.tx!.toLowerCase()] = { status: "success", block: 800n };
    rpc.base.finalizedNumber = 900n;
    await runEvmSweep(e, "base", t + HOUR + 1000);
    expect((await sweeps())[0]).toMatchObject({ status: "confirmed" });
    expect((await getPayment(e.DB, a.id))!.swept_at).not.toBeNull();
  });

  it("treats 'already known' on broadcast as sent when the node knows our hash", async () => {
    await mk();
    sw.base.sendError = "known";
    const r = await runEvmSweep(e, "base", now());
    expect(r.status).toBe("sent");
    expect((await sweeps())[0]).toMatchObject({ status: "pending", tx: r.tx });
  });

  it("a broadcast 'insufficient funds' raises sweep.insufficient_gas", async () => {
    await mk();
    sw.base.sendError = "funds";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await runEvmSweep(e, "base", now())).status).toBe("failed");
    expect((await alerts())[0]).toMatchObject({ kind: "sweep.insufficient_gas" });
    warn.mockRestore();
  });

  it("three consecutive failed sweeps raise sweep.failing", async () => {
    await mk();
    const t = now();
    for (let i = 0; i < 3; i++) {
      sw.base.sendError = true; // each attempt fails at broadcast
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await runEvmSweep(e, "base", t + i * 1000)).status).toBe("failed");
      warn.mockRestore();
      expect((await alerts()).some((x) => x.kind === "sweep.failing")).toBe(i === 2);
    }
  });

  it("a sweep and a recovery (or two sweeps) racing on one chain broadcast exactly one tx and leave one pending row", async () => {
    const a = await mk();
    await Promise.all([runEvmSweep(e, "base", now()), runEvmSweep(e, "base", now())]);
    expect(sw.base.sent).toHaveLength(1);
    expect((await sweeps()).filter((r) => r.status === "pending")).toHaveLength(1);
    for (const t of ["sweeps"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
    sw.base.sent.length = 0;
    const b = await mk({ chain: "arb", asset: "arb:usdc" });
    await Promise.all([runEvmSweep(e, "arb", now()), recoverDeposit(e, a, "arb", now())]);
    expect(sw.arb.sent).toHaveLength(1);
    expect((await sweeps()).filter((r) => r.status === "pending" && r.chain === "arb")).toHaveLength(1);
    void b;
  });

  describe("sweep lock", () => {
    // What a watcher poll does once the swept address reads 0.
    const poll = async (id: string) => {
      const p = (await getPayment(e.DB, id))!;
      return step({
        invoice: (await getInvoice(e.DB, p.invoice_id))!, payment: p, others: [], now: Date.now(),
        obs: { received: 0n, final: 0n, txids: [] }, currentPriceE8: async () => 10n ** 8n,
      });
    };
    const partial = async () => {
      await e.DB.prepare("UPDATE invoices SET paid_minor='40', status='partially_paid' WHERE id='inv_sweep_old'").run();
      return mk({ status: "partial", invoice_id: "inv_sweep_old", received: 400_000n, final: 400_000n, credited_minor: 40n, detected_at: Date.now() - HOUR });
    };

    it("a sweep writes sweep_tx with the pending row, so a 0 balance before reconcile changes nothing", async () => {
      const p = await partial();
      expect(await poll(p.id)).not.toBeNull(); // unlocked: the observation is followed
      const r = await runEvmSweep(e, "base", now());
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(r.tx);
      expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
      expect(await poll(p.id)).toBeNull();
    });

    it("an own-chain recovery of a partial payment keeps its credit", async () => {
      const p = await partial();
      const r = await recoverDeposit(e, p, "base", now());
      expect(r.status).toBe("sent");
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(r.tx);
      expect(await poll(p.id)).toBeNull();
    });

    it("a recovery on another chain does not lock the payment", async () => {
      const p = await partial();
      await recoverDeposit(e, p, "arb", now());
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
    });

    it("a sweep that is not recorded (another one holds the chain) leaves no lock", async () => {
      await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids) VALUES('swp_other','base','0x1',?,'pending','[]')").bind(now()).run();
      const p = await partial();
      await runEvmSweep(e, "base", now() + 1000); // blocked by the pending row
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
    });

    it("a failed broadcast clears the lock", async () => {
      const p = await partial();
      sw.base.sendError = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await runEvmSweep(e, "base", now());
      warn.mockRestore();
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
    });

    it("a dropped sweep clears the lock (the re-send is blocked, so only the dropped path can clear it)", async () => {
      const p = await partial();
      const t = now();
      const sent = await runEvmSweep(e, "base", t);
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(sent.tx);
      sw.base.latestNonce = 8;
      await e.DB.prepare("UPDATE payments SET sweep_retry_at=? WHERE id=?").bind(t + 10 * DAY, p.id).run(); // nothing is due: no re-send
      expect((await runEvmSweep(e, "base", t + HOUR + 1000)).status).toBe("idle");
      expect(sw.base.sent).toHaveLength(1);
      expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
      expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "dropped" });
    });
  });

  describe("bounded replacements", () => {
    const stuck = async () => {
      await mk();
      const t = now();
      await runEvmSweep(e, "base", t);
      return t;
    };
    it("replaces at most 3 times, then raises sweep.failing and stays pending", async () => {
      const t = await stuck();
      for (let i = 1; i <= 5; i++) await runEvmSweep(e, "base", t + i * (HOUR + 1000));
      expect(sw.base.sent).toHaveLength(4); // the original + 3 replacements
      expect((await sweeps())[0]).toMatchObject({ status: "pending" });
      expect((await alerts()).map((a) => a.kind)).toContain("sweep.failing");
      expect(JSON.parse((await sweeps())[0]!.txs as string)).toHaveLength(4);
    });
    it("a failed replacement broadcast raises sweep.failing and keeps the row pending", async () => {
      const t = await stuck();
      sw.base.sendError = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await runEvmSweep(e, "base", t + HOUR + 1000);
      warn.mockRestore();
      expect((await alerts()).map((a) => a.kind)).toContain("sweep.failing");
      expect((await sweeps())[0]).toMatchObject({ status: "pending" });
    });
    it("broadcasts a replacement only if the row was still pending when it was recorded", async () => {
      const t = await stuck();
      // the row is failed (by an admin, say) while the replacement is being prepared
      network.use(
        http.post(URL_OF.base, async ({ request }) => {
          const { method } = (await request.clone().json()) as { method: string };
          if (method === "eth_getBalance") await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
          return undefined;
        }),
      );
      await e.DB.prepare("UPDATE payments SET sweep_retry_at=?").bind(t + 10 * DAY).run(); // no fresh sweep either
      await runEvmSweep(e, "base", t + HOUR + 1000);
      expect(sw.base.sent).toHaveLength(1);
      expect((await sweeps())[0]).toMatchObject({ status: "failed" });
    });
    it("does not replace when the hot wallet can no longer pay for it", async () => {
      const t = await stuck();
      rpc.base.latest = { native: {} };
      await runEvmSweep(e, "base", t + HOUR + 1000);
      expect(sw.base.sent).toHaveLength(1);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.insufficient_gas" });
      expect((await sweeps())[0]).toMatchObject({ status: "pending" });
    });
    it("on mainnet does not replace when the 5% rule fails against a fresh quote", async () => {
      await mk({ chain: "eth", asset: "eth:usdc", credited_minor: 50_000n, confirmed_at: Date.now() - DAY });
      const t = now();
      expect((await runEvmSweep(e, "eth", t)).status).toBe("sent");
      await putPrice(e, "USD", "ETH", 100_000n * 10n ** 8n);
      await runEvmSweep(e, "eth", t + HOUR + 1000);
      expect(sw.eth.sent).toHaveLength(1);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.too_expensive", chain: "eth" });
    });
    it("fails a pending row that has no nonce or request data after an hour", async () => {
      const t = now();
      await e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids) VALUES('swp_legacy','base',?,?,'pending','[]')").bind(`0x${"ab".repeat(32)}`, t).run();
      expect((await runEvmSweep(e, "base", t + 30 * 60_000)).status).toBe("skipped");
      expect((await runEvmSweep(e, "base", t + HOUR + 1000)).status).toBe("idle");
      expect((await sweeps())[0]).toMatchObject({ status: "failed" });
    });
  });

  it("errText includes the top-level message, so a unique-index error is recognised", () => {
    expect(errText(new Error("D1_ERROR: UNIQUE constraint failed: sweeps.chain: SQLITE_CONSTRAINT"))).toMatch(/unique/i);
  });

  it("the schema allows only one pending sweep per chain", async () => {
    const ins = (id: string) => e.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids) VALUES(?,?,?,?,?,?)").bind(id, "base", "0x1", 1, "pending", "[]").run();
    await ins("swp_a");
    await expect(ins("swp_b")).rejects.toThrow();
  });

  it("records sweep.insufficient_gas and changes nothing when the hot wallet cannot pay for the tx", async () => {
    const a = await mk();
    rpc.base.latest = { native: {} }; // eth_getBalance = 0
    const r = await runEvmSweep(e, "base", now());
    expect(r).toMatchObject({ status: "skipped", paymentIds: [] });
    expect(sw.base.sent).toHaveLength(0);
    expect(await sweeps()).toHaveLength(0);
    const al = await alerts();
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "sweep.insufficient_gas", chain: "base", resolved_at: null });
    const p = (await getPayment(e.DB, a.id))!;
    expect([p.swept_at, p.sweep_error, p.sweep_retry_at]).toEqual([null, null, null]);
  });

  it("the gas check is gas x maxFeePerGas x 1.2 against the balance", async () => {
    await mk();
    const cost = (100_000n * 21n * GWEI * 12n) / 10n;
    rpc.base.latest = { native: { [hot.toLowerCase()]: cost - 1n } };
    expect((await runEvmSweep(e, "base", now())).status).toBe("skipped");
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    rpc.base.latest = { native: { [hot.toLowerCase()]: cost } };
    expect((await runEvmSweep(e, "base", now())).status).toBe("sent");
  });

  it("dedupes alerts: none while an unresolved one of the same kind and chain is under 6 hours old", async () => {
    const db = e.DB;
    const t = Date.now();
    expect(await recordAlert(db, "sweep.insufficient_gas", "base", "a", t)).toBe(true);
    expect(await recordAlert(db, "sweep.insufficient_gas", "base", "b", t + 5 * HOUR)).toBe(false);
    expect(await recordAlert(db, "sweep.insufficient_gas", "arb", "c", t + 5 * HOUR)).toBe(true); // other chain
    expect(await recordAlert(db, "sweep.payment_failed", "base", "d", t + 5 * HOUR)).toBe(true); // other kind
    expect(await recordAlert(db, "sweep.insufficient_gas", "base", "e", t + 6 * HOUR + 1)).toBe(true); // old enough
    await db.prepare("UPDATE alerts SET resolved_at=? WHERE kind='sweep.payment_failed'").bind(t).run();
    expect(await recordAlert(db, "sweep.payment_failed", "base", "f", t + 5 * HOUR)).toBe(true); // resolved: a new one may follow
    expect((await alerts()).length).toBe(5);
  });

  it("runs of the sweeper do not pile up insufficient_gas alerts", async () => {
    await mk();
    rpc.base.latest = { native: {} };
    await runEvmSweep(e, "base", now());
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    await runEvmSweep(e, "base", now() + 15 * 60_000);
    expect(await alerts()).toHaveLength(1);
  });

  describe("estimation reverts", () => {
    it("splits the batch: the healthy payments are swept; the blocked one is left alone this run, and parked once it is probed alone", async () => {
      const good1 = await mk();
      const bad = await mk();
      const good2 = await mk();
      const badSalt = salt(bad.derivation_index);
      sw.base.estimate = (salts) => (salts.includes(badSalt) ? "revert" : 100_000n);
      const t = now();
      const r = await runEvmSweep(e, "base", t);
      expect(r.status).toBe("sent");
      expect(r.paymentIds.sort()).toEqual([good1.id, good2.id].sort());
      const { salts } = decodeSent(sw.base.sent[0]!);
      expect(salts).toEqual([salt(good1.derivation_index), salt(good2.derivation_index)]);
      expect((await getPayment(e.DB, bad.id))!.sweep_error).toBeNull();
      expect(await alerts()).toHaveLength(0);
      expect(JSON.parse((await sweeps())[0]!.payment_ids as string).sort()).toEqual([good1.id, good2.id].sort());
      // once the good ones are settled, the blocked one is the whole batch: it fails with the 24h retry and an alert
      rpc.base.finalizedNumber = 900n;
      sw.base.receipts[r.tx!.toLowerCase()] = { status: "success", block: 890n };
      const r2 = await runEvmSweep(e, "base", t + 60_000);
      expect(r2).toMatchObject({ status: "failed", paymentIds: [bad.id] });
      const b = (await getPayment(e.DB, bad.id))!;
      expect(b.sweep_error!.length).toBeLessThanOrEqual(120);
      expect(b.sweep_retry_at).toBe(t + 60_000 + DAY);
      const al = await alerts();
      expect(al).toHaveLength(1);
      expect(al[0]).toMatchObject({ kind: "sweep.payment_failed", chain: "base" });
      expect(al[0]!.detail).toContain(bad.id);
    });

    it("a lone payment that reverts is failed, not sent; it is retried after 24 hours", async () => {
      const bad = await mk();
      sw.base.estimate = () => "revert";
      const t = now();
      const r = await runEvmSweep(e, "base", t);
      expect(r).toMatchObject({ status: "failed", paymentIds: [bad.id] });
      expect(sw.base.sent).toHaveLength(0);
      expect(await sweeps()).toHaveLength(0);
      expect((await getPayment(e.DB, bad.id))!.sweep_retry_at).toBe(t + DAY);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.payment_failed" });
      // before the retry time it is not even tried; after it, it is
      sw.base.estimated.length = 0;
      expect((await runEvmSweep(e, "base", t + HOUR)).status).toBe("idle");
      expect(sw.base.estimated).toHaveLength(0);
      sw.base.estimate = () => 100_000n;
      expect((await runEvmSweep(e, "base", t + DAY + 1)).status).toBe("sent");
    });

    it("falls back to the own token only when an unexpected token blocks the flush; after reconcile swept_at and unexpected_left are set", async () => {
      const blocked = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 5_000_000n } });
      sw.arb.estimate = (_s, tokens) => (tokens.some((x) => x.toLowerCase() === USDT_ARB.toLowerCase()) ? "revert" : 100_000n);
      const t = now();
      const r = await runEvmSweep(e, "arb", t);
      expect(r).toMatchObject({ status: "sent", paymentIds: [blocked.id] });
      expect(sw.arb.sent).toHaveLength(1);
      expect(decodeSent(sw.arb.sent[0]!).tokens.map((x) => x.toLowerCase())).toEqual([USDC_ARB.toLowerCase()]);
      expect(await alerts()).toHaveLength(0);
      expect((await getPayment(e.DB, blocked.id))!.sweep_error).toBeNull();
      rpc.arb.finalizedNumber = 900n;
      sw.arb.receipts[r.tx!.toLowerCase()] = { status: "success", block: 890n };
      await runEvmSweep(e, "arb", t + 60_000);
      const after = (await getPayment(e.DB, blocked.id))!;
      expect(after.swept_at).toBe(t + 60_000);
      expect(after.unexpected_left).toBe(1);
    });

    it("a normal full-token sweep leaves unexpected_left at 0", async () => {
      const ok = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 5_000_000n } });
      const t = now();
      const r = await runEvmSweep(e, "arb", t);
      expect(decodeSent(sw.arb.sent[0]!).tokens).toHaveLength(2);
      rpc.arb.finalizedNumber = 900n;
      sw.arb.receipts[r.tx!.toLowerCase()] = { status: "success", block: 890n };
      await runEvmSweep(e, "arb", t + 60_000);
      const after = (await getPayment(e.DB, ok.id))!;
      expect(after.swept_at).not.toBeNull();
      expect(after.unexpected_left).toBe(0);
    });

    it("in a batch the healthy payments go first, then each fallback payment in its own tx", async () => {
      const good = await mk({ chain: "arb", asset: "arb:usdc" });
      const f1 = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      const f2 = await mk({ chain: "arb", asset: "arb:eth", unexpected: { "arb:usdt": 1n } });
      sw.arb.estimate = (_s, tokens) => (tokens.some((x) => x.toLowerCase() === USDT_ARB.toLowerCase()) ? "revert" : 100_000n);
      const t = now();
      const r1 = await runEvmSweep(e, "arb", t);
      expect(r1.paymentIds).toEqual([good.id]);
      rpc.arb.finalizedNumber = 900n;
      sw.arb.receipts[r1.tx!.toLowerCase()] = { status: "success", block: 890n };
      const r2 = await runEvmSweep(e, "arb", t + 60_000); // settles the first, sends the next
      expect(r2.paymentIds).toEqual([f1.id]);
      sw.arb.receipts[r2.tx!.toLowerCase()] = { status: "success", block: 890n };
      const r3 = await runEvmSweep(e, "arb", t + 120_000);
      expect(r3.paymentIds).toEqual([f2.id]);
      expect(decodeSent(sw.arb.sent[2]!).tokens).toEqual([]); // native payment: own token list is empty
      expect((await getPayment(e.DB, f1.id))!.unexpected_left).toBe(1);
      sw.arb.receipts[r3.tx!.toLowerCase()] = { status: "success", block: 890n };
      await runEvmSweep(e, "arb", t + 180_000);
      expect((await getPayment(e.DB, f2.id))!.unexpected_left).toBe(1); // native payment: only native was flushed
    });

    const blockUsdt = (_s: Hex[], tokens: Address[]) => (tokens.some((x) => x.toLowerCase() === USDT_ARB.toLowerCase()) ? ("revert" as const) : 100_000n);

    it("a mixed batch runs no own-token probes: batch + one estimate per payment + the good batch", async () => {
      await mk({ chain: "arb", asset: "arb:usdc" });
      await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      sw.arb.estimate = blockUsdt;
      const r = await runEvmSweep(e, "arb", now());
      expect(r.status).toBe("sent");
      expect(sw.arb.estimated).toHaveLength(1 + 3 + 1);
      expect(sw.arb.estimated.filter((x) => x.tokens.length === 1)).toHaveLength(1 + 1); // the good payment alone and the good batch; no probe of the blocked
      expect(await alerts()).toHaveLength(0); // unprobed blocked payments are not parked
    });

    describe("starvation guard", () => {
      const old = () => ({ chain: "arb" as const, asset: "arb:usdc" as const, unexpected: { "arb:usdt": 1n }, confirmed_at: now() - 2 * DAY });
      it("a blocked payment older than 24h whose own-token list works is swept alone; the healthy batch waits", async () => {
        const good = await mk({ chain: "arb", asset: "arb:usdc" });
        const stuck = await mk(old());
        sw.arb.estimate = blockUsdt;
        const r = await runEvmSweep(e, "arb", now());
        expect(r).toMatchObject({ status: "sent", paymentIds: [stuck.id] });
        expect(decodeSent(sw.arb.sent[0]!).tokens.map((x) => x.toLowerCase())).toEqual([USDC_ARB.toLowerCase()]);
        expect(sw.arb.estimated).toHaveLength(1 + 2 + 1); // batch, each full list, the one probe
        expect(good.id).toBeTruthy();
      });
      it("if its own-token list also reverts it is parked with an alert and the healthy batch is swept in the same run", async () => {
        const good = await mk({ chain: "arb", asset: "arb:usdc" });
        const stuck = await mk(old());
        sw.arb.estimate = (_s, tokens) => (tokens.some((x) => x.toLowerCase() === USDT_ARB.toLowerCase()) || tokens.length === 1 && sw.arb.estimated.length === 4 ? "revert" : 100_000n);
        const t = now();
        const r = await runEvmSweep(e, "arb", t);
        expect(r).toMatchObject({ status: "sent", paymentIds: [good.id] });
        expect((await getPayment(e.DB, stuck.id))!.sweep_retry_at).toBe(t + DAY);
        expect((await alerts())[0]).toMatchObject({ kind: "sweep.payment_failed" });
        expect(sw.arb.estimated).toHaveLength(1 + 2 + 1 + 1);
      });
      it("a blocked payment younger than 24h is not probed", async () => {
        await mk({ chain: "arb", asset: "arb:usdc" });
        await mk({ ...old(), confirmed_at: now() - 2 * HOUR });
        sw.arb.estimate = blockUsdt;
        const r = await runEvmSweep(e, "arb", now());
        expect(r.status).toBe("sent");
        expect(sw.arb.estimated).toHaveLength(1 + 2 + 1);
        expect(await alerts()).toHaveLength(0);
      });
    });

    it("an all-blocked batch probes one payment at a time and stops at the first success", async () => {
      const a = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      sw.arb.estimate = blockUsdt;
      const r = await runEvmSweep(e, "arb", now());
      expect(r.paymentIds).toEqual([a.id]);
      expect(sw.arb.estimated).toHaveLength(1 + 3 + 1); // batch, each full list, one probe
      expect(await alerts()).toHaveLength(0);
    });

    it("a fee-bumped fallback tx still ends with unexpected_left = 1 after reconcile", async () => {
      const p = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 1n } });
      sw.arb.estimate = blockUsdt;
      const t = now();
      const first = await runEvmSweep(e, "arb", t);
      await runEvmSweep(e, "arb", t + HOUR + 1000);
      expect(sw.arb.sent).toHaveLength(2);
      rpc.arb.finalizedNumber = 900n;
      sw.arb.receipts[keccak256(sw.arb.sent[1]!).toLowerCase()] = { status: "success", block: 800n };
      await runEvmSweep(e, "arb", t + 2 * HOUR);
      expect(first.status).toBe("sent");
      expect((await getPayment(e.DB, p.id))!.unexpected_left).toBe(1);
    });

    it("keeps sweep_error, the 24h retry and the alert when even the own-token estimate reverts", async () => {
      const bad = await mk({ chain: "arb", asset: "arb:usdc", unexpected: { "arb:usdt": 5_000_000n } });
      sw.arb.estimate = () => "revert";
      const t = now();
      const r = await runEvmSweep(e, "arb", t);
      expect(r).toMatchObject({ status: "failed", paymentIds: [bad.id] });
      expect(sw.arb.sent).toHaveLength(0);
      const b = (await getPayment(e.DB, bad.id))!;
      expect(b.sweep_error).toBeTruthy();
      expect(b.sweep_retry_at).toBe(t + DAY);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.payment_failed", chain: "arb" });
      expect(sw.arb.estimated.map((x) => x.tokens.length)).toContain(1); // the own-token retry was tried
    });

    it("an RPC outage during estimation is not a revert: nothing is marked failed", async () => {
      const a = await mk();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      sw.base.estimate = () => "error";
      await expect(runEvmSweep(e, "base", now())).rejects.toBeDefined();
      expect(await alerts()).toHaveLength(0);
      expect((await getPayment(e.DB, a.id))!.sweep_retry_at).toBeNull();
      warn.mockRestore();
    });
  });

  describe("Ethereum mainnet economy rule", () => {
    const ethPay = (o: Partial<PaymentRow> = {}) => mk({ chain: "eth", asset: "eth:usdc", ...o });
    it("does not sweep a $100 batch that is one day old", async () => {
      await ethPay({ credited_minor: 10_000n, confirmed_at: Date.now() - DAY });
      const r = await runEvmSweep(e, "eth", now());
      expect(r.status).toBe("idle");
      expect(sw.eth.sent).toHaveLength(0);
      expect(sw.eth.estimated).toHaveLength(0);
    });
    it("sweeps once the batch is worth $500 (summed)", async () => {
      await ethPay({ credited_minor: 30_000n, confirmed_at: Date.now() - DAY });
      await ethPay({ credited_minor: 20_000n, confirmed_at: Date.now() - DAY });
      expect((await runEvmSweep(e, "eth", now())).status).toBe("sent");
      expect(parseTransaction(sw.eth.sent[0]!).chainId).toBe(1);
    });
    it("stays below at $499.99", async () => {
      await ethPay({ credited_minor: 49_999n, confirmed_at: Date.now() - DAY });
      expect((await runEvmSweep(e, "eth", now())).status).toBe("idle");
    });
    it("sweeps a small batch whose oldest payment was confirmed more than 7 days ago", async () => {
      await ethPay({ credited_minor: 30_000n, confirmed_at: Date.now() - 8 * DAY });
      expect((await runEvmSweep(e, "eth", now())).status).toBe("sent");
    });
    it("skips with a sweep.too_expensive alert when the gas costs more than 5% of the batch", async () => {
      await ethPay({ credited_minor: 50_000n, confirmed_at: Date.now() - DAY });
      sw.eth.estimate = () => 1_000_000n; // 1.2M gas x 21 gwei x $2000 = ~$50 > 5% of $500
      const r = await runEvmSweep(e, "eth", now());
      expect(r.status).toBe("skipped");
      expect(sw.eth.sent).toHaveLength(0);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.too_expensive", chain: "eth" });
    });
    it("does not sweep on mainnet without a native price, and says so in an alert", async () => {
      await dropPrice(e, "USD", "ETH");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await ethPay({ credited_minor: 50_000n, confirmed_at: Date.now() - DAY });
      expect((await runEvmSweep(e, "eth", now())).status).toBe("skipped");
      expect(sw.eth.sent).toHaveLength(0);
      expect((await alerts())[0]).toMatchObject({ kind: "sweep.too_expensive" });
      warn.mockRestore();
    });
    it("other chains sweep any batch", async () => {
      await mk({ credited_minor: 1n });
      expect((await runEvmSweep(e, "base", now())).status).toBe("sent");
    });
  });

  describe("BSC", () => {
    it("sends a legacy transaction priced from eth_gasPrice and checks the balance against it", async () => {
      const a = await mk({ chain: "bsc", asset: "bsc:usdc" });
      sw.bsc.gasPrice = 3n * GWEI;
      const price = 3n * GWEI;
      const cost = (100_000n * price * 12n) / 10n;
      rpc.bsc.latest = { native: { [hot.toLowerCase()]: cost - 1n } };
      expect((await runEvmSweep(e, "bsc", now())).status).toBe("skipped");
      await e.KV.delete("evm:health:bsc");
      clearHealthMemo();
      rpc.bsc.latest = { native: { [hot.toLowerCase()]: cost } };
      const r = await runEvmSweep(e, "bsc", now());
      expect(r).toMatchObject({ status: "sent", paymentIds: [a.id] });
      const { tx, tokens } = decodeSent(sw.bsc.sent[0]!);
      expect(tx.type).toBe("legacy");
      expect(tx.gasPrice).toBe(price);
      expect(tx.chainId).toBe(56);
      expect(await fromOf(sw.bsc.sent[0]!)).toBe(hot);
      expect(tokens.map((x) => x.toLowerCase())).toEqual([getAsset("bsc:usdc").contract!.toLowerCase()]);
    });
  });

  it("a failed broadcast leaves no pending row behind", async () => {
    const a = await mk();
    sw.base.sendError = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runEvmSweep(e, "base", now());
    expect(r.status).toBe("failed");
    expect((await sweeps())[0]).toMatchObject({ status: "failed" });
    expect((await getPayment(e.DB, a.id))!.swept_at).toBeNull();
    sw.base.sendError = false;
    expect((await runEvmSweep(e, "base", now() + 1000)).status).toBe("sent"); // not blocked
    warn.mockRestore();
  });
});

describe("chain id per RPC URL in the sweeper", () => {
  it("a fallback URL that reports another chain is never used for a nonce read (nothing is sent)", async () => {
    const WRONG = "https://imposter.test/rpc";
    const wrong: string[] = [];
    network.use(
      // The real node fails the nonce read, so a fallback would normally answer it.
      http.post(URL_OF.base, async ({ request }) => {
        const { method } = (await request.clone().json()) as { method: string };
        return method === "eth_getTransactionCount" ? new Response(null, { status: 500 }) : undefined;
      }),
      http.post(WRONG, async ({ request }) => {
        const { id, method } = (await request.json()) as { id: number; method: string };
        wrong.push(method);
        return Response.json({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? "0x1" : "0x0" });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = e.EVM_RPC_BASE;
    e.EVM_RPC_BASE = `${URL_OF.base},${WRONG}`;
    try {
      await mk();
      await expect(runEvmSweep(e, "base", now())).rejects.toThrow();
      expect(wrong).toEqual(["eth_chainId"]);
      expect(sw.base.sent).toHaveLength(0);
    } finally {
      e.EVM_RPC_BASE = saved;
      warn.mockRestore();
    }
  });
});

describe("recoverDeposit", () => {
  it("sends the payment's salt with every registry token of the chosen chain (enabled or not), from the hot wallet on that chain", async () => {
    // the customer paid the base address's twin on arb
    const p = await mk({ derivation_index: 41, status: "partial", chain: "base", asset: "base:usdc" });
    const t = now();
    const r = await recoverDeposit(e, p, "arb", t);
    expect(r.status).toBe("sent");
    expect(r.paymentIds).toEqual([p.id]);
    expect(sw.base.sent).toHaveLength(0);
    expect(sw.arb.sent).toHaveLength(1);
    const { tx, salts, tokens } = decodeSent(sw.arb.sent[0]!);
    expect(tx.chainId).toBe(42161);
    expect(tx.to?.toLowerCase()).toBe(factory.toLowerCase());
    expect(await fromOf(sw.arb.sent[0]!)).toBe(hot); // recovery sends from the sink too
    expect(sw.arb.estimated[0]!.from?.toLowerCase()).toBe(hot.toLowerCase());
    expect(salts).toEqual([salt(41)]);
    // arb:dai is not enabled, but recovery flushes every registry token of the chain
    expect(tokens.map((x) => x.toLowerCase()).sort()).toEqual([USDC_ARB, USDT_ARB, DAI_ARB].map((x) => x.toLowerCase()).sort());
    const rows = await sweeps();
    expect(rows[0]).toMatchObject({ chain: "arb", status: "pending", tx: r.tx });
    expect(rows[0]!.id).toMatch(/^rec_/);
    expect(JSON.parse(rows[0]!.payment_ids as string)).toEqual([p.id]);
    // confirming it never marks the payment swept
    rpc.arb.finalizedNumber = 900n;
    sw.arb.receipts[r.tx!.toLowerCase()] = { status: "success", block: 800n };
    await runEvmSweep(e, "arb", t + 60_000);
    expect((await sweeps())[0]).toMatchObject({ status: "confirmed" });
    const after = (await getPayment(e.DB, p.id))!;
    expect([after.swept_at, after.sweep_tx]).toEqual([null, null]);
  });

  it("adds an optional extra token address (outside the registry, e.g. bridged USDC.e), deduplicated", async () => {
    const p = await mk({ status: "partial" });
    const USDCE: Address = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
    expect((await recoverDeposit(e, p, "arb", now(), USDCE)).status).toBe("sent");
    const { tokens } = decodeSent(sw.arb.sent[0]!);
    expect(tokens.map((x) => x.toLowerCase()).sort()).toEqual([USDC_ARB, USDT_ARB, DAI_ARB, USDCE].map((x) => x.toLowerCase()).sort());
    await e.DB.prepare("UPDATE sweeps SET status='failed'").run();
    expect((await recoverDeposit(e, p, "arb", now(), USDC_ARB.toLowerCase() as Address)).status).toBe("sent");
    expect(decodeSent(sw.arb.sent[1]!).tokens).toHaveLength(3);
  });

  it("refuses a malformed extra token address and sends nothing", async () => {
    const p = await mk({ status: "partial" });
    for (const bad of ["0x123", "FF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", `0x${"g".repeat(40)}`, `0x${"a".repeat(41)}`])
      expect((await recoverDeposit(e, p, "arb", now(), bad as Address)).status, bad).toBe("failed");
    expect(sw.arb.sent).toHaveLength(0);
  });

  it("applies the gas check and the one-pending-sweep rule", async () => {
    const p = await mk();
    rpc.arb.latest = { native: {} };
    expect((await recoverDeposit(e, p, "arb", now())).status).toBe("skipped");
    expect((await alerts())[0]).toMatchObject({ kind: "sweep.insufficient_gas", chain: "arb" });
    rpc.arb.latest = { native: { [hot.toLowerCase()]: 10n ** 18n } };
    await e.KV.delete("evm:health:arb");
    clearHealthMemo();
    expect((await recoverDeposit(e, p, "arb", now())).status).toBe("sent");
    const blocked = await recoverDeposit(e, p, "arb", now() + 1000);
    expect(blocked.status).toBe("skipped");
    expect(blocked.reason).toMatch(/pending/);
    expect(sw.arb.sent).toHaveLength(1);
  });
});

describe("runSweeps", () => {
  it("runs every configured EVM chain and isolates failures per chain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mk();
    await mk({ chain: "arb", asset: "arb:usdc" });
    sw.base.estimate = () => "error";
    const out = await runSweeps(e, Date.now());
    expect(out.arb!.status).toBe("sent");
    expect(out.base!.status).toBe("failed");
    expect(Object.keys(out).sort()).toEqual(["arb", "base", "bsc", "eth", "polygon"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("base"))).toBe(true);
    warn.mockRestore();
  });
});

describe("stuck deposits", () => {
  it("runSweeps raises sweep.stuck for confirmed, unswept deposits older than 24h on a chain with no factory or no configuration", async () => {
    await mk({ confirmed_at: Date.now() - 2 * DAY }); // base: factory missing
    await mk({ chain: "arb", asset: "arb:usdc", confirmed_at: Date.now() - 2 * DAY }); // arb: unconfigured below
    await mk({ chain: "bsc", asset: "bsc:usdc", confirmed_at: Date.now() - HOUR }); // fresh: fine
    rpc.base.code = "0x";
    const saved = e.EVM_RPC_ARB;
    e.EVM_RPC_ARB = "";
    const out = await runSweeps(e, Date.now());
    e.EVM_RPC_ARB = saved;
    expect(out.arb).toBeUndefined();
    const stuck = (await alerts()).filter((a) => a.kind === "sweep.stuck");
    expect(stuck.map((a) => a.chain).sort()).toEqual(["arb", "base"]);
  });
});

describe("stuck partial and expired deposits", () => {
  it("sweep.stuck also counts partial and expired-with-unexpected payments that are due (past expiry + 7d + 1h)", async () => {
    rpc.base.code = "0x"; // base cannot sweep
    await mk({ status: "partial", invoice_id: "inv_sweep_recent" }); // not due yet: no alert
    await mk({ status: "expired", invoice_id: "inv_sweep_old", received: 0n, final: 0n, credited_minor: 0n }); // nothing there
    await runSweeps(e, Date.now());
    expect((await alerts()).filter((a) => a.kind === "sweep.stuck")).toHaveLength(0);
    await mk({ status: "expired", invoice_id: "inv_sweep_old", received: 0n, final: 0n, credited_minor: 0n, unexpected: { "base:dai": 1n } });
    await mk({ status: "partial", invoice_id: "inv_sweep_old" });
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    await runSweeps(e, Date.now());
    const stuck = (await alerts()).filter((a) => a.kind === "sweep.stuck");
    expect(stuck.map((a) => a.chain)).toEqual(["base"]);
    expect(stuck[0]!.detail).toMatch(/^2 /);
  });
});

describe("cron", () => {
  const tick = async (iso: string, cron: string) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(iso), cron }), e, ctx);
    await waitOnExecutionContext(ctx);
  };
  it("sweeps only on the sweeps cron expression", async () => {
    await mk();
    await tick("2026-11-13T10:07:00Z", "* * * * *");
    await tick("2026-11-13T10:30:00Z", "5-59/15 * * * *");
    expect(sw.base.sent).toHaveLength(0);
    await tick("2026-11-13T10:30:00Z", "*/15 * * * *");
    expect(sw.base.sent).toHaveLength(1);
  });
});
