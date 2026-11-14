import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { step } from "../../src/core/state";
import {
  allocateIndex,
  applyTransition,
  getInvoice,
  getPayment,
  INVOICE_COLUMNS,
  insertInvoice,
  insertInvoiceIfChanged,
  insertPayment,
  invoiceRowValues,
  listPayments,
  type EventRow,
  type InvoiceRow,
  type PaymentRow,
} from "../../src/db/repo";

const db = () => env.DB;

function invoice(id: string, over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id,
    created_at: 1000,
    expires_at: 2000,
    price_minor: 5000n,
    currency: "USD",
    order_id: "ord-1",
    metadata: { a: 1 },
    success_url: null,
    allowed_assets: ["btc:btc"],
    status: "open",
    late: false,
    overpaid: false,
    paid_minor: 0n,
    ...over,
  };
}

function payment(id: string, invoiceId: string, over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id,
    invoice_id: invoiceId,
    asset: "btc:btc",
    chain: "btc",
    address: `addr-${id}`,
    derivation_index: 0,
    reference: null,
    expected: 123456789012345678901234n,
    price_e8: 6000000000000n,
    rate_locked_until: 3000,
    received: 0n,
    final: 0n,
    txids: [],
    status: "awaiting",
    created_at: 1000,
    detected_at: null,
    confirmed_at: null,
    credited_minor: 0n,
    credit_price_e8: null,
    unexpected: null,
    ...over,
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("schema", () => {
  it("indexes the foreign keys that lookups filter on", async () => {
    const { results } = await db()
      .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all<{ tbl_name: string; sql: string }>();
    const on = (table: string, col: string) => results.some((r) => r.tbl_name === table && r.sql.includes(`(${col})`));
    expect(on("payments", "invoice_id")).toBe(true);
    expect(on("events", "invoice_id")).toBe(true);
    expect(on("deliveries", "event_id")).toBe(true);
  });
});

describe("allocateIndex", () => {
  it("increments per chain from 0", async () => {
    expect(await allocateIndex(db(), "btc")).toBe(0);
    expect(await allocateIndex(db(), "btc")).toBe(1);
    expect(await allocateIndex(db(), "btc")).toBe(2);
  });

  it("is independent per chain", async () => {
    expect(await allocateIndex(db(), "ltc")).toBe(0);
  });

  it("starts at the configured start index and never goes backwards", async () => {
    expect(await allocateIndex(db(), "eth", 5)).toBe(5);
    expect(await allocateIndex(db(), "eth", 5)).toBe(6);
    expect(await allocateIndex(db(), "eth")).toBe(7); // a lower start never rewinds
    expect(await allocateIndex(db(), "eth", 100)).toBe(100); // a raised start skips ahead
    expect(await allocateIndex(db(), "eth", 3)).toBe(101);
  });

  it("hands out unique indexes from the start index under concurrency", async () => {
    const got = await Promise.all(Array.from({ length: 10 }, () => allocateIndex(db(), "sol", 40)));
    expect(new Set(got)).toEqual(new Set(Array.from({ length: 10 }, (_, i) => 40 + i)));
  });

  it("hands out unique indexes under concurrency", async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => allocateIndex(db(), "doge")));
    expect(new Set(got)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => i)));
  });
});

