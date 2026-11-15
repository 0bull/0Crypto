import { applyD1Migrations, runDurableObjectAlarm, runInDurableObject, type D1Migration } from "cloudflare:test";
import { putPrice } from "../../prices/seed";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lightningAdapter, lightningNode, lightningRefused, roundUpToSat, testSocketFactory } from "../../../src/chains/lightning/adapter";
import * as nwcModule from "../../../src/chains/lightning/nwc";
import { NwcError, NwcTimeout } from "../../../src/chains/lightning/nwc";
import { chainConfigError, getAdapter } from "../../../src/chains/registry";
import { enabledAssets } from "../../../src/config";
import { getAsset } from "../../../src/core/assets";
import { step } from "../../../src/core/state";
import type { InvoiceRow } from "../../../src/db/repo";
import { getInvoice, getPayment, insertInvoice, insertPayment, type PaymentRow } from "../../../src/db/repo";
import type { Env } from "../../../src/env";
import { refundBlock } from "../../../src/routing/refund";
import { routedAssets, routingScope } from "../../../src/routing/router";
import { toTarget } from "../../../src/watcher/PaymentWatcher";
import { lightningPollDelay } from "../../../src/watcher/schedule";
import { defaultWallet, fakeBolt11, nwcUri, relayFactory, WALLET_PK, WalletState, type RelayOptions } from "./fake-relay";
import { CLIENT_PK, hex, OTHER_SK } from "./fake-relay";
import { getPublicKey } from "nostr-tools/pure";

const e = env as unknown as Env;
const LN = getAsset("ln:btc");
const saved = { NWC_URI: e.NWC_URI, ENABLED_ASSETS: e.ENABLED_ASSETS, NWC_TEST_SOCKET_FACTORY: e.NWC_TEST_SOCKET_FACTORY };
let wallet: WalletState;
let sockets: ReturnType<typeof relayFactory>["sockets"];
const useRelay = (o: RelayOptions = {}) => {
  const r = relayFactory({ handler: defaultWallet(wallet), infoEncryption: "nip44_v2", ...o });
  sockets = r.sockets;
  // The adapter is built by getAdapter (watcher, payment creation): the fake reaches it through the test-only env hook.
  e.NWC_TEST_SOCKET_FACTORY = r.factory;
};

const clearKv = async () => {
  for (const k of [`nwc:enc:${WALLET_PK}`, `nwc:caps:${WALLET_PK}:${CLIENT_PK}`]) await e.KV.delete(k);
};
const alerts = async (kind: string) => (await e.DB.prepare("SELECT detail FROM alerts WHERE kind=? AND resolved_at IS NULL").bind(kind).all<{ detail: string }>()).results;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  Object.assign(e, { NWC_URI: nwcUri(), ENABLED_ASSETS: "btc:btc,ln:btc" });
});
afterAll(() => {
  Object.assign(e, saved);
});
beforeEach(async () => {
  wallet = new WalletState();
  useRelay();
  await clearKv();
  await e.DB.prepare("DELETE FROM alerts").run();
});
afterEach(() => vi.useRealTimers());

