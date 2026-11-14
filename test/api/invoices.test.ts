import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { base58 } from "@scure/base";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../../src/api/auth";
import { parseSuccessHosts, validSuccessUrl } from "../../src/api/success-url";
import { saveSettings } from "../../src/settings";
import { api, createOrReusePayment } from "../../src/api/invoices";
import { getAdapter } from "../../src/chains/registry";
import { getInvoice, insertInvoice, listPayments, type InvoiceRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { offline } from "../offline";
import { putPrice } from "../prices/seed";
import { sameMinuteWindow } from "../rate-window";

const e = env as unknown as Env;
const BASE = "https://pay.test/api/v1";
let key: string;
const armed = new Set<string>();

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline()); // payments started here arm real watchers; their polls see an empty chain
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
// Each test gets its own API key and every request its own IP, so the shared 60/min budget never couples tests.
let ipSeq = 0;
const freshIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
afterAll(async () => {
  for (const id of armed)
    await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  network.disable();
});
const setPrice = (symbol: string, e8: bigint, at = Date.now(), cur = "USD") =>
  putPrice(e, cur, symbol, e8, at);
beforeEach(async () => {
  key = await createApiKey(e.DB, "test");
  await setPrice("BTC", 100_000n * 10n ** 8n);
  await setPrice("LTC", 100n * 10n ** 8n);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const create = (body: Record<string, unknown> = {}) =>
  post("/invoices", { price_amount: "50.00", price_currency: "USD", ...body }, { Authorization: `Bearer ${key}` });
const pay = (id: string, asset: string, ip = freshIp()) => {
  armed.add(id);
  return post(`/invoices/${id}/payments`, { asset }, { "cf-connecting-ip": ip });
};

describe("auth", () => {
  it("rejects missing, malformed, unknown and revoked keys", async () => {
    const body = { price_amount: "1.00", price_currency: "USD" };
    for (const h of [{} as Record<string, string>, { Authorization: "Bearer nope" }, { Authorization: "Bearer 0c_live_" + "x".repeat(43) }]) {
      const r = await post("/invoices", body, h);
      expect(r.status).toBe(401);
      expect((await r.json()) as unknown).toMatchObject({ error: "unauthorized" });
    }
    const revoked = await createApiKey(e.DB, "r");
    await e.DB.prepare("UPDATE api_keys SET revoked_at=1 WHERE label='r'").run();
    expect((await post("/invoices", body, { Authorization: `Bearer ${revoked}` })).status).toBe(401);
  });
  it("refuses an old pg_live_ key as malformed", async () => {
    const r = await post("/invoices", { price_amount: "1.00", price_currency: "USD" }, { Authorization: "Bearer pg_live_" + "x".repeat(43) });
    expect(r.status).toBe(401);
    expect((await r.json()) as unknown).toEqual({ error: "unauthorized", message: "missing or malformed API key" });
  });
  it("throttles failed auth per IP", async () => {
    await sameMinuteWindow();
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await post("/invoices", {}, { Authorization: "Bearer 0c_live_" + "y".repeat(43), "cf-connecting-ip": ip })).status;
    expect(last).toBe(429);
  });
  it("never spends the per-IP auth budget on valid keys", async () => {
    const ip = freshIp();
    // Two keys, so the per-key 60/min limit is not what is being tested.
    const keys = [await createApiKey(e.DB, "ip-a"), await createApiKey(e.DB, "ip-b")];
    const statuses = new Set<number>();
    for (let i = 0; i < 70; i++) {
      const r = await exports.default.fetch(`${BASE}/invoices/inv_nope`, {
        headers: { Authorization: `Bearer ${keys[i % 2]}`, "cf-connecting-ip": ip },
      });
      statuses.add(r.status);
    }
    expect([...statuses]).toEqual([404]);
    // The IP's failure budget is untouched: the first bad key is a plain 401.
    expect((await post("/invoices", {}, { Authorization: "Bearer 0c_live_" + "z".repeat(43), "cf-connecting-ip": ip })).status).toBe(401);
  });
  it("stores only the hash", async () => {
    const rows = (await e.DB.prepare("SELECT hash FROM api_keys").all<{ hash: string }>()).results;
    expect(key.startsWith("0c_live_")).toBe(true);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
  });
});

describe("POST /invoices", () => {
  it("creates an open invoice and its created event", async () => {
    const r = await create({ order_id: "o1", metadata: { a: 1 }, success_url: "https://m.example/ok" });
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.status).toBe("open");
    expect(j.price_amount).toBe("50.00");
    expect(j.checkout_url).toMatch(/\/i\/inv_[a-z2-7]{26}$/);
    const ev = await e.DB.prepare("SELECT id,type FROM events WHERE invoice_id=?").bind(j.id).all();
    expect(ev.results).toEqual([{ id: `invoice.created:${j.id}:1`, type: "invoice.created" }]);
    const inv = (await getInvoice(e.DB, j.id as string))!;
    expect(inv.expires_at - inv.created_at).toBe(3_600_000);
  });
  it("refuses the gateway's own metadata keys (pos, link_id, subscription_id) with a clear 400", async () => {
    for (const k of ["pos", "link_id", "subscription_id"]) {
      const r = await create({ metadata: { [k]: k === "pos" ? true : "x", note: 1 } });
      expect(r.status, k).toBe(400);
      expect(await r.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining(`"${k}" is reserved`) });
    }
    expect((await create({ metadata: { pos_terminal: 1, linkid: "x", my_subscription_id: "s" } })).status).toBe(201);
  });
  it("validates input", async () => {
    const bad: Record<string, unknown>[] = [
      { price_amount: "50.001" },
      { price_amount: "0.00" },
      { price_amount: "1000000.01" },
      { price_amount: 50 },
      { price_currency: "GBP" },
      { allowed_assets: ["btc:xyz"] },
      { allowed_assets: ["doge:doge"] },
      { order_id: "x".repeat(129) },
      { metadata: [] },
      { metadata: { big: "x".repeat(5000) } },
      { success_url: "http://evil.example" },
      { success_url: "javascript:alert(1)" },
      { expires_in_sec: 299 },
      { expires_in_sec: 86401 },
      { expires_in_sec: 600.5 },
    ];
    for (const b of bad) {
      const r = await create(b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(await r.json()).toMatchObject({ error: "invalid_request" });
    }
    const r = await post("/invoices", "{not json", { Authorization: `Bearer ${key}` });
    expect(r.status).toBe(400);
    expect((await create({ success_url: "http://localhost:3000/ok", expires_in_sec: 300 })).status).toBe(201);
  });
});

