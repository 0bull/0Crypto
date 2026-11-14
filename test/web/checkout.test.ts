import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPayment, insertInvoice, insertPayment, listPayments, type InvoiceRow, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { offline } from "../offline";
import { putPrice, dropPrice } from "../prices/seed";
import { getAdapter } from "../../src/chains/registry";
import { getAsset } from "../../src/core/assets";
import { toTarget } from "../../src/watcher/PaymentWatcher";
import { qrSvg } from "../../src/web/qr";
import { emptyState, evmRpc } from "../evm-rpc";

const e = env as unknown as Env;
const BASE = "https://pay.test";
const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const armed = new Set<string>();
let ipSeq = 0;
const freshIp = () => `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline()); // payments started here arm real watchers; their polls see an empty chain
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
afterAll(async () => {
  for (const id of armed)
    await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  network.disable();
});
const setPrice = (symbol: string, e8: bigint) => putPrice(e, "USD", symbol, e8);
beforeEach(async () => {
  await setPrice("BTC", 100_000n * 10n ** 8n);
  await setPrice("LTC", 100n * 10n ** 8n);
});

let seq = 0;
async function mkInvoice(o: Partial<InvoiceRow> = {}): Promise<string> {
  const id = `inv_web${Date.now()}${seq++}`;
  armed.add(id);
  await insertInvoice(e.DB, {
    id, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...o,
  });
  return id;
}
const get = (path: string, headers: Record<string, string> = {}) => exports.default.fetch(BASE + path, { headers });
const choose = (id: string, asset: string) =>
  exports.default.fetch(`${BASE}/i/${id}/pay`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
    body: new URLSearchParams({ asset }),
  });
async function startPayment(id: string, asset = "btc:btc"): Promise<string> {
  const r = await choose(id, asset);
  expect(r.status).toBe(303);
  return r.headers.get("location")!.split("/p/")[1]!;
}

describe("asset choice page", () => {
  it("lists a post form per enabled asset and sets security headers", async () => {
    const id = await mkInvoice({ order_id: "A-1042" });
    const r = await get(`/i/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await r.text();
    expect(html).toContain("$50.00");
    expect(html).toContain("Order #A-1042");
    expect(html).toContain(`action="/i/${id}/pay"`);
    expect(html).toContain('value="btc:btc"');
    expect(html).toContain('value="ltc:ltc"');
    expect(html).not.toContain('value="doge:doge"');
    expect(html).toContain("Store");
  });
  it("honours allowed_assets", async () => {
    const html = await (await get(`/i/${await mkInvoice({ allowed_assets: ["ltc:ltc"] })}`)).text();
    expect(html).toContain('value="ltc:ltc"');
    expect(html).not.toContain('value="btc:btc"');
  });
  it("expired invoice says so and offers no asset buttons", async () => {
    const html = await (await get(`/i/${await mkInvoice({ expires_at: Date.now() - 1000 })}`)).text();
    expect(html).toContain("expired");
    expect(html).not.toContain('name="asset"');
  });
  it("404 for an unknown invoice", async () => {
    expect((await get("/i/inv_nope")).status).toBe(404);
  });
});