describe("round trip", () => {
  it("round-trips unexpected deposits as decimal strings; empty or null reads back null", async () => {
    await insertInvoice(db(), invoice("inv_un"));
    const big = 123456789012345678901234567890n;
    await insertPayment(db(), payment("pay_un", "inv_un", { unexpected: { "base:eth": big, "base:dai": 5n } }));
    await insertPayment(db(), payment("pay_un2", "inv_un", { unexpected: {} }));
    await insertPayment(db(), payment("pay_un3", "inv_un"));
    expect((await getPayment(db(), "pay_un"))?.unexpected).toEqual({ "base:eth": big, "base:dai": 5n });
    expect((await getPayment(db(), "pay_un2"))?.unexpected).toBeNull();
    expect((await getPayment(db(), "pay_un3"))?.unexpected).toBeNull();
    const raw = await db().prepare("SELECT unexpected FROM payments WHERE id='pay_un'").first<{ unexpected: string }>();
    expect(JSON.parse(raw!.unexpected)).toEqual({ "base:eth": big.toString(), "base:dai": "5" });
    await applyTransition(db(), { payment: { ...(await getPayment(db(), "pay_un"))!, unexpected: null }, invoice: invoice("inv_un"), events: [] });
    expect((await getPayment(db(), "pay_un"))?.unexpected).toBeNull();
  });
  it("preserves bigint amounts and JSON fields", async () => {
    await insertInvoice(db(), invoice("inv_rt"));
    await insertPayment(db(), payment("pay_rt", "inv_rt", { txids: ["tx1"], credit_price_e8: 7n, detected_at: 1500 }));
    const inv = await getInvoice(db(), "inv_rt");
    expect(inv).toEqual(invoice("inv_rt"));
    const p = await getPayment(db(), "pay_rt");
    expect(p?.expected).toBe(123456789012345678901234n);
    expect(p?.txids).toEqual(["tx1"]);
    expect(p?.credit_price_e8).toBe(7n);
    expect(p?.detected_at).toBe(1500);
    expect((await listPayments(db(), "inv_rt")).map((x) => x.id)).toEqual(["pay_rt"]);
    expect(await getInvoice(db(), "nope")).toBeNull();
    expect(await getPayment(db(), "nope")).toBeNull();
  });
});

describe("applyTransition", () => {
  const ev = (id: string, invoiceId: string): EventRow => ({
    id,
    created_at: 1,
    type: "invoice.paid",
    invoice_id: invoiceId,
    payload: "{}",
  });

  it("writes payment, invoice and events together", async () => {
    await insertInvoice(db(), invoice("inv_ok"));
    const p = payment("pay_ok", "inv_ok");
    await insertPayment(db(), p);
    await applyTransition(db(), {
      payment: { ...p, status: "confirmed", received: 10n, final: 10n },
      invoice: invoice("inv_ok", { status: "paid", paid_minor: 5000n, late: true, overpaid: true }),
      events: [ev("evt_ok", "inv_ok")],
    });
    expect((await getPayment(db(), "pay_ok"))?.status).toBe("confirmed");
    const inv = await getInvoice(db(), "inv_ok");
    expect(inv?.status).toBe("paid");
    expect(inv?.late).toBe(true);
    const e = await db().prepare("SELECT COUNT(*) AS n FROM events WHERE id='evt_ok'").first<{ n: number }>();
    expect(e?.n).toBe(1);
  });

  it("is atomic when the invoice update fails", async () => {
    await insertInvoice(db(), invoice("inv_at"));
    const p = payment("pay_at", "inv_at");
    await insertPayment(db(), p);
    await expect(
      applyTransition(db(), {
        payment: { ...p, status: "confirmed" },
        // currency NOT NULL violation on the second statement forces the batch to fail after the payment update
        invoice: invoice("inv_at", { status: "paid", currency: null as unknown as string }),
        events: [ev("evt_at", "inv_at")],
      }),
    ).rejects.toThrow();
    expect((await getPayment(db(), "pay_at"))?.status).toBe("awaiting");
    expect((await getInvoice(db(), "inv_at"))?.status).toBe("open");
  });

  it("fails the whole batch on a NOT NULL event violation (only duplicate ids are ignored)", async () => {
    await insertInvoice(db(), invoice("inv_nn"));
    const p = payment("pay_nn", "inv_nn");
    await insertPayment(db(), p);
    await expect(
      applyTransition(db(), {
        payment: { ...p, status: "confirmed" },
        invoice: invoice("inv_nn", { status: "paid" }),
        events: [{ ...ev("evt_nn", "inv_nn"), payload: null as unknown as string }],
      }),
    ).rejects.toThrow(/NOT NULL/);
    expect((await getPayment(db(), "pay_nn"))?.status).toBe("awaiting");
    expect((await getInvoice(db(), "inv_nn"))?.status).toBe("open");
  });

  it("survives a reorg that re-emits an event id (received 50k -> 0 -> 50k)", async () => {
    await insertInvoice(db(), invoice("inv_re", { expires_at: 10_000_000 }));
    const p = payment("pay_re", "inv_re", { expected: 50_000n, price_e8: 100_000n * 10n ** 8n, rate_locked_until: 5_000_000 });
    await insertPayment(db(), p);
    let inv = (await getInvoice(db(), "inv_re"))!;
    let pay = (await getPayment(db(), "pay_re"))!;
    for (const [received, at] of [[50_000n, 2000], [0n, 3000], [50_000n, 4000]] as const) {
      const t = await step({
        invoice: inv,
        payment: pay,
        others: [],
        obs: { received, final: 0n, txids: [] },
        now: at,
        currentPriceE8: async () => 1n,
      });
      expect(t).not.toBeNull();
      await applyTransition(db(), t!);
      inv = (await getInvoice(db(), "inv_re"))!;
      pay = (await getPayment(db(), "pay_re"))!;
    }
    expect(pay.status).toBe("confirming");
    expect(pay.detected_at).toBe(2000); // first sighting survives the reorg
    const r = await db()
      .prepare("SELECT COUNT(*) AS n FROM events WHERE id='payment.detected:pay_re:1'")
      .first<{ n: number }>();
    expect(r?.n).toBe(1);
  });
});

