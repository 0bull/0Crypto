import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { chainConfigError } from "../../src/chains/registry";
import { accountFromSeed } from "../../src/chains/utxo/derive";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { createLink } from "../../src/links/store";
import { clearSettingsCache, effectiveEnv, firstReceiveAddress, publicUrlPinned, saveSettings, SettingsError } from "../../src/settings";

const e = env as unknown as Env;
/** The signed-in admin session (set in beforeAll). */
let S: AdminTestSession;
const BASE = "https://pay.test";
// BIP84 test vector (account 0 of the "abandon ... about" mnemonic).
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
});
beforeEach(async () => {
  await e.DB.batch([e.DB.prepare("DELETE FROM settings"), e.DB.prepare("DELETE FROM payments"), e.DB.prepare("DELETE FROM invoices")]);
  clearSettingsCache();
});
afterEach(() => vi.restoreAllMocks());

const putRow = (key: string, value: string) =>
  e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value, Date.now()).run();

describe("effectiveEnv precedence", () => {
  it("a D1 value wins over an empty var", async () => {
    await putRow("MERCHANT_NAME", "A");
    expect((await effectiveEnv({ ...e, MERCHANT_NAME: "" })).MERCHANT_NAME).toBe("A");
  });
  it("a D1 row wins even when its value is empty", async () => {
    await putRow("WEBHOOK_URL", "");
    expect((await effectiveEnv({ ...e, WEBHOOK_URL: "https://x.test/h" })).WEBHOOK_URL).toBe("");
  });
  it("without a D1 row the var stays", async () => {
    expect((await effectiveEnv({ ...e, WEBHOOK_URL: "https://x.test/h" })).WEBHOOK_URL).toBe("https://x.test/h");
  });
  it("a non-empty PUBLIC_URL var wins over D1; an empty one does not", async () => {
    await putRow("PUBLIC_URL", "https://other.test");
    expect((await effectiveEnv({ ...e, PUBLIC_URL: "https://pay.test" })).PUBLIC_URL).toBe("https://pay.test");
    expect((await effectiveEnv({ ...e, PUBLIC_URL: "" })).PUBLIC_URL).toBe("https://other.test");
  });
  it("is idempotent: wrapping an effective env again carries the pinned flag and re-reads D1", async () => {
    await putRow("PUBLIC_URL", "https://claimed.test");
    const once = await effectiveEnv({ ...e, PUBLIC_URL: "" });
    const twice = await effectiveEnv(once);
    expect(publicUrlPinned(once)).toBe(false);
    expect(publicUrlPinned(twice)).toBe(false); // its PUBLIC_URL came from D1, not a var
    await saveSettings(e, { PUBLIC_URL: "https://moved.test" });
    expect((await effectiveEnv(once)).PUBLIC_URL).toBe("https://moved.test");
    // A var-pinned env stays pinned and keeps the var.
    const pinned = await effectiveEnv(await effectiveEnv(e));
    expect(publicUrlPinned(pinned)).toBe(true);
    expect(pinned.PUBLIC_URL).toBe("https://pay.test");
  });
  it("returns a new object and leaves the input untouched", async () => {
    await putRow("MERCHANT_NAME", "A");
    const input = { ...e, MERCHANT_NAME: "" };
    const out = await effectiveEnv(input);
    expect(out).not.toBe(input);
    expect(input.MERCHANT_NAME).toBe("");
  });
});

describe("instance keys fill blank secrets", () => {
  it("an empty SESSION_SECRET becomes the 43-char instance key, stable across calls", async () => {
    const a = (await effectiveEnv({ ...e, SESSION_SECRET: "" })).SESSION_SECRET;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    clearSettingsCache();
    expect((await effectiveEnv({ ...e, SESSION_SECRET: "" })).SESSION_SECRET).toBe(a);
  });
  it("a set SESSION_SECRET is kept", async () => {
    expect((await effectiveEnv({ ...e, SESSION_SECRET: "my-own-secret" })).SESSION_SECRET).toBe("my-own-secret");
  });
  it("an empty WEBHOOK_SECRET becomes whsec_ + the webhook instance key", async () => {
    expect((await effectiveEnv({ ...e, WEBHOOK_SECRET: "" })).WEBHOOK_SECRET).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect((await effectiveEnv({ ...e, WEBHOOK_SECRET: "whsec_mine" })).WEBHOOK_SECRET).toBe("whsec_mine");
  });
});

