import { applyD1Migrations } from "cloudflare:test";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { createApiKey } from "../../src/api/auth";
import type { Env, WebhookJob } from "../../src/env";
import { fireSubscription, runSubscriptions } from "../../src/subs/cron";
import { nextDue } from "../../src/subs/schedule";
import { createSubscription, getSubscription, listDue, listSubscriptions, type SubRow } from "../../src/subs/store";
import { handleWebhookBatch } from "../../src/webhooks/consumer";
import { verifyWebhook } from "../../src/webhooks/sign";

const network = setupNetwork();
const e = env as unknown as Env;
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
const U = Date.UTC;
const DAY = 86_400_000;
let ipSeq = 0;
const freshIp = () => `10.31.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: never[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
});
afterEach(() => {
  network.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => network.disable());
beforeEach(async () => {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM subscription_periods"),
    e.DB.prepare("DELETE FROM subscriptions"),
    e.DB.prepare("DELETE FROM events WHERE type='subscription.invoice_created'"),
    e.DB.prepare("DELETE FROM invoices WHERE metadata LIKE '%subscription_id%'"),
  ]);
});

const mk = (o: Partial<Parameters<typeof createSubscription>[1]> = {}, now = U(2027, 0, 31, 9, 30)) =>
  createSubscription(e.DB, { label: "Pro plan", price_minor: 1999n, currency: "USD", interval: "monthly", start_at: now, metadata: { plan: "pro" }, ...o }, now);
const count = async (sql: string, ...b: unknown[]) => (await e.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const invoicesOf = (id: string) => count("SELECT COUNT(*) AS n FROM invoices WHERE json_extract(metadata,'$.subscription_id')=?", id);
const eventsOf = (id: string) => count("SELECT COUNT(*) AS n FROM events WHERE type='subscription.invoice_created' AND json_extract(payload,'$.subscription_id')=?", id);
const fakeQueue = (sendBatch: (m: { body: { eventId: string } }[]) => Promise<void>) => ({ ...e, WEBHOOK_URL: "https://merchant.test/hook", WEBHOOKS: { sendBatch } }) as unknown as Env;

describe("runSubscriptions", () => {
  it("a sub due now makes one invoice and one event, and next_at advances", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    expect(s.anchor_day).toBe(31);
    await runSubscriptions(e, now);
    expect(await invoicesOf(s.id)).toBe(1);
    expect(await eventsOf(s.id)).toBe(1);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(U(2027, 1, 28, 9, 30));
    const inv = (await e.DB.prepare("SELECT * FROM invoices WHERE json_extract(metadata,'$.subscription_id')=?").bind(s.id).first<Record<string, string | number>>())!;
    expect(inv.price_minor).toBe("1999");
    expect(inv.currency).toBe("USD");
    expect(inv.expires_at).toBe(now + 7 * DAY);
    expect(JSON.parse(inv.metadata as string)).toEqual({ plan: "pro", subscription_id: s.id });
  });

  it("run twice is idempotent through next_at", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    await runSubscriptions(e, now);
    await runSubscriptions(e, now);
    await runSubscriptions(e, now + 1000);
    expect(await invoicesOf(s.id)).toBe(1);
    expect(await eventsOf(s.id)).toBe(1);
  });

  it("missed periods: ONE invoice for the current period, next_at jumps past now", async () => {
    const start = U(2027, 0, 31, 9, 30);
    const s = await mk({}, start);
    const now = U(2027, 4, 15, 12, 0); // Jan 31, Feb 28, Mar 31 and Apr 30 are all overdue; May 31 is next
    await runSubscriptions(e, now);
    expect(await invoicesOf(s.id)).toBe(1);
    expect(await eventsOf(s.id)).toBe(1);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(U(2027, 4, 31, 9, 30));
    const period = await e.DB.prepare("SELECT period_start FROM subscription_periods WHERE subscription_id=?").bind(s.id).first<{ period_start: number }>();
    expect(period!.period_start).toBe(U(2027, 3, 30, 9, 30)); // the current (latest overdue) period
    await runSubscriptions(e, now + 60_000);
    expect(await invoicesOf(s.id)).toBe(1);
  });

  it("weekly missed periods: one invoice for the latest overdue week", async () => {
    const start = U(2027, 0, 4, 9);
    const s = await mk({ interval: "weekly" }, start);
    const now = start + 23 * DAY;
    await runSubscriptions(e, now);
    expect(await invoicesOf(s.id)).toBe(1);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(start + 28 * DAY);
    const period = await e.DB.prepare("SELECT period_start FROM subscription_periods WHERE subscription_id=?").bind(s.id).first<{ period_start: number }>();
    expect(period!.period_start).toBe(start + 21 * DAY);
  });

  it("yearly from Feb 29: billed on Feb 28 in common years and Feb 29 in leap years", async () => {
    const s = await mk({ interval: "yearly" }, U(2028, 1, 29, 10));
    expect(s.anchor_day).toBe(29);
    await runSubscriptions(e, U(2028, 1, 29, 10));
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(U(2029, 1, 28, 10));
    for (const [y, d] of [[2029, 28], [2030, 28], [2031, 28], [2032, 29]] as const) {
      await runSubscriptions(e, U(y, 1, d, 10));
      expect(await invoicesOf(s.id), `${y}`).toBe(y - 2027);
    }
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(U(2033, 1, 28, 10));
  });

  it("yearly from Jan 31 stays on Jan 31, also after a missed year", async () => {
    const s = await mk({ interval: "yearly" }, U(2027, 0, 31, 10));
    await runSubscriptions(e, U(2027, 0, 31, 10));
    await runSubscriptions(e, U(2029, 1, 1)); // 2028 and 2029 both missed: one invoice, for Jan 31 2029
    expect(await invoicesOf(s.id)).toBe(2);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(U(2030, 0, 31, 10));
    const periods = await e.DB.prepare("SELECT period_start FROM subscription_periods WHERE subscription_id=? ORDER BY 1").bind(s.id).all<{ period_start: number }>();
    expect(periods.results.map((r) => r.period_start)).toEqual([U(2027, 0, 31, 10), U(2029, 0, 31, 10)]);
  });

  it("a not-yet-due sub does not fire", async () => {
    const s = await mk({ start_at: U(2027, 5, 1) }, U(2027, 0, 1));
    await runSubscriptions(e, U(2027, 0, 2));
    expect(await invoicesOf(s.id)).toBe(0);
  });

  it("a deactivated sub does not fire", async () => {
    const s = await mk();
    await e.DB.prepare("UPDATE subscriptions SET active=0 WHERE id=?").bind(s.id).run();
    await runSubscriptions(e, U(2027, 0, 31, 9, 30));
    expect(await invoicesOf(s.id)).toBe(0);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(s.next_at);
  });

  it("CAS lost (next_at moved under us): nothing is inserted", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    const stale: SubRow = { ...s };
    await e.DB.prepare("UPDATE subscriptions SET next_at=? WHERE id=?").bind(nextDue("monthly", 31, s.next_at), s.id).run(); // another runner won
    const invBefore = await count("SELECT COUNT(*) AS n FROM invoices");
    const evBefore = await count("SELECT COUNT(*) AS n FROM events");
    expect(await fireSubscription(e, stale, now)).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM invoices")).toBe(invBefore);
    expect(await count("SELECT COUNT(*) AS n FROM events")).toBe(evBefore);
    expect(await count("SELECT COUNT(*) AS n FROM subscription_periods")).toBe(0);
  });

  it("the (subscription_id, period_start) guard rejects a second invoice for the same period and rolls back", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    await e.DB.prepare("INSERT INTO subscription_periods(subscription_id,period_start,invoice_id) VALUES(?,?,'inv_old')").bind(s.id, s.next_at).run();
    const invBefore = await count("SELECT COUNT(*) AS n FROM invoices");
    await expect(fireSubscription(e, s, now)).rejects.toThrow();
    expect(await count("SELECT COUNT(*) AS n FROM invoices")).toBe(invBefore);
    expect((await getSubscription(e.DB, s.id))!.next_at).toBe(s.next_at);
  });

  it("one failing sub does not stop the others, and only the error name is logged", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const bad = await mk({ label: "Broken" }, now - DAY);
    await e.DB.prepare("UPDATE subscriptions SET currency='XXX', next_at=? WHERE id=?").bind(now - 2 * DAY, bad.id).run(); // oldest, runs first
    const good = await mk({ label: "Fine" }, now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSubscriptions(e, now);
    expect(await invoicesOf(good.id)).toBe(1);
    expect(await invoicesOf(bad.id)).toBe(0);
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain(bad.id);
    expect(logged).not.toMatch(/XXX|Broken|currency/);
  });

  it("an invalid subscription is deactivated with one deduplicated alert; transient errors are not", async () => {
    const now = U(2027, 0, 31, 9, 30);
    await e.DB.prepare("DELETE FROM alerts WHERE kind='subscription.invalid'").run();
    const bad1 = await mk({ label: "Bad 1" }, now - DAY);
    const bad2 = await mk({ label: "Bad 2" }, now - DAY);
    await e.DB.prepare("UPDATE subscriptions SET currency='XXX' WHERE id IN (?,?)").bind(bad1.id, bad2.id).run();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSubscriptions(e, now);
    for (const b of [bad1, bad2]) expect((await getSubscription(e.DB, b.id))!.active, b.id).toBe(false);
    const alerts = await e.DB.prepare("SELECT detail FROM alerts WHERE kind='subscription.invalid'").all<{ detail: string }>();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0]!.detail).not.toMatch(/XXX|Bad/);
    // A D1 failure is not a verdict on the row: it stays active and is retried next run.
    const ok = await mk({ label: "Fine" }, now);
    const flaky = { ...e, DB: new Proxy(e.DB, { get: (t, k) => (k === "batch" ? () => Promise.reject(new Error("D1_ERROR")) : typeof Reflect.get(t, k) === "function" ? Reflect.get(t, k).bind(t) : Reflect.get(t, k)) }) } as Env;
    await runSubscriptions(flaky, now);
    expect((await getSubscription(e.DB, ok.id))!.active).toBe(true);
  });

  it("a corrupt row cannot abort the run: it is skipped by listDue, deactivated and alerted, and the others are billed", async () => {
    const now = U(2027, 0, 31, 9, 30);
    await e.DB.prepare("DELETE FROM alerts WHERE kind='subscription.invalid'").run();
    const rot = [await mk({ label: "Rot 1" }, now - 3 * DAY), await mk({ label: "Rot 2" }, now - 3 * DAY), await mk({ label: "Rot 3" }, now - 3 * DAY)];
    await e.DB.prepare("UPDATE subscriptions SET price_minor='12.x' WHERE id=?").bind(rot[0]!.id).run();
    await e.DB.prepare("UPDATE subscriptions SET metadata='{not json' WHERE id=?").bind(rot[1]!.id).run();
    await e.DB.prepare("UPDATE subscriptions SET interval='daily' WHERE id=?").bind(rot[2]!.id).run();
    const good = await mk({ label: "Fine" }, now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listed = await listDue(e.DB, now, 100);
    expect(listed.due.map((s) => s.id)).toEqual([good.id]);
    expect(listed.corrupt.sort()).toEqual(rot.map((r) => r.id).sort());
    await runSubscriptions(e, now);
    expect(await invoicesOf(good.id)).toBe(1);
    for (const r of rot) expect((await e.DB.prepare("SELECT active FROM subscriptions WHERE id=?").bind(r.id).first<{ active: number }>())!.active).toBe(0);
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind='subscription.invalid'").first<{ n: number }>())!.n).toBe(1);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/12\.x|not json|Rot/);
    // The list API still answers, without the corrupt rows.
    expect((await listSubscriptions(e.DB)).map((s) => s.id)).toContain(good.id);
  });

  it("processes at most 100 per run, oldest next_at first", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const stmts = Array.from({ length: 105 }, (_, i) =>
      e.DB.prepare("INSERT INTO subscriptions(id,label,price_minor,currency,interval,anchor_day,next_at,active,metadata,created_at) VALUES(?,?,?,?,?,?,?,1,NULL,?)").bind(
        `sub_cap_${String(i).padStart(3, "0")}`, "cap", "100", "USD", "monthly", 31, now - (200 - i) * 1000, now,
      ),
    );
    await e.DB.batch(stmts);
    await runSubscriptions(e, now);
    expect(await count("SELECT COUNT(*) AS n FROM subscription_periods")).toBe(100);
    expect(await count("SELECT COUNT(*) AS n FROM subscription_periods WHERE subscription_id >= 'sub_cap_100'")).toBe(0); // the 5 newest wait
    await runSubscriptions(e, now);
    expect(await count("SELECT COUNT(*) AS n FROM subscription_periods")).toBe(105);
  });

  it("stops starting new subs once the deadline has passed", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    await runSubscriptions(e, now, { budgetMs: -1 });
    expect(await invoicesOf(s.id)).toBe(0);
    await runSubscriptions(e, now);
    expect(await invoicesOf(s.id)).toBe(1);
  });

  it("enqueues subscription.invoice_created after commit; a queue failure leaves the row for the outbox and the invoice stays", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    const sent: string[] = [];
    await runSubscriptions(fakeQueue(async (m) => void sent.push(...m.map((x) => x.body.eventId))), now);
    const ev = (await e.DB.prepare("SELECT id,enqueued_at,invoice_id FROM events WHERE type='subscription.invoice_created' AND json_extract(payload,'$.subscription_id')=?").bind(s.id).first<{ id: string; enqueued_at: number | null; invoice_id: string }>())!;
    expect(sent).toEqual([ev.id]);
    expect(ev.enqueued_at).not.toBeNull();

    const s2 = await mk({ label: "q-fail" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSubscriptions(fakeQueue(async () => { throw new Error("queue down"); }), now);
    expect(await invoicesOf(s2.id)).toBe(1);
    const ev2 = (await e.DB.prepare("SELECT enqueued_at FROM events WHERE type='subscription.invoice_created' AND json_extract(payload,'$.subscription_id')=?").bind(s2.id).first<{ enqueued_at: number | null }>())!;
    expect(ev2.enqueued_at).toBeNull();
  });

  it("the webhook carries the invoice payload plus subscription_id and checkout_url, and is signed", async () => {
    const now = U(2027, 0, 31, 9, 30);
    const s = await mk();
    await runSubscriptions(fakeQueue(async () => {}), now);
    const ev = (await e.DB.prepare("SELECT id,invoice_id FROM events WHERE type='subscription.invoice_created' AND json_extract(payload,'$.subscription_id')=?").bind(s.id).first<{ id: string; invoice_id: string }>())!;
    const withUrl = { ...e, WEBHOOK_URL: "https://merchant.test/hook", WEBHOOK_SECRET: "whsec_test", PUBLIC_URL: BASE } as Env;
    let seen: { body: string; sig: string } | null = null;
    network.use(
      http.post("https://merchant.test/hook", async ({ request }) => {
        seen = { body: await request.text(), sig: request.headers.get("0crypto-signature") ?? "" };
        return new HttpResponse("ok");
      }),
    );
    const batch = createMessageBatch<WebhookJob>("0crypto-webhooks", [{ id: "m0", timestamp: new Date(), attempts: 1, body: { eventId: ev.id } }]);
    await handleWebhookBatch(batch, withUrl);
    await getQueueResult(batch, createExecutionContext());
    expect(seen).not.toBeNull();
    const { body, sig } = seen!;
    expect(await verifyWebhook("whsec_test", sig, body, Math.floor(Date.now() / 1000))).toBe(true);
    const j = JSON.parse(body) as { type: string; data: Record<string, unknown> };
    expect(j.type).toBe("subscription.invoice_created");
    expect(j.data).toMatchObject({ id: ev.invoice_id, subscription_id: s.id, checkout_url: `${BASE}/i/${ev.invoice_id}`, price_amount: "19.99", price_currency: "USD", status: "open" });
  });
});

describe("API /api/v1/subscriptions", () => {
  let key = "";
  beforeAll(async () => {
    key = await createApiKey(e.DB, "subs-test");
  });
  const api = (path: string, init: RequestInit = {}, auth = true) =>
    exports.default.fetch(BASE + "/api/v1" + path, {
      ...init,
      headers: { "cf-connecting-ip": freshIp(), "content-type": "application/json", ...(auth ? { authorization: `Bearer ${key}` } : {}) },
    });

  it("requires an API key on every endpoint", async () => {
    expect((await api("/subscriptions", {}, false)).status).toBe(401);
    expect((await api("/subscriptions", { method: "POST", body: "{}" }, false)).status).toBe(401);
    expect((await api("/subscriptions/sub_x", { method: "DELETE" }, false)).status).toBe(401);
  });
  it("creates (default start now), lists and deactivates; money is a string", async () => {
    const r = await api("/subscriptions", { method: "POST", body: JSON.stringify({ label: "Gold", price_amount: "29.90", price_currency: "EUR", interval: "monthly", metadata: { customer: "c1" } }) });
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ label: "Gold", price_amount: "29.90", price_currency: "EUR", interval: "monthly", active: true, metadata: { customer: "c1" } });
    expect(Math.abs(Date.parse(j.next_at as string) - Date.now())).toBeLessThan(10_000);
    const list = (await (await api("/subscriptions")).json()) as { subscriptions: { id: string }[] };
    expect(list.subscriptions.some((x) => x.id === j.id)).toBe(true);
    const d = await api(`/subscriptions/${j.id}`, { method: "DELETE" });
    expect(d.status).toBe(200);
    expect(((await d.json()) as Record<string, unknown>).active).toBe(false);
    expect((await getSubscription(e.DB, j.id as string))!.active).toBe(false);
    expect((await api("/subscriptions/sub_nope", { method: "DELETE" })).status).toBe(404);
  });
  it("lists with keyset pagination: ?limit=&cursor=, newest first, every row exactly once", async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(((await (await api("/subscriptions", { method: "POST", body: JSON.stringify({ label: `Page ${i}`, price_amount: "5", price_currency: "USD", interval: "monthly" }) })).json()) as { id: string }).id);
    // Same created_at for two rows: the id breaks the tie, so the cursor never skips or repeats one.
    await e.DB.prepare(`UPDATE subscriptions SET created_at=(SELECT created_at FROM subscriptions WHERE id=?) WHERE id=?`).bind(made[1], made[2]).run();
    const seen: { id: string; created_at: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await api(`${"/subscriptions"}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      const j = (await r.json()) as Record<string, unknown>;
      const items = j.subscriptions as { id: string; created_at: string }[];
      expect(items.length).toBeLessThanOrEqual(2);
      seen.push(...items);
      cursor = j.next_cursor as string | null;
      pages++;
    } while (cursor && pages < 1000);
    const ids = seen.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of made) expect(ids).toContain(id);
    for (let i = 1; i < seen.length; i++) expect(Date.parse(seen[i]!.created_at)).toBeLessThanOrEqual(Date.parse(seen[i - 1]!.created_at));
    const all = (await (await api("/subscriptions")).json()) as Record<string, unknown>;
    expect((all.subscriptions as unknown[]).length).toBeLessThanOrEqual(50); // default page size
    expect(all).toHaveProperty("next_cursor");
    for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "cursor=nope", "cursor=" + btoa("1:x").replaceAll("=", "")])
      expect((await api(`${"/subscriptions"}?${q}`)).status, q).toBe(400);
  });
  it("honours start_at and anchors on its UTC day", async () => {
    const r = await api("/subscriptions", { method: "POST", body: JSON.stringify({ label: "Y", price_amount: "5", price_currency: "USD", interval: "yearly", start_at: "2031-02-28T10:00:00Z" }) });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { id: string; next_at: string };
    expect(j.next_at).toBe("2031-02-28T10:00:00.000Z");
    expect((await getSubscription(e.DB, j.id))!.anchor_day).toBe(28);
  });
  it("validates input", async () => {
    const ok = { label: "a", price_amount: "5.00", price_currency: "USD", interval: "monthly" };
    const bad: Record<string, unknown>[] = [
      { ...ok, label: "" },
      { ...ok, label: "x".repeat(121) },
      { ...ok, price_amount: "0" },
      { ...ok, price_amount: 5 },
      { ...ok, price_amount: "5.001" },
      { ...ok, price_amount: "1000000.01" },
      { ...ok, price_currency: "GBP" },
      { ...ok, interval: "daily" },
      { ...ok, start_at: "not a date" },
      { ...ok, metadata: [] },
      { ...ok, metadata: { big: "x".repeat(4100) } },
      { ...ok, metadata: { pos: true } },
      { ...ok, metadata: { link_id: "lnk_x" } },
      { ...ok, metadata: { subscription_id: "sub_other" } },
    ];
    for (const b of bad) expect((await api("/subscriptions", { method: "POST", body: JSON.stringify(b) })).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await api("/subscriptions", { method: "POST", body: "nope" })).status).toBe(400);
    const r = await api("/subscriptions", { method: "POST", body: JSON.stringify({ ...ok, metadata: { pos: true } }) });
    expect(await r.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining('"pos" is reserved') });
  });
});