describe("GET", () => {
  it("returns an invoice with auth, 404 when unknown, assets publicly", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    expect((await exports.default.fetch(`${BASE}/invoices/${id}`)).status).toBe(401);
    const r = await exports.default.fetch(`${BASE}/invoices/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id, payments: [] });
    const nf = await exports.default.fetch(`${BASE}/invoices/inv_nope`, { headers: { Authorization: `Bearer ${key}` } });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: "not_found" });
    const a = await exports.default.fetch(`${BASE}/assets`);
    expect(await a.json()).toEqual([
      { id: "btc:btc", symbol: "BTC", chain: "btc", decimals: 8 },
      { id: "ltc:ltc", symbol: "LTC", chain: "ltc", decimals: 8 },
    ]);
  });
});

describe("custody opt-in", () => {
  it("lists only assets that are usable: watch mode by xpub, routed mode only with ALLOW_SEED_CUSTODY", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = async (o: Partial<Env>) =>
      ((await (await api.request("/assets", {}, { ...e, ...o })).json()) as { id: string }[]).map((a) => a.id);
    expect(await list({ ALLOW_SEED_CUSTODY: undefined })).toEqual([]);
    expect(await list({ ALLOW_SEED_CUSTODY: undefined, LTC_XPUB: "xpub-ltc" })).toEqual(["ltc:ltc"]);
    expect(await list({ ENABLED_ASSETS: "btc:btc,doge:doge" })).toEqual(["btc:btc"]); // doge needs DOGE_BLOCKBOOK_URL
    warn.mockRestore();
  });
});

describe("POST /invoices/:id/payments", () => {
  it("creates a payment, then reuses it within the rate lock", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    const r = await pay(id, "btc:btc");
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, string>;
    expect(j.amount).toBe("0.0005");
    expect(j.address).toBe(await getAdapter(e, "btc").deriveAddress(0));
    expect(j.uri).toContain(j.address);
    expect(j.asset).toBe("btc:btc");
    expect(Date.parse(j.rate_locked_until)).toBeGreaterThan(Date.now() + 19 * 60_000);
    const again = await pay(id, "btc:btc");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(j);
    expect(await listPayments(e.DB, id)).toHaveLength(1);
    // The per-invoice watcher was started for the new payment (and its alarm armed).
    await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), async (_w, state) => {
      expect(state.storage.kv.get<string[]>("payments")).toContain(j.payment_id);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
  const setPayment = (id: string, fields: Record<string, string | number>) =>
    e.DB.prepare(`UPDATE payments SET ${Object.keys(fields).map((k) => `${k}=?`).join(",")} WHERE id=?`)
      .bind(...Object.values(fields), id)
      .run();
  const newInvoiceWithPayment = async (asset: string) => {
    const id = ((await (await create()).json()) as { id: string }).id;
    const j = (await (await pay(id, asset)).json()) as { payment_id: string };
    return { id, pid: j.payment_id };
  };
  it("returns a same-asset in-flight payment even after the rate lock lapsed", async () => {
    const { id, pid } = await newInvoiceWithPayment("btc:btc");
    await setPayment(pid, { status: "detected", received: "50000", rate_locked_until: Date.now() - 1000 });
    const r = await pay(id, "btc:btc");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { payment_id: string }).payment_id).toBe(pid);
    expect(await listPayments(e.DB, id)).toHaveLength(1);
  });
  it("409 payment_in_progress when in-flight funds on another asset cover the total", async () => {
    const { id, pid } = await newInvoiceWithPayment("btc:btc");
    await setPayment(pid, { status: "confirming", received: "50000", final: "0" }); // 0.0005 BTC = $50
    const r = await pay(id, "ltc:ltc");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "payment_in_progress" });
    expect(await listPayments(e.DB, id)).toHaveLength(1);
  });
  it("reduces the new payment by partial in-flight coverage", async () => {
    const { id, pid } = await newInvoiceWithPayment("btc:btc");
    await setPayment(pid, { status: "detected", received: "25000", final: "0" }); // $25 in flight
    const r = await pay(id, "ltc:ltc");
    expect(r.status).toBe(201);
    expect(((await r.json()) as { amount: string }).amount).toBe("0.25"); // $25 at $100/LTC
  });
  it("does not reuse a locked payment worth more than what is still owed after a coin switch", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    const btc = (await (await pay(id, "btc:btc")).json()) as { payment_id: string; amount: string };
    expect(btc.amount).toBe("0.0005"); // $50
    const ltc = (await (await pay(id, "ltc:ltc")).json()) as { payment_id: string };
    await setPayment(ltc.payment_id, { status: "detected", received: "20000000", final: "0" }); // 0.2 LTC = $20 in flight
    const again = await pay(id, "btc:btc");
    expect(again.status).toBe(201);
    const j = (await again.json()) as { payment_id: string; amount: string };
    expect(j.payment_id).not.toBe(btc.payment_id);
    expect(j.amount).toBe("0.0003"); // $30
  });
  it("still reuses a locked payment within one cent of what is owed", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    const btc = (await (await pay(id, "btc:btc")).json()) as { payment_id: string };
    await e.DB.prepare("UPDATE invoices SET paid_minor='1', status='partially_paid' WHERE id=?").bind(id).run(); // owes $49.99
    const again = await pay(id, "btc:btc");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { payment_id: string }).payment_id).toBe(btc.payment_id);
  });
  it("counts the unconfirmed part of a partial payment on another asset as in flight", async () => {
    const { id, pid } = await newInvoiceWithPayment("ltc:ltc");
    // 0.3 LTC seen, 0.1 LTC final and credited ($10); $20 still unconfirmed.
    await setPayment(pid, { status: "partial", received: "30000000", final: "10000000", credited_minor: "1000", credit_price_e8: String(100n * 10n ** 8n) });
    await e.DB.prepare("UPDATE invoices SET paid_minor='1000', status='partially_paid' WHERE id=?").bind(id).run();
    const r = await pay(id, "btc:btc");
    expect(r.status).toBe(201);
    expect(((await r.json()) as { amount: string }).amount).toBe("0.0002"); // $50 - $10 paid - $20 in flight
  });
  it("derives the first address of a chain at <CHAIN>_XPUB_START_INDEX", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    armed.add(id);
    const env = { ...e, LTC_XPUB_START_INDEX: "500" };
    const r = await createOrReusePayment(env, id, "ltc:ltc", freshIp());
    expect("body" in r && r.body.address).toBe(await getAdapter(e, "ltc").deriveAddress(500));
    expect((await listPayments(e.DB, id))[0]!.derivation_index).toBe(500);
  });
  it("rejects assets outside allowed_assets or not enabled", async () => {
    const id = ((await (await create({ allowed_assets: ["btc:btc"] })).json()) as { id: string }).id;
    for (const a of ["ltc:ltc", "doge:doge"]) {
      const r = await pay(id, a);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: "asset_not_allowed" });
    }
  });
  it("503 on a stale price", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    await setPrice("BTC", 100_000n * 10n ** 8n, Date.now() - 400_000);
    const r = await pay(id, "btc:btc");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "price_unavailable" });
  });
  it("409 for expired, paid or unknown-remaining invoices; 404 unknown", async () => {
    const mk = async (o: Partial<InvoiceRow>) => {
      const id = "inv_t" + Math.random().toString(36).slice(2);
      await insertInvoice(e.DB, {
        id, created_at: Date.now(), expires_at: Date.now() + 60_000, price_minor: 5000n, currency: "USD", order_id: null,
        metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n, ...o,
      });
      return id;
    };
    for (const o of [{ expires_at: Date.now() - 1 }, { status: "paid" as const, paid_minor: 5000n }, { paid_minor: 5000n }]) {
      const r = await pay(await mk(o), "btc:btc");
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: "invoice_closed" });
    }
    expect((await pay("inv_missing", "btc:btc")).status).toBe(404);
  });
  it("prices the remaining amount after a partial payment", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    await e.DB.prepare("UPDATE invoices SET paid_minor='2500', status='partially_paid' WHERE id=?").bind(id).run();
    const j = (await (await pay(id, "btc:btc")).json()) as Record<string, string>;
    expect(j.amount).toBe("0.00025");
  });
  it("rate-limits per IP (61st request in a minute)", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    await sameMinuteWindow();
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await pay(id, "nope:nope", ip)).status;
    expect(last).toBe(429);
    const r = await pay(id, "nope:nope", ip);
    expect(await r.json()).toMatchObject({ error: "rate_limited" });
  });
  it("rate-limits an IPv6 /64 as one client", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    await sameMinuteWindow();
    const net = `2001:db8:${(ipSeq++ & 0xffff).toString(16)}:7`;
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await pay(id, "nope:nope", `${net}::${(i + 1).toString(16)}`)).status;
    expect(last).toBe(429);
    expect((await pay(id, "nope:nope", `${net.replace(/:7$/, ":8")}::1`)).status).not.toBe(429); // the next /64 is not
  });
});

describe("Solana payments", () => {
  const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, SOLANA_RPC_URL: e.SOLANA_RPC_URL };
  const B58_32 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  beforeAll(async () => {
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,sol:sol,sol:usdc", SOLANA_RPC_URL: "https://sol.test/rpc" });
    // watchers see a mainnet node and an empty address
    network.use(
      http.post("https://sol.test/rpc", async ({ request }) => {
        const b = (await request.json()) as { id: number; method: string };
        const result = b.method === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : b.method === "getBalance" ? { context: { slot: 1 }, value: 0 } : { context: { slot: 1 }, value: [] };
        return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result });
      }),
    );
    await setPrice("SOL", 150n * 10n ** 8n);
    await setPrice("USDC", 10n ** 8n);
  });
  afterAll(() => void Object.assign(e, saved));

  it("a sol payment gets a random 32-byte base58 reference, kept when the payment is reused; other chains get none", async () => {
    const id = ((await (await create()).json()) as { id: string }).id;
    const r = await pay(id, "sol:usdc");
    expect(r.status).toBe(201);
    const j = (await r.json()) as Record<string, string>;
    const [p] = await listPayments(e.DB, id);
    expect(p!.reference).toMatch(B58_32);
    expect(base58.decode(p!.reference!)).toHaveLength(32);
    expect(j.uri).toBe(`solana:${j.address}?amount=50&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${p!.reference}&label=pay.test`);
    const again = await pay(id, "sol:usdc");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(j);
    const after = await listPayments(e.DB, id);
    expect(after).toHaveLength(1);
    expect(after[0]!.reference).toBe(p!.reference);
    // a SOL payment on another invoice: its own reference
    const id2 = ((await (await create()).json()) as { id: string }).id;
    const j2 = (await (await pay(id2, "sol:sol")).json()) as Record<string, string>;
    const [p2] = await listPayments(e.DB, id2);
    expect(p2!.reference).toMatch(B58_32);
    expect(p2!.reference).not.toBe(p!.reference);
    expect(j2.uri).toBe(`solana:${j2.address}?amount=0.333333334&reference=${p2!.reference}&label=pay.test`);
    expect(j2.address).not.toBe(j.address);
    // btc stays reference-free
    const id3 = ((await (await create()).json()) as { id: string }).id;
    await pay(id3, "btc:btc");
    expect((await listPayments(e.DB, id3))[0]!.reference).toBeNull();
  });
});

describe("SUCCESS_URL_HOSTS allowlist", () => {
  afterEach(async () => {
    await saveSettings(e, { SUCCESS_URL_HOSTS: "" });
  });
  it("accepts a listed host case-insensitively with any port, refuses subdomains and unlisted localhost", async () => {
    await saveSettings(e, { SUCCESS_URL_HOSTS: "shop.example" });
    expect((await create({ success_url: "https://Shop.Example:8443/ok" })).status).toBe(201);
    const sub = await create({ success_url: "https://evil.shop.example/" });
    expect(sub.status).toBe(400);
    expect(await sub.json()).toMatchObject({ message: "success_url must be an https URL on one of SUCCESS_URL_HOSTS" });
    expect((await create({ success_url: "http://localhost/" })).status).toBe(400);
  });
  it("unset keeps today's behaviour: any https URL", async () => {
    expect((await create({ success_url: "https://anything.example/ok" })).status).toBe(201);
  });
  it("validSuccessUrl refuses tricks even for a listed host", () => {
    const h = ["shop.example", "localhost"];
    expect(validSuccessUrl("http://localhost:3000/x", h)).toBe(true);
    for (const bad of [
      "javascript:alert(1)", "data:text/html,x", "//shop.example/x", "https://shop.example@evil.com/", "https://evil.com@shop.example/",
      "https:\\\\shop.example\\x", "https://shop.example\\@evil.com/", "http://shop.example/", "ftp://shop.example/", "",
    ])
      expect(validSuccessUrl(bad, h), bad).toBe(false);
  });
  it("parseSuccessHosts trims and lowercases, and refuses schemes, paths, ports and wildcards", () => {
    expect(parseSuccessHosts("")).toEqual([]);
    expect(parseSuccessHosts(" Shop.Example , b.test ")).toEqual(["shop.example", "b.test"]);
    for (const bad of ["https://a.com", "a.com/x", "a.com:8080", "*.a.com"])
      expect(() => parseSuccessHosts(bad), bad).toThrow("SUCCESS_URL_HOSTS: " + bad + " is not a hostname");
  });
});
