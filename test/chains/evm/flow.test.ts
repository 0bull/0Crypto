import { applyD1Migrations, runDurableObjectAlarm, runInDurableObject, type D1Migration } from "cloudflare:test";
import { putPrice } from "../../prices/seed";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrReusePayment } from "../../../src/api/invoices";
import { factoryAddress, predictForwarder } from "../../../src/chains/evm/predict";
import { evmDepositSalt } from "../../../src/signing/addresses";
import { hotAccount } from "../../../src/signing/evmkeys";
import { enabledAssets } from "../../../src/config";
import { getAsset } from "../../../src/core/assets";
import { getInvoice, getPayment, insertInvoice, insertPayment, listPayments, type InvoiceRow, type PaymentRow } from "../../../src/db/repo";
import type { Env } from "../../../src/env";
import { evmRpc, emptyState, tokenKey, type RpcState } from "../../evm-rpc";

const e = env as unknown as Env;
const original = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE, EVM_RPC_ARB: e.EVM_RPC_ARB };
const ADDR_OF = (p: PaymentRow) => p.address;

const network = setupNetwork();
const state: Record<"base" | "arb", RpcState> = { base: emptyState(), arb: emptyState() };
const armed = new Set<string>();

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  // Env is shared with the Worker and the watcher in this test file; restored in afterAll.
  Object.assign(e, { ENABLED_ASSETS: "base:usdc,base:eth,arb:usdc", EVM_RPC_BASE: "https://rpc.test/base", EVM_RPC_ARB: "https://rpc.test/arb" });
  const price = (symbol: string, e8: bigint) => putPrice(e, "USD", symbol, e8);
  await price("USDC", 10n ** 8n);
  await price("ETH", 2000n * 10n ** 8n);
});
afterEach(() => {
  state.base = emptyState();
  state.arb = emptyState();
});
afterAll(async () => {
  for (const id of armed) await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  Object.assign(e, original);
  network.disable();
});
const serve = () => network.use(evmRpc("https://rpc.test/base", () => state.base), evmRpc("https://rpc.test/arb", () => state.arb));

let seq = 0;
async function mkInvoice(): Promise<string> {
  const id = `inv_evm${Date.now()}${seq++}`;
  armed.add(id);
  const inv: InvoiceRow = {
    id, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
  };
  await insertInvoice(e.DB, inv);
  return id;
}
const watcherOf = (id: string) => e.WATCHER.get(e.WATCHER.idFromName(id));
/** Stops the auto-armed alarm so only runDurableObjectAlarm polls, with the poll state reset to "due". */
async function holdAlarm(invoiceId: string, paymentId: string) {
  await runInDurableObject(watcherOf(invoiceId), async (_w, s) => {
    await s.storage.setAlarm(Date.now() + 3_600_000);
    s.storage.kv.put(`p:${paymentId}`, { errorStreak: 0, lastPolledAt: null, nextAt: 0 });
  });
}

describe("createOrReusePayment on EVM", () => {
  it("base and arb invoices share one counter: different indices and addresses (counterKey wiring)", async () => {
    serve();
    const a = await createOrReusePayment(e, await mkInvoice(), "base:usdc", "10.8.0.1");
    const b = await createOrReusePayment(e, await mkInvoice(), "arb:usdc", "10.8.0.2");
    if ("error" in a || "error" in b) throw new Error("payment creation failed");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const [pa, pb] = await Promise.all([getPayment(e.DB, a.body.payment_id), getPayment(e.DB, b.body.payment_id)]);
    expect(pa!.derivation_index).not.toBe(pb!.derivation_index);
    expect(pa!.address).not.toBe(pb!.address);
    const factory = factoryAddress(hotAccount(e).address);
    expect(pa!.address).toBe(predictForwarder(factory, evmDepositSalt(e.MASTER_SEED!, pa!.derivation_index)));
    expect(pb!.address).toBe(predictForwarder(factory, evmDepositSalt(e.MASTER_SEED!, pb!.derivation_index)));
    expect(a.body.uri).toBe(`ethereum:${getAsset("base:usdc").contract}@8453/transfer?address=${pa!.address}&uint256=${pa!.expected}`);
    expect(pa!.unexpected).toBeNull();
  });
});

describe("watcher on EVM", () => {
  it("confirms from balances, records an unexpected deposit without an event, and keeps credit and that record after a sweep", async () => {
    serve();
    const invId = await mkInvoice();
    const r = await createOrReusePayment(e, invId, "base:usdc", "10.8.0.3");
    if ("error" in r) throw new Error("payment creation failed");
    const pid = r.body.payment_id;
    const p0 = (await getPayment(e.DB, pid))!;
    expect(p0.expected).toBe(50_000_000n);
    const addr = ADDR_OF(p0).toLowerCase();
    const usdc = tokenKey(getAsset("base:usdc").contract!, addr);

    // Full amount finalized, plus a stray 0.01 ETH.
    state.base.latest = state.base.finalized = { tokens: { [usdc]: 50_000_000n }, native: { [addr]: 10n ** 16n } };
    await holdAlarm(invId, pid);
    expect(await runDurableObjectAlarm(watcherOf(invId))).toBe(true);
    const confirmed = (await getPayment(e.DB, pid))!;
    expect(confirmed).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n, unexpected: { "base:eth": 10n ** 16n } });
    expect((await getInvoice(e.DB, invId))!.status).toBe("paid");
    const eventTypes = async () =>
      (await e.DB.prepare("SELECT type FROM events WHERE invoice_id=? ORDER BY type").bind(invId).all<{ type: string }>()).results.map((x) => x.type);
    expect(await eventTypes()).toEqual(["invoice.paid", "payment.confirmed", "payment.detected"]);

    // The sweep empties the address: balances read 0, but the credit stays and no event fires.
    state.base.latest = state.base.finalized = {};
    await holdAlarm(invId, pid);
    expect(await runDurableObjectAlarm(watcherOf(invId))).toBe(true);
    const after = (await getPayment(e.DB, pid))!;
    expect(after).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n, credited_minor: confirmed.credited_minor });
    expect((await getInvoice(e.DB, invId))!.paid_minor).toBe(5000n);
    expect(await eventTypes()).toEqual(["invoice.paid", "payment.confirmed", "payment.detected"]);
    // The stray ETH was swept too, but the record of it stays (per asset, the highest reading) for the dashboard.
    expect((await listPayments(e.DB, invId))[0]!.unexpected).toEqual({ "base:eth": 10n ** 16n });
  });
});

