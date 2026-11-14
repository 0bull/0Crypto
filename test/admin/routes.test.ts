import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { clearSettingsCache } from "../../src/settings";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { admin } from "../../src/admin/routes";
import { csrfFor, sessionGen, signSession } from "../../src/admin/session";
import { insertInvoice, insertPayment, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { setupNetwork } from "@msw/cloudflare";
import { clearChainIdMemo } from "../../src/chains/evm/config";
import { clearHealthMemo } from "../../src/chains/evm/health";
import { hotAccount } from "../../src/signing/evmkeys";
import { solHotKey, tronHotKey } from "../../src/signing/keys";
import { emptyState, evmRpc } from "../evm-rpc";
import { signedIn, type AdminTestSession } from "../admin-session";
import { confirmFields } from "./helpers";

const e = env as unknown as Env;
const BASE = "https://pay.test";
// A fixed pre-auth binder (the __Host-0c_setup cookie) and its CSRF token, for the public login and setup forms.
const SETUP_BINDER = "pre-auth-binder-for-tests-0123456789abcdefg";
const PRE_COOKIE = `__Host-0c_setup=${SETUP_BINDER}`;
let PRE = "";
// The signed-in session most tests use, and its CSRF token.
let S: AdminTestSession;
let CSRF = "";
let ipSeq = 0;
const freshIp = () => `10.7.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  // A configured webhook URL (D1 setting, as the dashboard stores it) so events are enqueued.
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('WEBHOOK_URL','https://merchant.test/hook',0)").run();
  clearSettingsCache();
  PRE = await csrfFor(e.SESSION_SECRET, SETUP_BINDER);
  S = await signedIn(e);
  CSRF = S.csrf;
});

const rawCookie = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + "="));
const sessionNow = async (exp: number) => signSession(e.SESSION_SECRET, await sessionGen(e.DB), exp);

async function authed(): Promise<Record<string, string>> {
  return S.headers;
}
const get = async (path: string, headers?: Record<string, string>) =>
  exports.default.fetch(BASE + path, { headers: { "cf-connecting-ip": freshIp(), ...(headers ?? (await authed())) }, redirect: "manual" });
const post = async (path: string, form: Record<string, string>, headers?: Record<string, string>) =>
  exports.default.fetch(BASE + path, {
    method: "POST",
    headers: { "cf-connecting-ip": freshIp(), "content-type": "application/x-www-form-urlencoded", ...(headers ?? (await authed())) },
    body: new URLSearchParams(form),
    redirect: "manual",
  });

describe("setup and login", () => {
  it("redirects unauthenticated /admin to the login page", async () => {
    const r = await get("/admin", {});
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("setup is gone once a passkey exists (claiming: claim.test.ts)", async () => {
    for (const p of ["/admin/setup", "/admin/setup/options", "/admin/setup/code"]) expect((await get(p, {})).status, p).toBe(404);
    expect((await post("/admin/setup", { csrf: PRE, code: "x", credential: "{}" }, { cookie: PRE_COOKIE })).status).toBe(404);
    expect((await post("/admin/setup/options", { csrf: PRE, code: "x" }, { cookie: PRE_COOKIE })).status).toBe(404);
  });

  it("ignores a pg_session cookie", async () => {
    const signed = await sessionNow(Date.now() + 3_600_000);
    const r = await get("/admin", { cookie: `pg_session=${signed}` });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
    expect((await get("/admin", { cookie: `__Host-0c_session=${signed}` })).status).toBe(200);
  });

  it("the sign-in page sets only 0c_ cookies, and no 0c_csrf", async () => {
    const g = await get("/admin/login", {});
    expect(rawCookie(g, "__Host-0c_setup")).toBeDefined();
    expect(g.headers.getSetCookie().every((c) => /^(__Host-)?0c_/.test(c))).toBe(true);
    expect(g.headers.getSetCookie().some((c) => c.includes("0c_csrf") || c.includes("0c_totp_setup"))).toBe(false);
  });

  it("the sign-in page is passkey only (sign-in itself: login.test.ts)", async () => {
    const html = await (await get("/admin/login", {})).text();
    expect(/<title>([^<]*)<\/title>/.exec(html)![1]).toMatch(/ · 0Crypto$/);
    expect(html).toContain("Sign in with passkey");
    expect(html).not.toMatch(/type="password"|one-time-code|Authenticator code/);
    // Sign-in, recovery and their options endpoints are public; everything else needs a session.
    expect((await get("/admin/recover", {})).status).toBe(200);
    expect((await post("/admin/login", { csrf: PRE, assertion: "" }, { cookie: PRE_COOKIE })).status).toBe(401);
    expect((await post("/admin/login", { password: "correct horse battery staple", code: "000000" }, { cookie: PRE_COOKIE })).status).toBe(403);
    expect((await post("/admin/webauthn/challenge", { csrf: PRE, action: "refund", params: "{}" }, { cookie: PRE_COOKIE })).status).toBe(302);
  });

  it("signs out with a 303 to the sign-in page and clears the cookie at Path=/", async () => {
    const s = await signedIn(e);
    const out = await post("/admin/logout", { csrf: s.csrf }, s.headers);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/admin/login");
    expect(rawCookie(out, "__Host-0c_session")).toMatch(/Max-Age=0/);
    expect(rawCookie(out, "__Host-0c_session")).toMatch(/Path=\//);
  });

  it("rejects forged, tampered and expired sessions", async () => {
    const good = await sessionNow(Date.now() + 60_000);
    const [gen, exp, sig] = good.split(".");
    expect((await get("/admin", { cookie: `__Host-0c_session=${good}` })).status).toBe(200);
    for (const c of [`${gen}.${Number(exp) + 999}.${sig}`, `${gen}.${exp}.${"0".repeat(64)}`, `${Number(gen) + 1}.${exp}.${sig}`, await sessionNow(Date.now() - 1000), "junk"])
      expect((await get("/admin", { cookie: `__Host-0c_session=${c}` })).status).toBe(302);
  });
});

let seq = 0;
async function mkInvoice(o: Partial<InvoiceRow> = {}): Promise<InvoiceRow> {
  const inv: InvoiceRow = {
    id: `inv_adm${Date.now()}${seq++}`, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD",
    order_id: null, metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...o,
  };
  await insertInvoice(e.DB, inv);
  return inv;
}
let paySeq = 0;
const mkPayment = (invoice_id: string, o: Partial<PaymentRow> = {}) => {
  const p: PaymentRow = {
    id: `pay_adm${Date.now()}${paySeq}`, invoice_id, asset: "btc:btc", chain: "btc", address: `bc1qadmin${paySeq++}${Date.now()}`, derivation_index: paySeq,
    reference: null, expected: 100000n, price_e8: 100_000n * 10n ** 8n, rate_locked_until: Date.now() + 1000, received: 0n, final: 0n, txids: [],
    status: "awaiting", created_at: Date.now(), detected_at: null, confirmed_at: null, credited_minor: 0n, credit_price_e8: null, unexpected: null, ...o,
  };
  return insertPayment(e.DB, p).then(() => p);
};

describe("dashboard", () => {
  it("renders figures from D1, svg bars without inline styles, and the recent table", async () => {
    await e.DB.prepare("DELETE FROM payments").run();
    await e.DB.prepare("DELETE FROM invoices").run();
    const now = Date.now();
    const paid = await mkInvoice({ status: "paid", paid_minor: 12_345n, order_id: "ORD-77" });
    await mkPayment(paid.id, { status: "confirmed", received: 1n, final: 1n, credited_minor: 12_345n, confirmed_at: now });
    await mkInvoice({ status: "paid", paid_minor: 5_000n, created_at: now - 45 * 86_400_000 }); // previous 30d period
    await mkInvoice({ status: "partially_paid", paid_minor: 1_000n });
    await mkInvoice({ status: "open" });
    await mkInvoice({ status: "open", expires_at: now - 1000 }); // expired: not awaiting
    const html = await (await get("/admin")).text();
    expect(html).toContain("Overview");
    expect(html).toMatch(/>0Crypto<\/span>/); // the wordmark
    expect(html).toContain("$133.45"); // received 12,345 + 1,000
    expect(html).toContain("+166.9%"); // (13345-5000)/5000
    expect(html).toContain("Avg $123.45");
    expect(html).toMatch(/Waiting[\s\S]{0,200}>2</); // one open + one partially paid; the expired open one is excluded
    expect(html).toContain("1 partially paid");
    expect(html).toContain("<rect");
    expect(html).not.toMatch(/ style=/);
    // No inline script: the only script is the self-hosted passkey helper every admin page loads.
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/admin-passkey.js" defer="">']);
    expect(html).toContain("ORD-77");
    expect(html).toContain("BTC");
    expect(html).not.toContain("Waiting to route");
    const p7 = await (await get("/admin?p=7d")).text();
    expect(p7).toContain("$133.45");
    expect(p7).not.toContain("vs previous"); // previous 7d is zero: change omitted
  });

  it("the invoices list filters by status and sets security headers", async () => {
    await mkInvoice({ status: "expired", order_id: "ORD-EXPIRED-ONLY" });
    const r = await get("/admin/invoices?status=expired");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("ORD-EXPIRED-ONLY");
    expect(html).not.toContain("ORD-77");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the invoices list: every status by default, a GET filter form, the six columns, and a session", async () => {
    const inv = await mkInvoice({ order_id: "ORD-LIST" });
    const html = await (await get("/admin/invoices")).text();
    expect(html).toContain("<h1>Invoices</h1>");
    expect(html).toContain("ORD-LIST");
    expect(html).toContain("ORD-77");
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/admin\/invoices"/);
    expect(html).toMatch(/<select[^>]*name="status"/);
    expect(html).toMatch(/<table[^>]*aria-label="Invoices"/);
    for (const head of ["Invoice", "Order", "Amount", "Paid with", "Status", "Created"]) expect(html).toContain(`<th scope="col">${head}</th>`);
    expect(html).toContain(`href="/admin/invoices/${inv.id}"`);
    expect(html).toMatch(/title="\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC"/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/invoices\/new"/);
    // An unknown status is ignored (all invoices); signed out it is the sign-in page.
    expect(await (await get("/admin/invoices?status=bogus")).text()).toContain("ORD-LIST");
    const out = await get("/admin/invoices", {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/admin/login");
  });
});

describe("invoice detail and resend", () => {
  it("shows payments, events and deliveries, and resend needs the CSRF token", async () => {
    const inv = await mkInvoice({ order_id: "ORD-DETAIL" });
    const p = await mkPayment(inv.id, { status: "confirming", received: 50000n, txids: ["tx_aaa111"] });
    const evId = `invoice.created:${inv.id}:1`;
    await e.DB.prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) VALUES(?,?,?,?,?)").bind(evId, Date.now(), "invoice.created", inv.id, "{}").run();
    await e.DB.prepare("INSERT INTO deliveries(event_id,attempt,at,status,error) VALUES(?,?,?,?,?)").bind(evId, 1, Date.now(), 500, "boom").run();
    const html = await (await get(`/admin/invoices/${inv.id}`)).text();
    expect(html).toContain(p.address);
    expect(html).toContain("tx_aaa111");
    expect(html).toContain("invoice.created");
    expect(html).toContain("boom");
    expect(html).toContain(`/admin/events/${encodeURIComponent(evId)}/resend`);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/admin\/invoices"|href="\/admin\/invoices"[^>]*aria-current="page"/);
    expect(html).toContain("Payments");
    expect(html).toContain("Events and deliveries");
    expect(html).toContain(`href="/i/${inv.id}"`);
    expect(html).toContain('href="/admin/invoices"');
    expect((await get("/admin/invoices/inv_missing")).status).toBe(404);

    const url = `/admin/events/${encodeURIComponent(evId)}/resend`;
    expect((await post(url, {})).status).toBe(403);
    expect((await post(url, { csrf: "other" })).status).toBe(403);
    const spy = vi.spyOn(e.WEBHOOKS, "sendBatch");
    const ok = await post(url, { csrf: CSRF });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/admin/invoices/${inv.id}`);
    expect(spy).toHaveBeenCalledWith([{ body: { eventId: evId } }]);
    spy.mockRestore();
  });
});

