import { describe, expect, it } from "vitest";
import type { InvoiceRow, PaymentRow, Transition } from "../../src/db/repo";
import { step } from "../../src/core/state";
import type { Observation } from "../../src/core/types";

const T = Date.UTC(2027, 0, 1);
const MIN = 60_000;
const DAY = 86_400_000;
const BTC_100K = 100_000n * 10n ** 8n;
const BTC_80K = 80_000n * 10n ** 8n;

const invoice = (o: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: "inv1",
  created_at: T,
  expires_at: T + 60 * MIN,
  price_minor: 5000n,
  currency: "USD",
  order_id: null,
  metadata: null,
  success_url: null,
  allowed_assets: null,
  status: "open",
  late: false,
  overpaid: false,
  paid_minor: 0n,
  ...o,
});

const payment = (o: Partial<PaymentRow> = {}): PaymentRow => ({
  id: "pay1",
  invoice_id: "inv1",
  asset: "btc:btc",
  chain: "btc",
  address: "bc1qtest",
  derivation_index: 0,
  reference: null,
  expected: 50_000n,
  price_e8: BTC_100K,
  rate_locked_until: T + 20 * MIN,
  received: 0n,
  final: 0n,
  txids: [],
  status: "awaiting",
  created_at: T,
  detected_at: null,
  confirmed_at: null,
  credited_minor: 0n,
  credit_price_e8: null,
  unexpected: null,
  ...o,
});

const obs = (received: bigint, final: bigint): Observation => ({ received, final, txids: ["tx1"] });
const noPrice = async (): Promise<bigint> => {
  throw new Error("currentPriceE8 must not be called");
};
const types = (t: Transition | null) => t?.events.map((e) => e.type);

interface Scenario {
  name: string;
  invoice?: Partial<InvoiceRow>;
  payment?: Partial<PaymentRow>;
  others?: PaymentRow[];
  obs: Observation;
  at: number;
  price?: bigint;
  expect: {
    payment?: Partial<PaymentRow>;
    invoice?: Partial<InvoiceRow>;
    events: string[];
  };
}

const ltc20 = payment({
  id: "pay2",
  asset: "ltc:ltc",
  chain: "ltc",
  final: 1n,
  received: 1n,
  credited_minor: 2000n,
  credit_price_e8: 1n,
  status: "confirmed",
});