describe("watcher when the finalized read fails", () => {
  const streakOf = (invId: string, pid: string) =>
    runInDurableObject(watcherOf(invId), (_w, s) => s.storage.kv.get<{ errorStreak: number }>(`p:${pid}`)?.errorStreak);

  it("grows the error streak and leaves the payment untouched (no final 0, no regression)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      serve();
      const invId = await mkInvoice();
      const r = await createOrReusePayment(e, invId, "base:usdc", "10.8.0.4");
      if ("error" in r) throw new Error("payment creation failed");
      const pid = r.body.payment_id;
      const addr = (await getPayment(e.DB, pid))!.address.toLowerCase();
      const usdc = tokenKey(getAsset("base:usdc").contract!, addr);
      const full = { tokens: { [usdc]: 50_000_000n } };

      // Confirmed first.
      state.base.latest = state.base.finalized = full;
      await holdAlarm(invId, pid);
      await runDurableObjectAlarm(watcherOf(invId));
      expect((await getPayment(e.DB, pid))!.status).toBe("confirmed");
      expect(await streakOf(invId, pid)).toBe(0);

      // Now the node cannot serve the finalized block, and the head already shows an empty (swept) address: the adapter
      // skips the finalized read (nothing is there), so no error; step's monotone guard keeps every amount.
      state.base.latest = {};
      state.base.finalizedCallError = true;
      await holdAlarm(invId, pid);
      await runDurableObjectAlarm(watcherOf(invId));
      expect(await streakOf(invId, pid)).toBe(0);
      expect(await getPayment(e.DB, pid)).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n });

      // The head shows a lower balance, so the finalized read is made, and it fails: the streak grows, nothing changes.
      state.base.latest = { tokens: { [usdc]: 10_000_000n } };
      await holdAlarm(invId, pid);
      await runDurableObjectAlarm(watcherOf(invId));
      expect(await streakOf(invId, pid)).toBe(1);
      expect(await getPayment(e.DB, pid)).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n });
    } finally {
      warn.mockRestore();
    }
  });

  it("a payment seen at the head but not yet readable as final is not changed by a failed read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      serve();
      const invId = await mkInvoice();
      const r = await createOrReusePayment(e, invId, "base:usdc", "10.8.0.5");
      if ("error" in r) throw new Error("payment creation failed");
      const pid = r.body.payment_id;
      const addr = (await getPayment(e.DB, pid))!.address.toLowerCase();
      state.base.latest = { tokens: { [tokenKey(getAsset("base:usdc").contract!, addr)]: 50_000_000n } };
      state.base.finalizedCallError = true;
      await holdAlarm(invId, pid);
      await runDurableObjectAlarm(watcherOf(invId));
      expect(await streakOf(invId, pid)).toBe(1);
      expect(await getPayment(e.DB, pid)).toMatchObject({ status: "awaiting", received: 0n, final: 0n });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("enabledAssets", () => {
  it("warns once when EVM custody or the RPC URL is missing, and leaves the asset out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const base = { MASTER_SEED: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", BTC_XPUB: "x" };
      // custody opt-in missing (RPC present)
      const noCustody = { ...base, ENABLED_ASSETS: "polygon:usdc,btc:btc", EVM_RPC_POLYGON: "https://p.test" };
      expect(enabledAssets(noCustody).map((a) => a.id)).toEqual(["btc:btc"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("polygon:usdc is disabled: ALLOW_SEED_CUSTODY"));
      // RPC missing (custody present)
      const noRpc = { ...base, ENABLED_ASSETS: "bsc:usdt,btc:btc", ALLOW_SEED_CUSTODY: "true" };
      expect(enabledAssets(noRpc).map((a) => a.id)).toEqual(["btc:btc"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bsc:usdt is disabled: set EVM_RPC_BSC"));
      // logged once per isolate per asset
      const calls = warn.mock.calls.length;
      enabledAssets(noCustody);
      enabledAssets(noRpc);
      expect(warn.mock.calls.length).toBe(calls);
      // fully configured: enabled
      const ok = { ...base, ENABLED_ASSETS: "polygon:usdc,bsc:usdt,btc:btc", ALLOW_SEED_CUSTODY: "true", EVM_RPC_POLYGON: "https://p.test", EVM_RPC_BSC: "https://b.test" };
      expect(enabledAssets(ok).map((a) => a.id)).toEqual(["polygon:usdc", "bsc:usdt", "btc:btc"]);
    } finally {
      warn.mockRestore();
    }
  });
});