describe("POST /i/:id/pay", () => {
  it("creates a payment and 303s to its page", async () => {
    const id = await mkInvoice();
    const r = await choose(id, "btc:btc");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(new RegExp(`^/i/${id}/p/pay_[a-z2-7]+$`));
    expect((await listPayments(e.DB, id)).length).toBe(1);
  });
  it("reuses the locked payment on a second choice", async () => {
    const id = await mkInvoice();
    const a = await choose(id, "btc:btc");
    const b = await choose(id, "btc:btc");
    expect(b.headers.get("location")).toBe(a.headers.get("location"));
  });
  it("maps closed invoices to a friendly page", async () => {
    const expired = await choose(await mkInvoice({ expires_at: Date.now() - 1 }), "btc:btc");
    expect(expired.status).toBe(409);
    expect(await expired.text()).toContain("This invoice has expired");
    expect(expired.headers.get("content-security-policy")).toBe(CSP);
    const paid = await choose(await mkInvoice({ status: "paid", paid_minor: 5000n }), "btc:btc");
    expect(await paid.text()).toContain("already paid");
  });
  it("says to retry when no price is available", async () => {
    await dropPrice(e, "USD", "LTC");
    const r = await choose(await mkInvoice(), "ltc:ltc");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Try again in a minute");
  });
  it("links to the in-flight payment when one covers the invoice", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!;
    await e.DB.prepare("UPDATE payments SET status='confirming', received=?, expected=? WHERE id=?")
      .bind(p.expected.toString(), p.expected.toString(), pid)
      .run();
    const r = await choose(id, "ltc:ltc");
    expect(r.status).toBe(409);
    expect(await r.text()).toContain(`/i/${id}/p/${pid}`);
  });
  it("rejects unknown assets", async () => {
    const r = await choose(await mkInvoice(), "doge:doge");
    expect(r.status).toBe(400);
  });
});