const scenarios: Scenario[] = [
  {
    name: "received, not final -> confirming + detected",
    obs: obs(50_000n, 0n),
    at: T + 5 * MIN,
    expect: { payment: { status: "confirming" }, invoice: { status: "open" }, events: ["payment.detected"] },
  },
  {
    name: "final within lock -> confirmed, paid",
    payment: { received: 50_000n, status: "confirming", txids: ["tx1"], detected_at: T + 5 * MIN },
    obs: obs(50_000n, 50_000n),
    at: T + 15 * MIN,
    expect: {
      payment: { status: "confirmed", confirmed_at: T + 15 * MIN, credited_minor: 5000n, credit_price_e8: BTC_100K },
      invoice: { status: "paid", paid_minor: 5000n, late: false },
      events: ["payment.confirmed", "invoice.paid"],
    },
  },
  {
    name: "0.4% short is within tolerance",
    obs: obs(49_800n, 49_800n),
    at: T + 15 * MIN,
    expect: {
      payment: { status: "confirmed" },
      invoice: { status: "paid", paid_minor: 4980n },
      events: ["payment.detected", "payment.confirmed", "invoice.paid"],
    },
  },
  {
    name: "0.6% short is not confirmed (partial after lock)",
    obs: obs(49_700n, 49_700n),
    at: T + 25 * MIN,
    price: BTC_100K,
    expect: {
      payment: { status: "partial", credit_price_e8: BTC_100K, credited_minor: 4970n },
      invoice: { status: "partially_paid", paid_minor: 4970n },
      events: ["payment.detected", "invoice.partially_paid"],
    },
  },
  {
    name: "30k sats -> partially_paid $30, still confirming-less detected",
    obs: obs(30_000n, 30_000n),
    at: T + 10 * MIN,
    expect: {
      payment: { status: "detected", credited_minor: 3000n },
      invoice: { status: "partially_paid", paid_minor: 3000n },
      events: ["payment.detected", "invoice.partially_paid"],
    },
  },
  {
    name: "second payment completes invoice exactly once",
    invoice: { status: "partially_paid", paid_minor: 3000n },
    payment: { received: 30_000n, final: 30_000n, credited_minor: 3000n, credit_price_e8: BTC_100K, status: "detected", txids: ["tx1"], detected_at: T + 10 * MIN },
    others: [{ ...ltc20, credited_minor: 2000n }],
    obs: obs(30_000n, 30_000n),
    at: T + 12 * MIN,
    expect: { invoice: { status: "paid", paid_minor: 5000n }, events: ["invoice.paid"] },
  },
  {
    name: "detected after lock, final later uses current price ($80k) -> $40, partially paid, payment confirmed",
    payment: { received: 50_000n, status: "confirming", txids: ["tx1"], detected_at: T + 30 * MIN },
    obs: obs(50_000n, 50_000n),
    at: T + 90 * MIN,
    price: BTC_80K,
    expect: {
      payment: { status: "confirmed", credit_price_e8: BTC_80K, credited_minor: 4000n },
      invoice: { status: "partially_paid", paid_minor: 4000n, late: false },
      events: ["payment.confirmed", "invoice.partially_paid"],
    },
  },
  {
    name: "late completion at T+100m -> paid, late",
    invoice: { status: "partially_paid", paid_minor: 4000n },
    payment: {
      received: 50_000n,
      final: 50_000n,
      status: "confirmed",
      detected_at: T + 70 * MIN,
      confirmed_at: T + 90 * MIN,
      credit_price_e8: BTC_80K,
      credited_minor: 4000n,
      txids: ["tx1"],
    },
    others: [{ ...ltc20, credited_minor: 1000n }],
    obs: obs(50_000n, 50_000n),
    at: T + 100 * MIN,
    expect: {
      invoice: { status: "paid", paid_minor: 5000n, late: true },
      events: ["invoice.paid", "invoice.late_payment"],
    },
  },
  {
    name: "no receipts after expiry -> invoice expired, payment awaiting",
    obs: { received: 0n, final: 0n, txids: [] },
    at: T + 61 * MIN,
    expect: { payment: { status: "awaiting" }, invoice: { status: "expired" }, events: ["invoice.expired"] },
  },
  {
    name: "payment expires 24h after invoice expiry",
    invoice: { status: "expired" },
    obs: { received: 0n, final: 0n, txids: [] },
    at: T + 60 * MIN + DAY + 1,
    expect: { payment: { status: "expired" }, invoice: { status: "expired" }, events: [] },
  },
  {
    name: "payment still awaiting at exactly expiry + 24h",
    invoice: { status: "expired" },
    obs: { received: 0n, final: 0n, txids: [] },
    at: T + 60 * MIN + DAY,
    expect: { events: [] },
  },
  {
    name: "$55 total -> overpaid",
    obs: obs(55_000n, 55_000n),
    at: T + 10 * MIN,
    expect: {
      invoice: { status: "paid", paid_minor: 5500n, overpaid: true },
      events: ["payment.detected", "payment.confirmed", "invoice.paid"],
    },
  },
  {
    name: "$50.50 exactly 1% over is not overpaid",
    obs: obs(50_500n, 50_500n),
    at: T + 10 * MIN,
    expect: { invoice: { status: "paid", paid_minor: 5050n, overpaid: false }, events: ["payment.detected", "payment.confirmed", "invoice.paid"] },
  },
  {
    name: "invoice paid at exactly expiry is not late",
    obs: obs(50_000n, 50_000n),
    at: T + 60 * MIN,
    price: BTC_100K,
    expect: { invoice: { status: "paid", late: false }, events: ["payment.detected", "payment.confirmed", "invoice.paid"] },
  },
  {
    name: "paid invoice is never downgraded",
    invoice: { status: "paid", paid_minor: 5000n },
    payment: { received: 50_000n, final: 50_000n, status: "confirmed", detected_at: T, confirmed_at: T, credited_minor: 5000n, credit_price_e8: BTC_100K, txids: ["tx1"] },
    obs: obs(50_000n, 50_000n),
    at: T + 200 * MIN,
    expect: { events: [] },
  },
];

