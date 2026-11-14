import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "../../../src/chains/registry";
import { clearChainIdMemo } from "../../../src/chains/evm/config";
import { hotAccount } from "../../../src/signing/evmkeys";
import { factoryAddress, predictDeposit } from "../../../src/chains/evm/predict";
import { getAsset } from "../../../src/core/assets";
import type { DepositTarget } from "../../../src/core/types";
import type { Env } from "../../../src/env";
import { emptyState, evmRpc, tokenKey, type RpcLog, type RpcState } from "../../evm-rpc";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RPC = "https://rpc.test/base";
const ADDR = "0x1111111111111111111111111111111111111111";
const USDC = getAsset("base:usdc");
const BASE_USDC = USDC.contract!;
const POLY_USDC = getAsset("polygon:usdc").contract!;
const BASE_DAI = getAsset("base:dai").contract!;

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const mkEnv = (o: Partial<Env> = {}): Env =>
  ({
    MASTER_SEED: SEED,
    ALLOW_SEED_CUSTODY: "true",
    ENABLED_ASSETS: "base:eth,base:usdc,polygon:pol,polygon:usdc",
    EVM_RPC_BASE: RPC,
    EVM_RPC_POLYGON: "https://rpc.test/polygon",
    ...o,
  }) as Env;
const target = (asset: string, address = ADDR): DepositTarget => ({
  paymentId: "p1",
  chain: getAsset(asset).chain,
  asset,
  address,
  derivationIndex: 0,
  createdAt: 0,
});

let state: RpcState;
let log: RpcLog;
beforeEach(() => {
  state = emptyState();
  log = { methods: [], multicalls: [] };
  clearChainIdMemo();
});
const serve = (url = RPC) => network.use(evmRpc(url, () => state, log));
const observe = (asset: string, env = mkEnv()) => getAdapter(env, getAsset(asset).chain).observe(target(asset), getAsset(asset));

