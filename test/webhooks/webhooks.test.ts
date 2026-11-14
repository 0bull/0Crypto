import { applyD1Migrations, createMessageBatch, createExecutionContext, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertInvoice, insertPayment, applyTransition, type EventRow, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env, WebhookJob } from "../../src/env";
import { serializeInvoice } from "../../src/api/serialize";
import { handleWebhookBatch } from "../../src/webhooks/consumer";
import { enqueueEvents, enqueueNonInvoiceEvents } from "../../src/webhooks/outbox";
import { NON_INVOICE_EVENTS, nonInvoiceEventData } from "../../src/webhooks/routing";
import { recordRefundApproved } from "../../src/routing/refund-alert";
import type { RefundRow } from "../../src/routing/refund";
import { signWebhook, verifyWebhook } from "../../src/webhooks/sign";

const network = setupNetwork();
const e = env as unknown as Env;
const URL_ = "https://merchant.test/hook";

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seed();
});
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => network.disable());

const inv: InvoiceRow = {
  id: "inv_wh",
  created_at: 1_700_000_000_000,
  expires_at: 1_700_003_600_000,
  price_minor: 5000n,
  currency: "USD",
  order_id: "o1",
  metadata: { k: "v" },
  success_url: null,
  allowed_assets: null,
  status: "paid",
  late: false,
  overpaid: false,
  paid_minor: 5000n,
};
const pay: PaymentRow = {
  id: "pay_wh",
  invoice_id: "inv_wh",
  asset: "btc:btc",
  chain: "btc",
  address: "bc1qtest",
  derivation_index: 7,
  reference: null,
  expected: 50000n,
  price_e8: 10000000000000n,
  rate_locked_until: 1_700_001_200_000,
  received: 50000n,
  final: 50000n,
  txids: ["tx1"],
  status: "confirmed",
  created_at: 1_700_000_000_000,
  detected_at: 1_700_000_100_000,
  confirmed_at: 1_700_000_500_000,
  unexpected: null,
  credited_minor: 5000n,
  credit_price_e8: 10000000000000n,
};
const event: EventRow = { id: "evt_1", created_at: 1_700_000_600_000, type: "invoice.paid", invoice_id: "inv_wh", payload: "{}" };

async function seed() {
  await insertInvoice(env.DB, inv);
  await insertPayment(env.DB, pay);
  await applyTransition(env.DB, { payment: pay, invoice: inv, events: [event] });
}

function batchOf(ids: string[], attempts = 1) {
  return createMessageBatch<WebhookJob>(
    "0crypto-webhooks",
    ids.map((id, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body: { eventId: id } })),
  );
}

describe("signing", () => {
  it("matches the pinned HMAC", async () => {
    expect(await signWebhook("whsec_test", '{"a":1}', 1700000000)).toBe(
      "t=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789",
    );
  });
  it("verifies, rejects tampering and stale timestamps", async () => {
    const h = await signWebhook("whsec_test", '{"a":1}', 1700000000);
    expect(await verifyWebhook("whsec_test", h, '{"a":1}', 1700000100)).toBe(true);
    expect(await verifyWebhook("whsec_test", h, '{"a":2}', 1700000100)).toBe(false);
    expect(await verifyWebhook("whsec_test", h, '{"a":1}', 1700000301)).toBe(false);
    expect(await verifyWebhook("other", h, '{"a":1}', 1700000100)).toBe(false);
    expect(await verifyWebhook("whsec_test", "garbage", '{"a":1}', 1700000100)).toBe(false);
  });
});

describe("verifyWebhook hardening", () => {
  const body = '{"a":1}';
  const good = async () => (await signWebhook("s", body, 1700000000)).split(",")[1]!;
  it("rejects malformed input without throwing", async () => {
    const v1 = await good();
    for (const h of [null, undefined, "", "t=1700000000", v1, `t=1e3,${v1}`, `t=0x10,${v1}`, `t=,${v1}`, "t=1700000000,v1=zz" + "0".repeat(62), `t=1700000000,${v1.toUpperCase()}`]) {
      expect(await verifyWebhook("s", h, body, 1700000000)).toBe(false);
    }
  });
  it("accepts spaces around commas and rejects future t", async () => {
    const v1 = await good();
    expect(await verifyWebhook("s", ` t=1700000000 , ${v1} `, body, 1700000000)).toBe(true);
    expect(await verifyWebhook("s", `t=1700000000,${v1}`, body, 1699999000)).toBe(false);
  });
});

