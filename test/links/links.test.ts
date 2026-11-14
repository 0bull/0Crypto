import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacHex } from "../../src/admin/session";
import { preAuth, signedIn, type AdminTestSession } from "../admin-session";
import { createApiKey } from "../../src/api/auth";
import { getInvoice } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { links as linksApp } from "../../src/links/routes";
import { createLink, getLink, LINK_BUDGET_GLOBAL_PER_MIN, LINK_BUDGET_PER_MIN, reserveLinkBudget } from "../../src/links/store";
import { sameMinuteWindow } from "../rate-window";

const e = env as unknown as Env;
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
let ipSeq = 0;
const freshIp = () => `10.21.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
});

const mk = (o: Partial<Parameters<typeof createLink>[1]> = {}) =>
  createLink(e.DB, { title: "Tip jar", price_minor: 2500n, currency: "USD", allowed_assets: null, ...o });
const pub = (path: string, init: RequestInit = {}, ip = freshIp()) =>
  exports.default.fetch(BASE + path, { redirect: "manual", ...init, headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) } });
const invId = (r: Response) => /\/i\/(inv_[a-z2-7]+)$/.exec(r.headers.get("location") ?? "")?.[1];

describe("link ids", () => {
  it("are lnk_ + 10 random bytes in base32", async () => {
    const a = await mk();
    const b = await mk();
    expect(a.id).toMatch(/^lnk_[a-z2-7]{16}$/);
    expect(a.id).not.toBe(b.id);
  });
});

const formOf = async (id: string, ip = freshIp()) => {
  const r = await pub(`/l/${id}`, {}, ip);
  expect(r.status).toBe(200);
  const html = await r.text();
  return { token: /name="token" value="([^"]+)"/.exec(html)![1]!, ip, html };
};
const send = (id: string, body: Record<string, string>, ip: string, headers: Record<string, string> = {}) =>
  pub(`/l/${id}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) }, ip);
/** GET the page, then submit its Pay form: what a customer's browser does. */
const payFixed = async (id: string, ip = freshIp()) => send(id, { token: (await formOf(id, ip)).token }, ip);
const counts = async () => ({
  inv: (await e.DB.prepare("SELECT COUNT(*) AS n FROM invoices").first<{ n: number }>())!.n,
  pay: (await e.DB.prepare("SELECT COUNT(*) AS n FROM payments").first<{ n: number }>())!.n,
  ctr: (await e.DB.prepare("SELECT * FROM derivation_counters ORDER BY 1").all()).results,
});