describe("evm observe", () => {
  it("received = latest balance, final = finalized balance", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
    expect(await observe("base:usdc")).toEqual({ received: 50_000_000n, final: 0n, txids: [], unexpected: {} });
    state.finalized = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
    expect(await observe("base:usdc")).toMatchObject({ received: 50_000_000n, final: 50_000_000n });
  });

  it("reads latest and finalized in one multicall each, every registry token of the chain plus native, all on Multicall3", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 1n } };
    await observe("base:usdc");
    expect(log.multicalls).toHaveLength(2);
    const multicall3 = "0xca11bde05977b3631167028862be2a173976ca11";
    // DAI is not enabled, but it is a registry token of Base: an unexpected DAI deposit must still be seen.
    for (const m of log.multicalls) expect(m.targets.sort()).toEqual([BASE_USDC.toLowerCase(), BASE_DAI.toLowerCase(), multicall3].sort());
    expect(log.methods).not.toContain("eth_getLogs"); // Transfer/Flushed logs are spoofable: balances only
  });

  it("reports a non-zero balance of a registry asset that is not enabled as unexpected", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 1n, [tokenKey(BASE_DAI, ADDR)]: 5n * 10n ** 18n } };
    const out = await observe("base:usdc", mkEnv({ ENABLED_ASSETS: "base:usdc" }));
    expect(out.unexpected).toEqual({ "base:dai": 5n * 10n ** 18n });
  });

  it("native payment: received is the ETH balance, tokens go to unexpected", async () => {
    serve();
    state.latest = { native: { [ADDR]: 10n ** 16n }, tokens: { [tokenKey(BASE_USDC, ADDR)]: 7n } };
    state.finalized = { native: { [ADDR]: 10n ** 16n } };
    expect(await observe("base:eth")).toEqual({ received: 10n ** 16n, final: 10n ** 16n, txids: [], unexpected: { "base:usdc": 7n } });
  });

  it("another asset's balance is reported as unexpected, not credited", async () => {
    serve();
    state.latest = { native: { [ADDR]: 1000n }, tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
    expect(await observe("base:usdc")).toMatchObject({ received: 50_000_000n, unexpected: { "base:eth": 1000n } });
  });

  it("a disabled payment asset is still read", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 5n } };
    expect((await observe("base:usdc", mkEnv({ ENABLED_ASSETS: "base:eth" }))).received).toBe(5n);
  });

  it("a lagging finalized block means no confirmation", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
    state.finalized = {}; // finalized block predates the transfer
    expect(await observe("base:usdc")).toMatchObject({ received: 50_000_000n, final: 0n });
  });

  it("final never exceeds received", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 10n } };
    state.finalized = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 99n } };
    expect(await observe("base:usdc")).toMatchObject({ received: 10n, final: 10n });
  });

  it("an empty (swept) address reads zero", async () => {
    serve();
    expect(await observe("base:usdc")).toEqual({ received: 0n, final: 0n, txids: [], unexpected: {} });
  });

  describe("upstream requests per observe", () => {
    /** Serves RPC with counters; the first observe asks the URL's chain id (once per isolate), so it is not counted. */
    const counted = async (asset = "base:usdc") => {
      const rpc = evmRpc(RPC, () => state, log);
      network.use(rpc);
      await observe(asset);
      const [r0, c0] = [rpc.requests(), rpc.calls()];
      log.requests = [];
      log.multicalls = [];
      const out = await observe(asset);
      return { out, requests: rpc.requests() - r0, calls: rpc.calls() - c0 };
    };
    it("an empty address: one HTTP request (the latest balances), no head or finalized read", async () => {
      const { out, requests, calls } = await counted();
      expect(out).toEqual({ received: 0n, final: 0n, txids: [], unexpected: {} });
      expect(requests).toBe(1);
      expect(calls).toBe(1);
      expect(log.requests).toEqual([["eth_call"]]);
      expect(log.multicalls.map((m) => m.block)).toEqual(["latest"]);
    });
    it("only another asset at the address: still one request, the stray balance is reported as unexpected", async () => {
      state.latest = { native: { [ADDR]: 1000n } };
      state.finalized = { native: { [ADDR]: 1000n } };
      const { out, requests } = await counted();
      expect(out).toEqual({ received: 0n, final: 0n, txids: [], unexpected: { "base:eth": 1000n } });
      expect(requests).toBe(1);
    });
    it("a funded address: head and finalized block are separate requests (no JSON-RPC batching); received and final as before", async () => {
      state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
      state.finalized = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 50_000_000n } };
      const { out, requests, calls } = await counted();
      expect(out).toEqual({ received: 50_000_000n, final: 50_000_000n, txids: [], unexpected: {} });
      // An RPC that refuses batches would otherwise fail every funded poll while the unbatched health check stays green.
      expect(requests).toBe(4);
      expect(calls).toBe(4);
      expect(log.requests!.every((r) => r.length === 1)).toBe(true);
      expect(log.requests!.flat().sort()).toEqual(["eth_blockNumber", "eth_call", "eth_call", "eth_getBlockByNumber"]);
      expect(log.multicalls.map((m) => m.block)).toEqual(["latest", "0x384"]); // finalized 900 on Base (minDepth 0)
    });
  });

  it("throws when the payment asset's own balance cannot be read (never reads as 0)", async () => {
    serve();
    state.latest = { failing: [BASE_USDC.toLowerCase()] };
    await expect(observe("base:usdc")).rejects.toThrow("balance read failed");
  });

  describe("pinned block reads", () => {
    const hex = (n: bigint) => `0x${n.toString(16)}`;
    const blocks = () => log.multicalls.map((m) => m.block);
    const poly = (head: bigint, fin: bigint, bal = 50_000_000n) => {
      serve("https://rpc.test/polygon");
      state.head = head;
      state.finalizedNumber = fin;
      state.latest = { tokens: { [tokenKey(POLY_USDC, ADDR)]: 60_000_000n } };
      state.finalized = { tokens: { [tokenKey(POLY_USDC, ADDR)]: bal } };
      return observe("polygon:usdc");
    };
    it("polygon with finalized = head - 3 reads final at head - 64", async () => {
      const out = await poly(5000n, 4997n);
      expect(blocks().sort()).toEqual(["latest", hex(4936n)].sort());
      expect(out).toMatchObject({ received: 60_000_000n, final: 50_000_000n }); // confirms: the rule is about the block read, not the tag
    });
    it("polygon with head - 64 > finalized reads final at finalized", async () => {
      await poly(5000n, 4900n);
      expect(blocks().sort()).toEqual(["latest", hex(4900n)].sort());
    });
    it("polygon exactly 64 behind reads at the finalized block", async () => {
      await poly(5000n, 4936n);
      expect(blocks().sort()).toEqual(["latest", hex(4936n)].sort());
    });
    it("polygon early chain (head < 64): final 0 and no negative block is read", async () => {
      const out = await poly(10n, 5n);
      expect(out.final).toBe(0n);
      expect(blocks()).toEqual(["latest"]);
    });
    it("base reads final at the finalized block and latest with the latest tag", async () => {
      serve();
      state.head = 1000n;
      state.finalizedNumber = 990n;
      state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 3n } };
      state.finalized = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 2n } };
      expect(await observe("base:usdc")).toMatchObject({ received: 3n, final: 2n });
      expect(blocks().sort()).toEqual(["latest", hex(990n)].sort());
    });
  });

  describe("fails closed on the finalized read", () => {
    it("a rejected finalized eth_call makes observe reject, with a cause", async () => {
      serve();
      state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 5n } };
      state.finalizedCallError = true;
      await expect(observe("base:usdc")).rejects.toThrow();
    });
    it("a failed finalized entry for the payment asset throws (never final 0), with a cause", async () => {
      serve();
      state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 5n } };
      state.finalized = { failing: [BASE_USDC.toLowerCase()] };
      const err = await observe("base:usdc").catch((x: unknown) => x);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("balance read failed");
      expect((err as Error).cause).toBeDefined();
    });
  });

  it("a finalized block with a null number fails closed (never final 0)", async () => {
    serve();
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 5n } };
    state.finalizedNumberNull = true;
    await expect(observe("base:usdc")).rejects.toThrow("finalized block has no number");
  });

  it("falls back to the second RPC URL without retrying the failed one", async () => {
    const primary: string[] = [];
    network.use(
      http.post("https://down.test/rpc", async ({ request }) => {
        const { method, params } = (await request.json()) as { method: string; params: unknown[] };
        primary.push(JSON.stringify([method, params]));
        return new HttpResponse(null, { status: 500 });
      }),
    );
    network.use(evmRpc("https://up.test/rpc", () => state, log));
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 3n } };
    const out = await observe("base:usdc", mkEnv({ EVM_RPC_BASE: "https://down.test/rpc, https://up.test/rpc" }));
    expect(out.received).toBe(3n);
    // Each distinct request reached the failing primary exactly once (no transport retries), then the secondary served it.
    expect(primary.length).toBeGreaterThan(0);
    expect(new Set(primary).size).toBe(primary.length);
    expect(log.methods.length).toBeGreaterThanOrEqual(primary.length);
  });
});