describe("configuration", () => {
  it("ln:btc is registered with 11 decimals (msat), priced as BTC", () => {
    expect(LN).toMatchObject({ chain: "ln", symbol: "BTC", decimals: 11, priceSymbol: "BTC", confirmations: 0 });
  });
  it("chainConfigError('ln') is null only for a parseable NWC_URI", () => {
    expect(chainConfigError({ NWC_URI: nwcUri() }, "ln")).toBeNull();
    expect(chainConfigError({}, "ln")).toMatch(/NWC_URI/);
    expect(chainConfigError({ NWC_URI: "" }, "ln")).toMatch(/NWC_URI/);
    expect(chainConfigError({ NWC_URI: nwcUri(["ws://relay.test"]) }, "ln")).toMatch(/wss/);
    expect(enabledAssets({ ...e, NWC_URI: "" }).map((a) => a.id)).not.toContain("ln:btc");
    expect(enabledAssets(e).map((a) => a.id)).toContain("ln:btc");
    expect(getAdapter(e, "ln").chain).toBe("ln");
  });
  it("Lightning is never routed: ln:btc is outside the routing scope, even with every route set up", () => {
    const all = { ...e, ENABLED_ASSETS: "ln:btc", XMR_ADDRESS: "x", TROCADOR_API_KEY: "k", TROCADOR_LIVE_OK: "1" } as Env;
    expect(routingScope(all).map((a) => a.id)).not.toContain("ln:btc");
    expect(routedAssets(all).map((a) => a.id)).not.toContain("ln:btc");
  });
  it("Lightning payments are never refunded by the gateway (the funds are in the merchant's wallet)", () => {
    const now = Date.now();
    const p = { chain: "ln", asset: "ln:btc", status: "confirmed", final: 50_000_000n, received: 50_000_000n } as unknown as PaymentRow;
    expect(refundBlock(e, p, now - 3_600_000, now)).toMatch(/not supported on ln/);
    expect(refundBlock(e, { ...p, status: "expired" } as PaymentRow, now - 30 * 86_400_000, now)).toMatch(/not supported on ln/);
  });
  it("roundUpToSat rounds msat up to a whole sat", () => {
    expect(roundUpToSat(1n)).toBe(1000n);
    expect(roundUpToSat(1000n)).toBe(1000n);
    expect(roundUpToSat(50_000_001n)).toBe(50_001_000n);
  });
});

describe("socket factory injection", () => {
  it("no module-level factory setter exists; the factory is an option", () => {
    expect(Object.keys(nwcModule)).not.toContain("setNwcSocketFactory");
  });
  it("lightningAdapter takes an injected factory over the env hook", async () => {
    const injected = relayFactory({ handler: defaultWallet(wallet), infoEncryption: "nip44_v2" });
    await lightningAdapter(e, { socketFactory: injected.factory }).createInvoice(1_000n, "pay_x", 600);
    expect(injected.sockets.length).toBeGreaterThan(0);
    expect(sockets).toHaveLength(0); // the env hook's relay was never used
  });
  it("the env hook is honoured only when it is a function (a deployed var or secret is always a string)", () => {
    const f = () => ({}) as never;
    expect(testSocketFactory({ NWC_TEST_SOCKET_FACTORY: f } as unknown as Env)).toBe(f);
    expect(testSocketFactory({ NWC_TEST_SOCKET_FACTORY: "wss://evil.test" } as unknown as Env)).toBeUndefined();
    expect(testSocketFactory({} as Env)).toBeUndefined();
  });
});