describe("step", () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const res = await step({
        invoice: invoice(s.invoice),
        payment: payment(s.payment),
        others: s.others ?? [],
        obs: s.obs,
        now: s.at,
        currentPriceE8: s.price !== undefined ? async () => s.price! : noPrice,
      });
      if (s.expect.events.length === 0 && !s.expect.payment && !s.expect.invoice) {
        expect(res).toBeNull();
        return;
      }
      expect(res).not.toBeNull();
      expect(types(res)).toEqual(s.expect.events);
      expect(res!.payment).toMatchObject(s.expect.payment ?? {});
      expect(res!.invoice).toMatchObject(s.expect.invoice ?? {});
    });
  }

  it("event ids, payload and timestamps are deterministic", async () => {
    const res = await step({
      invoice: invoice(),
      payment: payment(),
      others: [],
      obs: obs(50_000n, 50_000n),
      now: T + 15 * MIN,
      currentPriceE8: noPrice,
    });
    expect(res!.events.map((e) => e.id)).toEqual([
      "payment.detected:pay1:1",
      "payment.confirmed:pay1:1",
      "invoice.paid:inv1:1",
    ]);
    expect(res!.events.every((e) => e.created_at === T + 15 * MIN && e.invoice_id === "inv1")).toBe(true);
    expect(JSON.parse(res!.events[0]!.payload)).toEqual({
      invoice_id: "inv1",
      payment_id: "pay1",
      status: "confirmed",
      paid_minor: "5000",
    });
    expect(JSON.parse(res!.events[2]!.payload)).toEqual({ invoice_id: "inv1", status: "paid", paid_minor: "5000" });
  });

  it("partially_paid event id carries paid_minor", async () => {
    const res = await step({
      invoice: invoice(),
      payment: payment(),
      others: [],
      obs: obs(30_000n, 30_000n),
      now: T + 10 * MIN,
      currentPriceE8: noPrice,
    });
    expect(res!.events.map((e) => e.id)).toContain("invoice.partially_paid:inv1:3000");
  });

  it("same observation applied to the resulting rows returns null and never re-fetches the price", async () => {
    let calls = 0;
    const price = async () => (calls++, BTC_80K);
    const base = { others: [] as PaymentRow[], now: T + 90 * MIN, currentPriceE8: price };
    const o = obs(50_000n, 50_000n);
    const first = await step({ invoice: invoice(), payment: payment(), obs: o, ...base });
    expect(first).not.toBeNull();
    const again = await step({ invoice: first!.invoice, payment: first!.payment, obs: o, ...base });
    expect(again).toBeNull();
    // later step, rate stays fixed
    const later = await step({ invoice: first!.invoice, payment: first!.payment, obs: o, ...base, now: T + 95 * MIN });
    expect(later).toBeNull();
    expect(calls).toBe(1);
  });

  it("confirmed payment stays confirmed and credits growth", async () => {
    const first = await step({
      invoice: invoice(),
      payment: payment(),
      others: [],
      obs: obs(50_000n, 50_000n),
      now: T + 15 * MIN,
      currentPriceE8: noPrice,
    });
    const grown = await step({
      invoice: first!.invoice,
      payment: first!.payment,
      others: [],
      obs: obs(60_000n, 60_000n),
      now: T + 16 * MIN,
      currentPriceE8: noPrice,
    });
    expect(grown!.payment).toMatchObject({ status: "confirmed", confirmed_at: T + 15 * MIN, credited_minor: 6000n });
    expect(grown!.invoice).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
    expect(types(grown)).toEqual([]);
  });

  it("invoice with receipts from other payment does not expire", async () => {
    const res = await step({
      invoice: invoice(),
      payment: payment(),
      others: [{ ...ltc20, received: 1n, final: 0n, credited_minor: 0n, status: "detected" }],
      obs: { received: 0n, final: 0n, txids: [] },
      now: T + 61 * MIN,
      currentPriceE8: noPrice,
    });
    expect(res).toBeNull();
  });

  describe("expired invoice then payment arrives", () => {
    const run = (o: Partial<Scenario>) =>
      step({
        invoice: invoice({ status: "expired" }),
        payment: payment(),
        others: o.others ?? [],
        obs: o.obs!,
        now: o.at!,
        currentPriceE8: async () => BTC_100K,
      });
    it("partial amount -> partially_paid", async () => {
      const res = await run({ obs: obs(30_000n, 30_000n), at: T + 70 * MIN });
      expect(res!.invoice).toMatchObject({ status: "partially_paid", paid_minor: 3000n, late: false });
      expect(types(res)).toEqual(["payment.detected", "invoice.partially_paid"]);
    });
    it("full amount -> paid, late", async () => {
      const res = await run({ obs: obs(50_000n, 50_000n), at: T + 70 * MIN });
      expect(res!.invoice).toMatchObject({ status: "paid", late: true });
      expect(types(res)).toEqual(["payment.detected", "payment.confirmed", "invoice.paid", "invoice.late_payment"]);
    });
  });

  describe("rate-lock boundary", () => {
    const run = (at: number) =>
      step({
        invoice: invoice({ expires_at: T + 600 * MIN }),
        payment: payment(),
        others: [],
        obs: obs(30_000n, 30_000n),
        now: at,
        currentPriceE8: async () => BTC_80K,
      });
    it("exactly at rate_locked_until uses locked price", async () => {
      const res = await run(T + 20 * MIN);
      expect(res!.payment).toMatchObject({ credit_price_e8: BTC_100K, credited_minor: 3000n });
    });
    it("one ms after uses current price", async () => {
      const res = await run(T + 20 * MIN + 1);
      expect(res!.payment).toMatchObject({ credit_price_e8: BTC_80K, credited_minor: 2400n });
    });
  });

  describe("rate lock and late flag judged at first sighting", () => {
    const at = (now: number, o: Observation, prev?: Transition | null, price: () => Promise<bigint> = noPrice) =>
      step({ invoice: prev?.invoice ?? invoice(), payment: prev?.payment ?? payment(), others: [], obs: o, now, currentPriceE8: price });

    it("sets detected_at on first sighting and never changes it", async () => {
      const seen = await at(T + 5 * MIN, obs(20_000n, 0n));
      expect(seen!.payment.detected_at).toBe(T + 5 * MIN);
      const more = await at(T + 8 * MIN, obs(50_000n, 0n), seen);
      expect(more!.payment.detected_at).toBe(T + 5 * MIN);
      const none = await at(T + 1 * MIN, { received: 0n, final: 0n, txids: [] });
      expect(none).toBeNull();
    });
    it("received inside the lock, final after it: locked price, not late", async () => {
      const seen = await at(T + 5 * MIN, obs(50_000n, 0n));
      const done = await at(T + 25 * MIN, obs(50_000n, 50_000n), seen, async () => BTC_80K);
      expect(done!.payment).toMatchObject({ status: "confirmed", credit_price_e8: BTC_100K, credited_minor: 5000n, detected_at: T + 5 * MIN });
      expect(done!.invoice).toMatchObject({ status: "paid", late: false });
    });
    it("received after the lock: current price", async () => {
      const seen = await at(T + 22 * MIN, obs(50_000n, 0n));
      const done = await at(T + 30 * MIN, obs(50_000n, 50_000n), seen, async () => BTC_80K);
      expect(done!.payment).toMatchObject({ credit_price_e8: BTC_80K, credited_minor: 4000n });
    });
    it("received before expiry, final after expiry: not late", async () => {
      const seen = await at(T + 50 * MIN, obs(50_000n, 0n));
      const done = await at(T + 70 * MIN, obs(50_000n, 50_000n), seen, async () => BTC_100K);
      expect(done!.invoice).toMatchObject({ status: "paid", late: false });
      expect(types(done)).toEqual(["payment.confirmed", "invoice.paid"]);
    });
    it("received after expiry: late", async () => {
      const seen = await at(T + 61 * MIN, obs(50_000n, 0n));
      const done = await at(T + 70 * MIN, obs(50_000n, 50_000n), seen, async () => BTC_100K);
      expect(done!.invoice).toMatchObject({ status: "paid", late: true });
      expect(types(done)).toEqual(["payment.confirmed", "invoice.paid", "invoice.late_payment"]);
    });
  });

  describe("the rate lock covers only funds seen inside it", () => {
    const at = (now: number, o: Observation, prev?: Transition | null, price: () => Promise<bigint> = noPrice) =>
      step({ invoice: prev?.invoice ?? invoice(), payment: prev?.payment ?? payment(), others: [], obs: o, now, currentPriceE8: price });

    it("dust inside the lock, the rest days later: the rest is credited at the current price and the invoice is late", async () => {
      const dust = await at(T + 5 * MIN, obs(1n, 1n));
      expect(dust!.payment).toMatchObject({ credit_price_e8: BTC_100K, credited_minor: 0n, locked_received: 1n });
      const rest = await at(T + 3 * DAY, obs(50_000n, 50_000n), dust, async () => BTC_80K);
      // 1 sat at the locked price (0 cents), 49,999 sat at $80k = 3999 cents: short of $50, not paid at the old rate.
      expect(rest!.payment).toMatchObject({ credited_minor: 3999n, later_atomic: 49_999n });
      expect(rest!.invoice).toMatchObject({ status: "partially_paid", paid_minor: 3999n });
      const full = await at(T + 3 * DAY + MIN, obs(63_000n, 63_000n), rest, async () => BTC_80K);
      expect(full!.invoice).toMatchObject({ status: "paid", late: true });
      expect(types(full)).toContain("invoice.late_payment");
    });

    it("an RBF'd tx inside the lock does not keep the lock for a later resend", async () => {
      const seen = await at(T + 5 * MIN, obs(50_000n, 0n));
      expect(seen!.payment.locked_received).toBe(50_000n);
      const gone = await at(T + 30 * MIN, { received: 0n, final: 0n, txids: [] }, seen);
      expect(gone!.payment).toMatchObject({ status: "awaiting", locked_received: 0n });
      const resent = await at(T + 2 * DAY, obs(50_000n, 50_000n), gone, async () => BTC_80K);
      expect(resent!.payment).toMatchObject({ credited_minor: 4000n, credit_price_e8: BTC_80K });
      expect(resent!.invoice).toMatchObject({ status: "partially_paid", paid_minor: 4000n });
    });

    it("a top-up inside the lock stays at the locked price", async () => {
      const first = await at(T + 5 * MIN, obs(20_000n, 20_000n));
      const more = await at(T + 10 * MIN, obs(50_000n, 50_000n), first);
      expect(more!.payment).toMatchObject({ credited_minor: 5000n, later_atomic: 0n });
      expect(more!.invoice).toMatchObject({ status: "paid", late: false });
    });

    it("a row written before the fix keeps its credit, and a top-up after the lock uses the current price", async () => {
      const run = (p: PaymentRow, inv: InvoiceRow, o: Observation) =>
        step({ invoice: inv, payment: p, others: [], obs: o, now: T + 2 * DAY, currentPriceE8: async () => BTC_80K });
      const locked = payment({ received: 50_000n, final: 50_000n, txids: ["tx1"], status: "confirmed", detected_at: T + 5 * MIN, confirmed_at: T + 5 * MIN, credited_minor: 5000n, credit_price_e8: BTC_100K });
      const paidInv = invoice({ status: "paid", paid_minor: 5000n });
      expect(await run(locked, paidInv, obs(50_000n, 50_000n))).toBeNull();
      expect((await run(locked, paidInv, obs(60_000n, 60_000n)))!.payment).toMatchObject({ credited_minor: 5800n, locked_received: 50_000n, later_atomic: 10_000n });
      const late = payment({ received: 50_000n, final: 50_000n, txids: ["tx1"], status: "confirmed", detected_at: T + 30 * MIN, confirmed_at: T + 30 * MIN, credited_minor: 4000n, credit_price_e8: BTC_80K });
      const partInv = invoice({ status: "partially_paid", paid_minor: 4000n });
      expect(await run(late, partInv, obs(50_000n, 50_000n))).toBeNull();
      expect((await run(late, partInv, obs(60_000n, 60_000n)))!.payment).toMatchObject({ credited_minor: 4800n, later_atomic: 60_000n, later_minor: 4800n });
    });
  });

  it("txids in a different order are not a change", async () => {
    const o = { received: 50_000n, final: 50_000n, txids: ["b", "a"] };
    const first = await step({ invoice: invoice(), payment: payment(), others: [], obs: o, now: T + 15 * MIN, currentPriceE8: noPrice });
    expect(first!.payment.txids).toEqual(["a", "b"]);
    const again = await step({
      invoice: first!.invoice,
      payment: first!.payment,
      others: [],
      obs: { ...o, txids: ["a", "b"] },
      now: T + 16 * MIN,
      currentPriceE8: noPrice,
    });
    expect(again).toBeNull();
  });

  describe("confirmed payment amounts never decrease", () => {
    const confirmed = (o: Partial<PaymentRow> = {}) =>
      payment({
        received: 50_000n,
        final: 50_000n,
        txids: ["tx1"],
        status: "confirmed",
        detected_at: T + 10 * MIN,
        confirmed_at: T + 15 * MIN,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
        ...o,
      });
    const run = (p: PaymentRow, inv: InvoiceRow, o: Observation, at = T + 30 * MIN, price: () => Promise<bigint> = noPrice) =>
      step({ invoice: inv, payment: p, others: [], obs: o, now: at, currentPriceE8: price });
    const paidInv = () => invoice({ status: "paid", paid_minor: 5000n });

    it("once swept, a partial payment's amounts never decrease either (a 0 balance does not regress credit)", async () => {
      const partial = confirmed({ status: "partial", swept_at: T + 20 * MIN, received: 20_000n, final: 20_000n, expected: 50_000n, credited_minor: 2000n });
      const inv = invoice({ status: "partially_paid", paid_minor: 2000n });
      expect(await run(partial, inv, { received: 0n, final: 0n, txids: [] })).toBeNull();
      const unswept = { ...partial, swept_at: null };
      const t = await run(unswept, inv, { received: 0n, final: 0n, txids: [] });
      expect(t?.payment.credited_minor).toBe(0n); // before the sweep the observation is followed
    });

    it("a payment with a sweep lock (sweep_tx set, not yet swept) keeps its amounts when the address reads 0", async () => {
      const locked = confirmed({ status: "partial", sweep_tx: "0xabc", received: 20_000n, final: 20_000n, credited_minor: 2000n });
      expect(await run(locked, invoice({ status: "partially_paid", paid_minor: 2000n }), { received: 0n, final: 0n, txids: [] })).toBeNull();
    });

    it("a lower observation (nothing seen) changes nothing", async () => {
      expect(await run(confirmed(), paidInv(), { received: 0n, final: 0n, txids: [] })).toBeNull();
    });

    it("a lower observation on a partially_paid (re-priced) invoice emits nothing", async () => {
      const p = confirmed({ credit_price_e8: BTC_80K, credited_minor: 4000n });
      const inv = invoice({ status: "partially_paid", paid_minor: 4000n });
      expect(await run(p, inv, { received: 0n, final: 0n, txids: [] })).toBeNull();
      expect(await run(p, inv, { received: 20_000n, final: 20_000n, txids: ["tx1"] })).toBeNull();
    });

    it("a lower observation then a top-up credits the higher amount", async () => {
      const p = confirmed();
      const inv = paidInv();
      expect(await run(p, inv, { received: 0n, final: 0n, txids: [] })).toBeNull();
      // The top-up arrives after the rate lock, so it is credited at the current price (here unchanged).
      const up = await run(p, inv, { received: 60_000n, final: 60_000n, txids: ["tx1", "tx2"] }, T + 30 * MIN, async () => BTC_100K);
      expect(up!.payment).toMatchObject({ received: 60_000n, final: 60_000n, credited_minor: 6000n, txids: ["tx1", "tx2"] });
      expect(up!.invoice).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
      expect(types(up)).toEqual([]);
    });

    it("a different txid set with lower totals keeps amounts and unions txids", async () => {
      const res = await run(confirmed(), paidInv(), { received: 10_000n, final: 10_000n, txids: ["tx0"] });
      expect(res).not.toBeNull();
      expect(res!.payment).toMatchObject({ received: 50_000n, final: 50_000n, credited_minor: 5000n, txids: ["tx0", "tx1"] });
      expect(res!.invoice).toMatchObject({ status: "paid", paid_minor: 5000n, overpaid: false });
      expect(types(res)).toEqual([]);
    });

    it("a detected (unconfirmed) payment whose received drops to 0 still drops", async () => {
      const p = payment({ received: 50_000n, txids: ["tx1"], status: "detected", detected_at: T + 10 * MIN });
      const res = await run(p, invoice(), { received: 0n, final: 0n, txids: [] });
      expect(res!.payment).toMatchObject({ received: 0n, final: 0n, status: "awaiting" });
    });
  });
});