describe("chain id per RPC URL", () => {
  const other = () => ({ ...emptyState(), chainId: 1, latest: { tokens: { [tokenKey(BASE_USDC, ADDR)]: 999n } } });
  it("a fallback URL that reports another chain is never used for a balance read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrongLog: RpcLog = { methods: [], multicalls: [] };
    // The primary is on the right chain but fails every other call, so the fallback would normally take over.
    network.use(
      http.post("https://good.test/rpc", async ({ request }) => {
        const { id, method } = (await request.json()) as { id: number; method: string };
        if (method === "eth_chainId") return HttpResponse.json({ jsonrpc: "2.0", id, result: "0x2105" });
        return new HttpResponse(null, { status: 500 });
      }),
      evmRpc("https://wrong.test/rpc", other, wrongLog),
    );
    await expect(observe("base:usdc", mkEnv({ EVM_RPC_BASE: "https://good.test/rpc,https://wrong.test/rpc" }))).rejects.toThrow();
    expect(wrongLog.methods).toEqual(["eth_chainId"]);
    expect(wrongLog.multicalls).toHaveLength(0);
    // the warning names the variable and the URL's position, never the URL (it may hold an API key)
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/EVM_RPC_BASE URL #2 .*chain id 1/);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("wrong.test");
    warn.mockRestore();
  });

  it("a mismatched primary is dropped and the correct fallback serves the reads; each URL is asked once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrongLog: RpcLog = { methods: [], multicalls: [] };
    network.use(evmRpc("https://wrong.test/rpc", other, wrongLog), evmRpc("https://up.test/rpc", () => state, log));
    state.latest = { tokens: { [tokenKey(BASE_USDC, ADDR)]: 3n } };
    const env = mkEnv({ EVM_RPC_BASE: "https://wrong.test/rpc, https://up.test/rpc" });
    expect((await observe("base:usdc", env)).received).toBe(3n);
    expect((await observe("base:usdc", env)).received).toBe(3n);
    expect(wrongLog.methods).toEqual(["eth_chainId"]);
    expect(log.methods.filter((m) => m === "eth_chainId")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("throws ChainIdMismatch when every URL reports another chain, and reads nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrongLog: RpcLog = { methods: [], multicalls: [] };
    network.use(evmRpc("https://wrong.test/rpc", other, wrongLog));
    const err = await observe("base:usdc", mkEnv({ EVM_RPC_BASE: "https://wrong.test/rpc" })).catch((x: unknown) => x);
    expect((err as Error).name).toBe("ChainIdMismatch");
    expect(wrongLog.methods).toEqual(["eth_chainId"]);
    warn.mockRestore();
  });

  it("an unreachable URL is not memoised: it is asked again next time, and an outage is not a mismatch", async () => {
    let down = true;
    const seen: string[] = [];
    network.use(
      http.post("https://flaky.test/rpc", async ({ request }) => {
        const { method } = (await request.clone().json()) as { method: string };
        seen.push(method);
        return down ? new HttpResponse(null, { status: 500 }) : undefined;
      }),
      evmRpc("https://flaky.test/rpc", () => state, log),
    );
    const env = mkEnv({ EVM_RPC_BASE: "https://flaky.test/rpc" });
    const err = await observe("base:usdc", env).catch((x: unknown) => x);
    expect((err as Error).name).not.toBe("ChainIdMismatch");
    down = false;
    expect((await observe("base:usdc", env)).received).toBe(0n);
    expect(seen.filter((m) => m === "eth_chainId")).toHaveLength(2);
  });
});

