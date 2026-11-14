import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrReusePayment } from "../../../src/api/invoices";
import { clearChainIdMemo } from "../../../src/chains/evm/config";
import { clearHealthMemo, evmHealth, evmHealthDetail } from "../../../src/chains/evm/health";
import { hotAccount } from "../../../src/signing/evmkeys";
import { usableAssets } from "../../../src/config";
import { insertInvoice, type InvoiceRow } from "../../../src/db/repo";
import type { Env } from "../../../src/env";
import { emptyState, evmRpc, type RpcLog, type RpcState } from "../../evm-rpc";
import { offline } from "../../offline";
import { putPrice } from "../../prices/seed";

const e = env as unknown as Env;
const BASE = "https://pay.test";
const RPC = "https://rpc.test/base";
const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, EVM_RPC_BASE: e.EVM_RPC_BASE };
const armed = new Set<string>();

const network = setupNetwork();
let state: RpcState;
let log: RpcLog;
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  Object.assign(e, { ENABLED_ASSETS: "btc:btc,base:eth,base:usdc", EVM_RPC_BASE: RPC });
  await putPrice(e, "USD", "USDC", 10n ** 8n);
});
beforeEach(async () => {
  state = emptyState();
  log = { methods: [], multicalls: [] };
  network.use(...offline(), evmRpc(RPC, () => state, log));
  await e.KV.delete("evm:health:base");
  clearHealthMemo();
  clearChainIdMemo();
});
afterEach(() => network.resetHandlers());
afterAll(async () => {
  for (const id of armed) await runInDurableObject(e.WATCHER.get(e.WATCHER.idFromName(id)), (_w, s) => s.storage.deleteAlarm());
  Object.assign(e, saved);
  network.disable();
});

const calls = (m: string) => log.methods.filter((x) => x === m).length;
const apiAssets = async () =>
  ((await (await exports.default.fetch(`${BASE}/api/v1/assets`)).json()) as { id: string }[]).map((a) => a.id);

async function mkInvoice(): Promise<string> {
  const id = `inv_health${Date.now()}${Math.random().toString(36).slice(2)}`;
  armed.add(id);
  const inv: InvoiceRow = {
    id, created_at: Date.now(), expires_at: Date.now() + 3_600_000, price_minor: 5000n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "open", late: false, overpaid: false, paid_minor: 0n,
  };
  await insertInvoice(e.DB, inv);
  return id;
}

