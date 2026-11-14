import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signedIn, type AdminTestSession } from "../../admin-session";
import { checkLightning, lightningRefused } from "../../../src/chains/lightning/adapter";
import { usableAssets } from "../../../src/config";
import { createLink } from "../../../src/links/store";
import { getPayment, insertInvoice, listPayments, type InvoiceRow } from "../../../src/db/repo";
import type { Env } from "../../../src/env";
import { qrSvg } from "../../../src/web/qr";
import { offline } from "../../offline";
import { putPrice } from "../../prices/seed";
import { defaultWallet, nwcUri, relayFactory, WALLET_PK, WalletState, type RelayOptions } from "./fake-relay";
import { CLIENT_PK } from "./fake-relay";

const e = env as unknown as Env;
/** The signed-in admin session (set in beforeAll). */
let S: AdminTestSession;
const BASE = "https://pay.test";
const saved = { NWC_URI: e.NWC_URI, ENABLED_ASSETS: e.ENABLED_ASSETS, NWC_TEST_SOCKET_FACTORY: e.NWC_TEST_SOCKET_FACTORY };
const armed = new Set<string>();
let ipSeq = 0;
const freshIp = () => `10.7.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
let wallet: WalletState;
const useRelay = (o: RelayOptions = {}) => {
  e.NWC_TEST_SOCKET_FACTORY = relayFactory({ handler: defaultWallet(wallet), infoEncryption: "nip44_v2", ...o }).factory;
};

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline());
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  Object.assign(e, { NWC_URI: nwcUri(), ENABLED_ASSETS: "btc:btc,ln:btc" });
});
afterAll(async () => {
  for (const id of armed) await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  Object.assign(e, saved);
  network.disable();
});
beforeEach(async () => {
  wallet = new WalletState();
  useRelay();
  for (const k of [`nwc:enc:${WALLET_PK}`, `nwc:caps:${WALLET_PK}:${CLIENT_PK}`]) await e.KV.delete(k);
  await putPrice(e, "USD", "BTC", 100_000n * 10n ** 8n);
});

let seq = 0;
async function mkInvoice(o: Partial<InvoiceRow> = {}): Promise<string> {
  const id = `inv_lnweb${Date.now()}${seq++}`;
  armed.add(id);
  await insertInvoice(e.DB, {
    id, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null, metadata: null,
    success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...o,
  });
  return id;
}
const get = (path: string) => exports.default.fetch(BASE + path);
const choose = (id: string, asset = "ln:btc") =>
  exports.default.fetch(`${BASE}/i/${id}/pay`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
    body: new URLSearchParams({ asset }),
  });
async function startPayment(id: string): Promise<string> {
  const r = await choose(id);
  expect(r.status).toBe(303);
  return r.headers.get("location")!.split("/p/")[1]!;
}
const makes = () => wallet.requests.filter((r) => r.method === "make_invoice");

describe("Lightning checkout", () => {
  it("offers Lightning on the choice page", async () => {
    const html = await (await get(`/i/${await mkInvoice()}`)).text();
    expect(html).toContain('value="ln:btc"');
    expect(html).toContain("Lightning");
  });

  it("picking Lightning calls make_invoice: bolt11 in address, hash in reference, whole sats, the payment id as description", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!;
    const made = [...wallet.invoices.values()][0]!;
    expect(p).toMatchObject({ chain: "ln", asset: "ln:btc", address: made.invoice, reference: made.payment_hash, derivation_index: -1, expected: 50_000_000n });
    expect(makes()).toEqual([{ method: "make_invoice", params: { amount: 50_000_000, description: pid, expiry: expect.any(Number) } }]);
    // The bolt11 (and so the payer's wallet history) never carries the invoice id: only the payment id.
    const description = makes()[0]!.params.description as string;
    expect(description).toMatch(/^pay_[a-z2-7]+$/);
    expect(description).not.toContain("inv_");
    expect(description).not.toContain(id);
    // The lock is the earlier of the bolt11 expiry and the 20-minute rate lock.
    expect(p.rate_locked_until).toBeLessThanOrEqual(made.expires_at * 1000);
    expect(p.rate_locked_until).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
    expect(p.rate_locked_until).toBeGreaterThan(Date.now() + 19 * 60_000);
  });

  it("rounds the amount up to a whole sat", async () => {
    const id = await mkInvoice({ price_minor: 1n }); // $0.01 at $99,999 is 10,000.1 msat: rounded up to 11 sat
    await putPrice(e, "USD", "BTC", 99_999n * 10n ** 8n);
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!;
    expect(p.expected % 1000n).toBe(0n);
    expect(makes()[0]!.params.amount).toBe(Number(p.expected));
  });

  it("caps the bolt11 expiry at the invoice's remaining time", async () => {
    const id = await mkInvoice({ expires_at: Date.now() + 5 * 60_000 });
    const pid = await startPayment(id);
    expect(makes()[0]!.params.expiry).toBeLessThanOrEqual(300);
    expect((await getPayment(e.DB, pid))!.rate_locked_until).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("renders an uppercase lightning: QR, the Lightning label and confirmation time", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!;
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain(qrSvg(`lightning:${p.address}`.toUpperCase()));
    expect(html).toContain("Lightning");
    expect(html).toContain("Usually seconds");
    expect(html).toContain("Only pay this invoice from a Lightning wallet");
    expect(html).toContain(`data-copy="${p.address}"`);
    // The expiry notice (with its form) is rendered hidden; checkout.js reveals it when the countdown ends.
    expect(html).toMatch(/data-lock-notice[^>]*hidden[^>]*>\s*<span>This Lightning invoice has expired/);
  });

  it("in JS mode the QR and copy button are hidden when the countdown ends (they carry data-hide-on-lock)", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toMatch(/<div class="qr-box" data-hide-on-lock="">/);
    expect(html).toMatch(/<div class="pair" data-hide-on-lock="">\s*<button[^>]*data-copy=/);
    const js = await (await get("/checkout.js")).text();
    expect(js).toContain('querySelectorAll("[data-hide-on-lock]")');
    // `.pair` is display:grid, which would beat the hidden attribute without this rule.
    expect(await (await get("/checkout.css")).text()).toContain("[data-hide-on-lock][hidden]{display:none}");
    // Other chains keep their QR after the lock ends (the address still receives).
    const btc = await (await choose(await mkInvoice(), "btc:btc")).headers.get("location")!;
    expect(await (await get(btc)).text()).not.toContain("data-hide-on-lock");
  });

  it("reuses an unexpired, unpaid Lightning payment", async () => {
    const id = await mkInvoice();
    const a = await startPayment(id);
    const b = await startPayment(id);
    expect(b).toBe(a);
    expect(makes()).toHaveLength(1);
  });

  it("an expired bolt11: no QR, a no-JS 'New invoice' form, and posting it makes a fresh payment", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE payments SET rate_locked_until=? WHERE id=?").bind(Date.now() - 1000, pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toMatch(/data-lock-notice(?![^>]*hidden)[^>]*>\s*<span>This Lightning invoice has expired/);
    expect(html).toMatch(new RegExp(`<form method="post" action="/i/${id}/pay"><input type="hidden" name="asset" value="ln:btc"/><button type="submit"[^>]*>New invoice</button>`));
    expect(html).not.toContain('class="qr"');
    const fresh = await startPayment(id);
    expect(fresh).not.toBe(pid);
    expect(makes()).toHaveLength(2);
    expect((await listPayments(e.DB, id)).map((p) => p.id).sort()).toEqual([pid, fresh].sort());
  });

  it("make_invoice failing shows a friendly retry page, not a 500", async () => {
    const id = await mkInvoice();
    useRelay({ fail: "refuse" });
    const r = await choose(id);
    expect(r.status).toBe(503);
    const html = await r.text();
    expect(html).toContain("Lightning is unavailable");
    expect(html).toContain(`href="/i/${id}"`);
    expect(await listPayments(e.DB, id)).toEqual([]);
  });

  it("the JSON API answers 503 lightning_unavailable", async () => {
    const id = await mkInvoice();
    useRelay({ fail: "refuse" });
    const r = await exports.default.fetch(`${BASE}/api/v1/invoices/${id}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ asset: "ln:btc" }),
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "lightning_unavailable" });
  });

  it("a wallet refused at config time is not offered", async () => {
    wallet.methods = ["get_info"];
    const id = await mkInvoice();
    const r = await choose(id);
    expect(r.status).toBe(503);
    expect((await usableAssets(e)).map((a) => a.id)).not.toContain("ln:btc");
    expect(await (await get(`/i/${id}`)).text()).not.toContain('value="ln:btc"');
  });

  it("a payment link drops a refused Lightning wallet (usableAssets), and is unavailable when Lightning was its only asset", async () => {
    wallet.methods = ["get_info"];
    await checkLightning(e);
    expect(await lightningRefused(e)).toBe(true);
    const submit = async (id: string) => {
      const ip = freshIp();
      const page = await exports.default.fetch(`${BASE}/l/${id}`, { headers: { "cf-connecting-ip": ip } });
      const token = /name="token" value="([^"]+)"/.exec(await page.text())![1]!;
      return exports.default.fetch(`${BASE}/l/${id}`, {
        method: "POST",
        redirect: "manual",
        headers: { "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    };
    const mixed = await createLink(e.DB, { title: "Mixed", price_minor: 500n, currency: "USD", allowed_assets: ["btc:btc", "ln:btc"] });
    const lnOnly = await createLink(e.DB, { title: "LN only", price_minor: 500n, currency: "USD", allowed_assets: ["ln:btc"] });
    const r = await submit(mixed.id);
    expect(r.status).toBe(303);
    const invoiceId = /\/i\/(inv_[a-z2-7]+)$/.exec(r.headers.get("location") ?? "")![1]!;
    const row = await e.DB.prepare("SELECT allowed_assets FROM invoices WHERE id=?").bind(invoiceId).first<{ allowed_assets: string }>();
    expect(JSON.parse(row!.allowed_assets)).toEqual(["btc:btc"]);
    expect((await submit(lnOnly.id)).status).toBe(503);
  });
});