describe("cache", () => {
  it("saveSettings is visible at once; a direct D1 write only after 30 s", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    await saveSettings(e, { MERCHANT_NAME: "  Saved shop  " });
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("Saved shop");
    await putRow("MERCHANT_NAME", "Direct");
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("Saved shop");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 30_000);
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("Saved shop");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 30_001);
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("Direct");
  });
  it("a load whose PUBLIC_URL is empty is not cached: a claim in another isolate is seen at once", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    const unpinned = { ...e, PUBLIC_URL: "" };
    expect((await effectiveEnv(unpinned)).PUBLIC_URL).toBe("");
    await putRow("PUBLIC_URL", "https://claimed.test"); // what the claim writes, without this isolate's clearSettingsCache
    expect((await effectiveEnv(unpinned)).PUBLIC_URL).toBe("https://claimed.test");
    // Once PUBLIC_URL is set, loads are cached again.
    await putRow("PUBLIC_URL", "https://later.test");
    expect((await effectiveEnv(unpinned)).PUBLIC_URL).toBe("https://claimed.test");
  });
  it("with a PUBLIC_URL var (and no D1 row) loads are still cached", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("");
    await putRow("MERCHANT_NAME", "Direct");
    expect((await effectiveEnv(e)).MERCHANT_NAME).toBe("");
  });
});

describe("saveSettings validation", () => {
  const refused = async (entries: Parameters<typeof saveSettings>[1], key: string) => {
    const err = await saveSettings(e, entries).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).key).toBe(key);
    expect((err as SettingsError).message.length).toBeGreaterThan(0);
    return err as SettingsError;
  };
  it("refuses an xpub that does not parse", async () => {
    await refused({ BTC_XPUB: "nope" }, "BTC_XPUB");
  });
  it("refuses bad start indexes", async () => {
    await refused({ BTC_XPUB_START_INDEX: "-1" }, "BTC_XPUB_START_INDEX");
    await refused({ LTC_XPUB_START_INDEX: "2147483648" }, "LTC_XPUB_START_INDEX");
    await refused({ DOGE_XPUB_START_INDEX: "1.5" }, "DOGE_XPUB_START_INDEX");
    await saveSettings(e, { BTC_XPUB_START_INDEX: "2147483647" });
  });
  it("refuses explorer and webhook URLs that are not https (http only on loopback)", async () => {
    await refused({ BTC_ESPLORA_URL: "http://esplora.test/api" }, "BTC_ESPLORA_URL");
    await refused({ WEBHOOK_URL: "ftp://x.test" }, "WEBHOOK_URL");
    await refused({ DOGE_BLOCKBOOK_URL: "not a url" }, "DOGE_BLOCKBOOK_URL");
    await saveSettings(e, { LTC_ESPLORA_URL: "http://127.0.0.1:3000/api", WEBHOOK_URL: "http://localhost:8080/hook", BTC_ESPLORA_URL: "https://esplora.test/api" });
    expect((await effectiveEnv(e)).WEBHOOK_URL).toBe("http://localhost:8080/hook");
  });
  it("refuses unknown assets, long merchant names and bad success hosts", async () => {
    await refused({ ENABLED_ASSETS: "btc:btc,nope:nope" }, "ENABLED_ASSETS");
    await refused({ MERCHANT_NAME: "x".repeat(65) }, "MERCHANT_NAME");
    await refused({ SUCCESS_URL_HOSTS: "shop.test,https://x.test/path" }, "SUCCESS_URL_HOSTS");
    await refused({ SUCCESS_URL_HOSTS: "a.com/x" }, "SUCCESS_URL_HOSTS");
    await refused({ SUCCESS_URL_HOSTS: "a.com:8080" }, "SUCCESS_URL_HOSTS");
    await refused({ SUCCESS_URL_HOSTS: "*.a.com" }, "SUCCESS_URL_HOSTS");
    await saveSettings(e, { ENABLED_ASSETS: "btc:btc, ltc:ltc", SUCCESS_URL_HOSTS: "shop.test, www.shop.test", MERCHANT_NAME: "x".repeat(64) });
    const out = await effectiveEnv(e);
    expect(out.ENABLED_ASSETS).toBe("btc:btc,ltc:ltc");
    expect(out.SUCCESS_URL_HOSTS).toBe("shop.test,www.shop.test");
  });
  it("writes nothing when one entry is invalid", async () => {
    await refused({ MERCHANT_NAME: "Fine", BTC_XPUB: "nope" }, "BTC_XPUB");
    expect(await e.DB.prepare("SELECT count(*) AS n FROM settings").first<{ n: number }>()).toEqual({ n: 0 });
  });
  it("refuses changing the wallet of a chain that has handed out addresses; the same value is fine", async () => {
    await saveSettings(e, { BTC_XPUB: ZPUB });
    await e.DB.batch([
      e.DB.prepare("INSERT INTO invoices(id,created_at,expires_at,price_minor,currency,status,late,overpaid,paid_minor) VALUES('inv_set',0,1,'1','USD','awaiting',0,0,'0')"),
      e.DB.prepare(
        "INSERT INTO payments(id,invoice_id,asset,chain,address,derivation_index,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,credited_minor) VALUES('pay_set','inv_set','btc:btc','btc','bc1qset',0,'1','1',0,'0','0','[]','awaiting',0,'0')",
      ),
    ]);
    const other = accountFromSeed(e.MASTER_SEED!, "btc").publicExtendedKey;
    const err = await refused({ BTC_XPUB: other }, "BTC_XPUB");
    expect(err.message).toBe(
      "Bitcoin has already handed out addresses from this wallet, so its wallet cannot be changed. To use another wallet, set up a new deployment (see the docs).",
    );
    await refused({ BTC_XPUB_START_INDEX: "5" }, "BTC_XPUB_START_INDEX");
    await saveSettings(e, { BTC_XPUB: ZPUB, BTC_XPUB_START_INDEX: "0" });
    // Other chains are unaffected.
    await saveSettings(e, { LTC_XPUB_START_INDEX: "7" });
  });
});