describe("evmHealth", () => {
  it("reports factory, hot balance and finalized lag", async () => {
    state.code = "0x6080";
    state.latest = { native: { [hotAccount(e).address.toLowerCase()]: 5n * 10n ** 18n } };
    state.latestTime = 5000;
    state.finalizedTime = 4000;
    expect(await evmHealth(e, "base")).toEqual({ factoryDeployed: true, hotBalance: 5n * 10n ** 18n, finalizedLagSec: 1000 });
  });

  it("eth_getCode 0x means the factory is not deployed", async () => {
    state.code = "0x";
    expect((await evmHealth(e, "base")).factoryDeployed).toBe(false);
  });

  it("caches the result in KV (bigint as a string) and the second call makes no RPC request", async () => {
    state.latest = { native: { [hotAccount(e).address.toLowerCase()]: 7n } };
    const a = await evmHealth(e, "base");
    const n = log.methods.length;
    expect(n).toBeGreaterThan(0);
    const b = await evmHealth(e, "base");
    expect(b).toEqual(a);
    expect(log.methods.length).toBe(n);
    expect(calls("eth_getCode")).toBe(1);
    expect(JSON.parse((await e.KV.get("evm:health:base"))!).hotBalance).toBe("7");
  });

  it("refreshes after the 10 minute freshness window", async () => {
    await evmHealth(e, "base");
    const stored = JSON.parse((await e.KV.get("evm:health:base"))!);
    await e.KV.put("evm:health:base", JSON.stringify({ ...stored, until: Date.now() - 1 }));
    clearHealthMemo();
    await evmHealth(e, "base");
    expect(calls("eth_getCode")).toBe(2);
  });

  it("on an RPC error returns the last cached value, else not-deployed with lag -1, and warns with the error name only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      state.down = true;
      expect(await evmHealth(e, "base")).toEqual({ factoryDeployed: false, hotBalance: 0n, finalizedLagSec: -1 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("base");
      expect(String(warn.mock.calls[0]![0])).not.toContain(e.MASTER_SEED);

      state.down = false;
      await e.KV.delete("evm:health:base"); // forget the 60 s backoff
      clearHealthMemo();
      state.latest = { native: { [hotAccount(e).address.toLowerCase()]: 9n } };
      const good = await evmHealth(e, "base");
      expect(good.factoryDeployed).toBe(true);
      const stored = JSON.parse((await e.KV.get("evm:health:base"))!);
      await e.KV.put("evm:health:base", JSON.stringify({ ...stored, until: Date.now() - 1 })); // stale
      clearHealthMemo();
      state.down = true;
      expect(await evmHealth(e, "base")).toEqual(good);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("assets are hidden until the factory is deployed", () => {
  it("code 0x hides the chain's assets from the API and the checkout, and refuses payment creation", async () => {
    state.code = "0x";
    expect(await apiAssets()).toEqual(["btc:btc"]);
    expect((await usableAssets(e)).map((a) => a.id)).toEqual(["btc:btc"]);
    const id = await mkInvoice();
    const html = await (await exports.default.fetch(`${BASE}/i/${id}`)).text();
    expect(html).toContain('value="btc:btc"');
    expect(html).not.toContain("base:usdc");
    expect(html).not.toContain("base:eth");
    const r = await createOrReusePayment(e, id, "base:usdc", "10.30.0.1");
    expect(r).toEqual({ error: { code: "asset_not_allowed", message: expect.any(String) } });
  });

  it("non-empty code shows them", async () => {
    state.code = "0x6080";
    expect(await apiAssets()).toEqual(["btc:btc", "base:eth", "base:usdc"]);
    const id = await mkInvoice();
    const html = await (await exports.default.fetch(`${BASE}/i/${id}`)).text();
    expect(html).toContain('value="base:usdc"');
    const r = await createOrReusePayment(e, id, "base:usdc", "10.30.0.2");
    expect("error" in r).toBe(false);
  });

  it("a payment created before the factory vanished from view keeps rendering", async () => {
    const id = await mkInvoice();
    const r = await createOrReusePayment(e, id, "base:usdc", "10.30.0.3");
    if ("error" in r) throw new Error("payment creation failed");
    state.code = "0x";
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    expect((await exports.default.fetch(`${BASE}/i/${id}/p/${r.body.payment_id}`)).status).toBe(200);
  });

  it("a cached result serves repeat requests without more RPC calls", async () => {
    await apiAssets();
    await apiAssets();
    await usableAssets(e);
    expect(calls("eth_getCode")).toBe(1);
  });

  it("an RPC outage with nothing cached hides the chain and warns once (the failure is cached, not retried per request)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.down = true;
    expect(await apiAssets()).toEqual(["btc:btc"]);
    expect(await apiAssets()).toEqual(["btc:btc"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("evmHealth backoff and cache validation", () => {
  const stored = async () => JSON.parse((await e.KV.get("evm:health:base"))!);

  it("during an outage the second call makes no RPC request (60 s retryAt, also across isolates via KV)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.down = true;
    await evmHealth(e, "base");
    const n = log.methods.length;
    expect(n).toBeGreaterThan(0);
    await evmHealth(e, "base");
    expect(log.methods.length).toBe(n);
    const s = await stored();
    expect(s.until - Date.now()).toBeGreaterThan(50_000);
    expect(s.until - Date.now()).toBeLessThanOrEqual(60_000);
    clearHealthMemo(); // a fresh isolate reads the KV entry
    await evmHealth(e, "base");
    expect(log.methods.length).toBe(n);
    warn.mockRestore();
  });

  it("a failed refresh keeps the last known value and backs off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = await evmHealth(e, "base");
    await e.KV.put("evm:health:base", JSON.stringify({ ...(await stored()), until: Date.now() - 1 }));
    clearHealthMemo();
    state.down = true;
    expect(await evmHealth(e, "base")).toEqual(good);
    const n = log.methods.length;
    expect(await evmHealth(e, "base")).toEqual(good);
    expect(log.methods.length).toBe(n);
    warn.mockRestore();
  });

  it("an entry for a different factory address (other seed) is ignored", async () => {
    await e.KV.put(
      "evm:health:base",
      JSON.stringify({ until: Date.now() + 500_000, factoryAddress: "0x0000000000000000000000000000000000000001", chainId: 8453, factoryDeployed: false, hotBalance: "0", finalizedLagSec: 5 }),
    );
    expect((await evmHealth(e, "base")).factoryDeployed).toBe(true);
    expect(calls("eth_getCode")).toBe(1);
  });

  it("an entry for a different chain id is ignored", async () => {
    const s = await (async () => { await evmHealth(e, "base"); return stored(); })();
    await e.KV.put("evm:health:base", JSON.stringify({ ...s, chainId: 1, factoryDeployed: false }));
    clearHealthMemo();
    expect((await evmHealth(e, "base")).factoryDeployed).toBe(true);
  });

  it("after a success, an RPC that switches to another chain id fails closed (the last value is never reused) and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await evmHealth(e, "base")).factoryDeployed).toBe(true);
    await e.KV.put("evm:health:base", JSON.stringify({ ...(await stored()), until: Date.now() - 1 }));
    clearHealthMemo();
    state.chainId = 10;
    expect(await evmHealthDetail(e, "base")).toMatchObject({ value: { factoryDeployed: false, hotBalance: 0n, finalizedLagSec: -1 }, error: "chain_id_mismatch" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("base");
    const n = log.methods.length;
    expect((await evmHealth(e, "base")).factoryDeployed).toBe(false); // 60 s backoff, still closed
    expect(log.methods.length).toBe(n);
    warn.mockRestore();
  });

  it("a failed refresh keeps the old checkedAt and is reported stale; success clears it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    await evmHealth(e, "base");
    const first = (await stored()).checkedAt;
    expect(first).toBeGreaterThanOrEqual(t0);
    expect((await evmHealthDetail(e, "base")).stale).toBe(false);
    await e.KV.put("evm:health:base", JSON.stringify({ ...(await stored()), until: Date.now() - 1 }));
    clearHealthMemo();
    state.down = true;
    expect(await evmHealthDetail(e, "base")).toMatchObject({ stale: true, checkedAt: first });
    expect((await stored()).checkedAt).toBe(first);
    expect((await stored()).failed).toBe(true);
    state.down = false;
    await e.KV.put("evm:health:base", JSON.stringify({ ...(await stored()), until: Date.now() - 1 }));
    clearHealthMemo();
    const ok = await evmHealthDetail(e, "base");
    expect(ok.stale).toBe(false);
    expect(ok.checkedAt).toBeGreaterThanOrEqual(first);
    warn.mockRestore();
  });

  it("an entry for another factory is not used as the fallback after a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await e.KV.put("evm:health:base", JSON.stringify({ until: Date.now() - 1, factoryAddress: "0x0000000000000000000000000000000000000001", chainId: 8453, factoryDeployed: true, hotBalance: "5", finalizedLagSec: 3, checkedAt: 1 }));
    state.down = true;
    expect(await evmHealth(e, "base")).toEqual({ factoryDeployed: false, hotBalance: 0n, finalizedLagSec: -1 });
    warn.mockRestore();
  });

  it("an RPC on the wrong chain id is an error: not deployed, kind chain_id_mismatch, with a warning naming the chain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.chainId = 1;
    expect(await evmHealthDetail(e, "base")).toMatchObject({ value: { factoryDeployed: false, hotBalance: 0n, finalizedLagSec: -1 }, error: "chain_id_mismatch" });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.every((c) => String(c[0]).includes("base") || String(c[0]).includes("EVM_RPC_BASE"))).toBe(true);
    expect(log.methods).toEqual(["eth_chainId"]); // nothing else is read from it
    expect((await stored()).error).toBe("chain_id_mismatch");
    warn.mockRestore();
  });

  it("an RPC outage is kind rpc_unavailable; a success clears the kind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.down = true;
    expect(await evmHealthDetail(e, "base")).toMatchObject({ error: "rpc_unavailable" });
    state.down = false;
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    expect((await evmHealthDetail(e, "base")).error).toBeNull();
    warn.mockRestore();
  });
});

describe("createOrReusePayment with funds in flight", () => {
  it("returns the in-flight payment even after the factory looks undeployed, and refuses a new choice on that chain", async () => {
    const id = await mkInvoice();
    const r = await createOrReusePayment(e, id, "base:usdc", "10.30.1.1");
    if ("error" in r) throw new Error("payment creation failed");
    await e.DB.prepare("UPDATE payments SET status='detected', received=?, detected_at=? WHERE id=?").bind("1000", Date.now(), r.body.payment_id).run();
    state.code = "0x";
    await e.KV.delete("evm:health:base");
    clearHealthMemo();
    const again = await createOrReusePayment(e, id, "base:usdc", "10.30.1.2");
    expect(again).toMatchObject({ status: 200, body: { payment_id: r.body.payment_id } });
    expect(await createOrReusePayment(e, id, "base:eth", "10.30.1.3")).toMatchObject({ error: { code: "asset_not_allowed" } });
  });
});