describe("admin /admin/subscriptions", () => {
  const authed = async () => S.headers;
  const get = async (p: string, h?: Record<string, string>) => exports.default.fetch(BASE + p, { headers: { "cf-connecting-ip": freshIp(), ...(h ?? (await authed())) }, redirect: "manual" });
  const post = async (p: string, form: Record<string, string>, h?: Record<string, string>) =>
    exports.default.fetch(BASE + p, { method: "POST", headers: { "cf-connecting-ip": freshIp(), "content-type": "application/x-www-form-urlencoded", ...(h ?? (await authed())) }, body: new URLSearchParams(form), redirect: "manual" });

  it("needs a session and the CSRF token", async () => {
    expect((await get("/admin/subscriptions", {})).status).toBe(302);
    expect((await post("/admin/subscriptions", { label: "x", amount: "5", currency: "USD", interval: "weekly" })).status).toBe(403);
  });
  it("creates, lists and deactivates", async () => {
    const r = await post("/admin/subscriptions", { csrf: CSRF, label: "Admin sub", amount: "12.50", currency: "EUR", interval: "weekly", start: "" });
    expect(r.status).toBe(303);
    const row = (await e.DB.prepare("SELECT id,price_minor,currency,interval,active FROM subscriptions WHERE label='Admin sub'").first<{ id: string; price_minor: string; currency: string; interval: string; active: number }>())!;
    expect(row).toMatchObject({ price_minor: "1250", currency: "EUR", interval: "weekly", active: 1 });
    expect(await (await get("/admin/subscriptions")).text()).toContain("Admin sub");
    expect((await post(`/admin/subscriptions/${row.id}/deactivate`, {})).status).toBe(403);
    expect((await post(`/admin/subscriptions/${row.id}/deactivate`, { csrf: CSRF })).status).toBe(303);
    expect((await getSubscription(e.DB, row.id))!.active).toBe(false);
    expect((await post("/admin/subscriptions/sub_nope/deactivate", { csrf: CSRF })).status).toBe(404);
  });
  it("is the restyled Subscriptions page: empty state, then a row with its interval and deactivate action", async () => {
    await e.DB.batch([e.DB.prepare("DELETE FROM subscription_periods"), e.DB.prepare("DELETE FROM subscriptions")]);
    const empty = await (await get("/admin/subscriptions")).text();
    expect(empty).toMatch(/<h1[^>]*>[\s\S]*Subscriptions[\s\S]*<\/h1>/);
    expect(empty).toMatch(/<a\b[^>]*aria-current="page"[^>]*href="\/admin\/subscriptions"|<a\b[^>]*href="\/admin\/subscriptions"[^>]*aria-current="page"/);
    // The "+" is decoration: screen readers hear "New subscription".
    expect(empty).toMatch(/<a\b[^>]*href="#new"[^>]*>\s*<span aria-hidden="true">\+<\/span> New subscription\s*<\/a>/);
    expect(empty).toMatch(/<section\b[^>]*id="new"/);
    expect(empty).toContain("No subscriptions yet");
    expect(empty).toMatch(/<option\b[^>]*value="monthly"[^>]*>\s*Monthly\s*<\/option>/);
    expect(empty).toMatch(/<option\b[^>]*value="weekly"[^>]*>\s*Weekly\s*<\/option>/);
    expect(empty).toMatch(/<option\b[^>]*value="yearly"[^>]*>\s*Yearly\s*<\/option>/);
    expect((await post("/admin/subscriptions", { csrf: CSRF, label: "Pro plan", amount: "19.99", currency: "USD", interval: "monthly", start: "" })).status).toBe(303);
    const row = (await e.DB.prepare("SELECT id FROM subscriptions WHERE label='Pro plan'").first<{ id: string }>())!;
    const html = await (await get("/admin/subscriptions")).text();
    expect(html).not.toContain("No subscriptions yet");
    expect(html).toContain("Pro plan");
    expect(html).toContain("$19.99 USD");
    expect(html).toMatch(/<td[^>]*>\s*Monthly\s*<\/td>/);
    expect(html).toMatch(/●<\/span>\s*Active/);
    expect(html).toMatch(new RegExp(`<form\\b[^>]*action="/admin/subscriptions/${row.id}/deactivate"`));
    expect(html).toMatch(/<button[^>]*>\s*Deactivate\s*<\/button>/);
  });
  it("rejects bad input", async () => {
    expect((await post("/admin/subscriptions", { csrf: CSRF, label: "", amount: "5", currency: "USD", interval: "weekly" })).status).toBe(400);
    expect((await post("/admin/subscriptions", { csrf: CSRF, label: "x", amount: "5", currency: "USD", interval: "hourly" })).status).toBe(400);
  });
});