describe("invoice detail actions", () => {
  it("keeps each confirm form's bound fields, the refund link and the recovery notice", async () => {
    const inv = await mkInvoice();
    const tx = "a1b2c3d4".repeat(8);
    const p = await mkPayment(inv.id, { asset: "tron:usdt", chain: "tron", status: "confirmed", txids: [tx] });
    await e.DB.prepare("UPDATE payments SET sweep_error='needs admin' WHERE id=?").bind(p.id).run();
    const html = await (await get(`/admin/invoices/${inv.id}`)).text();
    expect(html).toContain(tx);
    expect(confirmFields(html, `/admin/payments/${p.id}/retry-sweep`)).toEqual([]);
    expect(html).toContain(`href="/admin/payments/${p.id}/refund"`);
    const sent = await (await get(`/admin/invoices/${inv.id}?recovery=sent&chain=base`)).text();
    expect(sent).toContain("Recovery transaction sent on base");
    const failed = await (await get(`/admin/invoices/${inv.id}?recovery=failed&chain=base`)).text();
    expect(failed).toMatch(/role="alert"[^>]*>Recovery failed on base/);
  });
});

describe("invoice metadata", () => {
  it("renders escaped in the Metadata row, long values included", async () => {
    const long = "z".repeat(200);
    const inv = await mkInvoice({ metadata: { note: '<script>alert(1)</script> "quoted"', long } });
    const html = await (await get(`/admin/invoices/${inv.id}`)).text();
    const row = /<dt>Metadata<\/dt><dd>([\s\S]*?)<\/dd>/.exec(html)?.[1] ?? "";
    expect(row).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(row).not.toContain("<script>");
    expect(row).toContain("\\&quot;quoted\\&quot;");
    expect(row).toContain(long);
  });
});