describe("payment page", () => {
  it("shows address, exact amount, QR, copy buttons and no external URLs", async () => {
    const id = await mkInvoice({ order_id: "o1" });
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!;
    const r = await get(`/i/${id}/p/${pid}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    const html = await r.text();
    expect(html).toContain(p.address.slice(0, -4));
    expect(html).toContain(`<b>${p.address.slice(-4)}</b>`);
    expect(html).toContain("0.0005");
    expect(html).toContain("<svg");
    expect(html).toContain("Send exactly");
    expect(html).toContain("About 20 minutes");
    expect(html).toContain("Waiting for payment");
    expect(html).toContain("Only send BTC on the Bitcoin network");
    expect(html).toContain(`href="/i/${id}"`); // change link while open
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="20"/></noscript>');
    expect(html).toMatch(/data-copy=/);
    expect(html).not.toMatch(/<script[^>]*src="http/);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(html).not.toMatch(/<script>|<script [^>]*>[^<]/); // no inline scripts
    expect(html).not.toMatch(/ style=/); // CSP: no inline styles
  });
  it("renders in-flight payments after the invoice has expired, without a change link", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE invoices SET expires_at=? WHERE id=?").bind(Date.now() - 1000, id).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("This invoice has expired");
    expect(html).toContain("Don&#39;t send funds to this address");
    expect(html).not.toContain("Send exactly");
    expect(html).not.toContain("Copy amount");
    expect(html).not.toContain(`>change<`);
  });
  it("shows the lock-ended notice once the rate lock has passed", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE payments SET rate_locked_until=? WHERE id=?").bind(Date.now() - 1000, pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("The price lock has ended.");
    expect(html).toContain(`<a href="/i/${id}">Pick the coin again for a fresh quote</a>`);
    expect(html).not.toMatch(/data-lock-notice[^>]*hidden/);
    // still locked: present but hidden for checkout.js to reveal
    const id2 = await mkInvoice();
    const html2 = await (await get(`/i/${id2}/p/${await startPayment(id2)}`)).text();
    expect(html2).toMatch(/data-lock-notice[^>]*hidden/);
  });
  it("asks only for the outstanding amount after a partial payment is detected", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const p = (await getPayment(e.DB, pid))!; // expected 50000 sats
    await e.DB.prepare("UPDATE payments SET status='detected', received=? WHERE id=?").bind("20000", pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(p.expected).toBe(50000n);
    expect(html).toContain("Received");
    expect(html).toContain("0.0002 BTC");
    expect(html).toContain("Send the remaining");
    expect(html).toContain("0.0003 BTC");
    expect(html).not.toContain("Send exactly");
    expect(html).toContain('data-copy="0.0003"');
    const uri = getAdapter(e, "btc").paymentUri(toTarget(p), getAsset("btc:btc"), 30000n);
    expect(html).toContain(qrSvg(uri)); // QR encodes the outstanding amount, not the full one
  });
  it("shows only a waiting notice when the full amount is received and confirming", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE payments SET status='confirming', received=expected WHERE id=?").bind(pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("Payment received, waiting for confirmations");
    expect(html).not.toContain("Send exactly");
    expect(html).not.toContain("Send the remaining");
    expect(html).not.toContain("Copy amount");
    expect(html).not.toContain("<svg class=\"qr\"");
  });
  it("asks for no dust top-up while a within-tolerance amount is confirming", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    // 49800 of 50000 sats (99.6%) is within the 0.5% tolerance: the watcher marks it confirming.
    await e.DB.prepare("UPDATE payments SET status='confirming', received='49800' WHERE id=?").bind(pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("Payment received, waiting for confirmations");
    for (const t of ["Send the remaining", "Send exactly", "Copy amount", 'class="qr-box"']) expect(html).not.toContain(t);
  });
  it("renders the shown status and received amount as data attributes for live reloads", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const fresh = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(fresh).toMatch(/data-ws="[^"]+"[^>]*data-status="awaiting"[^>]*data-received="0"/);
    await e.DB.prepare("UPDATE payments SET status='detected', received='20000' WHERE id=?").bind(pid).run();
    const seen = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(seen).toContain('data-status="detected"');
    expect(seen).toContain('data-received="0.0002"');
  });
  it("never asks for more funds on a confirmed payment, and links to pay the rest", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE payments SET status='confirmed', received=expected, final=expected WHERE id=?").bind(pid).run();
    await e.DB.prepare("UPDATE invoices SET paid_minor='3000', status='partially_paid' WHERE id=?").bind(id).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("Payment confirmed");
    expect(html).toContain("$20.00 still due on this invoice");
    expect(html).toContain(`<a href="/i/${id}">Pay the rest</a>`);
    for (const t of ["Send exactly", "Send the remaining", "Copy amount", 'class="qr"']) expect(html).not.toContain(t);
  });
  it("shows progress, not expiry, for a detected payment on an expired invoice", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE payments SET status='detected', received='20000' WHERE id=?").bind(pid).run();
    await e.DB.prepare("UPDATE invoices SET expires_at=? WHERE id=?").bind(Date.now() - 1000, id).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("Received");
    expect(html).toContain("0.0002 BTC");
    expect(html).not.toContain("This invoice has expired");
    expect(html).not.toContain("Don&#39;t send funds");
  });
  it("lets a long order id wrap and escapes hostile order ids and merchant names", async () => {
    const long = "A".repeat(128);
    const id = await mkInvoice({ order_id: long });
    const html = await (await get(`/i/${id}`)).text();
    expect(html).toContain(`<span class="muted small order" title="Order #${long}">`);
    const evil = await mkInvoice({ order_id: '"><script>alert(1)</script>' });
    const saved = e.MERCHANT_NAME;
    e.MERCHANT_NAME = "<img src=x onerror=alert(1)>";
    try {
      const h = await (await get(`/i/${evil}`)).text();
      expect(h).not.toContain("<script>alert");
      expect(h).not.toContain("<img");
      expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(h).not.toContain('title="Order #"><script');
    } finally {
      e.MERCHANT_NAME = saved;
    }
  });
  it("shows the paid state with a return link and a 3s refresh to the success url", async () => {
    const id = await mkInvoice({ success_url: "https://m.example/ok?o=1&x=2" });
    const pid = await startPayment(id);
    await e.DB.prepare("UPDATE invoices SET status='paid', paid_minor='5000' WHERE id=?").bind(id).run();
    await e.DB.prepare("UPDATE payments SET status='confirmed' WHERE id=?").bind(pid).run();
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("Return to store");
    expect(html).toContain('http-equiv="refresh" content="3;url=https://m.example/ok?o=1&amp;x=2"');
    expect(html).not.toContain('content="20"');
  });
  it("404s for another invoice's payment or unknown ids", async () => {
    const a = await mkInvoice();
    const b = await mkInvoice();
    const pid = await startPayment(a);
    expect((await get(`/i/${b}/p/${pid}`)).status).toBe(404);
    expect((await get(`/i/${a}/p/pay_missing`)).status).toBe(404);
  });
});

describe("websocket route", () => {
  it("426 without an Upgrade header", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    expect((await get(`/i/${id}/p/${pid}/ws`)).status).toBe(426);
  });
  it("upgrades through to the watcher and streams the status", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id);
    const r = await get(`/i/${id}/p/${pid}/ws`, { Upgrade: "websocket" });
    expect(r.status).toBe(101);
    const ws = r.webSocket!;
    ws.accept();
    const msg = await new Promise<string>((res) => ws.addEventListener("message", (ev) => res(ev.data as string)));
    expect(JSON.parse(msg)).toMatchObject({ type: "status", payment_id: pid, status: "awaiting", invoice_status: "open" });
    ws.close();
  });
  it("404 when the payment belongs to a different invoice", async () => {
    const a = await mkInvoice();
    const b = await mkInvoice();
    const pid = await startPayment(a);
    expect((await get(`/i/${b}/p/${pid}/ws`, { Upgrade: "websocket" })).status).toBe(404);
  });
});

describe("static assets and qr", () => {
  it("falls through to ASSETS for public files", async () => {
    const css = await get("/theme.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
    expect(await css.text()).toContain(".card");
    expect((await get("/fonts/inter-latin-400-normal.woff2")).status).toBe(200);
    expect((await get("/checkout.js")).status).toBe(200);
    expect((await get("/nope-not-here")).status).toBe(404);
  });
  it("theme.css has no external urls", async () => {
    expect(await (await get("/theme.css")).text()).not.toMatch(/https?:\/\//);
  });
  it("qrSvg returns inline svg markup", () => {
    const s = qrSvg("bitcoin:bc1qexample?amount=0.0005");
    expect(s.startsWith("<svg")).toBe(true);
    expect(s).not.toContain("style=");
  });
});

describe("EVM payment page", () => {
  const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE, EVM_RPC_POLYGON: e.EVM_RPC_POLYGON };
  beforeAll(async () => {
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,base:usdc,polygon:usdc", EVM_RPC_BASE: "https://rpc.test/base", EVM_RPC_POLYGON: "https://rpc.test/polygon" });
    network.use(evmRpc("https://rpc.test/base", emptyState), evmRpc("https://rpc.test/polygon", emptyState)); // watchers see empty addresses
    await setPrice("USDC", 10n ** 8n);
  });
  afterAll(async () => {
    // Disarm watchers first: a late alarm must not poll with the restored (EVM-less) env.
    for (const id of armed)
      await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
    Object.assign(e, saved);
  });

  it("lists the token with its chain name on the choice page", async () => {
    const html = await (await get(`/i/${await mkInvoice()}`)).text();
    expect(html).toContain('value="base:usdc"');
    expect(html).toMatch(/USDC<\/span>\s*<span class="muted small">Base</);
  });

  it("base:usdc shows token and chain tiles, the EVM warning, L2 confirmation time and a QR; URI is EIP-681", async () => {
    const id = await mkInvoice();
    const pid = await startPayment(id, "base:usdc");
    const p = (await getPayment(e.DB, pid))!;
    expect(p).toMatchObject({ chain: "base", expected: 50_000_000n, unexpected: null });
    const res = await get(`/i/${id}/p/${pid}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<span>USDC</span>");
    expect(html).toContain("<span>Base</span>");
    expect(html).toContain("Only send USDC on Base. Other networks can&#39;t be credited automatically."); // html-escaped apostrophe
    expect(html).toContain("About 20 minutes");
    expect(html).toContain("50 USDC");
    expect(html).toContain(p.address.slice(0, -4));
    expect(html).not.toContain("network. Other coins"); // the UTXO wording is not used for EVM
    const uri = getAdapter(e, "base").paymentUri(toTarget(p), getAsset("base:usdc"), p.expected);
    expect(uri).toBe(`ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=${p.address}&uint256=50000000`);
    expect(html).toContain('class="qr"'); // QR rendered inline
  });

  it("polygon confirms in about a minute", async () => {
    const id = await mkInvoice();
    const html = await (await get(`/i/${id}/p/${await startPayment(id, "polygon:usdc")}`)).text();
    expect(html).toContain("<span>Polygon</span>");
    expect(html).toContain("About 1 minute");
    expect(html).toContain("Only send USDC on Polygon.");
  });
});

describe("Tron payment page", () => {
  const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, TRONGRID_API_KEY: e.TRONGRID_API_KEY };
  beforeAll(async () => {
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,tron:usdt", TRONGRID_API_KEY: "test-key" });
    network.use(
      // watchers see an empty, never-activated address
      http.get("https://api.trongrid.io/v1/accounts/:addr/transactions/trc20", () => HttpResponse.json({ data: [], success: true, meta: {} })),
      http.get("https://api.trongrid.io/v1/accounts/:addr", () => HttpResponse.json({ data: [], success: true })),
    );
    await setPrice("USDT", 10n ** 8n);
  });
  afterAll(async () => {
    for (const id of armed)
      await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
    Object.assign(e, saved);
  });

  it("tron:usdt shows Tron, the TRC-20 warning, About 1 minute, a QR and the tron: URI", async () => {
    const id = await mkInvoice();
    const html0 = await (await get(`/i/${id}`)).text();
    expect(html0).toContain('value="tron:usdt"');
    const pid = await startPayment(id, "tron:usdt");
    const p = (await getPayment(e.DB, pid))!;
    expect(p).toMatchObject({ chain: "tron", expected: 50_000_000n });
    expect(p.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("<span>Tron</span>");
    expect(html).toContain("Only send USDT on Tron (TRC-20). Other networks can&#39;t be credited automatically.");
    expect(html).toContain("About 1 minute");
    expect(html).toContain("50 USDT");
    expect(html).toContain('class="qr"');
    const uri = getAdapter(e, "tron").paymentUri(toTarget(p), getAsset("tron:usdt"), p.expected);
    expect(uri).toBe(`tron:${p.address}?token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&amount=50`);
  });
});

describe("Solana payment page", () => {
  const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, SOLANA_RPC_URL: e.SOLANA_RPC_URL };
  beforeAll(async () => {
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,sol:sol,sol:usdc", SOLANA_RPC_URL: "https://sol.test/rpc" });
    network.use(
      http.post("https://sol.test/rpc", async ({ request }) => {
        const b = (await request.json()) as { id: number; method: string };
        const result = b.method === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : b.method === "getBalance" ? { context: { slot: 1 }, value: 0 } : { context: { slot: 1 }, value: [] };
        return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result });
      }),
    );
    await setPrice("SOL", 100n * 10n ** 8n);
    await setPrice("USDC", 10n ** 8n);
  });
  afterAll(() => void Object.assign(e, saved));

  it.each([
    ["sol:sol", "SOL", "0.5 SOL"],
    ["sol:usdc", "USDC", "50 USDC"],
  ])("%s shows Solana, About 1 minute, the warning, a QR and the solana: URI", async (asset, symbol, amount) => {
    const id = await mkInvoice();
    expect(await (await get(`/i/${id}`)).text()).toContain(`value="${asset}"`);
    const pid = await startPayment(id, asset);
    const p = (await getPayment(e.DB, pid))!;
    expect(p.chain).toBe("sol");
    const html = await (await get(`/i/${id}/p/${pid}`)).text();
    expect(html).toContain("<span>Solana</span>");
    expect(html).toContain("About 1 minute");
    expect(html).toContain(`Only send ${symbol} on Solana. Other networks can&#39;t be credited automatically.`);
    expect(html).toContain(amount);
    expect(html).toContain('class="qr"');
    expect(html).toContain(p.address);
    const uri = getAdapter(e, "sol").paymentUri(toTarget(p), getAsset(asset), p.expected);
    expect(uri).toContain(`solana:${p.address}?amount=`);
    expect(uri).toContain(`reference=${p.reference}`);
  });
});