describe("createInvoice", () => {
  it("checks the wallet's methods, then calls make_invoice with the invoice id as the only description", async () => {
    const now = Date.now();
    const r = await lightningAdapter(e).createInvoice(21_000_000n, "inv_abc", 1200);
    const made = [...wallet.invoices.values()][0]!;
    expect(r).toEqual({ bolt11: made.invoice, paymentHash: made.payment_hash, expiresAt: made.expires_at * 1000 });
    expect(r.expiresAt).toBeGreaterThan(now + 1_100_000);
    expect(wallet.requests).toEqual([{ method: "make_invoice", params: { amount: 21_000_000, description: "inv_abc", expiry: 1200 } }]);
    expect(sockets.every((s) => s.closed)).toBe(true);
    // The capability check and the encryption are cached: a second invoice is one socket.
    const n = sockets.length;
    await lightningAdapter(e).createInvoice(1_000n, "inv_def", 600);
    expect(sockets.length).toBe(n + 1);
  });
  it("refuses a connection that cannot make and look up invoices, with one deduplicated alert", async () => {
    wallet.methods = ["get_info", "make_invoice"];
    for (let i = 0; i < 2; i++) {
      const err = await lightningAdapter(e).createInvoice(1_000n, "inv_x", 600).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(NwcError);
      expect((err as NwcError).code).toBe("UNSUPPORTED");
    }
    expect(wallet.requests).toEqual([]); // make_invoice never sent
    expect(await alerts("lightning.config_error")).toHaveLength(1);
    expect(await lightningRefused(e)).toBe(true);
    await clearKv();
    expect(await lightningRefused(e)).toBe(false); // KV only: unknown is not refused
  });
  it("the capability verdict is per connection (wallet and client key): a replacement NWC_URI is checked afresh", async () => {
    wallet.methods = ["get_info"];
    await lightningAdapter(e).createInvoice(1_000n, "inv_x", 600).catch(() => undefined);
    expect(await lightningRefused(e)).toBe(true);
    const old = e.NWC_URI;
    try {
      e.NWC_URI = nwcUri(undefined, undefined, hex(OTHER_SK)); // same wallet, new receive-only connection (new client key)
      expect(await lightningRefused(e)).toBe(false);
      wallet.methods = ["get_info", "make_invoice", "lookup_invoice"];
      await lightningAdapter(e).createInvoice(1_000n, "inv_y", 600);
      e.NWC_URI = old;
      expect(await lightningRefused(e)).toBe(true); // the old connection keeps its own verdict
    } finally {
      e.NWC_URI = old;
      await e.KV.delete(`nwc:caps:${WALLET_PK}:${getPublicKey(OTHER_SK)}`);
    }
  });
  it("remembers the node id get_info reports (lowercased), and nothing for a missing or malformed one", async () => {
    expect(await lightningNode(e)).toBeNull();
    wallet.pubkey = `03${"AB".repeat(32)}`;
    await lightningAdapter(e).createInvoice(1_000n, "inv_x", 600);
    expect(await lightningNode(e)).toBe(`03${"ab".repeat(32)}`);
    await clearKv();
    wallet.pubkey = "not a node id";
    await lightningAdapter(e).createInvoice(1_000n, "inv_y", 600);
    expect(await lightningNode(e)).toBeNull();
  });
  it("a connection that can also pay works, with an admin warning to use a receive-only one", async () => {
    wallet.methods = ["get_info", "make_invoice", "lookup_invoice", "pay_" + "invoice"];
    await lightningAdapter(e).createInvoice(1_000n, "inv_x", 600);
    const a = await alerts("lightning.spend_permission");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatch(/receive-only/);
  });
  it.each([
    ["the bolt11 is for another amount", (s: WalletState) => (s.nextInvoice = fakeBolt11(2_000n, Math.floor(Date.now() / 1000), 600))],
    ["the bolt11 has no amount", (s: WalletState) => (s.nextInvoice = fakeBolt11(1_000n, Math.floor(Date.now() / 1000), 600, undefined, "lnbc"))],
    ["the bolt11 is for testnet", (s: WalletState) => (s.nextInvoice = fakeBolt11(1_000n, Math.floor(Date.now() / 1000), 600, undefined, "lntb10n"))],
    ["the hash differs from the bolt11's", (s: WalletState) => (s.nextInvoice = { ...fakeBolt11(1_000n, Math.floor(Date.now() / 1000), 600), hash: "ab".repeat(32) })],
  ])("fails closed when %s", async (_what, setup) => {
    setup(wallet);
    await expect(lightningAdapter(e).createInvoice(1_000n, "inv_x", 600)).rejects.toBeInstanceOf(NwcError);
  });
  it("the expiry is the earlier of the bolt11's and the wallet's", async () => {
    const ts = Math.floor(Date.now() / 1000);
    wallet.nextInvoice = fakeBolt11(1_000n, ts, 300);
    const r = await lightningAdapter(e).createInvoice(1_000n, "inv_x", 600); // the wallet says +600, the bolt11 says +300
    expect(r.expiresAt).toBe((ts + 300) * 1000);
  });
  it("refuses an amount that is not a whole sat or is out of range", async () => {
    await expect(lightningAdapter(e).createInvoice(1_500n, "inv_x", 600)).rejects.toThrow();
    await expect(lightningAdapter(e).createInvoice(0n, "inv_x", 600)).rejects.toThrow();
  });
  it("has an overall 25 s deadline across its relay rounds (three silent relays would otherwise take 30 s)", async () => {
    await lightningAdapter(e).createInvoice(1_000n, "pay_warm", 600); // capability check and encryption now cached
    const relays = ["wss://a.test", "wss://b.test", "wss://c.test"];
    e.NWC_URI = nwcUri(relays);
    try {
      useRelay({ handler: () => null });
      vi.useFakeTimers();
      let settled = false;
      const r = lightningAdapter(e).createInvoice(1_000n, "pay_x", 600).catch((x: unknown) => x).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await r).toBeInstanceOf(NwcTimeout);
      expect(sockets.map((s) => s.url)).toEqual(relays);
      expect(sockets.every((s) => s.closed)).toBe(true);
    } finally {
      e.NWC_URI = nwcUri();
    }
  });
  it("deriveAddress throws; paymentUri is lightning:<bolt11>", async () => {
    const a = lightningAdapter(e);
    await expect(a.deriveAddress(0)).rejects.toThrow(/Lightning/);
    expect(a.paymentUri({ address: "lnbc1x" } as never, LN, 1n)).toBe("lightning:lnbc1x");
  });
});

