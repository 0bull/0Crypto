// The first-run wizard (Your shop → Coins → Done) and the Overview's "Finish setting up" checklist (Plan 7 Task 10).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NEEDS_JS } from "../../src/admin/confirm";
import { setupChecklist } from "../../src/admin/checklist";
import { insertInvoice } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { clearSettingsCache, effectiveEnv, saveSettings } from "../../src/settings";
import { signedIn, type AdminTestSession } from "../admin-session";

const e = env as unknown as Env;
const BASE = "https://pay.test";
// BIP84 test vector (account 0 of the "abandon ... about" mnemonic) and its first receive address.
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const SECRET = /whsec_[A-Za-z0-9_-]{43}/;
let S: AdminTestSession;
const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
beforeEach(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await e.DB.batch(
    ["settings", "payments", "invoices", "passkeys", "webauthn_challenges"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
  );
  clearSettingsCache();
  // A claim leaves exactly one passkey and a session: what signedIn sets up.
  S = await signedIn(e);
});

const post = (path: string, form: Record<string, string>, cookie = S.cookie) =>
  exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
const get = (path: string, cookie = S.cookie) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });

/** The coins step with a "settings.wallets" assertion bound to these fields on /admin/welcome/coins. */
async function coins(fields: Record<string, string>) {
  const assertion = await S.confirm("settings.wallets", "/admin/welcome/coins", fields);
  return post("/admin/welcome/coins", { csrf: S.csrf, ...fields, assertion });
}

/** The `<li>` of checklist item `step`, or undefined when the panel does not list it. */
const item = (html: string, step: string) => new RegExp(`<li[^>]*data-step="${step}"[^>]*>`).exec(html)?.[0];

