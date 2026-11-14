import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { verifyPassword } from "../../src/admin/password";
import { getInvoice, listPayments } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { createInvoice } from "../../src/api/invoices";
import { disablePin, getPosConfig, reserve, setPin } from "../../src/pos/store";
import { offline } from "../offline";
import { putPrice } from "../prices/seed";
import { confirmFields } from "../admin/helpers";
import { runInDurableObject } from "cloudflare:test";

const e = env as unknown as Env;
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
const PIN = "24681012";
const armed = new Set<string>();
let ipSeq = 0;
const freshIp = () => `10.33.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline());
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
  await putPrice(e, "USD", "BTC", 100_000n * 10n ** 8n);
  await putPrice(e, "USD", "LTC", 100n * 10n ** 8n);
  await putPrice(e, "EUR", "BTC", 90_000n * 10n ** 8n);
});
afterAll(async () => {
  for (const id of armed) await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  network.disable();
});

const req = (path: string, init: RequestInit = {}, ip = freshIp()) =>
  exports.default.fetch(BASE + path, { redirect: "manual", ...init, headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) } });
const form = (path: string, body: Record<string, string>, cookie = "", ip = freshIp(), extra: Record<string, string> = {}) =>
  req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...extra }, body: new URLSearchParams(body) }, ip);
const cookieOf = (r: Response, name: string) => new RegExp(`${name}=([^;]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1];
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
/** A new admin session each call (distinct cookie, so distinct CSRF tokens). */
const adminCookie = async () => (await signedIn(e)).cookie;
const login = async (pin = PIN, ip = freshIp()) => {
  const r = await form("/pos/login", { pin }, "", ip);
  const v = cookieOf(r, "0c_pos");
  return { r, cookie: v ? `0c_pos=${v}` : "" };
};
const posSession = async () => {
  await setPin(e.DB, PIN);
  const { cookie } = await login();
  expect(cookie).not.toBe("");
  return cookie;
};
const tokenFor = async (cookie: string) => csrfOf(await (await req("/pos", { headers: { cookie } })).text());
const charge = async (cookie: string, body: Record<string, string>, csrf?: string) =>
  form("/pos/charge", { csrf: csrf ?? (await tokenFor(cookie)), ...body }, cookie);
const invCount = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM invoices").first<{ n: number }>())!.n;
const posInvoice = (id: string) => getInvoice(e.DB, id);

describe("login", () => {
  it("shows the PIN form without a session", async () => {
    await setPin(e.DB, PIN);
    const r = await req("/pos");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('name="pin"');
    expect(html).not.toContain('name="amount"');
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("correct PIN sets a scoped cookie and shows the keypad", async () => {
    await setPin(e.DB, PIN);
    const r = await form("/pos/login", { pin: PIN });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/pos");
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^0c_pos=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\/pos(;|$)/i);
    expect(sc).toMatch(/Max-Age=43200/i);
    const page = await req("/pos", { headers: { cookie: `0c_pos=${cookieOf(r, "0c_pos")}` } });
    const html = await page.text();
    expect(html).toContain('name="amount"');
    expect(html).toContain('src="/pos.js"');
    expect(html).not.toMatch(/<script>|onclick=|style=/);
  });
  it("wrong PIN is 401, the 5th wrong PIN from one IP is 429, and then even the right PIN is refused", async () => {
    await setPin(e.DB, PIN);
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await form("/pos/login", { pin: "000000" }, "", ip)).status);
    expect(codes).toEqual([401, 401, 401, 401, 429]);
    const r = await form("/pos/login", { pin: PIN }, "", ip);
    expect(r.status).toBe(429);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await login(PIN, freshIp())).cookie).not.toBe(""); // another IP is unaffected
  });
  it("an IPv6 /64 is one address for the lockout", async () => {
    await setPin(e.DB, PIN);
    const net = `2001:db8:${(ipSeq++ & 0xffff).toString(16)}:5`;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await form("/pos/login", { pin: "000000" }, "", `${net}::${(i + 1).toString(16)}`)).status);
    expect(codes).toEqual([401, 401, 401, 401, 429]);
    expect((await form("/pos/login", { pin: PIN }, "", `${net}:ffff:ffff:ffff:ffff`)).status).toBe(429);
    expect((await login(PIN, `${net.replace(/:5$/, ":6")}::1`)).cookie).not.toBe(""); // the next /64 is unaffected
  });
  it("is not available when no PIN is set", async () => {
    await disablePin(e.DB);
    const page = await req("/pos");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('name="pin"');
    const r = await form("/pos/login", { pin: PIN });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await getPosConfig(e.DB)).pin_hash).toBeNull();
  });
  it("rejects a cross-origin login post", async () => {
    await setPin(e.DB, PIN);
    const r = await form("/pos/login", { pin: PIN }, "", freshIp(), { origin: "https://evil.test" });
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  it("stores the PIN PBKDF2-hashed, never in the clear", async () => {
    await setPin(e.DB, PIN);
    const c = await getPosConfig(e.DB);
    expect(c.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.pin_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyPassword(PIN, c.pin_hash!, c.pin_salt!)).toBe(true);
    expect(JSON.stringify(await e.DB.prepare("SELECT * FROM pos_config").all())).not.toContain(PIN);
  });
});