describe("POS with Lightning", () => {
  beforeEach(async () => {
    wallet = new WalletState();
    for (const k of [`nwc:enc:${WALLET_PK}`, `nwc:caps:${WALLET_PK}:${CLIENT_PK}`]) await e.KV.delete(k);
  });
  const posCharge = async (asset: string) => {
    const cookie = S.cookie;
    const ip = freshIp();
    const html = await (await exports.default.fetch(`${BASE}/pos`, { headers: { cookie, "cf-connecting-ip": ip } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    return exports.default.fetch(`${BASE}/pos/charge`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, amount: "12.50", currency: "USD", asset }),
    });
  };
  it("a relay outage while charging in ln:btc sends the customer to the invoice's choice page, never a 500", async () => {
    useRelay({ fail: "refuse" });
    const before = (await e.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE json_extract(metadata,'$.pos')=1").first<{ n: number }>())!.n;
    const r = await posCharge("ln:btc");
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/i\/inv_[a-z2-7]+$/);
    armed.add(loc.slice(3));
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE json_extract(metadata,'$.pos')=1").first<{ n: number }>())!.n).toBe(before + 1);
    expect(await listPayments(e.DB, loc.slice(3))).toEqual([]);
  });
  it("a working wallet goes straight to the Lightning payment page", async () => {
    useRelay();
    const r = await posCharge("ln:btc");
    expect(r.status).toBe(303);
    const m = /^\/i\/(inv_[a-z2-7]+)\/p\/pay_[a-z2-7]+$/.exec(r.headers.get("location") ?? "");
    expect(m).not.toBeNull();
    armed.add(m![1]!);
  });
});