describe("rpc transport", () => {
  it("never retries a failing endpoint: every request is sent exactly once", async () => {
    const seen: string[] = [];
    network.use(
      http.post("https://dead.test/rpc", async ({ request }) => {
        const { method, params } = (await request.json()) as { method: string; params: unknown[] };
        seen.push(JSON.stringify([method, params]));
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(observe("base:usdc", mkEnv({ EVM_RPC_BASE: "https://dead.test/rpc" }))).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("evm adapter wiring", () => {
  it("deriveAddress is the predicted forwarder of the hot wallet's factory", async () => {
    const a = getAdapter(mkEnv(), "base");
    const factory = factoryAddress(hotAccount({ MASTER_SEED: SEED }).address);
    expect(await a.deriveAddress(0)).toBe(predictDeposit(factory, 0));
    expect(await a.deriveAddress(5)).toBe(predictDeposit(factory, 5));
    expect(await a.deriveAddress(5)).not.toBe(await a.deriveAddress(6));
    // same index, same address on every chain
    expect(await getAdapter(mkEnv({ EVM_RPC_ARB: "https://rpc.test/arb" }), "arb").deriveAddress(5)).toBe(await a.deriveAddress(5));
  });

  it("an unconfigured EVM chain still throws at getAdapter", () => {
    expect(() => getAdapter(mkEnv({ EVM_RPC_BASE: "" }), "base")).toThrow("EVM_RPC_BASE");
  });

  it("paymentUri: EIP-681 token transfer and native value", () => {
    const a = getAdapter(mkEnv(), "base");
    expect(a.paymentUri(target("base:usdc"), USDC, 50_000_000n)).toBe(
      `ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=${ADDR}&uint256=50000000`,
    );
    expect(a.paymentUri(target("base:eth"), getAsset("base:eth"), 123456789n)).toBe(`ethereum:${ADDR}@8453?value=123456789`);
    const poly = getAdapter(mkEnv(), "polygon");
    expect(poly.paymentUri(target("polygon:pol"), getAsset("polygon:pol"), 1n)).toBe(`ethereum:${ADDR}@137?value=1`);
  });
});