describe("invoice insert column parity", () => {
  it("one column list: every listed column exists, every required schema column is listed, values match one-to-one", async () => {
    const info = (await db().prepare("PRAGMA table_info(invoices)").all<{ name: string; notnull: number; dflt_value: unknown; pk: number }>()).results;
    const schema = new Set(info.map((c) => c.name));
    for (const c of INVOICE_COLUMNS) expect(schema.has(c), c).toBe(true);
    for (const c of info) if (c.notnull && c.dflt_value === null) expect(INVOICE_COLUMNS as readonly string[], c.name).toContain(c.name);
    expect(INVOICE_COLUMNS[0]).toBe("id");
    expect(new Set(INVOICE_COLUMNS).size).toBe(INVOICE_COLUMNS.length);
    expect(invoiceRowValues(invoice("inv_parity0")).length).toBe(INVOICE_COLUMNS.length);
  });
  it("insertInvoiceIfChanged writes exactly what insertInvoice writes, and nothing after a statement that changed no row", async () => {
    const over: Partial<InvoiceRow> = { order_id: "o-9", metadata: { k: "v" }, success_url: "https://m.example/ok", allowed_assets: ["ltc:ltc"], status: "partially_paid", late: true, overpaid: true, paid_minor: 123n, price_minor: 777n, currency: "EUR", created_at: 11, expires_at: 22 };
    await insertInvoice(db(), invoice("inv_parity1", over));
    await db().prepare("CREATE TABLE IF NOT EXISTS parity_probe(x INTEGER)").run();
    await db().batch([db().prepare("INSERT INTO parity_probe(x) VALUES(1)"), insertInvoiceIfChanged(db(), invoice("inv_parity2", over))]);
    const [a, b] = [(await getInvoice(db(), "inv_parity1"))!, (await getInvoice(db(), "inv_parity2"))!];
    expect({ ...b, id: "x" }).toEqual({ ...a, id: "x" });
    await db().batch([db().prepare("UPDATE parity_probe SET x=2 WHERE x=-1"), insertInvoiceIfChanged(db(), invoice("inv_parity3", over))]);
    expect(await getInvoice(db(), "inv_parity3")).toBeNull();
  });
});