describe("serializeInvoice", () => {
  it("formats fiat with two decimals and hides internals", () => {
    const out = serializeInvoice({ ...inv, price_minor: 5050n, paid_minor: 7n }, [pay], "https://pay.test");
    expect(out.price_amount).toBe("50.50");
    expect(out.paid_amount).toBe("0.07");
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/derivation_index|price_e8|credit_price_e8/);
    expect(serializeInvoice(inv, [], "u").price_amount).toBe("50.00");
  });
  it("does not expose unexpected deposits", () => {
    const out = serializeInvoice(inv, [{ ...pay, unexpected: { "base:eth": 10n ** 16n } }], "u");
    expect(JSON.stringify(out)).not.toMatch(/unexpected|base:eth/);
  });
  it("formats stored unix ms as ISO timestamps", () => {
    const out = serializeInvoice(inv, [pay], "u");
    expect(out.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(out.created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(out.expires_at).toBe(new Date(1_700_003_600_000).toISOString());
    expect(out.payments[0]!.rate_locked_until).toBe(new Date(1_700_001_200_000).toISOString());
  });
});

describe("consumer", () => {
  const withUrl = { ...e, WEBHOOK_URL: URL_, WEBHOOK_SECRET: "whsec_test", PUBLIC_URL: "https://pay.test" } as Env;

  it("retries with 60s delay on 500 and records the delivery", async () => {
    network.use(http.post(URL_, () => new HttpResponse("boom", { status: 500 })));
    const batch = batchOf(["evt_1"], 1);
    const retry = vi.spyOn(batch.messages[0]!, "retry");
    const before = Date.now();
    await handleWebhookBatch(batch, withUrl);
    const r = await getQueueResult(batch, createExecutionContext());
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(r.retryMessages).toEqual([{ msgId: "m0" }]);
    expect(r.ackAll).toBe(false);
    const row = await env.DB.prepare("SELECT * FROM deliveries WHERE event_id='evt_1' AND status=500").first<{
      attempt: number;
      at: number;
      error: string;
    }>();
    expect(row?.attempt).toBe(1);
    // stored times are unix ms
    expect(row?.at).toBeGreaterThanOrEqual(before);
    expect(row?.at).toBeLessThanOrEqual(Date.now());
    expect(row?.error).toContain("500");
  });

  it("acks on 200, signs the exact body, and repeats identical ids", async () => {
    const seen: { body: string; sig: string; old: string | null; ua: string | null; ct: string | null }[] = [];
    network.use(
      http.post(URL_, async ({ request }) => {
        seen.push({
          body: await request.text(),
          sig: request.headers.get("0crypto-signature")!,
          old: request.headers.get("paygate-signature"),
          ua: request.headers.get("user-agent"),
          ct: request.headers.get("content-type"),
        });
        return new HttpResponse("ok", { status: 200 });
      }),
    );
    for (let i = 0; i < 2; i++) {
      const batch = batchOf(["evt_1"], i + 1);
      await handleWebhookBatch(batch, withUrl);
      const r = await getQueueResult(batch, createExecutionContext());
      expect(r.explicitAcks).toEqual(["m0"]);
      expect(r.retryMessages).toEqual([]);
    }
    expect(seen).toHaveLength(2);
    const [a, b] = seen.map((s) => JSON.parse(s.body));
    expect(a.id).toBe("evt_1");
    expect(b.id).toBe(a.id);
    expect(a.type).toBe("invoice.paid");
    expect(a.created_at).toBe("2023-11-14T22:23:20.000Z");
    expect(a.data.checkout_url).toBe("https://pay.test/i/inv_wh");
    expect(a.data.payments[0].amount).toBe("0.0005");
    expect(JSON.stringify(a)).not.toMatch(/derivation_index|price_e8/);
    expect(seen[0]!.ua).toBe("0crypto-webhooks/1");
    expect(seen[0]!.ct).toBe("application/json");
    expect(seen[0]!.old).toBeNull();
    expect(seen[0]!.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const t = Number(/t=(\d+)/.exec(seen[0]!.sig)![1]);
    expect(await verifyWebhook("whsec_test", seen[0]!.sig, seen[0]!.body, t)).toBe(true);
  });

  it("treats 3xx as failure without following redirects", async () => {
    let hits = 0;
    network.use(
      http.post(URL_, () => new HttpResponse(null, { status: 302, headers: { location: "https://evil.test/x" } })),
      http.post("https://evil.test/x", () => {
        hits++;
        return new HttpResponse("ok");
      }),
    );
    const batch = batchOf(["evt_1"], 1);
    const retry = vi.spyOn(batch.messages[0]!, "retry");
    await handleWebhookBatch(batch, withUrl);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(hits).toBe(0);
  });

  it("still acks/retries when recording the delivery fails", async () => {
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("INSERT INTO deliveries")) throw new Error("db down");
      return real(sql);
    }) as typeof env.DB.prepare);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    network.use(http.post(URL_, () => new HttpResponse("ok", { status: 200 })));
    const ok = batchOf(["evt_1"], 1);
    await handleWebhookBatch(ok, withUrl);
    expect((await getQueueResult(ok, createExecutionContext())).explicitAcks).toEqual(["m0"]);
    network.use(http.post(URL_, () => new HttpResponse("no", { status: 500 })));
    const bad = batchOf(["evt_1"], 1);
    const retry = vi.spyOn(bad.messages[0]!, "retry");
    await handleWebhookBatch(bad, withUrl);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    spy.mockRestore();
  });

  it("redacts raw error messages from delivery rows", async () => {
    network.use(http.post(URL_, () => HttpResponse.error()));
    const batch = batchOf(["evt_1"], 7);
    await handleWebhookBatch(batch, withUrl);
    const row = await env.DB.prepare("SELECT error FROM deliveries WHERE event_id='evt_1' AND attempt=7").first<{ error: string }>();
    expect(row?.error).toMatch(/network error|timeout/);
    expect(row?.error).not.toContain("merchant.test");
  });

  it("retries on network error with status 0", async () => {
    network.use(http.post(URL_, () => HttpResponse.error()));
    const batch = batchOf(["evt_1"], 3);
    const retry = vi.spyOn(batch.messages[0]!, "retry");
    await handleWebhookBatch(batch, withUrl);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    const row = await env.DB.prepare("SELECT status FROM deliveries WHERE event_id='evt_1' AND attempt=3").first<{ status: number }>();
    expect(row?.status).toBe(0);
  });

  it("caps retry delay at 21600", async () => {
    network.use(http.post(URL_, () => new HttpResponse(null, { status: 503 })));
    const batch = batchOf(["evt_1"], 20);
    const retry = vi.spyOn(batch.messages[0]!, "retry");
    await handleWebhookBatch(batch, withUrl);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 21600 });
  });

  it("acks silently when WEBHOOK_URL is unset", async () => {
    const batch = batchOf(["evt_1"]);
    await handleWebhookBatch(batch, { ...withUrl, WEBHOOK_URL: undefined });
    const r = await getQueueResult(batch, createExecutionContext());
    expect(r.explicitAcks).toEqual(["m0"]);
  });

  it("acks and warns when the event is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const batch = batchOf(["evt_missing"]);
    await handleWebhookBatch(batch, withUrl);
    const r = await getQueueResult(batch, createExecutionContext());
    expect(r.explicitAcks).toEqual(["m0"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("evt_missing"));
  });
});