describe("fixed price link", () => {
  it("GET creates nothing: it shows the title, the price and a Pay button that POSTs a signed token", async () => {
    const l = await mk();
    const before = await counts();
    const r = await pub(`/l/${l.id}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Tip jar");
    expect(html).toContain("$25.00 USD");
    expect(html).toMatch(new RegExp(`<form method="post" action="/l/${l.id}"`));
    expect(html).toMatch(/name="token" value="\d+\.[0-9a-f]{64}"/);
    expect(html).toMatch(/<button type="submit"[^>]*>Pay<\/button>/);
    expect(html).not.toContain('name="amount"');
    expect(await counts()).toEqual(before);
  });
  it("any client (browsers, link previews, crawlers) can GET it as often as it likes without creating an invoice", async () => {
    const l = await mk();
    const before = await counts();
    for (const ua of ["Mozilla/5.0 Safari", "Slackbot-LinkExpanding 1.0", "Twitterbot/1.0", "Googlebot/2.1", "curl/8"])
      for (let i = 0; i < 3; i++) expect((await pub(`/l/${l.id}`, { headers: { "user-agent": ua } })).status, ua).toBe(200);
    expect((await counts()).inv).toBe(before.inv);
  });
  it("each POST of the Pay form creates a new invoice and 303s to it, with link_id metadata", async () => {
    const l = await mk({ allowed_assets: ["btc:btc"] });
    const { token, ip } = await formOf(l.id);
    const before = await counts();
    const r1 = await send(l.id, { token }, ip);
    const r2 = await send(l.id, { token }, ip);
    expect(r1.status).toBe(303);
    expect(r2.status).toBe(303);
    const [i1, i2] = [invId(r1)!, invId(r2)!];
    expect(i1).toBeTruthy();
    expect(i1).not.toBe(i2);
    const after = await counts();
    expect(after.inv).toBe(before.inv + 2);
    expect(after.pay).toBe(before.pay); // no payment, derivation index or watcher
    expect(after.ctr).toEqual(before.ctr);
    const inv = (await getInvoice(e.DB, i1))!;
    expect(inv.price_minor).toBe(2500n);
    expect(inv.currency).toBe("USD");
    expect(inv.metadata).toEqual({ link_id: l.id });
    expect(inv.allowed_assets).toEqual(["btc:btc"]);
  });
  it("the price is the link's: an amount field in the POST is ignored", async () => {
    const l = await mk();
    const { token, ip } = await formOf(l.id);
    const r = await send(l.id, { token, amount: "0.01" }, ip);
    expect((await getInvoice(e.DB, invId(r)!))!.price_minor).toBe(2500n);
  });
  it("POST without a valid token creates nothing (403)", async () => {
    const l = await mk();
    const before = await counts();
    expect((await send(l.id, {}, freshIp())).status).toBe(403);
    expect((await send(l.id, { token: "1.00" }, freshIp())).status).toBe(403);
    const other = await mk();
    expect((await send(l.id, { token: (await formOf(other.id)).token }, freshIp())).status).toBe(403);
    expect((await counts()).inv).toBe(before.inv);
  });
  it("leaves allowed_assets open when the link has none", async () => {
    const l = await mk();
    const inv = (await getInvoice(e.DB, invId(await payFixed(l.id))!))!;
    expect(inv.allowed_assets).toBeNull();
  });
  it("shows a friendly unavailable page (not a 500) when none of the link's assets are enabled", async () => {
    const l = await mk({ allowed_assets: ["doge:doge"] });
    const before = (await counts()).inv;
    const r = await payFixed(l.id);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("unavailable");
    expect((await counts()).inv).toBe(before);
  });
  it("only offers the still-enabled subset", async () => {
    const l = await mk({ allowed_assets: ["btc:btc", "doge:doge"] });
    const inv = (await getInvoice(e.DB, invId(await payFixed(l.id))!))!;
    expect(inv.allowed_assets).toEqual(["btc:btc"]);
  });
  it("unknown and inactive links give the same 404", async () => {
    const l = await mk();
    await e.DB.prepare("UPDATE links SET active=0 WHERE id=?").bind(l.id).run();
    const a = await pub(`/l/${l.id}`);
    const b = await pub("/l/lnk_aaaaaaaaaaaaaaaa");
    const c = await pub("/l/garbage");
    for (const r of [a, b, c]) expect(r.status).toBe(404);
    const [ta, tb, tc] = [await a.text(), await b.text(), await c.text()];
    expect(ta).toBe(tb);
    expect(ta).toBe(tc);
    expect(a.headers.get("content-security-policy")).toBe(b.headers.get("content-security-policy"));
    expect(ta).not.toContain(l.id);
  });
  it("rate-limits GETs per IP", async () => {
    const l = await mk();
    const ip = freshIp();
    const codes: number[] = [];
    // 60 a minute in fixed windows: two windows absorb at most 120, so the 121st request at the latest is refused.
    await sameMinuteWindow();
    for (let i = 0; i < 121 && !codes.includes(429); i++) codes.push((await pub(`/l/${l.id}`, {}, ip)).status);
    expect(codes).toContain(429);
    expect(codes[0]).toBe(200);
    expect((await pub(`/l/${l.id}`)).status).toBe(200); // another IP is unaffected
  });
  it("rate-limits an IPv6 /64 as one client", async () => {
    const l = await mk();
    const net = `2001:db8:${(ipSeq++ & 0xffff).toString(16)}:1`;
    const codes: number[] = [];
    await sameMinuteWindow();
    for (let i = 0; i < 121 && !codes.includes(429); i++) codes.push((await pub(`/l/${l.id}`, {}, `${net}::${(i + 1).toString(16)}`)).status);
    expect(codes).toContain(429);
    expect((await pub(`/l/${l.id}`, {}, `${net.replace(/:1$/, ":2")}::1`)).status).toBe(200);
  });
  it("shows only title, price and merchant branding", async () => {
    for (const l of [await mk({ price_minor: null }), await mk()]) {
      const html = await (await pub(`/l/${l.id}`)).text();
      expect(html).toContain("Tip jar");
      expect(html).not.toMatch(/inv_[a-z2-7]{26}/);
      expect(html).not.toMatch(/pay_[a-z2-7]+/);
      expect(html).not.toMatch(/\b(bc1|tb1|ltc1|0x[0-9a-fA-F]{40})/);
      expect(html.toLowerCase()).not.toContain("balance");
    }
  });
  it("HEAD returns headers only and creates no invoice", async () => {
    const l = await mk();
    const before = await counts();
    const r = await pub(`/l/${l.id}`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect((await counts()).inv).toBe(before.inv);
    expect((await pub("/l/lnk_aaaaaaaaaaaaaaaa", { method: "HEAD" })).status).toBe(404);
  });
});

describe("invoice budget", () => {
  const minute = () => Math.floor(Date.now() / 60_000);
  /** Waits out the last seconds of a UTC minute, so a test's requests all fall into one budget bucket. */
  const seed = (key: string, n: number) =>
    e.DB.prepare("INSERT INTO link_budget(key,bucket,n) VALUES(?,?,?) ON CONFLICT(key,bucket) DO UPDATE SET n=excluded.n").bind(key, minute(), n).run();

  it("reserveLinkBudget counts per link and globally, per UTC minute, atomically", async () => {
    const t = Date.UTC(2030, 0, 1, 12, 0, 5);
    const res: boolean[] = [];
    for (let i = 0; i < LINK_BUDGET_PER_MIN + 2; i++) res.push((await reserveLinkBudget(e.DB, "lnk_budgetunit000001", t)).ok);
    expect(res.filter(Boolean).length).toBe(LINK_BUDGET_PER_MIN);
    expect(res.slice(-2)).toEqual([false, false]);
    expect((await reserveLinkBudget(e.DB, "lnk_budgetunit000001", t + 60_000)).ok).toBe(true); // next minute
    expect((await reserveLinkBudget(e.DB, "lnk_budgetunit000002", t)).ok).toBe(true); // another link
    // Concurrent reservations never over-grant.
    const par = await Promise.all(Array.from({ length: LINK_BUDGET_PER_MIN + 10 }, () => reserveLinkBudget(e.DB, "lnk_budgetunit000003", t)));
    expect(par.filter((r) => r.ok).length).toBe(LINK_BUDGET_PER_MIN);
  });
  it("the global budget caps every link together; a refused per-link attempt does not use it", async () => {
    const t = Date.UTC(2030, 0, 1, 13, 0, 5);
    let granted = 0;
    for (let i = 0; i < LINK_BUDGET_GLOBAL_PER_MIN + 5; i++) if ((await reserveLinkBudget(e.DB, `lnk_glob${String(i).padStart(12, "0")}`, t)).ok) granted++;
    expect(granted).toBe(LINK_BUDGET_GLOBAL_PER_MIN);
    const t2 = t + 60_000;
    for (let i = 0; i < LINK_BUDGET_PER_MIN + 20; i++) await reserveLinkBudget(e.DB, "lnk_hammered00000001", t2);
    const row = await e.DB.prepare("SELECT n FROM link_budget WHERE key='link:*' AND bucket=?").bind(Math.floor(t2 / 60_000)).first<{ n: number }>();
    expect(row!.n).toBe(LINK_BUDGET_PER_MIN);
  });
  it("old buckets are pruned", async () => {
    const t = Date.UTC(2030, 0, 1, 14, 0, 5);
    await reserveLinkBudget(e.DB, "lnk_prune00000000001", t);
    await reserveLinkBudget(e.DB, "lnk_prune00000000002", t + 5 * 60_000);
    const old = await e.DB.prepare("SELECT COUNT(*) AS n FROM link_budget WHERE bucket<=?").bind(Math.floor(t / 60_000)).first<{ n: number }>();
    expect(old!.n).toBe(0);
  });
  it("budgets are exactly 10 a link and 40 across links a minute", () => {
    expect(LINK_BUDGET_PER_MIN).toBe(10);
    expect(LINK_BUDGET_GLOBAL_PER_MIN).toBe(40);
  });
  it("a link's 11th invoice in a minute is refused with 429 and creates nothing; other links still work", async () => {
    await sameMinuteWindow();
    const l = await mk();
    await seed(`link:${l.id}`, LINK_BUDGET_PER_MIN - 1);
    expect((await payFixed(l.id)).status).toBe(303);
    const before = await counts();
    const r = await payFixed(l.id);
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("Too many requests");
    expect((await counts()).inv).toBe(before.inv);
    expect((await pub(`/l/${l.id}`)).status).toBe(200); // the page itself still shows
    expect((await payFixed((await mk()).id)).status).toBe(303);
  });
  it("once the global budget is spent no link creates an invoice until the minute ends", async () => {
    await sameMinuteWindow();
    const [a, b] = [await mk(), await mk({ price_minor: null })];
    await seed("link:*", LINK_BUDGET_GLOBAL_PER_MIN);
    const before = await counts();
    expect((await payFixed(a.id)).status).toBe(429);
    const { token, ip } = await formOf(b.id);
    expect((await send(b.id, { amount: "25.00", token }, ip)).status).toBe(429);
    expect((await counts()).inv).toBe(before.inv);
    await e.DB.prepare("DELETE FROM link_budget WHERE key='link:*'").run();
    expect((await payFixed(a.id)).status).toBe(303);
  });
  it("an invalid amount does not use the budget", async () => {
    await sameMinuteWindow();
    const l = await mk({ price_minor: null });
    for (let i = 0; i < 3; i++) {
      const { token, ip } = await formOf(l.id);
      expect((await send(l.id, { amount: "0.01", token }, ip)).status).toBe(400);
    }
    expect(await e.DB.prepare("SELECT n FROM link_budget WHERE key=?").bind(`link:${l.id}`).first()).toBeNull();
  });
  it("a D1 failure while reserving fails closed: no invoice", async () => {
    const l = await mk();
    const ip = freshIp();
    const page = await linksApp.request(`/l/${l.id}`, { headers: { "cf-connecting-ip": ip } }, e);
    const token = /name="token" value="([^"]+)"/.exec(await page.text())![1]!;
    const brokenDb = new Proxy(e.DB, {
      get(t, k) {
        if (k === "prepare") return (sql: string) => (sql.includes("link_budget") ? (() => { throw new Error("D1_ERROR"); })() : t.prepare(sql));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const before = await counts();
    const r = await linksApp.request(`/l/${l.id}`, { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }, { ...e, DB: brokenDb } as Env);
    expect(r.status).toBe(503);
    expect((await counts()).inv).toBe(before.inv);
  });
});

describe("open amount", () => {
  it("shows an amount form with a Pay button on GET, and creates nothing", async () => {
    const l = await mk({ price_minor: null });
    const before = await counts();
    const html = await (await pub(`/l/${l.id}`)).text();
    expect(html).toContain('name="amount"');
    expect(html).toMatch(/<button type="submit"[^>]*>Pay<\/button>/);
    expect((await counts()).inv).toBe(before.inv);
  });
  it("each valid POST creates one new invoice", async () => {
    const l = await mk({ price_minor: null });
    const { token, ip } = await formOf(l.id);
    const before = await counts();
    const [r1, r2] = [await send(l.id, { amount: "5.00", token }, ip), await send(l.id, { amount: "6.00", token }, ip)];
    expect(invId(r1)).not.toBe(invId(r2));
    expect((await counts()).inv).toBe(before.inv + 2);
  });
  it("rejects amounts out of bounds or not plain decimals; accepts 25.00", async () => {
    const l = await mk({ price_minor: null });
    for (const bad of ["0.50", "0.99", "10000.01", "0", "-5", "1e3", "25.001", " 25", "25,00", "abc", "", "0x10", "+25", ".5"]) {
      const { token, ip } = await formOf(l.id);
      expect((await send(l.id, { amount: bad, token }, ip)).status, bad).toBe(400);
    }
    for (const good of ["1", "1.00", "10000", "10000.00"]) {
      const { token, ip } = await formOf(l.id);
      expect((await send(l.id, { amount: good, token }, ip)).status, good).toBe(303);
    }
    const { token, ip } = await formOf(l.id);
    const r = await send(l.id, { amount: "25.00", token }, ip);
    expect(r.status).toBe(303);
    const inv = (await getInvoice(e.DB, invId(r)!))!;
    expect(inv.price_minor).toBe(2500n);
    expect(inv.metadata).toEqual({ link_id: l.id });
  });
  it("rejects a missing, forged or other-link token, and a foreign Origin", async () => {
    const l = await mk({ price_minor: null });
    const other = await mk({ price_minor: null });
    const { token, ip } = await formOf(l.id);
    expect((await send(l.id, { amount: "25.00" }, ip)).status).toBe(403);
    expect((await send(l.id, { amount: "25.00", token: token.slice(0, -2) + "xx" }, ip)).status).toBe(403);
    expect((await send(other.id, { amount: "25.00", token }, ip)).status).toBe(403);
    expect((await send(l.id, { amount: "25.00", token }, ip, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send(l.id, { amount: "25.00", token }, ip, { origin: BASE })).status).toBe(303);
  });
  it("rejects an expired token", async () => {
    const l = await mk({ price_minor: null });
    const exp = Date.now() - 1000;
    const token = `${exp}.${await hmacHex(e.SESSION_SECRET, `link-form:${l.id}:${exp}`)}`;
    expect((await send(l.id, { amount: "25.00", token }, freshIp())).status).toBe(403);
  });
  it("POST shows the unavailable page (503) when the link's assets are gone", async () => {
    const l = await mk({ price_minor: null, allowed_assets: ["doge:doge"] });
    const { token, ip } = await formOf(l.id);
    const r = await send(l.id, { amount: "25.00", token }, ip);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("unavailable");
  });
  it("rate-limits POSTs per IP", async () => {
    const l = await mk({ price_minor: null });
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) codes.push((await send(l.id, { amount: "5", token: "x" }, ip)).status);
    expect(codes).toContain(429);
  });
  it("an inactive or unknown link 404s on POST too", async () => {
    const l = await mk({ price_minor: null });
    const { token, ip } = await formOf(l.id);
    await e.DB.prepare("UPDATE links SET active=0 WHERE id=?").bind(l.id).run();
    expect((await send(l.id, { amount: "25.00", token }, ip)).status).toBe(404);
  });
});

describe("API", () => {
  let key = "";
  beforeAll(async () => {
    key = await createApiKey(e.DB, "links-test");
  });
  const api = (path: string, init: RequestInit = {}, auth = true) =>
    exports.default.fetch(BASE + "/api/v1" + path, {
      ...init,
      headers: { "cf-connecting-ip": freshIp(), "content-type": "application/json", ...(auth ? { authorization: `Bearer ${key}` } : {}) },
    });
  it("requires an API key", async () => {
    expect((await api("/links", {}, false)).status).toBe(401);
    expect((await api("/links", { method: "POST", body: "{}" }, false)).status).toBe(401);
    expect((await api("/links/lnk_x", { method: "PATCH", body: "{}" }, false)).status).toBe(401);
  });
  it("creates, lists and deactivates; money is a string", async () => {
    const r = await api("/links", { method: "POST", body: JSON.stringify({ title: "Pro", price_amount: "19.90", price_currency: "USD", allowed_assets: ["btc:btc"] }) });
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ title: "Pro", price_amount: "19.90", price_currency: "USD", allowed_assets: ["btc:btc"], active: true, url: `${BASE}/l/${j.id}` });
    const open = await api("/links", { method: "POST", body: JSON.stringify({ title: "Any", price_currency: "EUR" }) });
    expect(open.status).toBe(201);
    expect(((await open.json()) as Record<string, unknown>).price_amount).toBeNull();
    const list = (await (await api("/links")).json()) as { links: { id: string }[] };
    expect(list.links.some((l) => l.id === j.id)).toBe(true);
    const p = await api(`/links/${j.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
    expect(p.status).toBe(200);
    expect(((await p.json()) as Record<string, unknown>).active).toBe(false);
    expect((await getLink(e.DB, j.id as string))!.active).toBe(false);
    expect((await pub(`/l/${j.id}`)).status).toBe(404);
    expect((await api("/links/lnk_nope", { method: "PATCH", body: JSON.stringify({ active: true }) })).status).toBe(404);
    expect((await api(`/links/${j.id}`, { method: "PATCH", body: JSON.stringify({ active: "yes" }) })).status).toBe(400);
  });
  it("lists with keyset pagination: ?limit=&cursor=, newest first, every row exactly once", async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(((await (await api("/links", { method: "POST", body: JSON.stringify({ title: `Page ${i}`, price_currency: "USD" }) })).json()) as { id: string }).id);
    // Same created_at for two rows: the id breaks the tie, so the cursor never skips or repeats one.
    await e.DB.prepare(`UPDATE links SET created_at=(SELECT created_at FROM links WHERE id=?) WHERE id=?`).bind(made[1], made[2]).run();
    const seen: { id: string; created_at: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await api(`${"/links"}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      const j = (await r.json()) as Record<string, unknown>;
      const items = j.links as { id: string; created_at: string }[];
      expect(items.length).toBeLessThanOrEqual(2);
      seen.push(...items);
      cursor = j.next_cursor as string | null;
      pages++;
    } while (cursor && pages < 1000);
    const ids = seen.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of made) expect(ids).toContain(id);
    for (let i = 1; i < seen.length; i++) expect(Date.parse(seen[i]!.created_at)).toBeLessThanOrEqual(Date.parse(seen[i - 1]!.created_at));
    const all = (await (await api("/links")).json()) as Record<string, unknown>;
    expect((all.links as unknown[]).length).toBeLessThanOrEqual(50); // default page size
    expect(all).toHaveProperty("next_cursor");
    for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "cursor=nope", "cursor=" + btoa("1:x").replaceAll("=", "")])
      expect((await api(`${"/links"}?${q}`)).status, q).toBe(400);
  });
  it("validates input", async () => {
    const bad: Record<string, unknown>[] = [
      { title: "", price_currency: "USD" },
      { title: "x".repeat(121), price_currency: "USD" },
      { title: "a", price_currency: "GBP" },
      { title: "a", price_currency: "USD", price_amount: "0.00" },
      { title: "a", price_currency: "USD", price_amount: 5 },
      { title: "a", price_currency: "USD", price_amount: "5.001" },
      { title: "a", price_currency: "USD", price_amount: "1000000.01" },
      { title: "a", price_currency: "USD", allowed_assets: ["doge:doge"] },
      { title: "a", price_currency: "USD", allowed_assets: [] },
    ];
    for (const b of bad) expect((await api("/links", { method: "POST", body: JSON.stringify(b) })).status, JSON.stringify(b)).toBe(400);
  });
});

describe("admin /admin/links", () => {
  const authed = async () => S.headers;
  const get = async (p: string, h?: Record<string, string>) =>
    exports.default.fetch(BASE + p, { headers: { "cf-connecting-ip": freshIp(), ...(h ?? (await authed())) }, redirect: "manual" });
  const post = async (p: string, form: Record<string, string>, h?: Record<string, string>) =>
    exports.default.fetch(BASE + p, {
      method: "POST",
      headers: { "cf-connecting-ip": freshIp(), "content-type": "application/x-www-form-urlencoded", ...(h ?? (await authed())) },
      body: new URLSearchParams(form),
      redirect: "manual",
    });

  it("needs a session", async () => {
    const r = await get("/admin/links", {});
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
    const pre = await preAuth(e); // passes CSRF signed out, then meets the session gate
    expect((await post("/admin/links", { csrf: pre.csrf, title: "x" }, pre.headers)).status).toBe(302);
  });
  it("shows an empty state before any link exists", async () => {
    await e.DB.prepare("DELETE FROM links").run();
    const html = await (await get("/admin/links")).text();
    expect(html).toContain("No payment links yet");
    expect(html).toContain("Create one above and share its URL.");
    expect(html).toMatch(/<a\b[^>]*href="#new"[^>]*>\s*<span aria-hidden="true">\+<\/span> New link\s*<\/a>/);
  });
  it("creating needs the CSRF token", async () => {
    expect((await post("/admin/links", { title: "No csrf", amount: "5", currency: "USD" })).status).toBe(403);
    expect((await post("/admin/links", { csrf: "wrong", title: "Bad csrf", amount: "5", currency: "USD" })).status).toBe(403);
  });
  it("creates, lists with a copyable URL, deactivates and reactivates", async () => {
    const r = await post("/admin/links", { csrf: CSRF, title: "Admin made", amount: "12.50", currency: "EUR", "a_btc:btc": "1" });
    expect(r.status).toBe(303);
    const row = (await e.DB.prepare("SELECT id,price_minor,currency,allowed_assets,active FROM links WHERE title='Admin made'").first<{ id: string; price_minor: string; currency: string; allowed_assets: string; active: number }>())!;
    expect(row).toMatchObject({ price_minor: "1250", currency: "EUR", allowed_assets: '["btc:btc"]', active: 1 });
    const html = await (await get("/admin/links")).text();
    expect(html).toContain(`${BASE}/l/${row.id}`);
    expect(html).toContain("Admin made");
    expect(html).toContain(`data-copy="${BASE}/l/${row.id}"`);
    expect(html).toMatch(/<a\b[^>]*aria-current="page"[^>]*href="\/admin\/links"|<a\b[^>]*href="\/admin\/links"[^>]*aria-current="page"/);
    expect(html).toContain("Active");
    expect((await post(`/admin/links/${row.id}/active`, { csrf: CSRF, active: "0" })).status).toBe(303);
    expect(await (await get("/admin/links")).text()).toContain("Inactive");
    expect((await getLink(e.DB, row.id))!.active).toBe(false);
    expect((await post(`/admin/links/${row.id}/active`, { active: "1" })).status).toBe(403);
    expect((await getLink(e.DB, row.id))!.active).toBe(false);
    expect((await post(`/admin/links/${row.id}/active`, { csrf: CSRF, active: "1" })).status).toBe(303);
    expect((await getLink(e.DB, row.id))!.active).toBe(true);
  });
  it("creates an open-amount link when the amount is blank, and rejects bad input", async () => {
    expect((await post("/admin/links", { csrf: CSRF, title: "Open one", amount: "", currency: "USD" })).status).toBe(303);
    expect((await e.DB.prepare("SELECT price_minor FROM links WHERE title='Open one'").first<{ price_minor: string | null }>())!.price_minor).toBeNull();
    expect((await post("/admin/links", { csrf: CSRF, title: "", amount: "5", currency: "USD" })).status).toBe(400);
    expect((await post("/admin/links", { csrf: CSRF, title: "x", amount: "5.555", currency: "USD" })).status).toBe(400);
  });
  it("lists the enabled assets as checkboxes and keeps a ticked one after a failed create", async () => {
    const html = await (await get("/admin/links")).text();
    expect(html).toContain("Assets");
    expect(html).toContain('name="a_btc:btc"');
    expect(html).not.toMatch(/name="a_btc:btc"[^>]*checked/);
    const r = await post("/admin/links", { csrf: CSRF, title: "", amount: "5", currency: "USD", "a_btc:btc": "1" });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/name="a_btc:btc"[^>]*checked/);
  });
  it("unknown link id on toggle is a 404", async () => {
    expect((await post("/admin/links/lnk_nope/active", { csrf: CSRF, active: "1" })).status).toBe(404);
  });
});