describe("helpers", () => {
  it("firstReceiveAddress matches the BIP84 vector", () => {
    expect(firstReceiveAddress("btc", ZPUB, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });
  it("a routed chain with a blank MASTER_SEED says so", () => {
    expect(chainConfigError({ ALLOW_SEED_CUSTODY: "true", MASTER_SEED: "", SOLANA_RPC_URL: "https://s.test" }, "sol")).toBe("MASTER_SEED is not set");
    expect(chainConfigError({ ALLOW_SEED_CUSTODY: "true", MASTER_SEED: "", TRONGRID_API_KEY: "k" }, "tron")).toBe("MASTER_SEED is not set");
    expect(chainConfigError({ ALLOW_SEED_CUSTODY: "true", MASTER_SEED: "", EVM_RPC_BASE: "https://rpc.test" }, "base")).toBe("MASTER_SEED is not set");
    expect(chainConfigError({ ALLOW_SEED_CUSTODY: "true" }, "btc")).toBe("MASTER_SEED is not set");
    expect(chainConfigError({ ALLOW_SEED_CUSTODY: "true", MASTER_SEED: "", BTC_XPUB: ZPUB }, "btc")).toBeNull();
  });
});

// Review Focus 5: before the first claim PUBLIC_URL can be empty; form posts that compare Origin with it answer 403, not 500.
describe("empty PUBLIC_URL", () => {
  const call = async (path: string, headers: Record<string, string>, body: Record<string, string>) => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request(BASE + path, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "10.77.0.1", ...headers },
        body: new URLSearchParams(body),
      }),
      { ...e, PUBLIC_URL: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return r;
  };
  it("POST /pos/charge answers 403", async () => {
    const cookie = S.cookie;
    const body = { csrf: "x", amount: "1.00", currency: "USD" };
    expect((await call("/pos/charge", { cookie, origin: BASE }, body)).status).toBe(403);
    expect((await call("/pos/charge", { cookie }, body)).status).toBe(403);
  });
  it("POST /l/<id> answers 403", async () => {
    const l = await createLink(e.DB, { title: "Tip jar", price_minor: 2500n, currency: "USD", allowed_assets: null });
    expect((await call(`/l/${l.id}`, { origin: BASE }, { token: "x" })).status).toBe(403);
    expect((await call(`/l/${l.id}`, {}, { token: "x" })).status).toBe(403);
  });
});