describe("wizard: your shop", () => {
  it("after a claim, /admin/welcome is the shop step: the name form, the public URL read-only and Skip for now", async () => {
    const r = await get("/admin/welcome");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain('action="/admin/welcome/shop"');
    expect(html).toContain('name="MERCHANT_NAME"');
    expect(html).toContain("https://pay.test");
    expect(html).not.toContain('name="PUBLIC_URL"');
    expect(html).toMatch(/<a[^>]*href="\/admin\/welcome\?step=coins"[^>]*>Skip for now<\/a>/);
    expect((await get("/admin/welcome?step=shop")).status).toBe(200);
  });

  it("needs a session", async () => {
    const r = await exports.default.fetch(`${BASE}/admin/welcome`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
  });

  it("saving the shop name answers 303 to the coins step; CSRF is required and a bad value is 400", async () => {
    expect((await post("/admin/welcome/shop", { MERCHANT_NAME: "Bean Bar" })).status).toBe(403);
    const r = await post("/admin/welcome/shop", { csrf: S.csrf, MERCHANT_NAME: "Bean Bar" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/welcome?step=coins");
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("Bean Bar");
    const bad = await post("/admin/welcome/shop", { csrf: S.csrf, MERCHANT_NAME: "x".repeat(65) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("at most 64 characters");
  });
});

describe("wizard: coins", () => {
  it("shows the passkey-confirmed wallets form with uniquely named coin boxes and Skip for now", async () => {
    const html = await (await get("/admin/welcome?step=coins")).text();
    expect(html).toContain('action="/admin/welcome/coins"');
    expect(html).toContain('data-passkey-confirm="settings.wallets"');
    for (const k of ["BTC_XPUB", "LTC_XPUB", "DOGE_XPUB", "DOGE_BLOCKBOOK_URL", "asset:btc:btc", "asset:ltc:ltc", "asset:doge:doge"]) expect(html).toContain(`name="${k}"`);
    // Routed-mode coins are greyed out with a docs link.
    expect(html).toMatch(/name="asset:base:usdc"[^>]*disabled/);
    expect(html).toContain("Advanced: see docs");
    expect(html).not.toMatch(/name="action"/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/welcome\?step=done"[^>]*>Skip for now<\/a>/);
  });

  it("with an assertion, saves the zpub and shows the BIP84 first address and a Continue link", async () => {
    const r = await coins({ BTC_XPUB: ZPUB, "asset:btc:btc": "on" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(FIRST);
    expect(html).toContain("Check this matches the first address in your wallet.");
    expect(html).toMatch(/<a[^>]*href="\/admin\/welcome\?step=done"[^>]*>Continue<\/a>/);
    const eff = await effectiveEnv(e);
    expect(eff.BTC_XPUB).toBe(ZPUB);
    expect(eff.ENABLED_ASSETS).toBe("btc:btc");
  });

  it("keeps an enabled locked coin (its box is not posted or bound) and notes it", async () => {
    await saveSettings(e, { ENABLED_ASSETS: "base:usdc" });
    expect(await (await get("/admin/welcome?step=coins")).text()).toContain("Kept on; configure under Advanced.");
    const r = await coins({ BTC_XPUB: ZPUB, "asset:btc:btc": "on" });
    expect(r.status).toBe(200);
    expect((await effectiveEnv(e)).ENABLED_ASSETS).toBe("btc:btc,base:usdc");
  });

  it("without an assertion: 403 with the needs-JavaScript text, nothing saved", async () => {
    const r = await post("/admin/welcome/coins", { csrf: S.csrf, BTC_XPUB: ZPUB, "asset:btc:btc": "on" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect((await effectiveEnv(e)).BTC_XPUB ?? "").toBe("");
  });

  it("an assertion made for the Settings page does not pass on the wizard (the path is bound)", async () => {
    const fields = { BTC_XPUB: ZPUB, "asset:btc:btc": "on" };
    const assertion = await S.confirm("settings.wallets", "/admin/settings/wallets", fields);
    expect((await post("/admin/welcome/coins", { csrf: S.csrf, ...fields, assertion })).status).toBe(403);
  });

  it("fits a 375 px screen: fieldsets may shrink below their content and the first-address well wraps", async () => {
    // A fieldset defaults to min-inline-size: min-content, so the unbreakable bc1q… address widened the page.
    const css = await (await get("/admin.css")).text();
    expect(css).toMatch(/(^|[\s,}])fieldset\{[^}]*min-width:0/);
    expect(css).toMatch(/\.form \.well\{[^}]*overflow-wrap:anywhere/);
  });
  it("an invalid xpub is 400 with the settings message", async () => {
    const r = await coins({ BTC_XPUB: "xpub-nope", "asset:btc:btc": "on" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("That is not a Bitcoin account extended public key");
  });
});

describe("wizard: done", () => {
  it("shows the reveal form (never the secret), the webhook URL and test forms, the $1 test invoice form and a link to /admin", async () => {
    const r = await get("/admin/welcome?step=done");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain("whsec_");
    expect(html).toMatch(/<form[^>]*action="\/admin\/developers\/webhook\/reveal"[^>]*data-passkey-confirm="webhook.rotate"/);
    expect(html).toMatch(/<form[^>]*action="\/admin\/developers\/webhook"[^>]*>[\s\S]*?name="from" value="welcome"/);
    expect(html).toMatch(/<form[^>]*action="\/admin\/developers\/webhook\/test"[^>]*>[\s\S]*?name="from" value="welcome"/);
    expect(html).toContain('<form method="post" action="/admin/welcome/test-invoice" target="_blank"');
    expect(html).toMatch(/<a[^>]*href="\/admin"[^>]*>/);
  });

  it("reveal from the wizard renders the wizard with the secret: no redirect, no-store, never in a URL", async () => {
    const assertion = await S.confirm("webhook.rotate", "/admin/developers/webhook/reveal", { from: "welcome" });
    const r = await post("/admin/developers/webhook/reveal", { csrf: S.csrf, from: "welcome", assertion });
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    const secret = SECRET.exec(html)![0];
    expect(secret).toBe((await effectiveEnv(e)).WEBHOOK_SECRET);
    expect(html).toContain(`data-copy="${secret}"`);
    // It is the wizard's done step (the test invoice form), not the Developers page.
    expect(html).toContain('action="/admin/welcome/test-invoice"');
    expect(html).not.toMatch(/href="[^"]*whsec_/);
  });

  it("the test event from the wizard renders the wizard (400 without a webhook URL)", async () => {
    const r = await post("/admin/developers/webhook/test", { csrf: S.csrf, from: "welcome" });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("Save a webhook URL first.");
    expect(html).toContain('action="/admin/welcome/test-invoice"');
  });

  it("the wizard's test event: a 2xx answer is a status, a non-2xx answer an alert", async () => {
    const hook = "https://merchant.test/hook";
    await saveSettings(e, { WEBHOOK_URL: hook });
    network.use(http.post(hook, () => HttpResponse.json({ ok: true })));
    const ok = await (await post("/admin/developers/webhook/test", { csrf: S.csrf, from: "welcome" })).text();
    expect(ok).toMatch(/role="status"[^>]*>Test event: HTTP 200\./);
    network.use(http.post(hook, () => new HttpResponse("nope", { status: 404 })));
    const bad = await (await post("/admin/developers/webhook/test", { csrf: S.csrf, from: "welcome" })).text();
    expect(bad).toMatch(/role="alert"[^>]*>Test event: HTTP 404\. Your endpoint did not accept it/);
    expect(bad).not.toMatch(/role="status"[^>]*>Test event/);
    expect(bad).toContain('action="/admin/welcome/test-invoice"');
  });

  it("the $1 test invoice answers 303 to its checkout, priced 100 minor USD with order id test", async () => {
    expect((await post("/admin/welcome/test-invoice", {})).status).toBe(403);
    const r = await post("/admin/welcome/test-invoice", { csrf: S.csrf });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location")!;
    expect(loc).toMatch(/^\/i\/inv_[A-Za-z0-9]+$/);
    const row = await e.DB.prepare("SELECT price_minor, currency, order_id FROM invoices WHERE id=?").bind(loc.slice(3)).first<{ price_minor: string; currency: string; order_id: string }>();
    expect(row).toEqual({ price_minor: "100", currency: "USD", order_id: "test" });
  });
});

describe("setup checklist", () => {
  const paidInvoice = () =>
    insertInvoice(e.DB, {
      id: `inv_paid${Date.now()}`, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 100n, currency: "USD", order_id: null,
      metadata: null, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 100n,
    });

  it("setupChecklist follows the done conditions", async () => {
    await saveSettings(e, { ENABLED_ASSETS: "" });
    expect(await setupChecklist(await effectiveEnv(e))).toEqual({ passkey: true, wallet: false, paidInvoice: false, webhook: false, backupPasskey: false });
    await saveSettings(e, { ENABLED_ASSETS: "btc:btc", BTC_XPUB: ZPUB, WEBHOOK_URL: "https://merchant.test/hook" });
    await paidInvoice();
    // A second passkey for another RP ID (an old domain) is no backup here.
    await e.DB.prepare("INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id) VALUES('old-pk',x'00',0,NULL,'Old',1,'old.test')").run();
    expect((await setupChecklist(await effectiveEnv(e))).backupPasskey).toBe(false);
    await signedIn(e); // a second passkey
    expect(await setupChecklist(await effectiveEnv(e))).toEqual({ passkey: true, wallet: true, paidInvoice: true, webhook: true, backupPasskey: true });
  });

  it("the Overview lists 5 items with links, marks wallet done after the coins step, and drops the panel once all 5 are done", async () => {
    await saveSettings(e, { ENABLED_ASSETS: "" });
    let html = await (await get("/admin")).text();
    expect(html).toContain("Finish setting up");
    expect(html.match(/<li[^>]*data-step="/g)).toHaveLength(5);
    expect(item(html, "passkey")).toContain('data-done="true"');
    expect(item(html, "wallet")).toContain('data-done="false"');
    expect(html).toContain('href="/admin/welcome?step=coins"');
    expect(html).toContain('href="/admin/passkeys"');
    expect(html).toContain("1 of 5 done");

    expect((await coins({ BTC_XPUB: ZPUB, "asset:btc:btc": "on" })).status).toBe(200);
    html = await (await get("/admin")).text();
    expect(item(html, "wallet")).toContain('data-done="true"');
    expect(html).toContain("2 of 5 done");

    await saveSettings(e, { WEBHOOK_URL: "https://merchant.test/hook" });
    await paidInvoice();
    await signedIn(e);
    html = await (await get("/admin")).text();
    expect(html).not.toContain("Finish setting up");
    expect(item(html, "wallet")).toBeUndefined();
    expect(html).toContain("<h1>Overview</h1>");
  });
});
