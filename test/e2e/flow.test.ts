import { applyD1Migrations, createMessageBatch, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { clearSettingsCache } from "../../src/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../../src/api/auth";
import type { Env, WebhookJob } from "../../src/env";
import { refreshPrices } from "../../src/prices/cache";
import { handleWebhookBatch } from "../../src/webhooks/consumer";
import { verifyWebhook } from "../../src/webhooks/sign";

const network = setupNetwork();
const e = env as unknown as Env;
const HOOK = "https://merchant.test/hook";
const SECRET = "whsec_e2e_secret";
const withHook = { ...e, WEBHOOK_URL: HOOK, WEBHOOK_SECRET: SECRET } as Env;
const EXPLORERS = ["https://mempool.space/api", "https://blockstream.info/api"];
const TIP = 900_000;
const IP = "10.9.9.9";

let invoiceId = "";
afterAll(async () => {
  network.disable();
  if (invoiceId) await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(invoiceId)), (_w, s) => s.storage.deleteAlarm());
});
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: never }).TEST_MIGRATIONS);
  // A configured webhook URL (D1 setting, as the dashboard stores it) so events are enqueued.
  await e.DB.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('WEBHOOK_URL','https://merchant.test/hook',0)").run();
  clearSettingsCache();
});
afterEach(() => network.resetHandlers());
afterAll(() => vi.restoreAllMocks());

/** Esplora on both default explorers: one tx of `sats` to `address`, optionally confirmed in `block`. */
function mockExplorer(address: string, sats: number, tip: number, block: number | null) {
  return EXPLORERS.flatMap((base) => [
    http.get(`${base}/blocks/tip/height`, () => HttpResponse.text(String(tip))),
    http.get(`${base}/address/:addr/txs`, () =>
      HttpResponse.json([
        {
          txid: "e2e_tx_1",
          vout: [{ value: sats, scriptpubkey_address: address }],
          status:
            block === null ? { confirmed: false } : { confirmed: true, block_height: block, block_time: Math.floor(Date.now() / 1000) },
        },
      ]),
    ),
  ]);
}

const krakenTicker = (pair: string, price: string) => ({ [pair]: { c: [price, "1"] } });

/** Every `{ eventId }` handed to WEBHOOKS.sendBatch, by the Worker's env or the watcher DO's env. */
const record = (spy: { mock: { calls: unknown[][] } }) => () =>
  spy.mock.calls.flatMap((c) => (c[0] as { body: WebhookJob }[]).map((m) => m.body.eventId));
let readers: (() => string[])[] = [];

/** Deliver the messages enqueued since the last call, as the queue consumer would receive them. */
const seen = new Set<string>();
async function deliverEnqueued() {
  const ids = [...new Set(readers.flatMap((r) => r()))].filter((id) => !seen.has(id));
  ids.forEach((id) => seen.add(id));
  const captured: { header: string | null; body: string }[] = [];
  network.use(
    http.post(HOOK, async ({ request }) => {
      captured.push({ header: request.headers.get("0crypto-signature"), body: await request.text() });
      return new HttpResponse(null, { status: 200 });
    }),
  );
  const batch = createMessageBatch<WebhookJob>(
    "0crypto-webhooks",
    ids.map((id, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body: { eventId: id } })),
  );
  await handleWebhookBatch(batch, withHook);
  return { ids, captured };
}

describe("invoice to paid, end to end", () => {
  it("creates, detects, confirms and notifies", async () => {
    // Price: Kraken via msw, cached into KV by refreshPrices.
    network.use(
      http.get("https://api.kraken.com/0/public/Ticker", () =>
        HttpResponse.json({
          error: [],
          result: { ...krakenTicker("XXBTZUSD", "100000.0"), ...krakenTicker("XLTCZUSD", "100.0") },
        }),
      ),
    );
    await refreshPrices(e);

    // 1. API key, $50 invoice, BTC payment.
    const key = await createApiKey(e.DB, "e2e");
    const auth = { Authorization: `Bearer ${key}`, "content-type": "application/json", "cf-connecting-ip": IP };
    const created = await exports.default.fetch("https://pay.test/api/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ price_amount: "50.00", price_currency: "USD" }),
    });
    expect(created.status).toBe(201);
    invoiceId = ((await created.json()) as { id: string }).id;

    const payRes = await exports.default.fetch(`https://pay.test/api/v1/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({ asset: "btc:btc" }),
    });
    expect(payRes.status).toBe(201);
    const pay = (await payRes.json()) as { payment_id: string; address: string; amount: string };
    expect(pay.amount).toBe("0.0005"); // $50 at $100,000/BTC
    const stub = e.WATCHER.get(e.WATCHER.idFromName(invoiceId));
    const outer = vi.spyOn(e.WEBHOOKS, "sendBatch");
    const inner = await runInDurableObject(stub, (w) => vi.spyOn((w as unknown as { env: Env }).env.WEBHOOKS, "sendBatch"));
    readers = [record(outer), record(inner)];
    // Hold the self-armed alarm back so only runDurableObjectAlarm fires it.
    await runInDurableObject(stub, (_w, s) => s.storage.setAlarm(Date.now() + 3_600_000));

    // 2. Exact amount in the mempool: confirming.
    network.use(...mockExplorer(pay.address, 50_000, TIP, null));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const mid = (await (await exports.default.fetch(`https://pay.test/api/v1/invoices/${invoiceId}`, { headers: auth })).json()) as {
      status: string;
      payments: { status: string }[];
    };
    expect(mid.payments[0]!.status).toBe("confirming");
    expect(mid.status).toBe("open");

    // 3. payment.detected webhook, signed.
    const { ids: firstIds, captured: first } = await deliverEnqueued();
    expect(firstIds.some((id) => id.startsWith(`payment.detected:${pay.payment_id}:`))).toBe(true);
    for (const m of first) expect(await verifyWebhook(SECRET, m.header, m.body, Math.floor(Date.now() / 1000))).toBe(true);
    expect(first.map((m) => JSON.parse(m.body).type)).toContain("payment.detected");

    // 4. One block later the tx has 2 confirmations: paid.
    network.resetHandlers();
    network.use(...mockExplorer(pay.address, 50_000, TIP + 1, TIP));
    // A block interval has passed: make the payment due for polling again.
    await runInDurableObject(stub, (_w, s) => {
      s.storage.kv.put(`p:${pay.payment_id}`, { errorStreak: 0, lastPolledAt: 0, nextAt: 0 });
      return s.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const { ids: secondIds, captured: second } = await deliverEnqueued();
    expect(secondIds.some((id) => id.startsWith(`invoice.paid:${invoiceId}:`))).toBe(true);
    const types = second.map((m) => JSON.parse(m.body).type).sort();
    expect(types).toEqual(["invoice.paid", "payment.confirmed"]);
    for (const m of second) expect(await verifyWebhook(SECRET, m.header, m.body, Math.floor(Date.now() / 1000))).toBe(true);
    const paidHook = JSON.parse(second.find((m) => JSON.parse(m.body).type === "invoice.paid")!.body);
    expect(paidHook.data.status).toBe("paid");

    const final = (await (await exports.default.fetch(`https://pay.test/api/v1/invoices/${invoiceId}`, { headers: auth })).json()) as {
      status: string;
      paid_amount: string;
    };
    expect(final.status).toBe("paid");
    expect(final.paid_amount).toBe("50.00");
  });
});
