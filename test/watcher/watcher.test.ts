import { applyD1Migrations, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { clearSettingsCache } from "../../src/settings";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getInvoice, getPayment, insertInvoice, insertPayment, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import type { PaymentWatcher } from "../../src/watcher/PaymentWatcher";
import { requeuePendingEvents } from "../../src/webhooks/outbox";
import { emptyState, evmRpc, type RpcLog } from "../evm-rpc";

const network = setupNetwork();
const EXPLORERS = ["https://mempool.space/api", "https://blockstream.info/api"];
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TIP = 900_000;
const BTC_100K = 100_000n * 10n ** 8n;

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // A configured webhook URL (D1 setting, as the dashboard stores it) so events are enqueued.
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('WEBHOOK_URL','https://merchant.test/hook',0)").run();
  clearSettingsCache();
});
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  network.resetHandlers();
  vi.restoreAllMocks();
  // A failed backoff test must not leave its chain backed off for the tests after it.
  for (const chain of ["btc", "ltc"]) await env.KV.delete(`backoff:${chain}`);
});
/** Watchers left with a pending alarm; disarmed after the file so no poll outlives the mocks. */
const armed = new Set<string>();
afterAll(async () => {
  for (const id of armed) await runInDurableObject(stubFor(id), (_w, state) => state.storage.deleteAlarm());
  network.disable();
});

const invoice = (id: string, o: Partial<InvoiceRow> = {}): InvoiceRow => {
  const now = Date.now();
  return {
    id,
    created_at: now,
    expires_at: now + 60 * MIN,
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
  };
};

const payment = (id: string, invoiceId: string, address: string, o: Partial<PaymentRow> = {}): PaymentRow => {
  const now = Date.now();
  return {
    id,
    invoice_id: invoiceId,
    asset: "btc:btc",
    chain: "btc",
    address,
    derivation_index: 0,
    reference: null,
    expected: 50_000n,
    price_e8: BTC_100K,
    rate_locked_until: now + 20 * MIN,
    received: 0n,
    final: 0n,
    txids: [],
    status: "awaiting",
    created_at: now,
    detected_at: null,
    confirmed_at: null,
    credited_minor: 0n,
    credit_price_e8: null,
    unexpected: null,
    ...o,
  };
};

/** Esplora answers on both default BTC explorers. `txs` maps address → confirmed value (sats) at TIP-1 (2 confs). */
function mockChain(txs: Record<string, number>) {
  const blockTime = Math.floor(Date.now() / 1000);
  return EXPLORERS.flatMap((base) => [
    http.get(`${base}/blocks/tip/height`, () => HttpResponse.text(String(TIP))),
    http.get(`${base}/address/:addr/txs`, ({ params }) => {
      const addr = params.addr as string;
      const value = txs[addr];
      if (value === undefined) return HttpResponse.json([]);
      return HttpResponse.json([
        {
          txid: `tx_${addr}`,
          vout: [{ value, scriptpubkey_address: addr }],
          status: { confirmed: true, block_height: TIP - 1, block_time: blockTime },
        },
      ]);
    }),
  ]);
}

const stubFor = (invoiceId: string) => env.WATCHER.get(env.WATCHER.idFromName(invoiceId));
const envOf = (w: PaymentWatcher) => (w as unknown as { env: Env }).env;

/** start() each payment, then push the alarm into the future so only runDurableObjectAlarm fires it. */
async function track(invoiceId: string, ...paymentIds: string[]) {
  const stub = stubFor(invoiceId);
  armed.add(invoiceId);
  await runInDurableObject(stub, async (w: PaymentWatcher, state) => {
    for (const p of paymentIds) await w.start(invoiceId, p);
    await state.storage.setAlarm(Date.now() + HOUR);
  });
  return stub;
}

const eventTypes = async (invoiceId: string) =>
  (
    await env.DB.prepare("SELECT type FROM events WHERE invoice_id=? ORDER BY type").bind(invoiceId).all<{ type: string }>()
  ).results.map((r) => r.type);