describe("lockout (D1, atomic)", () => {
  const row = (k: string) => e.DB.prepare("SELECT n,window_start FROM pos_attempts WHERE key=?").bind(k).first<{ n: number; window_start: number }>();
  const setGlobal = (n: number, start: number) => e.DB.prepare("INSERT OR REPLACE INTO pos_attempts(key,n,window_start) VALUES('global',?,?)").bind(n, start).run();
  it("200 attempts per hour across all IPs lock POS login for everyone and raise an alert; admin is unaffected", async () => {
    await setPin(e.DB, PIN);
    await e.DB.prepare("DELETE FROM alerts WHERE kind='pos.lockout'").run();
    await setGlobal(198, Date.now());
    expect((await form("/pos/login", { pin: "11111111" })).status).toBe(401); // 199
    expect((await form("/pos/login", { pin: "11111111" })).status).toBe(401); // 200: still allowed
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind='pos.lockout'").first<{ n: number }>())!.n).toBe(0);
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    const right = await form("/pos/login", { pin: PIN }); // 201: refused without a PIN check
    const checks = spy.mock.calls.length;
    spy.mockRestore();
    expect(right.status).toBe(429);
    expect(checks).toBe(0);
    expect(right.headers.get("set-cookie")).toBeNull();
    const alert = await e.DB.prepare("SELECT detail FROM alerts WHERE kind='pos.lockout'").first<{ detail: string }>();
    expect(alert).not.toBeNull();
    expect(alert!.detail).not.toContain(PIN);
    expect(await (await req("/pos", { headers: { cookie: await adminCookie() } })).text()).toContain('name="amount"');
    await e.DB.prepare("DELETE FROM pos_attempts").run();
    expect((await login()).cookie).not.toBe("");
  });
  it("a correct PIN resets the per-IP count and gives the global attempt back", async () => {
    await setPin(e.DB, PIN);
    await e.DB.prepare("DELETE FROM pos_attempts").run();
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await form("/pos/login", { pin: "11111111" }, "", ip);
    const g = (await row("global"))!.n;
    expect((await login(PIN, ip)).cookie).not.toBe("");
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM pos_attempts WHERE key LIKE 'ip:%'").first<{ n: number }>())!.n).toBe(0);
    expect((await row("global"))!.n).toBe(g);
    for (let i = 0; i < 4; i++) expect((await form("/pos/login", { pin: "11111111" }, "", ip)).status).toBe(401);
  });
  it("10 parallel wrong PINs from one IP run at most 5 PBKDF2 checks, the rest are 429", async () => {
    await setPin(e.DB, PIN);
    await e.DB.prepare("DELETE FROM pos_attempts").run();
    const ip = freshIp();
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    const rs = await Promise.all(Array.from({ length: 10 }, () => form("/pos/login", { pin: "11111111" }, "", ip)));
    const checks = spy.mock.calls.length;
    spy.mockRestore();
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
    expect(rs.every((r) => r.status === 401 || r.status === 429)).toBe(true);
  });
  it("an attempt near the end of the window still counts; after the window the count resets", async () => {
    const start = 1_700_000_000_000;
    await e.DB.prepare("DELETE FROM pos_attempts WHERE key='t'").run();
    expect((await reserve(e.DB, "t", 3_600_000, start)).n).toBe(1);
    expect((await reserve(e.DB, "t", 3_600_000, start + 3_590_000)).n).toBe(2);
    expect((await row("t"))!.window_start).toBe(start); // the window is not extended
    expect((await reserve(e.DB, "t", 3_600_000, start + 3_600_001)).n).toBe(1); // reset
    expect((await row("t"))!.window_start).toBe(start + 3_600_001);
  });
  it("a D1 error fails closed with 429, never a 500 or a login", async () => {
    await setPin(e.DB, PIN);
    await e.DB.prepare("ALTER TABLE pos_attempts RENAME TO pos_attempts_x").run();
    try {
      const r = await form("/pos/login", { pin: PIN });
      expect(r.status).toBe(429);
      expect(r.headers.get("set-cookie")).toBeNull();
    } finally {
      await e.DB.prepare("ALTER TABLE pos_attempts_x RENAME TO pos_attempts").run();
    }
  });
});