let seq = 0;
async function lnPayment(o: Partial<PaymentRow> = {}, invoiceExpiresAt = Date.now() + 3_600_000) {
  const made = wallet.make({ amount: 50_000_000, description: "x", expiry: 1200 });
  const id = `ln${Date.now()}${seq++}`;
  await insertInvoice(e.DB, {
    id: `inv_${id}`, created_at: Date.now(), expires_at: invoiceExpiresAt, price_minor: 5000n, currency: "USD", order_id: null, metadata: null,
    success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
  });
  const p: PaymentRow = {
    id: `pay_${id}`, invoice_id: `inv_${id}`, asset: "ln:btc", chain: "ln", address: made.invoice, derivation_index: -1, reference: made.payment_hash,
    expected: 50_000_000n, price_e8: 100_000n * 10n ** 8n, rate_locked_until: Date.now() + 1_200_000, received: 0n, final: 0n, txids: [], status: "awaiting",
    created_at: Date.now(), detected_at: null, confirmed_at: null, credited_minor: 0n, credit_price_e8: null, unexpected: null, ...o,
  };
  await insertPayment(e.DB, p);
  wallet.requests = [];
  return p;
}

describe("observe", () => {
  it("unsettled: nothing received; settled: received = final = amount", async () => {
    const p = await lnPayment();
    const a = lightningAdapter(e);
    expect(await a.observe(toTarget(p), LN)).toEqual({ received: 0n, final: 0n, txids: [] });
    expect(wallet.requests).toEqual([{ method: "lookup_invoice", params: { payment_hash: p.reference } }]);
    wallet.settle(p.reference!);
    expect(await a.observe(toTarget(p), LN)).toEqual({ received: 50_000_000n, final: 50_000_000n, txids: [p.reference], settledAt: expect.any(Number) });
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it("a mismatched payment_hash echo is never credited", async () => {
    const p = await lnPayment();
    wallet.settle(p.reference!);
    useRelay({ handler: (m, params) => (m === "lookup_invoice" ? { result: { ...wallet.lookup(params), payment_hash: "cd".repeat(32) } } : defaultWallet(wallet)(m, params)) });
    await expect(lightningAdapter(e).observe(toTarget(p), LN)).rejects.toBeInstanceOf(NwcError);
  });
  it("an amount other than the invoice's is never credited", async () => {
    const p = await lnPayment();
    wallet.settle(p.reference!);
    useRelay({ handler: (m, params) => (m === "lookup_invoice" ? { result: { ...wallet.lookup(params), amount: 1_000 } } : defaultWallet(wallet)(m, params)) });
    await expect(lightningAdapter(e).observe(toTarget(p), LN)).rejects.toBeInstanceOf(NwcError);
  });
  it.each([0, null])("settled_at %s means unsettled", async (settled_at) => {
    const p = await lnPayment();
    useRelay({ handler: (m, params) => (m === "lookup_invoice" ? { result: { ...wallet.lookup(params), settled_at } } : defaultWallet(wallet)(m, params)) });
    expect(await lightningAdapter(e).observe(toTarget(p), LN)).toEqual({ received: 0n, final: 0n, txids: [] });
  });
  it("an unknown lookup result fails closed", async () => {
    const p = await lnPayment();
    useRelay({ handler: (m, params) => (m === "lookup_invoice" ? { result: { payment_hash: p.reference, amount: "50000000", settled_at: 1 } } : defaultWallet(wallet)(m, params)) });
    await expect(lightningAdapter(e).observe(toTarget(p), LN)).rejects.toBeInstanceOf(NwcError);
  });
  it("a timeout throws NwcTimeout (the watcher backs off)", async () => {
    const p = await lnPayment();
    await lightningAdapter(e).observe(toTarget(p), LN); // warm the encryption cache
    useRelay({ handler: () => null });
    vi.useFakeTimers();
    const r = lightningAdapter(e).observe(toTarget(p), LN).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await r).toBeInstanceOf(NwcTimeout);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
});

describe("credit timing: the settle time, not the poll time", () => {
  const MIN = 60_000;
  const PRICE = 100_000n * 10n ** 8n;
  const rows = (chain: "ln" | "btc", now: number, inv: Partial<InvoiceRow> = {}) => {
    const invoice: InvoiceRow = {
      id: "inv_t", created_at: now - 30 * MIN, expires_at: now + 30 * MIN, price_minor: 5000n, currency: "USD", order_id: null, metadata: null,
      success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...inv,
    };
    const payment: PaymentRow = {
      id: "pay_t", invoice_id: "inv_t", asset: chain === "ln" ? "ln:btc" : "btc:btc", chain, address: "x", derivation_index: -1, reference: "ab".repeat(32),
      expected: chain === "ln" ? 50_000_000n : 50_000n, price_e8: PRICE, rate_locked_until: now - 5 * MIN, received: 0n, final: 0n, txids: [], status: "awaiting",
      created_at: now - 25 * MIN, detected_at: null, confirmed_at: null, credited_minor: 0n, credit_price_e8: null, unexpected: null,
    };
    return { invoice, payment };
  };
  const halfPrice = async () => PRICE / 2n; // the market moved: crediting at the poll's price would leave the invoice part paid

  it("settled before the rate lock ended, polled after it: credited at the locked rate, not late, paid", async () => {
    const now = Date.now();
    // The invoice also expired between the settle and the poll: still not late.
    const { invoice, payment } = rows("ln", now, { expires_at: now - 2 * MIN });
    const settledAt = now - 10 * MIN;
    const t = (await step({ invoice, payment, others: [], obs: { received: 50_000_000n, final: 50_000_000n, txids: ["h"], settledAt }, now, currentPriceE8: halfPrice }))!;
    expect(t.payment).toMatchObject({ status: "confirmed", detected_at: settledAt, credit_price_e8: PRICE, credited_minor: 5000n });
    expect(t.invoice).toMatchObject({ status: "paid", late: false });
    expect(t.events.map((x) => x.type)).not.toContain("invoice.partially_paid");
    expect(t.events.map((x) => x.type)).not.toContain("invoice.late_payment");
  });
  it("the settle time is clamped to [payment created, now]", async () => {
    const now = Date.now();
    const { invoice, payment } = rows("ln", now);
    const obs = (settledAt: number) => ({ received: 50_000_000n, final: 50_000_000n, txids: ["h"], settledAt });
    const future = (await step({ invoice, payment, others: [], obs: obs(now + 3_600_000), now, currentPriceE8: halfPrice }))!;
    expect(future.payment.detected_at).toBe(now);
    const ancient = (await step({ invoice, payment, others: [], obs: obs(0), now, currentPriceE8: halfPrice }))!;
    expect(ancient.payment.detected_at).toBe(payment.created_at);
  });
  it("other chains ignore settledAt: the poll time stays the detection time", async () => {
    const now = Date.now();
    const { invoice, payment } = rows("btc", now);
    const t = (await step({ invoice, payment, others: [], obs: { received: 50_000n, final: 50_000n, txids: ["h"], settledAt: now - 10 * MIN }, now, currentPriceE8: halfPrice }))!;
    expect(t.payment.detected_at).toBe(now);
    expect(t.payment.credit_price_e8).toBe(PRICE / 2n);
  });
  it("observe reports the wallet's settled_at in ms, clamped to [created, now]", async () => {
    const p = await lnPayment({ created_at: Date.now() - 60_000 });
    wallet.settle(p.reference!);
    const at = wallet.invoices.get(p.reference!)!.settled_at!;
    const o = await lightningAdapter(e).observe(toTarget(p), LN);
    expect(o.settledAt).toBe(Math.max(at * 1000, p.created_at));
    expect(o.settledAt!).toBeLessThanOrEqual(Date.now());
  });
});

describe("watcher", () => {
  const track = async (p: PaymentRow) => {
    const stub = e.WATCHER.get(e.WATCHER.idFromName(p.invoice_id));
    await runInDurableObject(stub, async (w, state) => {
      Object.assign((w as unknown as { env: Env }).env, { NWC_URI: nwcUri(), ENABLED_ASSETS: "btc:btc,ln:btc" });
      await w.start(p.invoice_id, p.id);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    return stub;
  };
  it("a relay outage backs off and never expires the payment or the invoice", async () => {
    // The invoice expired two days ago: a zero observation would expire both. The failed one must change nothing.
    const p = await lnPayment({ created_at: Date.now() - 3 * 86_400_000, rate_locked_until: Date.now() - 2 * 86_400_000 }, Date.now() - 2 * 86_400_000);
    useRelay({ fail: "refuse" });
    const stub = await track(p);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getPayment(e.DB, p.id))!.status).toBe("awaiting");
    expect((await getInvoice(e.DB, p.invoice_id))!.status).toBe("open");
    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>(`p:${p.id}`)?.errorStreak).toBe(1);
    });
    await runInDurableObject(stub, (_w, s) => s.storage.deleteAlarm());
  });
  it("lightningPollDelay: normal until 10 min after the lock, then one final lookup at bolt11 expiry + 1 h, then stop", () => {
    const lock = 1_000_000_000;
    const MIN = 60_000;
    expect(lightningPollDelay(lock + 9 * MIN, 15_000, lock, lock)).toBe(15_000);
    expect(lightningPollDelay(lock + 11 * MIN, 15_000, lock, lock)).toBe(49 * MIN);
    expect(lightningPollDelay(lock + 11 * MIN, 15_000, lock, lock + 30 * MIN)).toBe(79 * MIN); // the bolt11 outlives the lock
    expect(lightningPollDelay(lock + 60 * MIN, 15_000, lock, lock)).toBeNull();
    expect(lightningPollDelay(lock + 61 * MIN, 15_000, lock, lock)).toBeNull();
    expect(lightningPollDelay(lock, null, lock, lock)).toBeNull();
  });
  it("an expired, unpaid ln payment gets one final lookup, then is no longer watched; its siblings still are", async () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    // Expired 15 minutes ago: next poll is the final one, at its bolt11 expiry + 1 h.
    wallet.nextInvoice = fakeBolt11(50_000_000n, ts - 35 * 60, 20 * 60);
    const late = await lnPayment({ rate_locked_until: (ts - 15 * 60) * 1000 });
    // Expired 2 hours ago: this poll was its final lookup.
    wallet.nextInvoice = fakeBolt11(50_000_000n, ts - 140 * 60, 20 * 60);
    const done = await lnPayment({ invoice_id: late.invoice_id, rate_locked_until: (ts - 120 * 60) * 1000 });
    wallet.nextInvoice = null;
    const fresh = await lnPayment({ invoice_id: late.invoice_id });
    const stub = await track(late);
    await runInDurableObject(stub, async (w, state) => {
      await w.start(late.invoice_id, done.id);
      await w.start(late.invoice_id, fresh.id);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get<string[]>("payments")).toEqual([late.id, fresh.id]);
      const finalAt = state.storage.kv.get<{ nextAt: number }>(`p:${late.id}`)!.nextAt;
      expect(finalAt).toBe((ts - 15 * 60 + 3600) * 1000);
      expect(state.storage.kv.get<{ nextAt: number }>(`p:${fresh.id}`)!.nextAt).toBeLessThan(Date.now() + 60_000);
    });
    expect(wallet.requests.filter((r) => r.method === "lookup_invoice")).toHaveLength(3); // each got its lookup
    expect((await getPayment(e.DB, done.id))!.status).toBe("awaiting"); // not expired by this: just no longer watched
    await runInDurableObject(stub, (_w, s) => s.storage.deleteAlarm());
  });
  it("a settled invoice confirms the payment and pays the invoice", async () => {
    await putPrice(e, "USD", "BTC", 100_000n * 10n ** 8n);
    const p = await lnPayment();
    wallet.settle(p.reference!);
    const stub = await track(p);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getPayment(e.DB, p.id))!).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n });
    expect((await getInvoice(e.DB, p.invoice_id))!.status).toBe("paid");
    await runInDurableObject(stub, (_w, s) => s.storage.deleteAlarm());
  });
});