function collect(ws: WebSocket) {
  const msgs: Record<string, unknown>[] = [];
  ws.addEventListener("message", (e) => {
    msgs.push(JSON.parse(e.data as string));
  });
  ws.accept();
  return {
    msgs,
    async waitFor(n: number) {
      for (let i = 0; i < 100 && msgs.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      return msgs;
    },
  };
}

async function connect(invoiceId: string, paymentId: string) {
  const res = await stubFor(invoiceId).fetch(`https://watcher/ws?payment=${paymentId}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  return collect(res.webSocket!);
}

describe("start", () => {
  it("tracks the payment and schedules the alarm now unless an earlier one is pending", async () => {
    const stub = stubFor("inv_start");
    await runInDurableObject(stub, async (w: PaymentWatcher, state) => {
      await state.storage.setAlarm(Date.now() + HOUR);
      const before = Date.now();
      await w.start("inv_start", "pay_s1");
      const first = (await state.storage.getAlarm())!;
      expect(first).toBeLessThanOrEqual(Date.now());
      expect(first).toBeGreaterThanOrEqual(before);
      await w.start("inv_start", "pay_s2");
      expect(await state.storage.getAlarm()).toBe(first);
      expect(state.storage.kv.get("invoiceId")).toBe("inv_start");
      expect(state.storage.kv.get("payments")).toEqual(["pay_s1", "pay_s2"]);
      await w.start("inv_start", "pay_s1");
      expect(state.storage.kv.get("payments")).toEqual(["pay_s1", "pay_s2"]);
      // Leave nothing that could poll a real explorer: the invoice does not exist, so the alarm drops both.
      await state.storage.setAlarm(Date.now() + HOUR);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_w, s) => s.storage.getAlarm())).toBeNull();
  });
});

describe("alarm", () => {
  it("confirms a paid payment, enqueues one message per event, and keeps a slow watch for top-ups", async () => {
    await insertInvoice(env.DB, invoice("inv_ok"));
    await insertPayment(env.DB, payment("pay_ok", "inv_ok", "bc1qwatchok"));
    network.use(...mockChain({ bc1qwatchok: 50_000 }));
    const stub = await track("inv_ok", "pay_ok");
    const sendBatch = await runInDurableObject(stub, (w: PaymentWatcher) => vi.spyOn(envOf(w).WEBHOOKS, "sendBatch"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const p = (await getPayment(env.DB, "pay_ok"))!;
    expect(p.status).toBe("confirmed");
    expect(p.final).toBe(50_000n);
    expect((await getInvoice(env.DB, "inv_ok"))!.status).toBe("paid");
    const types = await eventTypes("inv_ok");
    expect(types).toEqual(["invoice.paid", "payment.confirmed", "payment.detected"]);
    const sent = sendBatch.mock.calls.flatMap((c) => (c as unknown as [{ body: { eventId: string } }[]])[0]);
    expect(sent.map((m) => m.body.eventId).sort()).toEqual([
      "invoice.paid:inv_ok:1",
      "payment.confirmed:pay_ok:1",
      "payment.detected:pay_ok:1",
    ]);
    const unmarked = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE invoice_id='inv_ok' AND enqueued_at IS NULL").first<{ n: number }>();
    expect(unmarked?.n).toBe(0);
    await runInDurableObject(stub, async (_w, state) => {
      // Confirmed payments are re-checked hourly until 24h after invoice expiry.
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThan(Date.now() + HOUR - 10_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR);
      expect(state.storage.kv.get("payments")).toEqual(["pay_ok"]);
    });
  });

  it("credits funds sent to a confirmed payment later and flags the overpayment", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_more", { created_at: now - HOUR, expires_at: now, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_more", "inv_more", "bc1qwatchmore", {
        created_at: now - HOUR,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchmore"],
        status: "confirmed",
        detected_at: now - HOUR,
        confirmed_at: now - HOUR,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    network.use(...mockChain({ bc1qwatchmore: 60_000 }));
    const stub = await track("inv_more", "pay_more");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_more")).toMatchObject({ status: "confirmed", final: 60_000n, credited_minor: 6000n });
    expect(await getInvoice(env.DB, "inv_more")).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
  });

  it("a confirmed payment polled with no txs keeps its amounts and the invoice stays paid", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_keep", { created_at: now - HOUR, expires_at: now, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_keep", "inv_keep", "bc1qwatchkeep", {
        created_at: now - HOUR,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchkeep"],
        status: "confirmed",
        detected_at: now - HOUR,
        confirmed_at: now - HOUR,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    network.use(...mockChain({}));
    const stub = await track("inv_keep", "pay_keep");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_keep")).toMatchObject({ status: "confirmed", received: 50_000n, final: 50_000n, credited_minor: 5000n });
    expect(await getInvoice(env.DB, "inv_keep")).toMatchObject({ status: "paid", paid_minor: 5000n, overpaid: false });
    expect(await eventTypes("inv_keep")).toEqual([]);
  });

  it("a swept, confirmed EVM payment whose address now reads zero keeps its credit (the adapter's empty-address shortcut)", async () => {
    const now = Date.now();
    const e = env as unknown as Env;
    const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE };
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,base:usdc", EVM_RPC_BASE: "https://rpc.test/base" });
    try {
      await insertInvoice(env.DB, invoice("inv_swept", { created_at: now - HOUR, expires_at: now, status: "paid", paid_minor: 5000n }));
      const confirmed = payment("pay_swept", "inv_swept", "0x2222222222222222222222222222222222222222", {
        asset: "base:usdc",
        chain: "base",
        expected: 50_000_000n,
        price_e8: 10n ** 8n,
        created_at: now - HOUR,
        received: 50_000_000n,
        final: 50_000_000n,
        status: "confirmed",
        detected_at: now - HOUR,
        confirmed_at: now - HOUR,
        credited_minor: 5000n,
        credit_price_e8: 10n ** 8n,
      });
      await insertPayment(env.DB, confirmed);
      await env.DB.prepare("UPDATE payments SET swept_at=?, sweep_tx=? WHERE id=?").bind(now - 30 * MIN, `0x${"ab".repeat(32)}`, "pay_swept").run();
      const log: RpcLog = { methods: [], multicalls: [] };
      network.use(evmRpc("https://rpc.test/base", emptyState, log)); // the sweep emptied the address
      const stub = await track("inv_swept", "pay_swept");
      const prepare = await runInDurableObject(stub, (w: PaymentWatcher) => vi.spyOn(envOf(w).DB, "prepare"));

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      // The observation took the empty-address shortcut: one latest balance read, no head or finalized read ...
      expect(log.methods.filter((m) => m !== "eth_chainId")).toEqual(["eth_call"]);
      // ... and step's monotone guard kept every amount: step returned null, so nothing was written and no event raised.
      expect(prepare.mock.calls.map((c) => c[0] as string).filter((q) => /^\s*(UPDATE|INSERT)\b.*\b(payments|invoices|events)\b/i.test(q))).toEqual([]);
      expect(await getPayment(env.DB, "pay_swept")).toMatchObject({ status: "confirmed", received: 50_000_000n, final: 50_000_000n, credited_minor: 5000n, txids: [] });
      expect(await getInvoice(env.DB, "inv_swept")).toMatchObject({ status: "paid", paid_minor: 5000n });
      expect(await eventTypes("inv_swept")).toEqual([]);
    } finally {
      Object.assign(e, saved);
    }
  });

  it("stops watching a confirmed payment 24h after invoice expiry, after one final observe", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_done", { created_at: now - 2 * DAY, expires_at: now - DAY - MIN, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_done", "inv_done", "bc1qwatchdone", {
        created_at: now - 2 * DAY,
        received: 50_000n,
        final: 50_000n,
        status: "confirmed",
        confirmed_at: now - 2 * DAY,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
        txids: ["tx_bc1qwatchdone"],
      }),
    );
    network.use(...mockChain({ bc1qwatchdone: 50_000 }));
    const stub = await track("inv_done", "pay_done");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await getPayment(env.DB, "pay_done")).toMatchObject({ status: "confirmed", final: 50_000n, credited_minor: 5000n });
    expect(await eventTypes("inv_done")).toEqual([]);
    await runInDurableObject(stub, async (_w, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.kv.get("payments")).toEqual([]);
    });
  });

  it("loads the invoice and its payments once per alarm and rewrites nothing when no payment was dropped", async () => {
    await insertInvoice(env.DB, invoice("inv_once", { price_minor: 10_000n }));
    await insertPayment(env.DB, payment("pay_once_a", "inv_once", "bc1qwatchoncea"));
    await insertPayment(env.DB, payment("pay_once_b", "inv_once", "bc1qwatchonceb"));
    network.use(...mockChain({}));
    const stub = await track("inv_once", "pay_once_a", "pay_once_b");
    const { prepare, put } = await runInDurableObject(stub, (w: PaymentWatcher, state) => ({
      prepare: vi.spyOn(envOf(w).DB, "prepare"),
      put: vi.spyOn(state.storage.kv, "put"),
    }));

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const sql = prepare.mock.calls.map((c) => c[0] as string);
    expect(sql.filter((q) => q === "SELECT * FROM invoices WHERE id=?")).toHaveLength(1);
    expect(sql.filter((q) => q === "SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at, id")).toHaveLength(1);
    expect(put.mock.calls.filter((c) => c[0] === "payments")).toHaveLength(0);
    expect(put.mock.calls.filter((c) => c[0] === "p:pay_once_a" || c[0] === "p:pay_once_b")).toHaveLength(2);
    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get("payments")).toEqual(["pay_once_a", "pay_once_b"]);
    });
  });

  it("loads nothing from D1 when no payment is due", async () => {
    await insertInvoice(env.DB, invoice("inv_idle"));
    await insertPayment(env.DB, payment("pay_idle", "inv_idle", "bc1qwatchidle"));
    const stub = await track("inv_idle", "pay_idle");
    const later = Date.now() + HOUR;
    const prepare = await runInDurableObject(stub, (w: PaymentWatcher, state) => {
      state.storage.kv.put("p:pay_idle", { errorStreak: 0, lastPolledAt: null, nextAt: later });
      return vi.spyOn(envOf(w).DB, "prepare");
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const sql = prepare.mock.calls.map((c) => c[0] as string);
    expect(sql.filter((q) => q.includes("FROM invoices") || q.includes("FROM payments"))).toEqual([]);
    expect(await runInDurableObject(stub, (_w, state) => state.storage.getAlarm())).toBe(later);
  });

  it("a second payment due in the same alarm steps against the invoice the first one just paid", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_seq", { price_minor: 5000n }));
    // A: 50 000 sats seen, unconfirmed; this poll confirms them and pays the invoice.
    await insertPayment(
      env.DB,
      payment("pay_seq_a", "inv_seq", "bc1qwatchseqa", { received: 50_000n, txids: ["tx_bc1qwatchseqa"], status: "confirming", detected_at: now - MIN }),
    );
    // B: a top-up of 10 000 sats on another payment of the same invoice, polled after A in the same alarm.
    await insertPayment(env.DB, payment("pay_seq_b", "inv_seq", "bc1qwatchseqb"));
    network.use(...mockChain({ bc1qwatchseqa: 50_000, bc1qwatchseqb: 10_000 }));
    const stub = await track("inv_seq", "pay_seq_a", "pay_seq_b");
    const sendBatch = await runInDurableObject(stub, (w: PaymentWatcher) => vi.spyOn(envOf(w).WEBHOOKS, "sendBatch"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_seq_a")).toMatchObject({ status: "confirmed", credited_minor: 5000n });
    expect(await getPayment(env.DB, "pay_seq_b")).toMatchObject({ status: "detected", final: 10_000n, credited_minor: 1000n });
    expect(await getInvoice(env.DB, "inv_seq")).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
    const types = await eventTypes("inv_seq");
    expect(types.filter((t) => t === "invoice.paid")).toHaveLength(1);
    expect(types).not.toContain("invoice.partially_paid");
    const sent = sendBatch.mock.calls.flatMap((c) => (c as unknown as [{ body: { eventId: string } }[]])[0].map((m) => m.body.eventId));
    expect(sent.filter((id) => id.startsWith("invoice.paid:"))).toEqual(["invoice.paid:inv_seq:1"]);
    expect(sent.filter((id) => id.startsWith("invoice.partially_paid:"))).toEqual([]);
  });

  it("re-checks a confirmed payment hourly after invoice expiry and raises its credit when a top-up arrives", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_late", { created_at: now - 3 * HOUR, expires_at: now - 2 * HOUR, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_late", "inv_late", "bc1qwatchlate", {
        created_at: now - 3 * HOUR,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchlate"],
        status: "confirmed",
        detected_at: now - 3 * HOUR,
        confirmed_at: now - 3 * HOUR,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    network.use(...mockChain({ bc1qwatchlate: 50_000 }));
    const stub = await track("inv_late", "pay_late");

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_w, state) => {
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThan(Date.now() + HOUR - 10_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR);
    });

    // The top-up lands; the hour passes (the next poll is made due now).
    network.resetHandlers();
    network.use(...mockChain({ bc1qwatchlate: 60_000 }));
    await runInDurableObject(stub, (_w, state) => {
      state.storage.kv.put("p:pay_late", { errorStreak: 0, lastPolledAt: now, nextAt: 0 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_late")).toMatchObject({ status: "confirmed", final: 60_000n, credited_minor: 6000n });
    expect(await getInvoice(env.DB, "inv_late")).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
    expect(await eventTypes("inv_late")).not.toContain("invoice.paid");
  });

  it("credits a top-up from the last hour before expiry + 24h on the final poll just past the window, then stops", async () => {
    const now = Date.now();
    // Last poll was at expiry + 23h10m; the top-up arrived at expiry + 23h30m; the next poll lands at expiry + 24h10m.
    const expiresAt = now - DAY - 10 * MIN;
    await insertInvoice(env.DB, invoice("inv_edge", { created_at: expiresAt - HOUR, expires_at: expiresAt, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_edge", "inv_edge", "bc1qwatchedge", {
        created_at: expiresAt - HOUR,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchedge"],
        status: "confirmed",
        detected_at: expiresAt - HOUR,
        confirmed_at: expiresAt - HOUR,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    network.use(...mockChain({ bc1qwatchedge: 60_000 }));
    const stub = await track("inv_edge", "pay_edge");
    await runInDurableObject(stub, (_w, state) => {
      state.storage.kv.put("p:pay_edge", { errorStreak: 0, lastPolledAt: now - HOUR, nextAt: now });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_edge")).toMatchObject({ status: "confirmed", final: 60_000n, credited_minor: 6000n });
    expect(await getInvoice(env.DB, "inv_edge")).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
    await runInDurableObject(stub, async (_w, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.kv.get("payments")).toEqual([]);
      expect(state.storage.kv.get("p:pay_edge")).toBeUndefined();
    });
  });

  /** Invoice of 5000 minor units: A (50 000 sats seen, confirming) pays it on this poll; B gets a 10 000-sat top-up. */
  async function payThenTopUp(id: string) {
    const now = Date.now();
    await insertInvoice(env.DB, invoice(id, { price_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment(`${id}_a`, id, `bc1q${id}a`, { received: 50_000n, txids: [`tx_bc1q${id}a`], status: "confirming", detected_at: now - MIN }),
    );
    await insertPayment(env.DB, payment(`${id}_b`, id, `bc1q${id}b`));
    network.use(...mockChain({ [`bc1q${id}a`]: 50_000, [`bc1q${id}b`]: 10_000 }));
    return track(id, `${id}_a`, `${id}_b`);
  }

  async function expectPaidOnceWithTopUp(id: string) {
    expect(await getPayment(env.DB, `${id}_a`)).toMatchObject({ status: "confirmed", credited_minor: 5000n });
    expect(await getPayment(env.DB, `${id}_b`)).toMatchObject({ final: 10_000n, credited_minor: 1000n });
    expect(await getInvoice(env.DB, id)).toMatchObject({ status: "paid", paid_minor: 6000n, overpaid: true });
    const types = await eventTypes(id);
    expect(types.filter((t) => t === "invoice.paid")).toHaveLength(1);
    expect(types).not.toContain("invoice.partially_paid");
  }

  it("a failed enqueue after the first payment's write still hands the written rows to the second payment", async () => {
    const stub = await payThenTopUp("invenq");
    await runInDurableObject(stub, (w: PaymentWatcher) => {
      vi.spyOn(envOf(w).WEBHOOKS, "sendBatch").mockRejectedValueOnce(new Error("queue down"));
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectPaidOnceWithTopUp("invenq");
  });

  it("a write that lands but reports failure makes the next payment re-read the rows first", async () => {
    const stub = await payThenTopUp("invamb");
    await runInDurableObject(stub, (w: PaymentWatcher) => {
      const db = envOf(w).DB;
      const batch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementationOnce(async (stmts) => {
        await batch(stmts);
        throw new Error("d1 timeout");
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectPaidOnceWithTopUp("invamb");
  });

  it("a failed final observe past the window keeps the confirmed payment on an hourly retry", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_edge503", { created_at: now - 2 * DAY, expires_at: now - DAY - 10 * MIN, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_edge503", "inv_edge503", "bc1qwatchedge503", {
        created_at: now - 2 * DAY,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchedge503"],
        status: "confirmed",
        confirmed_at: now - 2 * DAY,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => new HttpResponse(null, { status: 503 })),
        http.get(`${base}/address/:addr/txs`, () => new HttpResponse(null, { status: 503 })),
      ]),
    );
    const stub = await track("inv_edge503", "pay_edge503");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get("payments")).toEqual(["pay_edge503"]);
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_edge503")?.errorStreak).toBe(1);
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThan(Date.now() + HOUR - 10_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR);
    });
  });

  it("a partial payment swept during the alarm, read back at zero, keeps its credit (sweep columns re-read)", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_swp", { created_at: now - 2 * HOUR, expires_at: now - HOUR, status: "partially_paid", paid_minor: 1000n }));
    await insertPayment(
      env.DB,
      payment("pay_swp", "inv_swp", "bc1qwatchswp", {
        created_at: now - 2 * HOUR,
        rate_locked_until: now - 2 * HOUR + 20 * MIN,
        received: 10_000n,
        final: 10_000n,
        txids: ["tx_bc1qwatchswp"],
        status: "partial",
        detected_at: now - 2 * HOUR,
        credited_minor: 1000n,
        credit_price_e8: BTC_100K,
      }),
    );
    // The alarm has already loaded the rows when the sweeper locks the payment, sends its sweep and the address empties.
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => HttpResponse.text(String(TIP))),
        http.get(`${base}/address/:addr/txs`, async () => {
          await env.DB.prepare("UPDATE payments SET swept_at=?, sweep_tx=? WHERE id=?").bind(Date.now(), "sweeptx_swp", "pay_swp").run();
          return HttpResponse.json([]);
        }),
      ]),
    );
    const stub = await track("inv_swp", "pay_swp");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_swp")).toMatchObject({ status: "partial", received: 10_000n, final: 10_000n, credited_minor: 1000n });
    expect(await getInvoice(env.DB, "inv_swp")).toMatchObject({ status: "partially_paid", paid_minor: 1000n });
    expect(await eventTypes("inv_swp")).toEqual([]);
  });

  it("keeps a confirmed payment past the window while a top-up is still unconfirmed, and credits it once confirmed", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_unc", { created_at: now - 2 * DAY, expires_at: now - DAY - 10 * MIN, status: "paid", paid_minor: 5000n }));
    await insertPayment(
      env.DB,
      payment("pay_unc", "inv_unc", "bc1qwatchunc", {
        created_at: now - 2 * DAY,
        received: 50_000n,
        final: 50_000n,
        txids: ["tx_bc1qwatchunc"],
        status: "confirmed",
        confirmed_at: now - 2 * DAY,
        credited_minor: 5000n,
        credit_price_e8: BTC_100K,
      }),
    );
    // The original 50 000 plus a 10 000-sat top-up still in the mempool.
    const txs = (confirmed: boolean) =>
      EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => HttpResponse.text(String(TIP))),
        http.get(`${base}/address/:addr/txs`, ({ params }) =>
          HttpResponse.json([
            {
              txid: "tx_bc1qwatchunc",
              vout: [{ value: 50_000, scriptpubkey_address: params.addr }],
              status: { confirmed: true, block_height: TIP - 5, block_time: Math.floor(now / 1000) - 3600 },
            },
            {
              txid: "tx_bc1qwatchunc_topup",
              vout: [{ value: 10_000, scriptpubkey_address: params.addr }],
              status: confirmed ? { confirmed: true, block_height: TIP - 1, block_time: Math.floor(now / 1000) } : { confirmed: false },
            },
          ]),
        ),
      ]);
    network.use(...txs(false));
    const stub = await track("inv_unc", "pay_unc");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_unc")).toMatchObject({ received: 60_000n, final: 50_000n, credited_minor: 5000n });
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get("payments")).toEqual(["pay_unc"]);
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThan(Date.now() + HOUR - 10_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR);
      state.storage.kv.put("p:pay_unc", { errorStreak: 0, lastPolledAt: now, nextAt: 0 });
    });

    network.resetHandlers();
    network.use(...txs(true));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await getPayment(env.DB, "pay_unc")).toMatchObject({ received: 60_000n, final: 60_000n, credited_minor: 6000n });
    expect(await getInvoice(env.DB, "inv_unc")).toMatchObject({ status: "paid", paid_minor: 6000n });
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get("payments")).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("a payment created at invoice expiry is polled on the fast schedule while its rate lock runs", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_lock", { created_at: now - HOUR, expires_at: now - MIN }));
    await insertPayment(env.DB, payment("pay_lock", "inv_lock", "bc1qwatchlock", { created_at: now - 2 * MIN, rate_locked_until: now + 18 * MIN }));
    network.use(...mockChain({}));
    const stub = await track("inv_lock", "pay_lock");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_w, state) => {
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeLessThanOrEqual(Date.now() + 15_000);
    });
  });

  it("events whose enqueue failed after applyTransition are recovered by requeuePendingEvents", async () => {
    await insertInvoice(env.DB, invoice("inv_lost"));
    await insertPayment(env.DB, payment("pay_lost", "inv_lost", "bc1qwatchlost"));
    network.use(...mockChain({ bc1qwatchlost: 50_000 }));
    const stub = await track("inv_lost", "pay_lost");
    await runInDurableObject(stub, (w: PaymentWatcher) => {
      vi.spyOn(envOf(w).WEBHOOKS, "sendBatch").mockRejectedValueOnce(new Error("queue down"));
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await getPayment(env.DB, "pay_lost"))!.status).toBe("confirmed");
    const pending = async () =>
      (
        await env.DB.prepare("SELECT id FROM events WHERE invoice_id='inv_lost' AND enqueued_at IS NULL ORDER BY id").all<{
          id: string;
        }>()
      ).results.map((r) => r.id);
    expect(await pending()).toEqual(["invoice.paid:inv_lost:1", "payment.confirmed:pay_lost:1", "payment.detected:pay_lost:1"]);

    const sendBatch = vi.spyOn(env.WEBHOOKS, "sendBatch");
    await requeuePendingEvents(env as unknown as Env, Date.now() + 61_000);
    const sent = sendBatch.mock.calls.flatMap((c) => (c as unknown as [{ body: { eventId: string } }[]])[0].map((m) => m.body.eventId));
    expect(sent).toEqual(expect.arrayContaining(["invoice.paid:inv_lost:1", "payment.confirmed:pay_lost:1", "payment.detected:pay_lost:1"]));
    expect(await pending()).toEqual([]);
  });

  it("explorer 503 on both endpoints leaves the payment untouched, bumps errorStreak, keeps an alarm", async () => {
    await insertInvoice(env.DB, invoice("inv_503"));
    await insertPayment(env.DB, payment("pay_503", "inv_503", "bc1qwatch503"));
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => new HttpResponse(null, { status: 503 })),
        http.get(`${base}/address/:addr/txs`, () => new HttpResponse(null, { status: 503 })),
      ]),
    );
    const stub = await track("inv_503", "pay_503");
    const before = Date.now();

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const p = (await getPayment(env.DB, "pay_503"))!;
    expect(p.status).toBe("awaiting");
    expect(p.received).toBe(0n);
    expect(await eventTypes("inv_503")).toEqual([]);
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_503")?.errorStreak).toBe(1);
      const alarm = await state.storage.getAlarm();
      // 15s base × 2^1 for one error
      expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(state.storage.kv.get("payments")).toEqual(["pay_503"]);
    });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("pay_503");
    expect(logged).toContain("ExplorerUnavailable");
    expect(logged).not.toContain("bc1qwatch503");
  });

  it("an LTC explorer 429 backs the chain off for every watcher of it, never for BTC", async () => {
    const LTC = "https://litecoinspace.org/api";
    const ltcPay = (id: string, inv: string, addr: string) =>
      payment(id, inv, addr, { asset: "ltc:ltc", chain: "ltc", expected: 5_000_000n });
    for (const n of ["a", "b"]) {
      await insertInvoice(env.DB, invoice(`inv_bo_${n}`));
      await insertPayment(env.DB, ltcPay(`pay_bo_${n}`, `inv_bo_${n}`, `ltc1qbackoff${n}`));
    }
    await insertInvoice(env.DB, invoice("inv_bo_btc"));
    await insertPayment(env.DB, payment("pay_bo_btc", "inv_bo_btc", "bc1qbackoffbtc"));
    await env.KV.delete("backoff:ltc");
    let ltcCalls = 0;
    let btcCalls = 0;
    network.use(
      http.get(`${LTC}/blocks/tip/height`, () => {
        ltcCalls++;
        return new HttpResponse(null, { status: 429 });
      }),
      http.get(`${LTC}/address/:addr/txs`, () => {
        ltcCalls++;
        return new HttpResponse(null, { status: 429 });
      }),
      http.get(`${EXPLORERS[0]}/address/:addr/txs`, () => {
        btcCalls++;
        return HttpResponse.json([]);
      }),
      ...mockChain({}),
    );
    const w1 = await track("inv_bo_a", "pay_bo_a");
    const w2 = await track("inv_bo_b", "pay_bo_b");
    const wb = await track("inv_bo_btc", "pay_bo_btc");

    expect(await runDurableObjectAlarm(w1)).toBe(true);
    expect(await env.KV.get("backoff:ltc")).not.toBeNull();
    const first = ltcCalls;
    expect(first).toBeGreaterThan(0);

    expect(await runDurableObjectAlarm(w2)).toBe(true);
    expect(ltcCalls).toBe(first); // the second watcher made no LTC request
    await runInDurableObject(w2, (_w, state) => {
      // A backoff skip made no upstream call: not an error, the streak stays where it was.
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_bo_b")?.errorStreak).toBe(0);
      expect(state.storage.kv.get("payments")).toEqual(["pay_bo_b"]);
    });
    expect((await getPayment(env.DB, "pay_bo_b"))!.status).toBe("awaiting");

    expect(await runDurableObjectAlarm(wb)).toBe(true);
    expect(btcCalls).toBe(1);
    await runInDurableObject(wb, (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_bo_btc")?.errorStreak).toBe(0);
    });
    expect(await env.KV.get("backoff:btc")).toBeNull();
    await env.KV.delete("backoff:ltc");
  });

  it("a backoff skip keeps errorStreak and waits out the backoff instead of doubling the delay", async () => {
    await insertInvoice(env.DB, invoice("inv_skip"));
    await insertPayment(env.DB, payment("pay_skip", "inv_skip", "bc1qwatchskip"));
    let calls = 0;
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => {
          calls++;
          return HttpResponse.text(String(TIP));
        }),
        http.get(`${base}/address/:addr/txs`, () => {
          calls++;
          return HttpResponse.json([]);
        }),
      ]),
    );
    await env.KV.put("backoff:btc", "1", { expirationTtl: 60 });
    const stub = await track("inv_skip", "pay_skip");
    await runInDurableObject(stub, (_w, state) => {
      state.storage.kv.put("p:pay_skip", { errorStreak: 2, lastPolledAt: 0, nextAt: 0 });
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls).toBe(0);
    await runInDurableObject(stub, async (_w, state) => {
      const s = state.storage.kv.get<{ errorStreak: number; nextAt: number }>("p:pay_skip")!;
      expect(s.errorStreak).toBe(2);
      // max(15s base, 60s backoff TTL); a doubled streak would have been 15s × 2^3 = 120s.
      expect(s.nextAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(s.nextAt).toBeLessThanOrEqual(Date.now() + 60_000);
    });
    await env.KV.delete("backoff:btc");
  });

  it("an unfunded payment inside its rate lock gets a poll just before the lock ends, never after it", async () => {
    const now = Date.now();
    const lock = now + 30_000;
    await insertInvoice(env.DB, invoice("inv_edge_bo"));
    await insertPayment(env.DB, payment("pay_edge_bo", "inv_edge_bo", "bc1qedgebo", { rate_locked_until: lock }));
    await insertInvoice(env.DB, invoice("inv_edge_err"));
    await insertPayment(env.DB, payment("pay_edge_err", "inv_edge_err", "bc1qedgeerr", { rate_locked_until: lock }));
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => new HttpResponse(null, { status: 503 })),
        http.get(`${base}/address/:addr/txs`, () => new HttpResponse(null, { status: 503 })),
      ]),
    );
    // Backed off: 60s would land after the lock.
    await env.KV.put("backoff:btc", "1", { expirationTtl: 60 });
    const bo = await track("inv_edge_bo", "pay_edge_bo");
    expect(await runDurableObjectAlarm(bo)).toBe(true);
    await env.KV.delete("backoff:btc");
    // A long error streak: 15s × 2^4 = 240s would land after the lock too.
    const er = await track("inv_edge_err", "pay_edge_err");
    await runInDurableObject(er, (_w, state) => {
      state.storage.kv.put("p:pay_edge_err", { errorStreak: 3, lastPolledAt: 0, nextAt: 0 });
    });
    expect(await runDurableObjectAlarm(er)).toBe(true);
    for (const [stub, id, streak] of [
      [bo, "pay_edge_bo", 0],
      [er, "pay_edge_err", 4],
    ] as const) {
      await runInDurableObject(stub, async (_w, state) => {
        const s = state.storage.kv.get<{ errorStreak: number; nextAt: number }>(`p:${id}`)!;
        expect(s.errorStreak).toBe(streak);
        expect(s.nextAt).toBeLessThan(lock);
        expect(s.nextAt).toBeGreaterThanOrEqual(lock - 10_000);
        expect(await state.storage.getAlarm()).toBe(s.nextAt);
      });
    }
  });

  it("reads each chain's backoff flag once per alarm, and a 429 in the alarm backs off the siblings after it", async () => {
    await insertInvoice(env.DB, invoice("inv_memo"));
    for (const n of ["a", "b", "c"]) await insertPayment(env.DB, payment(`pay_memo_${n}`, "inv_memo", `bc1qmemo${n}`));
    await env.KV.delete("backoff:btc");
    let calls = 0;
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => {
          calls++;
          return new HttpResponse(null, { status: 429 });
        }),
        http.get(`${base}/address/:addr/txs`, () => {
          calls++;
          return new HttpResponse(null, { status: 429 });
        }),
      ]),
    );
    const stub = await track("inv_memo", "pay_memo_a", "pay_memo_b", "pay_memo_c");
    const get = await runInDurableObject(stub, (w: PaymentWatcher) => vi.spyOn(envOf(w).KV, "get"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const reads = get.mock.calls.filter((c) => String(c[0]) === "backoff:btc");
    expect(reads).toHaveLength(1);
    const first = calls;
    expect(first).toBeGreaterThan(0);
    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_memo_a")?.errorStreak).toBe(1);
      // The siblings were skipped after the first 429, not sent upstream.
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_memo_b")?.errorStreak).toBe(0);
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_memo_c")?.errorStreak).toBe(0);
    });
    await env.KV.delete("backoff:btc");
  });

  it("a successful observe resets errorStreak", async () => {
    await insertInvoice(env.DB, invoice("inv_reset"));
    await insertPayment(env.DB, payment("pay_reset", "inv_reset", "bc1qwatchreset"));
    network.use(...mockChain({}));
    const stub = await track("inv_reset", "pay_reset");
    await runInDurableObject(stub, (_w, state) => {
      state.storage.kv.put("p:pay_reset", { errorStreak: 4, lastPolledAt: 0, nextAt: 0 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_reset")?.errorStreak).toBe(0);
    });
  });

  it("missing price after the rate lock counts as an error and changes nothing", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_px", { currency: "EUR" }));
    await insertPayment(env.DB, payment("pay_px", "inv_px", "bc1qwatchpx", { rate_locked_until: now - MIN }));
    network.use(...mockChain({ bc1qwatchpx: 50_000 }), http.get("https://api.kraken.com/*", () => new HttpResponse(null, { status: 500 })));
    const stub = await track("inv_px", "pay_px");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getPayment(env.DB, "pay_px"))!.status).toBe("awaiting");
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_px")?.errorStreak).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(warn.mock.calls.flat().join(" ")).toContain("PriceUnavailable");
  });

  it("two payments confirming in one alarm mark the invoice paid exactly once", async () => {
    await insertInvoice(env.DB, invoice("inv_two", { price_minor: 10_000n }));
    await insertPayment(env.DB, payment("pay_two_a", "inv_two", "bc1qwatchtwoa"));
    await insertPayment(env.DB, payment("pay_two_b", "inv_two", "bc1qwatchtwob"));
    network.use(...mockChain({ bc1qwatchtwoa: 50_000, bc1qwatchtwob: 50_000 }));
    const stub = await track("inv_two", "pay_two_a", "pay_two_b");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const inv = (await getInvoice(env.DB, "inv_two"))!;
    expect(inv.status).toBe("paid");
    expect(inv.paid_minor).toBe(10_000n);
    expect((await getPayment(env.DB, "pay_two_a"))!.status).toBe("confirmed");
    expect((await getPayment(env.DB, "pay_two_b"))!.status).toBe("confirmed");
    const types = await eventTypes("inv_two");
    expect(types.filter((t) => t === "invoice.paid")).toHaveLength(1);
    expect(types.filter((t) => t === "payment.confirmed")).toHaveLength(2);
  });

  it("drops a payment 7 days after invoice expiry whatever its status, without polling", async () => {
    const now = Date.now();
    await insertInvoice(env.DB, invoice("inv_old", { created_at: now - 9 * DAY, expires_at: now - 7 * DAY - MIN }));
    await insertPayment(
      env.DB,
      payment("pay_old", "inv_old", "bc1qwatchold", { created_at: now - 9 * DAY, received: 1_000n, status: "detected" }),
    );
    let hits = 0;
    network.use(
      ...EXPLORERS.map((base) =>
        http.get(`${base}/*`, () => {
          hits++;
          return new HttpResponse(null, { status: 500 });
        }),
      ),
    );
    const stub = await track("inv_old", "pay_old");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(hits).toBe(0);
    expect((await getPayment(env.DB, "pay_old"))!.status).toBe("detected");
    expect(warn.mock.calls.flat().join(" ")).toContain("pay_old");
    await runInDurableObject(stub, async (_w, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.kv.get("payments")).toEqual([]);
      expect(state.storage.kv.get("p:pay_old")).toBeUndefined();
    });
  });

  it("a non-observe error on one payment backs it off without starving its siblings", async () => {
    await insertInvoice(env.DB, invoice("inv_iso"));
    // Corrupt row: unknown asset makes getAsset throw for this payment on every poll.
    await insertPayment(env.DB, payment("pay_iso_a", "inv_iso", "bc1qwatchisoa", { asset: "btc:nope" }));
    await insertPayment(env.DB, payment("pay_iso_b", "inv_iso", "bc1qwatchisob"));
    network.use(...mockChain({ bc1qwatchisoa: 50_000, bc1qwatchisob: 50_000 }));
    const stub = await track("inv_iso", "pay_iso_a", "pay_iso_b");
    const before = Date.now();

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await getPayment(env.DB, "pay_iso_a"))!.status).toBe("awaiting");
    expect((await getPayment(env.DB, "pay_iso_b"))!.status).toBe("confirmed");
    expect((await getInvoice(env.DB, "inv_iso"))!.status).toBe("paid");
    await runInDurableObject(stub, async (_w, state) => {
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_iso_a")?.errorStreak).toBe(1);
      expect(state.storage.kv.get("payments")).toEqual(["pay_iso_a", "pay_iso_b"]); // b stays on the slow confirmed watch
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);
    });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("pay_iso_a");
    expect(logged).not.toContain("btc:nope");
  });

  it("a D1 read failure counts as that payment's error", async () => {
    await insertInvoice(env.DB, invoice("inv_d1"));
    await insertPayment(env.DB, payment("pay_d1", "inv_d1", "bc1qwatchd1"));
    const stub = await track("inv_d1", "pay_d1");
    await runInDurableObject(stub, (w: PaymentWatcher) => {
      vi.spyOn(envOf(w).DB, "prepare").mockImplementation(() => {
        throw new Error("d1 down");
      });
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (w: PaymentWatcher, state) => {
      vi.mocked(envOf(w).DB.prepare).mockRestore();
      expect(state.storage.kv.get<{ errorStreak: number }>("p:pay_d1")?.errorStreak).toBe(1);
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(state.storage.kv.get("payments")).toEqual(["pay_d1"]);
    });
  });

  it("an error while re-arming reschedules the alarm 60s out", async () => {
    await insertInvoice(env.DB, invoice("inv_boom"));
    await insertPayment(env.DB, payment("pay_boom", "inv_boom", "bc1qwatchboom"));
    network.use(...mockChain({}));
    const stub = await track("inv_boom", "pay_boom");
    await runInDurableObject(stub, (_w, state) => {
      vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("storage down"));
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_w, state) => {
      const alarm = (await state.storage.getAlarm())!;
      expect(alarm).toBeGreaterThanOrEqual(before + 60_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(state.storage.kv.get("payments")).toEqual(["pay_boom"]);
    });
    expect(warn.mock.calls.flat().join(" ")).toContain("alarm failed: Error");
  });

  it("never arms the alarm in the past", async () => {
    await insertInvoice(env.DB, invoice("inv_past"));
    await insertPayment(env.DB, payment("pay_past", "inv_past", "bc1qwatchpast"));
    // start() lands mid-alarm, while the alarm awaits the explorer: the new id has no poll state (nextAt 0).
    network.use(
      ...EXPLORERS.flatMap((base) => [
        http.get(`${base}/blocks/tip/height`, () => HttpResponse.text(String(TIP))),
        http.get(`${base}/address/:addr/txs`, async () => {
          await stubFor("inv_past").start("inv_past", "pay_new");
          return HttpResponse.json([]);
        }),
      ]),
    );
    const stub = await track("inv_past", "pay_past");
    const setAlarm = await runInDurableObject(stub, (_w, state) => vi.spyOn(state.storage, "setAlarm"));
    const before = Date.now();

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_w, state) => {
      expect(state.storage.kv.get("payments")).toEqual(["pay_past", "pay_new"]);
    });
    const times = setAlarm.mock.calls.map((c) => c[0] as number);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(before);
    // pay_new is due now, so the alarm is re-armed immediately, not via the 60s error path
    expect(times.at(-1)!).toBeLessThan(before + 60_000);
  });
});

describe("websocket", () => {
  it("rejects non-upgrade requests with 426", async () => {
    const res = await stubFor("inv_ws").fetch("https://watcher/ws?payment=pay_ws");
    expect(res.status).toBe(426);
  });

  it("sends the current status on connect", async () => {
    await insertInvoice(env.DB, invoice("inv_ws", { status: "open" }));
    await insertPayment(env.DB, payment("pay_ws", "inv_ws", "bc1qwatchws", { received: 12_345n, status: "detected" }));
    const ws = await connect("inv_ws", "pay_ws");
    expect(await ws.waitFor(1)).toEqual([
      { type: "status", payment_id: "pay_ws", status: "detected", received: "0.00012345", final: "0", invoice_status: "open" },
    ]);
  });

  it("broadcasts a transition only to sockets tagged with that payment", async () => {
    await insertInvoice(env.DB, invoice("inv_bc", { price_minor: 10_000n }));
    await insertPayment(env.DB, payment("pay_bc_a", "inv_bc", "bc1qwatchbca"));
    await insertPayment(env.DB, payment("pay_bc_b", "inv_bc", "bc1qwatchbcb"));
    network.use(...mockChain({ bc1qwatchbca: 50_000 }));
    const stub = await track("inv_bc", "pay_bc_a", "pay_bc_b");
    const a = await connect("inv_bc", "pay_bc_a");
    const b = await connect("inv_bc", "pay_bc_b");
    await a.waitFor(1);
    await b.waitFor(1);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await a.waitFor(2))[1]).toEqual({
      type: "status",
      payment_id: "pay_bc_a",
      status: "confirmed",
      received: "0.0005",
      final: "0.0005",
      invoice_status: "partially_paid",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.msgs).toHaveLength(1);
  });
});