describe("step: EVM balance observations", () => {
  const USDC_PRICE = 10n ** 8n;
  const evmPayment = (o: Partial<PaymentRow> = {}) =>
    payment({ asset: "base:usdc", chain: "base", expected: 50_000_000n, price_e8: USDC_PRICE, ...o });
  const run = (p: PaymentRow, o: Observation, at = T + 15 * MIN) =>
    step({ invoice: invoice(), payment: p, others: [], obs: o, now: at, currentPriceE8: noPrice });

  it("copies unexpected deposits into the row without emitting an event", async () => {
    const p = evmPayment({ received: 10_000_000n, status: "detected", detected_at: T + MIN });
    const res = await run(p, { received: 10_000_000n, final: 0n, txids: [], unexpected: { "base:eth": 1000n } });
    expect(res).not.toBeNull(); // a change in unexpected alone is a row change
    expect(res!.payment.unexpected).toEqual({ "base:eth": 1000n });
    expect(res!.events).toEqual([]);
    expect(res!.invoice).toMatchObject({ status: "open", paid_minor: 0n });
  });

  it("an unchanged unexpected map is no change at all", async () => {
    const p = evmPayment({ received: 10_000_000n, status: "detected", detected_at: T + MIN, unexpected: { "base:eth": 1000n } });
    expect(await run(p, { received: 10_000_000n, final: 0n, txids: [], unexpected: { "base:eth": 1000n } })).toBeNull();
  });

  it("an empty map clears it; an absent field leaves it alone", async () => {
    const p = evmPayment({ received: 10_000_000n, status: "detected", detected_at: T + MIN, unexpected: { "base:eth": 1000n } });
    expect((await run(p, { received: 10_000_000n, final: 0n, txids: [], unexpected: {} }))!.payment.unexpected).toBeNull();
    expect(await run(p, { received: 10_000_000n, final: 0n, txids: [] })).toBeNull();
  });

  describe("unexpected is kept per asset (max) once confirmed, locked or swept", () => {
    const seen = { "base:eth": 1000n, "base:dai": 7n };
    // The invoice already reflects the payment's credit, so only `unexpected` can change.
    const run = (p: PaymentRow, o: Observation) =>
      step({
        invoice: invoice({ status: p.credited_minor >= 5000n ? "paid" : "partially_paid", paid_minor: p.credited_minor }),
        payment: p, others: [], obs: o, now: T + 15 * MIN, currentPriceE8: noPrice,
      });
    const cases: [string, Partial<PaymentRow>][] = [
      ["confirmed", { status: "confirmed", received: 50_000_000n, final: 50_000_000n, confirmed_at: T + MIN, credited_minor: 5000n, credit_price_e8: USDC_PRICE }],
      ["under a sweep lock", { status: "partial", received: 20_000_000n, final: 20_000_000n, credited_minor: 2000n, credit_price_e8: USDC_PRICE, rate_locked_until: T, sweep_tx: "0xabc" }],
      ["swept", { status: "partial", received: 20_000_000n, final: 20_000_000n, credited_minor: 2000n, credit_price_e8: USDC_PRICE, rate_locked_until: T, swept_at: T + 2 * MIN }],
    ];
    for (const [name, o] of cases) {
      it(`${name}: a swept (empty) address keeps the record; a higher reading raises one asset, a lower one changes nothing`, async () => {
        const p = evmPayment({ detected_at: T + MIN, unexpected: seen, ...o });
        // Emptied by the sweep: nothing is lost.
        expect(await run(p, { received: 0n, final: 0n, txids: [], unexpected: {} })).toBeNull();
        // Lower for one asset, higher for another.
        const res = await run(p, { received: 0n, final: 0n, txids: [], unexpected: { "base:eth": 1n, "base:dai": 9n } });
        expect(res!.payment.unexpected).toEqual({ "base:eth": 1000n, "base:dai": 9n });
        expect(res!.events).toEqual([]);
        // A new asset is added next to the kept one.
        const added = await run({ ...p, unexpected: { "base:eth": 1000n } }, { received: 0n, final: 0n, txids: [], unexpected: { "base:dai": 3n } });
        expect(added!.payment.unexpected).toEqual({ "base:eth": 1000n, "base:dai": 3n });
      });
    }
    it("an unlocked, unconfirmed payment still follows the observation", async () => {
      const p = evmPayment({ received: 10_000_000n, status: "detected", detected_at: T + MIN, unexpected: seen });
      expect((await run(p, { received: 10_000_000n, final: 0n, txids: [], unexpected: { "base:eth": 5n } }))!.payment.unexpected).toEqual({ "base:eth": 5n });
    });
  });

  it("unexpected amounts are never credited", async () => {
    const res = await run(evmPayment(), { received: 0n, final: 0n, txids: [], unexpected: { "base:dai": 10n ** 21n } });
    expect(res!.payment).toMatchObject({ status: "awaiting", credited_minor: 0n });
    expect(res!.invoice).toMatchObject({ status: "open", paid_minor: 0n });
  });

  it("a confirmed payment whose address later reads 0 (swept) stays credited", async () => {
    const confirmed = await run(evmPayment(), { received: 50_000_000n, final: 50_000_000n, txids: [] });
    expect(confirmed!.payment).toMatchObject({ status: "confirmed", credited_minor: 5000n });
    const swept = await step({
      invoice: confirmed!.invoice,
      payment: confirmed!.payment,
      others: [],
      obs: { received: 0n, final: 0n, txids: [], unexpected: {} },
      now: T + 30 * MIN,
      currentPriceE8: noPrice,
    });
    // Nothing changed (the amounts are monotonic), so there is no transition to apply; if one were produced it would hold the same credit.
    const { payment: p, invoice: i } = swept ?? confirmed!;
    expect(p).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n, credited_minor: 5000n });
    expect(i).toMatchObject({ status: "paid", paid_minor: 5000n });
    expect(swept?.events ?? []).toEqual([]);
  });

  describe("a refill after a sweep", () => {
    const swept = () =>
      evmPayment({
        received: 100_000_000n, final: 100_000_000n, status: "confirmed", detected_at: T + MIN, confirmed_at: T + 2 * MIN,
        credited_minor: 10_000n, credit_price_e8: USDC_PRICE, swept_at: T + 10 * MIN, sweep_tx: "0xsweep", swept_base: 100_000_000n,
      });
    const paid = () => invoice({ price_minor: 10_000n, status: "paid", paid_minor: 10_000n });
    const at = (p: PaymentRow, o: Observation, now = T + 2 * 60 * MIN) => step({ invoice: paid(), payment: p, others: [], obs: o, now, currentPriceE8: async () => USDC_PRICE });

    it("a smaller second deposit is credited on top and sends the payment back to the sweeper", async () => {
      const r = await at(swept(), { received: 90_000_000n, final: 90_000_000n, txids: [] });
      expect(r!.payment).toMatchObject({ received: 190_000_000n, final: 190_000_000n, credited_minor: 19_000n });
      expect(r!.invoice).toMatchObject({ status: "paid", paid_minor: 19_000n, overpaid: true });
      expect(r!.resweep).toBe(true);
    });
    it("an empty swept address changes nothing", async () => {
      expect(await at(swept(), { received: 0n, final: 0n, txids: [] })).toBeNull();
    });
    it("once swept again, the emptied address keeps the full credit", async () => {
      const again = { ...swept(), received: 190_000_000n, final: 190_000_000n, credited_minor: 19_000n, swept_base: 190_000_000n, later_atomic: 90_000_000n, later_minor: 9_000n, locked_received: 100_000_000n, expiry_received: 100_000_000n };
      const r = await step({ invoice: invoice({ price_minor: 10_000n, status: "paid", paid_minor: 19_000n, overpaid: true }), payment: again, others: [], obs: { received: 0n, final: 0n, txids: [] }, now: T + 3 * 60 * MIN, currentPriceE8: noPrice });
      expect(r).toBeNull();
    });
    it("UTXO chains never add a swept base", async () => {
      const utxo = payment({ received: 50_000n, final: 50_000n, status: "confirmed", detected_at: T + MIN, confirmed_at: T + MIN, credited_minor: 5000n, credit_price_e8: BTC_100K, swept_base: 50_000n });
      const r = await step({ invoice: invoice({ status: "paid", paid_minor: 5000n }), payment: utxo, others: [], obs: { received: 50_000n, final: 50_000n, txids: [] }, now: T + 2 * 60 * MIN, currentPriceE8: noPrice });
      expect(r).toBeNull();
    });
  });
});
