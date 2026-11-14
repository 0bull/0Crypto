import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { getInvoice, insertInvoice, insertPayment, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { expireStaleInvoices } from "../../src/watcher/expiry";

const e = env as unknown as Env;
const NOW = 1_900_000_000_000;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterAll(() => network.disable());

const invoice = (id: string, o: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id, created_at: NOW - 7_200_000, expires_at: NOW - 3_600_000, price_minor: 5000n, currency: "USD", order_id: null, metadata: null,
  success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...o,
});
const payment = (id: string, invoiceId: string): PaymentRow => ({
  id, invoice_id: invoiceId, asset: "btc:btc", chain: "btc", address: `bc1qexp${id}`, derivation_index: 0, reference: null,
  expected: 50_000n, price_e8: 1n, rate_locked_until: NOW, received: 0n, final: 0n, txids: [], status: "awaiting",
  created_at: NOW - 7_000_000, detected_at: null, confirmed_at: null, credited_minor: 0n, credit_price_e8: null, unexpected: null,
});
const events = async (invoiceId: string) =>
  (await env.DB.prepare("SELECT id,type,payload,created_at FROM events WHERE invoice_id=?").bind(invoiceId).all()).results;

const eh = { ...e, WEBHOOK_URL: "https://merchant.test/hook" } as Env;

describe("expireStaleInvoices", () => {
  it("expires open, past-due invoices without payments and emits invoice.expired once", async () => {
    await insertInvoice(e.DB, invoice("inv_exp_a"));
    await insertInvoice(e.DB, invoice("inv_exp_future", { expires_at: NOW + 1000 }));
    await insertInvoice(e.DB, invoice("inv_exp_paid", { status: "paid", paid_minor: 5000n }));
    await insertInvoice(e.DB, invoice("inv_exp_haspay"));
    await insertPayment(e.DB, payment("pay_exp_1", "inv_exp_haspay"));
    const sendBatch = vi.spyOn(e.WEBHOOKS, "sendBatch");

    await expireStaleInvoices(eh, NOW);

    expect((await getInvoice(e.DB, "inv_exp_a"))!.status).toBe("expired");
    expect((await getInvoice(e.DB, "inv_exp_future"))!.status).toBe("open");
    expect((await getInvoice(e.DB, "inv_exp_paid"))!.status).toBe("paid");
    expect((await getInvoice(e.DB, "inv_exp_haspay"))!.status).toBe("open"); // its watcher decides
    expect(await events("inv_exp_a")).toEqual([
      {
        id: "invoice.expired:inv_exp_a:1",
        type: "invoice.expired",
        created_at: NOW,
        payload: JSON.stringify({ invoice_id: "inv_exp_a", status: "expired", paid_minor: "0" }),
      },
    ]);
    expect(await events("inv_exp_haspay")).toEqual([]);
    const sent = sendBatch.mock.calls.flatMap((c) => (c[0] as { body: { eventId: string } }[]).map((m) => m.body.eventId));
    expect(sent).toEqual(["invoice.expired:inv_exp_a:1"]);
    const marked = await env.DB.prepare("SELECT enqueued_at FROM events WHERE id='invoice.expired:inv_exp_a:1'").first<{ enqueued_at: number }>();
    expect(marked?.enqueued_at).toBe(NOW);

    // A second sweep finds nothing to do.
    sendBatch.mockClear();
    await expireStaleInvoices(eh, NOW + 500);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(await events("inv_exp_a")).toHaveLength(1);
    sendBatch.mockRestore();
  });

  it("re-checks in the write: an invoice that changed after the select is left alone", async () => {
    await insertInvoice(e.DB, invoice("inv_exp_raced"));
    await insertPayment(e.DB, payment("pay_exp_raced", "inv_exp_raced")); // created between SELECT and UPDATE
    const stale = { bind: () => ({ all: async () => ({ results: [{ id: "inv_exp_raced" }] }) }) };
    const prepare = vi.spyOn(e.DB, "prepare").mockImplementationOnce(() => stale as unknown as D1PreparedStatement);
    const sendBatch = vi.spyOn(e.WEBHOOKS, "sendBatch");
    await expireStaleInvoices(eh, NOW);
    expect((await getInvoice(e.DB, "inv_exp_raced"))!.status).toBe("open");
    expect(await events("inv_exp_raced")).toEqual([]);
    expect(sendBatch).not.toHaveBeenCalled();
    prepare.mockRestore();
    sendBatch.mockRestore();
  });

  it("keeps the expiry when enqueueing fails (the outbox cron re-sends it)", async () => {
    await insertInvoice(e.DB, invoice("inv_exp_q"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendBatch = vi.spyOn(e.WEBHOOKS, "sendBatch").mockRejectedValueOnce(new Error("queue down"));
    await expireStaleInvoices(eh, NOW);
    expect((await getInvoice(e.DB, "inv_exp_q"))!.status).toBe("expired");
    const row = await env.DB.prepare("SELECT enqueued_at FROM events WHERE id='invoice.expired:inv_exp_q:1'").first<{ enqueued_at: number | null }>();
    expect(row).toEqual({ enqueued_at: null });
    expect(warn).toHaveBeenCalled();
    sendBatch.mockRestore();
    warn.mockRestore();
  });

  it("runs from the cron", async () => {
    await insertInvoice(e.DB, invoice("inv_exp_cron", { expires_at: Date.now() - 1000 }));
    network.use(http.get("https://api.kraken.com/0/public/Ticker", () => new HttpResponse(null, { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "* * * * *" }), e, ctx);
    await waitOnExecutionContext(ctx);
    expect((await getInvoice(e.DB, "inv_exp_cron"))!.status).toBe("expired");
    warn.mockRestore();
  });
});