describe("new invoice expiry error", () => {
  it("names the field and says minutes", async () => {
    const bad = await post("/admin/invoices/new", { csrf: CSRF, amount: "5.00", currency: "USD", expiry_minutes: "abc" });
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toMatch(/role="alert"[^>]*>Expiry must be a whole number of minutes/);
    expect(html).toMatch(/<input[^>]*name="expiry_minutes"[^>]*aria-invalid="true"|<input[^>]*aria-invalid="true"[^>]*name="expiry_minutes"/);
  });
});

describe("unexpected deposits", () => {
  it("are listed per payment with each asset's decimals, only when present", async () => {
    const inv = await mkInvoice();
    await mkPayment(inv.id, { asset: "base:usdc", chain: "base", unexpected: { "base:eth": 10n ** 16n, "base:dai": 2_500_000_000_000_000_000n } });
    const html = await (await get(`/admin/invoices/${inv.id}`)).text();
    expect(html).toContain("Unexpected: 0.01 ETH");
    expect(html).toContain("Unexpected: 2.5 DAI");
    const clean = await mkInvoice();
    await mkPayment(clean.id);
    expect(await (await get(`/admin/invoices/${clean.id}`)).text()).not.toContain("Unexpected");
  });
});

describe("new invoice", () => {
  it("creates through the shared createInvoice and redirects to the detail page", async () => {
    expect((await (await get("/admin/invoices/new")).text())).toContain('name="amount"');
    const bad = await post("/admin/invoices/new", { csrf: CSRF, amount: "abc", currency: "USD" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toMatch(/<input[^>]*name="amount"[^>]*aria-invalid="true"|<input[^>]*aria-invalid="true"[^>]*name="amount"/);
    expect(badHtml).toMatch(/role="alert"[^>]*>Amount must be a decimal/);
    const ok = await post("/admin/invoices/new", { csrf: CSRF, amount: "19.99", currency: "EUR", order_id: "FORM-1", expiry_minutes: "30" });
    expect(ok.status).toBe(303);
    const loc = ok.headers.get("location")!;
    expect(loc).toMatch(/^\/admin\/invoices\/inv_/);
    const inv = await e.DB.prepare("SELECT price_minor,currency,order_id,expires_at,created_at FROM invoices WHERE id=?").bind(loc.split("/").pop()).first<Record<string, unknown>>();
    expect(inv).toMatchObject({ price_minor: "1999", currency: "EUR", order_id: "FORM-1" });
    expect((inv!.expires_at as number) - (inv!.created_at as number)).toBe(30 * 60_000);
  });
});

describe("hardening", () => {
  it("returns 503 on every admin route when SESSION_SECRET is missing or short", async () => {
    const app = new Hono().route("/admin", admin);
    for (const secret of [undefined, "too-short"]) {
      const r = await app.request("/admin/login", {}, { ...e, SESSION_SECRET: secret });
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("no longer accepts a double-submitted 0c_csrf cookie", async () => {
    const bad = "short";
    const r = await post("/admin/alerts/none/resolve", { csrf: bad }, { cookie: `${S.cookie}; 0c_csrf=${bad}` });
    expect(r.status).toBe(403);
  });

  it("rejects sessions that expire further out than 12h", async () => {
    const far = await sessionNow(Date.now() + 13 * 3_600_000);
    expect((await get("/admin", { cookie: `__Host-0c_session=${far}` })).status).toBe(302);
  });

  it("filters open-but-past-expiry invoices as expired, not open", async () => {
    await mkInvoice({ status: "open", order_id: "ORD-LAPSED", expires_at: Date.now() - 5000 });
    expect(await (await get("/admin/invoices?status=expired")).text()).toContain("ORD-LAPSED");
    expect(await (await get("/admin/invoices?status=open")).text()).not.toContain("ORD-LAPSED");
  });
});

describe("EVM chains panel", () => {
  const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE };
  const network = setupNetwork();
  beforeAll(() => network.enable());
  afterAll(() => {
    Object.assign(e, saved);
    network.disable();
  });

  it("lists each configured chain with factory status, hot wallet, balance and finality lag", async () => {
    Object.assign(e, { EVM_RPC_BASE: "https://rpc.test/admin-base" });
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    const hot = hotAccount(e).address;
    const state = { ...emptyState(), code: "0x", latestTime: 2000, finalizedTime: 1940, latest: { native: { [hot.toLowerCase()]: 15n * 10n ** 17n } } };
    network.use(evmRpc("https://rpc.test/admin-base", () => state));
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("EVM chains");
    expect(html).toContain("base");
    expect(html).toContain("Not deployed");
    expect(html).toContain(hot);
    expect(html).toContain("1.5 ETH");
    expect(html).toContain("60 s");
    expect(html).not.toMatch(/data-label="Chain">arb</); // unconfigured chains are not listed
    expect((await get("/admin/wallets", {})).status).toBe(302); // needs a session
  });

  it("marks values stale (with the time of the last good read) when the latest refresh failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    const hot = hotAccount(e).address;
    let state = { ...emptyState(), latest: { native: { [hot.toLowerCase()]: 10n ** 18n } } } as ReturnType<typeof emptyState>;
    network.use(evmRpc("https://rpc.test/admin-base", () => state));
    expect(await (await get("/admin/wallets")).text()).not.toContain("stale since");
    const kv = JSON.parse((await e.KV.get("evm:health:base"))!);
    await e.KV.put("evm:health:base", JSON.stringify({ ...kv, until: Date.now() - 1, checkedAt: Date.UTC(2026, 10, 13, 12, 0, 0) }));
    clearHealthMemo();
    state = { ...state, down: true };
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("1 ETH");
    expect(html).toContain("stale since 2026-11-13 12:00:00 UTC");
    expect(html.match(/stale since/g)).toHaveLength(1); // once per row
    warn.mockRestore();
  });

  it("shows unknown deployment and balance when the RPC could not be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    network.use(evmRpc("https://rpc.test/admin-base", () => ({ ...emptyState(), down: true })));
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("unknown (RPC unavailable)");
    expect(html).not.toContain("chain id mismatch");
    expect(html).not.toContain("Not deployed");
    expect(html).not.toContain("0 ETH");
    warn.mockRestore();
  });

  it("shows a chain id mismatch distinctly from an RPC outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    clearChainIdMemo();
    network.use(evmRpc("https://rpc.test/admin-base", () => ({ ...emptyState(), chainId: 1 })));
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("chain id mismatch");
    expect(html).not.toContain("RPC unavailable");
    expect(html).not.toContain("Not deployed");
    clearChainIdMemo();
    warn.mockRestore();
  });
});

describe("Wallets page: watch-only wallets", () => {
  const saved = { BTC_XPUB: e.BTC_XPUB, LTC_XPUB: e.LTC_XPUB, DOGE_XPUB: e.DOGE_XPUB, BTC_XPUB_START_INDEX: e.BTC_XPUB_START_INDEX };
  afterAll(() => Object.assign(e, saved));
  const XPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

  it("says Not connected for a chain with no xpub, linking to Settings", async () => {
    Object.assign(e, { BTC_XPUB: "", LTC_XPUB: "", DOGE_XPUB: "" });
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("Watch-only wallets");
    expect(html).toContain("Not connected");
    expect(html).toMatch(/<a [^>]*href="\/admin\/settings"[^>]*>Connect in Settings<\/a>/);
    expect(html).toContain("Where payments land and the hot wallets that sweep them.");
  });

  it("shows a connected xpub truncated with the full value in a title, and its start index", async () => {
    Object.assign(e, { BTC_XPUB: XPUB, BTC_XPUB_START_INDEX: "5" });
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain(`title="${XPUB}"`);
    expect(html).not.toMatch(new RegExp(`>${XPUB}<`));
    expect(html).toContain("Start index");
  });

  it("explains a chain disabled because MASTER_SEED is not set", async () => {
    const savedEnv = { MASTER_SEED: e.MASTER_SEED, EVM_RPC_BASE: e.EVM_RPC_BASE, ALLOW_SEED_CUSTODY: e.ALLOW_SEED_CUSTODY };
    Object.assign(e, { MASTER_SEED: "", EVM_RPC_BASE: "https://rpc.test/admin-base", ALLOW_SEED_CUSTODY: "true" });
    try {
      const r = await get("/admin/wallets");
      expect(await r.text()).toMatch(/role="alert"[^>]*>[^<]*MASTER_SEED is not set/);
    } finally {
      Object.assign(e, savedEnv);
    }
  });
});

describe("Tron and Solana hot wallets on the chains page", () => {
  const saved = { TRONGRID_API_KEY: e.TRONGRID_API_KEY, SOLANA_RPC_URL: e.SOLANA_RPC_URL };
  afterAll(() => Object.assign(e, saved));
  const tronHot = tronHotKey(e.MASTER_SEED!).address;
  const solHot = solHotKey(e.MASTER_SEED!).address;

  it("shows each configured chain's hot wallet address and path, derived from MASTER_SEED, with what to fund it with", async () => {
    Object.assign(e, { TRONGRID_API_KEY: "test-trongrid-key", SOLANA_RPC_URL: "https://sol.test/rpc" });
    const html = await (await get("/admin/wallets")).text();
    expect(html).toContain("Tron and Solana hot wallets");
    expect(html).toContain(tronHot);
    expect(html).toContain("m/44&#39;/195&#39;/1&#39;/0/0");
    expect(html).toContain(solHot);
    expect(html).toContain("m/44&#39;/501&#39;/2147483646&#39;/0&#39;");
    expect(html).toMatch(/TRX/);
    expect(html).toMatch(/custom derivation path/);
    expect((await get("/admin/wallets", {})).status).toBe(302);
  });

  it("lists only chains whose config is valid", async () => {
    Object.assign(e, { TRONGRID_API_KEY: "", SOLANA_RPC_URL: "https://sol.test/rpc" });
    let html = await (await get("/admin/wallets")).text();
    expect(html).not.toContain(tronHot);
    expect(html).toContain(solHot);
    Object.assign(e, { TRONGRID_API_KEY: "test-trongrid-key", SOLANA_RPC_URL: "http://insecure.test/rpc" });
    html = await (await get("/admin/wallets")).text();
    expect(html).toContain(tronHot);
    expect(html).not.toContain(solHot);
    Object.assign(e, { TRONGRID_API_KEY: "", SOLANA_RPC_URL: "" });
    html = await (await get("/admin/wallets")).text();
    expect(html).not.toContain(tronHot);
    expect(html).not.toContain(solHot);
    expect(html).toMatch(/Neither Tron nor Solana is configured/);
  });
});