describe("sessions", () => {
  it("an admin session works with a CSRF token bound to it", async () => {
    await disablePin(e.DB);
    const cookie = await adminCookie();
    const page = await req("/pos", { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('name="amount"');
    const r = await charge(cookie, { amount: "5.00", currency: "USD" }, csrfOf(html));
    expect(r.status).toBe(303);
    expect((await req("/pos/recent", { headers: { cookie } })).status).toBe(200);
  });
  it("changing the PIN invalidates every existing POS cookie", async () => {
    const old = await posSession();
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(200);
    await setPin(e.DB, "13579135");
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(401);
    const page = await req("/pos", { headers: { cookie: old } });
    expect(await page.text()).toContain('name="pin"');
    const fresh = (await login("13579135")).cookie;
    expect((await req("/pos/recent", { headers: { cookie: fresh } })).status).toBe(200);
  });
  it("disabling the PIN invalidates PIN cookies, and PIN cookies never work with no PIN set", async () => {
    const old = await posSession();
    await disablePin(e.DB);
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(401);
    expect((await form("/pos/charge", { csrf: "x", amount: "1.00", currency: "USD" }, old)).status).toBe(401);
  });
  it("rejects forged, tampered and expired cookies", async () => {
    const good = await posSession();
    const v = good.slice("0c_pos=".length);
    const bad = [`0c_pos=${v.slice(0, -1)}${v.endsWith("0") ? "1" : "0"}`, "0c_pos=p.1.9999999999999.", `0c_pos=${v.replace(/\.\d{13}\./, ".1000000000000.")}`, "0c_pos=garbage"];
    for (const c of bad) expect((await req("/pos/recent", { headers: { cookie: c } })).status).toBe(401);
  });
  it("an admin-issued POS cookie works with no PIN set, and stops when the PIN version changes", async () => {
    await disablePin(e.DB);
    const adm = await form("/admin/pos/open", { csrf: CSRF }, S.cookie);
    expect(adm.status).toBe(303);
    expect(adm.headers.get("location")).toBe("/pos");
    const sc = adm.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/Path=\/pos/i);
    expect(sc).toMatch(/Max-Age=7200/i);
    const cookie = `0c_pos=${cookieOf(adm, "0c_pos")}`;
    const ex = Number(cookie.split(".")[2]);
    expect(ex).toBeLessThanOrEqual(Date.now() + 7_200_000 + 5000);
    const adminTry = await req("/admin", { headers: { cookie } }); // a POS cookie is not an admin session
    expect(adminTry.status).toBe(302);
    expect(adminTry.headers.get("location")).toBe("/admin/login");
    expect((await req("/pos/recent", { headers: { cookie } })).status).toBe(200);
    await setPin(e.DB, PIN);
    expect((await req("/pos/recent", { headers: { cookie } })).status).toBe(401);
  });
});

describe("POST /pos/charge", () => {
  it("12.50 with asset btc:btc creates a pos invoice and payment and 303s to the payment page", async () => {
    const cookie = await posSession();
    const r = await charge(cookie, { amount: "12.50", currency: "USD", asset: "btc:btc" });
    expect(r.status).toBe(303);
    const m = /^\/i\/(inv_[a-z2-7]+)\/p\/(pay_[a-z2-7]+)$/.exec(r.headers.get("location") ?? "");
    expect(m).not.toBeNull();
    armed.add(m![1]!);
    const inv = (await posInvoice(m![1]!))!;
    expect(inv.price_minor).toBe(1250n);
    expect(inv.currency).toBe("USD");
    expect(inv.metadata).toEqual({ pos: true });
    const pays = await listPayments(e.DB, inv.id);
    expect(pays.map((p) => p.id)).toEqual([m![2]]);
    expect(pays[0]!.asset).toBe("btc:btc");
  });
  it("without an asset it goes to the invoice choice page", async () => {
    const cookie = await posSession();
    const r = await charge(cookie, { amount: "3", currency: "EUR", asset: "" });
    expect(r.status).toBe(303);
    const id = /^\/i\/(inv_[a-z2-7]+)$/.exec(r.headers.get("location") ?? "")?.[1];
    expect(id).toBeTruthy();
    const inv = (await posInvoice(id!))!;
    expect(inv.price_minor).toBe(300n);
    expect(inv.currency).toBe("EUR");
    expect(inv.metadata).toEqual({ pos: true });
    expect(await listPayments(e.DB, id!)).toEqual([]);
  });
  it("requires auth", async () => {
    await disablePin(e.DB);
    const before = await invCount();
    const r = await form("/pos/charge", { csrf: "x", amount: "5.00", currency: "USD" });
    expect(r.status).toBe(401);
    expect(await invCount()).toBe(before);
  });
  it("requires a CSRF token bound to the session", async () => {
    const a = await posSession();
    const before = await invCount();
    const body = { amount: "5.00", currency: "USD" };
    expect((await form("/pos/charge", body, a)).status).toBe(403); // none
    expect((await charge(a, body, "forged-token")).status).toBe(403); // wrong
    const b = await adminCookie();
    const tokenB = csrfOf(await (await req("/pos", { headers: { cookie: b } })).text());
    expect((await charge(a, body, tokenB)).status).toBe(403); // another session's token
    expect(await invCount()).toBe(before);
  });
  it.each([["0"], ["0.00"], ["0.001"], ["10000.01"], ["12.345"], ["abc"], ["-1"], ["1e3"], [" "], [""], ["1,50"], ["99999999999999999999"]])("rejects amount %j with 400 and no invoice", async (amount) => {
    const cookie = await posSession();
    const before = await invCount();
    const r = await charge(cookie, { amount, currency: "USD" });
    expect(r.status).toBe(400);
    expect(await invCount()).toBe(before);
  });
  it("accepts the bounds 0.01 and 10000.00", async () => {
    const cookie = await posSession();
    for (const [amount, minor] of [["0.01", 1n], ["10000", 1_000_000n], ["10000.00", 1_000_000n]] as const) {
      const r = await charge(cookie, { amount, currency: "USD" });
      expect(r.status).toBe(303);
      const id = /\/i\/(inv_[a-z2-7]+)$/.exec(r.headers.get("location") ?? "")![1]!;
      expect((await posInvoice(id))!.price_minor).toBe(minor);
    }
  });
  it("rejects an unknown currency", async () => {
    const cookie = await posSession();
    expect((await charge(cookie, { amount: "5.00", currency: "GBP" })).status).toBe(400);
  });
  it.each([["doge:doge"], ["nonsense"], ["btc"], ["eth:eth"]])("rejects invalid or unusable asset %j with 400 and no invoice", async (asset) => {
    const cookie = await posSession();
    const before = await invCount();
    const r = await charge(cookie, { amount: "5.00", currency: "USD", asset });
    expect(r.status).toBe(400);
    expect(await invCount()).toBe(before);
  });
  it("falls back to the invoice page when the payment cannot be priced", async () => {
    const cookie = await posSession();
    await putPrice(e, "USD", "LTC", 1n, Date.now() - 3_600_000);
    try {
      const r = await charge(cookie, { amount: "5.00", currency: "USD", asset: "ltc:ltc" });
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toMatch(/^\/i\/inv_[a-z2-7]+$/);
    } finally {
      await putPrice(e, "USD", "LTC", 100n * 10n ** 8n);
    }
  });
});

describe("recent", () => {
  it("requires auth", async () => {
    await setPin(e.DB, PIN);
    const r = await req("/pos/recent");
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("amount");
  });
  it("lists the last 20 POS invoices only, newest first, with no addresses or ids", async () => {
    await e.DB.prepare("UPDATE invoices SET metadata=NULL WHERE json_extract(metadata, '$.pos') = 1").run(); // forget earlier POS invoices
    const cookie = await posSession();
    await createInvoice(e, { price_amount: "99.00", price_currency: "USD", metadata: { link_id: "lnk_x" } }); // not POS
    await createInvoice(e, { price_amount: "98.00", price_currency: "USD" });
    for (let i = 1; i <= 21; i++) await createInvoice(e, { price_amount: `${i}.00`, price_currency: i % 2 ? "USD" : "EUR", metadata: { pos: true } });
    const paid = await charge(cookie, { amount: "12.50", currency: "USD", asset: "btc:btc" });
    const invId = /\/i\/(inv_[a-z2-7]+)\//.exec(paid.headers.get("location") ?? "")![1]!;
    armed.add(invId);
    const r = await req("/pos/recent", { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    const j = JSON.parse(text) as { invoices: Record<string, unknown>[] };
    expect(j.invoices).toHaveLength(20);
    expect(j.invoices[0]).toMatchObject({ amount: "12.50", currency: "USD", status: "open" });
    expect(Object.keys(j.invoices[0]!).sort()).toEqual(["amount", "created_at", "currency", "status"]);
    expect(j.invoices.map((i) => i.amount)).not.toContain("99.00");
    expect(j.invoices.map((i) => i.amount)).not.toContain("98.00");
    const addr = (await listPayments(e.DB, invId))[0]!.address;
    expect(text).not.toContain(addr);
    expect(text).not.toMatch(/inv_|pay_|bc1[qp]|metadata|order/);
  });
  it("is rendered server-side on the keypad page for no-JS use, also without addresses", async () => {
    await e.DB.prepare("UPDATE invoices SET metadata=NULL WHERE json_extract(metadata, '$.pos') = 1").run(); // forget earlier POS invoices
    const cookie = await posSession();
    const paid = await charge(cookie, { amount: "7.25", currency: "USD", asset: "btc:btc" });
    armed.add(/\/i\/(inv_[a-z2-7]+)\//.exec(paid.headers.get("location") ?? "")![1]!);
    const html = await (await req("/pos", { headers: { cookie } })).text();
    expect(html).toContain("7.25");
    expect(html).toContain("USD");
    expect(html).toContain("open");
    // bc1q/bc1p, not bare "bc1": the page carries a hex CSRF token, which can contain "bc1" by chance but never q or p.
    expect(html).not.toMatch(/bc1[qp]|inv_|pay_/);
  });
  it("shows an unpaid invoice past its expiry as expired", async () => {
    await e.DB.prepare("UPDATE invoices SET metadata=NULL WHERE json_extract(metadata, '$.pos') = 1").run(); // forget earlier POS invoices
    const cookie = await posSession();
    const r = await createInvoice(e, { price_amount: "4.00", price_currency: "USD", metadata: { pos: true } });
    if ("error" in r) throw new Error(r.error);
    await e.DB.prepare("UPDATE invoices SET expires_at=? WHERE id=?").bind(Date.now() - 1000, r.invoice.id).run();
    const j = (await (await req("/pos/recent", { headers: { cookie } })).json()) as { invoices: { status: string }[] };
    expect(j.invoices[0]!.status).toBe("expired");
  });
});

describe("assets and CSP", () => {
  it("serves pos.js and pos.css under the strict CSP with no third-party or inline code", async () => {
    const js = await req("/pos.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    const src = await js.text();
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).toContain("/pos/recent");
    expect(src).toContain("5000");
    expect(src).toContain("visibilitychange");
    expect((await req("/pos.css")).status).toBe(200);
    await setPin(e.DB, PIN);
    const csp = (await req("/pos")).headers.get("content-security-policy")!;
    expect(csp).not.toContain("script-src");
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline|https?:/);
  });
});

describe("admin /admin/pos", () => {
  const A = async () => S.cookie;
  const fp = async (path: string, body: Record<string, string>) => form(path, { csrf: CSRF, ...body }, await A());
  /** Passkey assertion for exactly this path and these fields (action pos.pin or pos.disable). */
  const ok = (path: string, body: Record<string, string>) => S.confirm(path.endsWith("/disable") ? "pos.disable" : "pos.pin", path, body);
  /** fp with a fresh passkey confirmation. */
  const cfp = async (path: string, body: Record<string, string>) => fp(path, { ...body, assertion: await ok(path, body) });
  it("requires an admin session", async () => {
    expect((await req("/admin/pos")).status).toBe(302);
    expect((await form("/admin/pos/pin", { csrf: CSRF, pin: "123456", pin2: "123456" })).status).not.toBe(303);
  });
  it("renders the POS section", async () => {
    const r = await req("/admin/pos", { headers: { cookie: await A() } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("POS");
    expect(html).toContain('name="pin"');
  });
  it("is the restyled Point of sale page", async () => {
    await disablePin(e.DB);
    const html = await (await req("/admin/pos", { headers: { cookie: await A() } })).text();
    expect(html).toMatch(/<h1[^>]*>[\s\S]*Point of sale[\s\S]*<\/h1>/);
    expect(html).toMatch(/<a\b[^>]*aria-current="page"[^>]*href="\/admin\/pos"|<a\b[^>]*href="\/admin\/pos"[^>]*aria-current="page"/);
    expect(html).toMatch(/<form\b[^>]*action="\/admin\/pos\/open"/);
    expect(html).toContain("Set a PIN");
    expect(html).not.toContain("Disable PIN");
    // The open form is the header action: one button, named "Open the POS", before the page body.
    expect(html.match(/action="\/admin\/pos\/open"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*>\s*Open the POS\s*<\/button>/);
    expect(html).toMatch(/<h2[^>]*>\s*How it works\s*<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>\s*Lockout\s*<\/h2>/);
    expect(html.indexOf("Open the POS")).toBeLessThan(html.indexOf("Set a PIN"));
  });
  it("?done=set shows the notice in a status region", async () => {
    const html = await (await req("/admin/pos?done=set", { headers: { cookie: await A() } })).text();
    expect(html).toMatch(/role="status"[^>]*>\s*PIN saved\. All POS sessions were signed out\./);
  });
  it("the passkey-confirmed forms bind exactly the same fields", async () => {
    await setPin(e.DB, PIN);
    const html = await (await req("/admin/pos", { headers: { cookie: await A() } })).text();
    expect(html).toContain("Change PIN");
    expect(confirmFields(html, "/admin/pos/pin")).toEqual(["pin", "pin2"]);
    expect(confirmFields(html, "/admin/pos/disable")).toEqual([]);
    expect(html).toMatch(/data-passkey-confirm="pos\.pin"/);
    expect(html).toMatch(/data-passkey-confirm="pos\.disable"/);
    await disablePin(e.DB);
  });
  it("setting the PIN needs a passkey confirmation (403 otherwise), an 8+ digit PIN, and changes the version", async () => {
    await disablePin(e.DB);
    const v0 = (await getPosConfig(e.DB)).version;
    expect((await fp("/admin/pos/pin", { pin: PIN, pin2: PIN, assertion: await ok("/admin/pos/pin", { pin: "13579135", pin2: "13579135" }) })).status).toBe(403);
    expect((await fp("/admin/pos/pin", { pin: PIN, pin2: PIN })).status).toBe(403);
    // Format checks run first (400 even with a valid confirmation).
    for (const bad of ["1234567", "abcdefgh", "1234567a", "1234567890123456789012345678901234567890"])
      expect((await cfp("/admin/pos/pin", { pin: bad, pin2: bad })).status).toBe(400);
    expect((await cfp("/admin/pos/pin", { pin: PIN, pin2: "99999999" })).status).toBe(400);
    expect((await getPosConfig(e.DB)).pin_hash).toBeNull();
    const assertion = await ok("/admin/pos/pin", { pin: PIN, pin2: PIN });
    const done = await fp("/admin/pos/pin", { pin: PIN, pin2: PIN, assertion });
    expect(done.status).toBe(303);
    const c = await getPosConfig(e.DB);
    expect(c.pin_hash).not.toBeNull();
    expect(c.version).toBeGreaterThan(v0);
    expect(await verifyPassword(PIN, c.pin_hash!, c.pin_salt!)).toBe(true);
    expect((await login()).cookie).not.toBe("");
    // a used confirmation does not work twice
    expect((await fp("/admin/pos/pin", { pin: PIN, pin2: PIN, assertion })).status).toBe(403);
  });
  it("changing the PIN through the panel kills existing POS sessions", async () => {
    await setPin(e.DB, PIN);
    const old = (await login()).cookie;
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(200);
    expect((await cfp("/admin/pos/pin", { pin: "65432165", pin2: "65432165" })).status).toBe(303);
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(401);
  });
  it("disabling needs a passkey confirmation and clears the hash and sessions", async () => {
    await setPin(e.DB, PIN);
    const old = (await login()).cookie;
    expect((await fp("/admin/pos/disable", {})).status).toBe(403);
    expect((await fp("/admin/pos/disable", { assertion: await ok("/admin/pos/pin", {}) })).status).toBe(403);
    expect((await getPosConfig(e.DB)).pin_hash).not.toBeNull();
    expect((await cfp("/admin/pos/disable", {})).status).toBe(303);
    const c = await getPosConfig(e.DB);
    expect(c.pin_hash).toBeNull();
    expect(c.pin_salt).toBeNull();
    expect((await req("/pos/recent", { headers: { cookie: old } })).status).toBe(401);
    expect((await form("/pos/login", { pin: PIN })).status).toBe(401);
  });
});