describe("enqueueEvents", () => {
  it("is a no-op for an empty list and chunks by 100", async () => {
    const sendBatch = vi.fn(async () => {});
    const fake = { ...e, WEBHOOK_URL: "https://merchant.test/hook", WEBHOOKS: { sendBatch } } as unknown as Env;
    await enqueueEvents(fake, []);
    expect(sendBatch).not.toHaveBeenCalled();
    const evs = Array.from({ length: 250 }, (_, i) => ({ ...event, id: `e${i}` }));
    await enqueueEvents(fake, evs);
    expect(sendBatch.mock.calls.map((c) => (c as unknown as [unknown[]])[0].length)).toEqual([100, 100, 50]);
    expect((sendBatch.mock.calls[0] as unknown as [unknown[]])[0][0]).toEqual({ body: { eventId: "e0" } });
  });
});

describe("refund.approved (Plan 9)", () => {
  const refund: RefundRow = {
    id: "rf_wh", payment_id: "pay_wh", to_address: "bc1qcustomer", amount: "1234", approved_at: 1, tx: null, consumed_at: null, created_at: 1,
    claim: null, claimed_at: null, sent_at: null, error: null, cancelled_at: null, inputs: null, tx_at: null,
  };

  it("recordRefundApproved: an alert (never deduped) and one event per alert, its payload the refund; enqueued with the non-invoice events", async () => {
    await recordRefundApproved(e, refund, pay, 1_700_000_700_000);
    await recordRefundApproved(e, refund, pay, 1_700_000_700_001);
    const alerts = (await env.DB.prepare("SELECT * FROM alerts WHERE kind='refund.approved' ORDER BY created_at").all<{ id: string; chain: string; detail: string }>()).results;
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ chain: "btc" });
    expect(alerts[0]!.detail).toContain("Refund approved: 1234 btc:btc (atomic units) from payment pay_wh to bc1qcustomer.");
    const evs = (await env.DB.prepare("SELECT * FROM events WHERE type='refund.approved' ORDER BY created_at").all<EventRow & { enqueued_at: number | null }>()).results;
    expect(evs.map((x) => x.id)).toEqual(alerts.map((a) => `refund.approved:${a.id}`));
    expect(JSON.parse(evs[0]!.payload)).toEqual({ refund_id: "rf_wh", payment_id: "pay_wh", invoice_id: "inv_wh", asset: "btc:btc", amount: "1234", to_address: "bc1qcustomer" });
    expect(nonInvoiceEventData("refund.approved", alerts[0]!.id, evs[0]!.payload, null)).toEqual({
      object: "refund", id: "rf_wh", payment_id: "pay_wh", invoice_id: "inv_wh", asset: "btc:btc", amount: "1234", to_address: "bc1qcustomer", alert_id: alerts[0]!.id,
    });
    expect(NON_INVOICE_EVENTS.has("refund.approved")).toBe(true);
    await enqueueNonInvoiceEvents(e, 1_700_000_800_000);
    const marked = await env.DB.prepare("SELECT count(*) AS n FROM events WHERE type='refund.approved' AND enqueued_at=1700000800000").first<{ n: number }>();
    expect(marked!.n).toBe(2);
  });

  it("recordRefundApproved throws when D1 fails (the caller sends nothing)", async () => {
    vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("D1 down"));
    await expect(recordRefundApproved(e, refund, pay, 1_700_000_900_000)).rejects.toThrow("D1 down");
  });

  it("delivered: data.object is refund", async () => {
    await env.DB.prepare("DELETE FROM events WHERE type='refund.approved'").run();
    await recordRefundApproved(e, refund, pay, 1_700_001_000_000);
    const ev = (await env.DB.prepare("SELECT id FROM events WHERE type='refund.approved'").first<{ id: string }>())!;
    const seen: string[] = [];
    network.use(http.post(URL_, async ({ request }) => (seen.push(await request.text()), new HttpResponse("ok", { status: 200 }))));
    const batch = batchOf([ev.id]);
    await handleWebhookBatch(batch, { ...e, WEBHOOK_URL: URL_, WEBHOOK_SECRET: "whsec_test" } as Env);
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual(["m0"]);
    const body = JSON.parse(seen[0]!) as { id: string; type: string; data: Record<string, unknown> };
    expect(body).toMatchObject({ id: ev.id, type: "refund.approved", data: { object: "refund", id: "rf_wh", payment_id: "pay_wh", asset: "btc:btc", amount: "1234" } });
  });
});
