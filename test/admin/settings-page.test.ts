// The Settings page (Plan 7 Task 9): shop (session + CSRF), read-only public URL, wallets and coins (passkey-confirmed).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BAD_ASSERTION, NEEDS_JS } from "../../src/admin/confirm";
import { insertInvoice, insertPayment } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { clearSettingsCache, effectiveEnv } from "../../src/settings";
import { signedIn, type AdminTestSession } from "../admin-session";
import { assetField, OFFERABLE } from "../../src/admin/settings";
import { confirmFields } from "./helpers";

const e = env as unknown as Env;
const BASE = "https://pay.test";
// BIP84 test vector (account 0 of the "abandon ... about" mnemonic); its first receive address is below.
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const NOTE = "Moving to a new domain? Open the gateway on the new domain and use “Lost your passkey or moved?”";
const PINNED = "PUBLIC_URL is set by a Wrangler var, which wins over this page. To move to a new domain, change the var.";
let S: AdminTestSession;

beforeEach(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await e.DB.batch([
    e.DB.prepare("DELETE FROM settings"),
    e.DB.prepare("DELETE FROM payments"),
    e.DB.prepare("DELETE FROM invoices"),
    e.DB.prepare("DELETE FROM passkeys"),
    e.DB.prepare("DELETE FROM webauthn_challenges"),
  ]);
  clearSettingsCache();
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

/** Posts the wallets form with a passkey assertion bound to `bound` (default: the posted fields). */
async function saveWallets(fields: Record<string, string>, bound = fields) {
  const assertion = await S.confirm("settings.wallets", "/admin/settings/wallets", bound);
  return post("/admin/settings/wallets", { csrf: S.csrf, ...fields, assertion });
}

describe("settings page", () => {
  it("without a PUBLIC_URL var, says how to move with recovery", async () => {
    const saved = e.PUBLIC_URL;
    await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('PUBLIC_URL','https://pay.test',?)").bind(Date.now()).run();
    clearSettingsCache();
    Object.assign(e, { PUBLIC_URL: "" });
    try {
      const html = await (await get("/admin/settings")).text();
      expect(html).toContain("https://pay.test");
      expect(html).toContain(NOTE);
      expect(html).not.toContain(PINNED);
    } finally {
      Object.assign(e, { PUBLIC_URL: saved });
      clearSettingsCache();
    }
  });
  it("needs a session", async () => {
    const r = await exports.default.fetch(`${BASE}/admin/settings`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
  });

  it("shows the shop form, the public URL read-only with the move note, and the passkey-confirmed wallets form", async () => {
    const r = await get("/admin/settings");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('action="/admin/settings/shop"');
    expect(html).toContain('name="MERCHANT_NAME"');
    expect(html).toContain('name="SUCCESS_URL_HOSTS"');
    expect(html).toContain("https://pay.test");
    expect(html).not.toContain('name="PUBLIC_URL"');
    // The test config sets PUBLIC_URL as a Wrangler var, which wins over D1: recovery cannot move it, the var must change.
    expect(html).toContain(PINNED);
    expect(html).not.toContain(NOTE);
    expect(html).toContain('data-passkey-confirm="settings.wallets"');
    for (const k of ["BTC_XPUB", "BTC_XPUB_START_INDEX", "BTC_ESPLORA_URL", "LTC_XPUB", "LTC_XPUB_START_INDEX", "LTC_ESPLORA_URL", "DOGE_XPUB", "DOGE_XPUB_START_INDEX", "DOGE_BLOCKBOOK_URL"])
      expect(html).toContain(`name="${k}"`);
  });

  it("lists every asset as a uniquely named checkbox, ticked from the effective ENABLED_ASSETS", async () => {
    const html = await (await get("/admin/settings")).text();
    // The test var is "btc:btc,ltc:ltc".
    expect(html).toMatch(/name="asset:btc:btc"[^>]*checked/);
    expect(html).toMatch(/name="asset:ltc:ltc"[^>]*checked/);
    expect(html).not.toMatch(/name="asset:doge:doge"[^>]*checked/);
    expect(html).toContain('name="asset:sol:usdc"');
    expect(html).toContain('name="asset:ln:btc"');
    // Detection-only TRX is never a payment asset.
    expect(html).not.toContain('name="asset:tron:trx"');
  });

  it("disables a coin whose chain needs secrets, with 'Advanced: see docs' and its reason", async () => {
    const html = await (await get("/admin/settings")).text();
    expect(html).toMatch(/name="asset:base:usdc"[^>]*disabled/);
    expect(html).toContain("Advanced: see docs");
    expect(html).toContain("EVM_RPC_BASE");
    // UTXO coins are configured on this form, so they stay tickable.
    expect(html).not.toMatch(/name="asset:doge:doge"[^>]*disabled/);
  });
});

describe("split shop forms", () => {
  it("posting only the shop name leaves the success URL hosts unchanged", async () => {
    await post("/admin/settings/shop", { csrf: S.csrf, MERCHANT_NAME: "Bean Bar", SUCCESS_URL_HOSTS: "shop.example.com" });
    const r = await post("/admin/settings/shop", { csrf: S.csrf, MERCHANT_NAME: "Bean Bar 2" });
    expect(r.status).toBe(303);
    clearSettingsCache();
    const eff = await effectiveEnv(e);
    expect(eff.MERCHANT_NAME).toBe("Bean Bar 2");
    expect(eff.SUCCESS_URL_HOSTS).toBe("shop.example.com");
  });
  it("posting only the success URL hosts leaves the shop name unchanged", async () => {
    await post("/admin/settings/shop", { csrf: S.csrf, MERCHANT_NAME: "Bean Bar", SUCCESS_URL_HOSTS: "shop.example.com" });
    const r = await post("/admin/settings/shop", { csrf: S.csrf, SUCCESS_URL_HOSTS: "other.example.com" });
    expect(r.status).toBe(303);
    clearSettingsCache();
    const eff = await effectiveEnv(e);
    expect(eff.MERCHANT_NAME).toBe("Bean Bar");
    expect(eff.SUCCESS_URL_HOSTS).toBe("other.example.com");
  });
});

describe("settings restyle", () => {
  it("the wallets confirm form binds exactly the same fields as before (nine wallet fields and one box per coin, with btc and ltc ticked)", async () => {
    const html = await (await get("/admin/settings")).text();
    expect(confirmFields(html, "/admin/settings/wallets")).toEqual(
      [
        "BTC_XPUB", "BTC_XPUB_START_INDEX", "BTC_ESPLORA_URL", "LTC_XPUB", "LTC_XPUB_START_INDEX", "LTC_ESPLORA_URL",
        "DOGE_XPUB", "DOGE_XPUB_START_INDEX", "DOGE_BLOCKBOOK_URL", ...OFFERABLE.map((a) => assetField(a.id)),
      ].sort(),
    );
  });

  it("an invalid xpub marks that field aria-invalid and keeps the settings message", async () => {
    const r = await saveWallets({ BTC_XPUB: "xpub-nope", "asset:btc:btc": "on" });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("That is not a Bitcoan account extended public key".replace("Bitcoan", "Bitcoin"));
    expect(html).toMatch(/<input[^>]*name="BTC_XPUB"[^>]*aria-invalid="true"|<input[^>]*aria-invalid="true"[^>]*name="BTC_XPUB"/);
    expect(html).not.toMatch(/<input[^>]*name="LTC_XPUB"[^>]*aria-invalid/);
  });

  it("shows a section per concern: shop, public URL, coins, wallets, success URL hosts", async () => {
    const html = await (await get("/admin/settings")).text();
    for (const h of ["Your shop", "Public URL", "Coins", "Wallets", "Success URL hosts"]) expect(html).toContain(`>${h}</h2>`);
  });
});

describe("shop", () => {
  it("saving the shop name makes checkout show it", async () => {
    const r = await post("/admin/settings/shop", { csrf: S.csrf, MERCHANT_NAME: "Bean Bar", SUCCESS_URL_HOSTS: "shop.example.com" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/settings?saved=shop");
    const id = `inv_shop${Date.now()}`;
    await insertInvoice(e.DB, {
      id, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 500n, currency: "USD", order_id: null,
      metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
    });
    expect(await (await exports.default.fetch(`${BASE}/i/${id}`)).text()).toContain("Bean Bar");
    const eff = await effectiveEnv(e);
    expect(eff.SUCCESS_URL_HOSTS).toBe("shop.example.com");
    const page = await (await get("/admin/settings?saved=shop")).text();
    expect(page).toContain('value="Bean Bar"');
  });

  it("needs CSRF but no passkey; an invalid value is refused with 400", async () => {
    expect((await post("/admin/settings/shop", { MERCHANT_NAME: "X" })).status).toBe(403);
    const bad = await post("/admin/settings/shop", { csrf: S.csrf, MERCHANT_NAME: "ok", SUCCESS_URL_HOSTS: "not a host!" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Success URL hosts must be hostnames");
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("");
  });
});

describe("wallets and coins", () => {
  it("saving the BIP84 zpub with btc:btc ticked shows the first receive address and stores it", async () => {
    const r = await saveWallets({ BTC_XPUB: ZPUB, BTC_XPUB_START_INDEX: "", "asset:btc:btc": "on" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`First receive address: ${FIRST}. Check this matches the first address in your wallet.`);
    const eff = await effectiveEnv(e);
    expect(eff.BTC_XPUB).toBe(ZPUB);
    expect(eff.ENABLED_ASSETS).toBe("btc:btc");
  });

  it("joins the ticked coins in ASSETS order", async () => {
    const r = await saveWallets({ "asset:ltc:ltc": "on", "asset:btc:btc": "on" });
    expect(r.status).toBe(200);
    expect((await effectiveEnv(e)).ENABLED_ASSETS).toBe("btc:btc,ltc:ltc");
  });

  it("without an assertion: 403 and nothing is saved", async () => {
    const r = await post("/admin/settings/wallets", { csrf: S.csrf, BTC_XPUB: ZPUB, "asset:btc:btc": "on" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect((await effectiveEnv(e)).BTC_XPUB ?? "").toBe("");
  });

  it("the enabled set is bound: an assertion for btc only does not save btc and ltc", async () => {
    const r = await saveWallets({ "asset:btc:btc": "on", "asset:ltc:ltc": "on" }, { "asset:btc:btc": "on" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(BAD_ASSERTION);
    expect((await effectiveEnv(e)).ENABLED_ASSETS).toBe("btc:btc,ltc:ltc"); // still the var
    expect((await e.DB.prepare("SELECT count(*) AS n FROM settings").first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps an enabled coin whose box is locked (not posted): the save neither drops it nor binds it", async () => {
    // base:usdc enabled earlier (say by a var or an older setup), now locked because EVM_RPC_BASE is unset.
    await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('ENABLED_ASSETS','btc:btc,base:usdc',?)").bind(Date.now()).run();
    clearSettingsCache();
    const page = await (await get("/admin/settings")).text();
    expect(page).toMatch(/name="asset:base:usdc"[^>]*checked[^>]*disabled|name="asset:base:usdc"[^>]*disabled[^>]*checked/);
    expect(page).toContain("Kept on; configure under Advanced.");
    // The browser posts (and the confirmation binds) only the ticked boxes: ltc here, btc unticked.
    const r = await saveWallets({ "asset:ltc:ltc": "on" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await effectiveEnv(e)).ENABLED_ASSETS).toBe("ltc:ltc,base:usdc"); // ASSETS order
  });

  it("ticking base:usdc without an RPC gives 400 'needs more setup'", async () => {
    const r = await saveWallets({ "asset:btc:btc": "on", "asset:base:usdc": "on" });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("base:usdc needs more setup:");
    expect(html).toContain("EVM_RPC_BASE");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM settings").first<{ n: number }>())!.n).toBe(0);
  });

  it("checks a ticked chain with the new values: dogecoin needs the Blockbook URL entered on the same form", async () => {
    const without = await saveWallets({ "asset:doge:doge": "on" });
    expect(without.status).toBe(400);
    expect(await without.text()).toContain("doge:doge needs more setup: DOGE_BLOCKBOOK_URL is required");
    const withUrl = await saveWallets({ DOGE_BLOCKBOOK_URL: "https://doge.example.test", "asset:doge:doge": "on" });
    expect(withUrl.status).toBe(200);
    expect((await effectiveEnv(e)).ENABLED_ASSETS).toBe("doge:doge");
  });

  it("an invalid xpub is refused with the settings message", async () => {
    const r = await saveWallets({ BTC_XPUB: "xpub-nope", "asset:btc:btc": "on" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("That is not a Bitcoin account extended public key");
  });

  it("a chain that handed out addresses keeps its wallet (the field is read-only and a change is refused)", async () => {
    expect((await saveWallets({ BTC_XPUB: ZPUB, "asset:btc:btc": "on" })).status).toBe(200);
    await insertInvoice(e.DB, {
      id: "inv_used", created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 500n, currency: "USD", order_id: null,
      metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
    });
    await insertPayment(e.DB, {
      id: "pay_used", invoice_id: "inv_used", asset: "btc:btc", chain: "btc", address: FIRST, derivation_index: 0, reference: null,
      expected: 1000n, price_e8: 10n ** 13n, rate_locked_until: Date.now() + 600_000, received: 0n, final: 0n, txids: [],
      status: "awaiting", created_at: Date.now(), detected_at: null, confirmed_at: null, unexpected: null, credited_minor: 0n, credit_price_e8: null,
    });
    const html = await (await get("/admin/settings")).text();
    expect(html).toMatch(/name="BTC_XPUB"[^>]*readonly/);
    expect(html).toContain("This wallet has handed out addresses, so it cannot be changed. To use another wallet, set up a new deployment");
    const r = await saveWallets({ BTC_XPUB: "", "asset:btc:btc": "on" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("already handed out addresses");
    expect((await effectiveEnv(e)).BTC_XPUB).toBe(ZPUB);
  });
});
