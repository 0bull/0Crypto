import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse, delay } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chainConfigError, counterKey, getAdapter, startIndex } from "../../../src/chains/registry";
import { SOL_MAINNET_GENESIS, clearGenesisMemo } from "../../../src/chains/solana/rpc";
import { solanaAdapter } from "../../../src/chains/solana/adapter";
import { solDepositKey } from "../../../src/signing/keys";
import { enabledAssets } from "../../../src/config";
import { ASSETS, getAsset } from "../../../src/core/assets";
import type { DepositTarget } from "../../../src/core/types";
import type { Env } from "../../../src/env";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const U1 = "https://sol1.test/rpc";
const U2 = "https://sol2.test/rpc";
const ADDR = solDepositKey(SEED, 0).address;
const OTHER = solDepositKey(SEED, 1).address;
const REF = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const SOL = getAsset("sol:sol");
const USD = getAsset("sol:usdc");

const network = setupNetwork();
beforeAll(() => network.enable());
beforeEach(() => clearGenesisMemo());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

const mkEnv = (o: Partial<Env> = {}): Env =>
  ({ MASTER_SEED: SEED, ALLOW_SEED_CUSTODY: "true", ENABLED_ASSETS: "sol:sol,sol:usdc", SOLANA_RPC_URL: U1, PUBLIC_URL: "https://pay.example.com", ...o }) as Env;
const target = (o: Partial<DepositTarget> = {}): DepositTarget => ({
  paymentId: "p1", chain: "sol", asset: "sol:usdc", address: ADDR, derivationIndex: 0, createdAt: 1000, reference: REF, ...o,
});

type Commitment = "confirmed" | "finalized";
type Acct = { state?: string; type?: string; pubkey?: string; owner?: string; mint?: string; tokenOwner?: string; amount?: unknown; noParsed?: boolean };
const acct = (amount: unknown, o: Acct = {}) => ({
  pubkey: o.pubkey ?? "AtaAccount11111111111111111111111111111111",
  account: {
    lamports: 2039280,
    owner: o.owner ?? TOKEN_PROGRAM,
    executable: false,
    data: o.noParsed
      ? ["AAAA", "base64"]
      : { program: "spl-token", space: 165, parsed: { type: o.type ?? "account", info: { state: o.state ?? "initialized", mint: o.mint ?? USDC, owner: o.tokenOwner ?? ADDR, tokenAmount: { amount, decimals: 6, uiAmount: 1 } } } },
  },
});

interface Sim {
  genesis?: string;
  /** lamports per commitment, or a raw value */
  balance?: Partial<Record<Commitment, unknown>>;
  tokens?: Partial<Record<Commitment, unknown[]>>;
  /** override the whole response for a method */
  fail?: Partial<Record<string, () => Response | Promise<Response>>>;
}
const calls: { url: string; method: string; params: unknown[] }[] = [];
function sim(url: string, s: Sim = {}) {
  return http.post(url, async ({ request }) => {
    const b = (await request.json()) as { id: number; method: string; params: unknown[] };
    calls.push({ url, method: b.method, params: b.params });
    const f = s.fail?.[b.method];
    if (f) return f();
    const reply = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id: b.id, result });
    const cfg = b.params[b.params.length - 1] as { commitment: Commitment };
    switch (b.method) {
      case "getGenesisHash":
        return reply(s.genesis ?? SOL_MAINNET_GENESIS);
      case "getBalance":
        return reply({ context: { slot: 1 }, value: s.balance?.[cfg.commitment] ?? 0 });
      case "getTokenAccountsByOwner":
        return reply({ context: { slot: 1 }, value: s.tokens?.[cfg.commitment] ?? [] });
    }
    return HttpResponse.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "no" } });
  });
}
beforeEach(() => void (calls.length = 0));
const observe = (env: Env, t: DepositTarget, a = USD) => solanaAdapter(env, 500).observe(t, a);

describe("assets", () => {
  it("sol:sol and sol:usdc", () => {
    expect(ASSETS["sol:sol"]).toEqual({ id: "sol:sol", chain: "sol", symbol: "SOL", decimals: 9, priceSymbol: "SOL", confirmations: 0 });
    expect(ASSETS["sol:usdc"]).toEqual({ id: "sol:usdc", chain: "sol", symbol: "USDC", decimals: 6, contract: USDC, priceSymbol: "USDC", confirmations: 0 });
    expect(SOL.detectionOnly).toBeUndefined();
    expect(USD.detectionOnly).toBeUndefined();
  });
});

describe("observe sol:usdc", () => {
  it("confirmed 50 USDC, finalized 0: received 50, final 0, no txids", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("50000000")], finalized: [] } }));
    expect(await observe(mkEnv(), target())).toEqual({ received: 50_000_000n, final: 0n, txids: [] });
  });
  it("asks both commitments with jsonParsed, the mint filter and the deposit as owner", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("5")], finalized: [acct("5")] } }));
    await observe(mkEnv(), target());
    const q = calls.filter((c) => c.method === "getTokenAccountsByOwner" && (c.params[2] as { commitment: string }).commitment).filter((c) => (c.params[1] as { mint?: string }).mint === USDC);
    expect(q.map((c) => (c.params[2] as { commitment: string }).commitment).sort()).toEqual(["confirmed", "finalized"]);
    for (const c of q) expect(c.params).toEqual([ADDR, { mint: USDC }, { encoding: "jsonParsed", commitment: (c.params[2] as { commitment: string }).commitment }]);
  });
  it("sums several accounts; finalized above confirmed lifts received (max)", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("10"), acct("20")], finalized: [acct("10"), acct("20"), acct("5")] } }));
    expect(await observe(mkEnv(), target())).toMatchObject({ received: 35n, final: 35n });
  });
  it("ignores accounts with another mint, another program, another token owner, or unparsed data", async () => {
    const good = acct("7");
    const bad = [
      acct("100", { mint: "So11111111111111111111111111111111111111112" }),
      acct("100", { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),
      acct("100", { tokenOwner: OTHER }),
      acct("100", { noParsed: true }),
    ];
    network.use(sim(U1, { tokens: { confirmed: [good, ...bad], finalized: [...bad, good] } }));
    expect(await observe(mkEnv(), target())).toMatchObject({ received: 7n, final: 7n });
  });
  it("ignores frozen, uninitialized and non-account token accounts (a frozen account cannot be swept) for received and final", async () => {
    const good = acct("7");
    const bad = [acct("100", { state: "frozen" }), acct("100", { state: "uninitialized" }), acct("100", { type: "mint" }), acct("100", { state: undefined as never, type: "multisig" })];
    network.use(sim(U1, { tokens: { confirmed: [good, ...bad], finalized: [...bad, good] } }));
    expect(await observe(mkEnv(), target())).toMatchObject({ received: 7n, final: 7n });
    clearGenesisMemo();
    network.use(sim(U1, { tokens: { confirmed: [acct("100", { state: "frozen" })], finalized: [acct("100", { state: "frozen" })] } }));
    expect(await observe(mkEnv(), target())).toMatchObject({ received: 0n, final: 0n });
  });
  it("credits a transfer with no reference (the target has none)", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("3000000")], finalized: [acct("3000000")] } }));
    expect(await observe(mkEnv(), target({ reference: undefined }))).toEqual({ received: 3_000_000n, final: 3_000_000n, txids: [] });
  });
  it("a malformed amount in an otherwise valid account throws (never read as 0)", async () => {
    for (const amount of ["1e6", "-5", "1.5", "", " 5", 5, null, undefined, "0x10"]) {
      clearGenesisMemo();
      network.use(sim(U1, { tokens: { confirmed: [acct(amount)], finalized: [] } }));
      await expect(observe(mkEnv(), target()), String(amount)).rejects.toThrow();
    }
  });
  it("a value that is not an array throws", async () => {
    network.use(sim(U1, { tokens: { confirmed: "nope" as never } }));
    await expect(observe(mkEnv(), target())).rejects.toThrow();
  });
  it("amounts beyond 2^53 stay exact", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("18446744073709551615")], finalized: [] } }));
    expect((await observe(mkEnv(), target())).received).toBe(18446744073709551615n);
  });
  it("unexpected: the deposit's SOL balance under sol:sol", async () => {
    network.use(sim(U1, { balance: { confirmed: 5_000_000, finalized: 5_000_000 }, tokens: { confirmed: [acct("1")], finalized: [acct("1")] } }));
    expect((await observe(mkEnv(), target())).unexpected).toEqual({ "sol:sol": 5_000_000n });
  });
  it("no unexpected when the SOL balance is 0", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("1")], finalized: [acct("1")] } }));
    expect(await observe(mkEnv(), target())).not.toHaveProperty("unexpected");
  });
  it("a failing SOL read omits unexpected but still credits the USDC", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("9")], finalized: [acct("9")] }, fail: { getBalance: () => new HttpResponse(null, { status: 500 }) } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = await observe(mkEnv(), target());
    warn.mockRestore();
    expect(o).toEqual({ received: 9n, final: 9n, txids: [] });
  });
});

describe("RPC requests per observe", () => {
  /** Requests other than the genesis check (asked once per URL per isolate). */
  const reads = () => calls.filter((c) => c.method !== "getGenesisHash").map((c) => `${c.method}:${(c.params[c.params.length - 1] as { commitment: string }).commitment}`);
  it("an empty address: two requests (both assets at confirmed), no finalized read", async () => {
    network.use(sim(U1));
    expect(await observe(mkEnv(), target())).toEqual({ received: 0n, final: 0n, txids: [] });
    expect(reads().sort()).toEqual(["getBalance:confirmed", "getTokenAccountsByOwner:confirmed"]);
  });
  it("an emptied (swept) address reads zero at confirmed and skips the finalized read; a stray balance is still reported", async () => {
    network.use(sim(U1, { balance: { confirmed: 5, finalized: 5 }, tokens: { confirmed: [], finalized: [acct("50000000")] } }));
    expect(await observe(mkEnv(), target())).toEqual({ received: 0n, final: 0n, txids: [], unexpected: { "sol:sol": 5n } });
    expect(reads()).toHaveLength(2);
  });
  it("a funded address: three requests, the finalized read of the payment asset added", async () => {
    network.use(sim(U1, { tokens: { confirmed: [acct("7")], finalized: [acct("7")] } }));
    expect(await observe(mkEnv(), target())).toEqual({ received: 7n, final: 7n, txids: [] });
    expect(reads().sort()).toEqual(["getBalance:confirmed", "getTokenAccountsByOwner:confirmed", "getTokenAccountsByOwner:finalized"]);
  });
  it("sol:sol funded: three requests", async () => {
    network.use(sim(U1, { balance: { confirmed: 2, finalized: 1 } }));
    expect(await observe(mkEnv(), target({ asset: "sol:sol" }), SOL)).toEqual({ received: 2n, final: 1n, txids: [] });
    expect(reads().sort()).toEqual(["getBalance:confirmed", "getBalance:finalized", "getTokenAccountsByOwner:confirmed"]);
  });
});

describe("observe sol:sol", () => {
  const t = () => target({ asset: "sol:sol" });
  it("getBalance at both commitments", async () => {
    network.use(sim(U1, { balance: { confirmed: 2_500_000_000, finalized: 1_000_000_000 } }));
    expect(await observe(mkEnv(), t(), SOL)).toEqual({ received: 2_500_000_000n, final: 1_000_000_000n, txids: [] });
    const q = calls.filter((c) => c.method === "getBalance" && c.params[0] === ADDR);
    expect(q.map((c) => c.params[1]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ commitment: "confirmed" }, { commitment: "finalized" }]);
  });
  it("received is at least final", async () => {
    network.use(sim(U1, { balance: { confirmed: 1, finalized: 9 } }));
    expect(await observe(mkEnv(), t(), SOL)).toMatchObject({ received: 9n, final: 9n });
  });
  it("a balance that is not a safe integer throws", async () => {
    for (const v of [2 ** 53, 1.5, -1, "5", Number.MAX_SAFE_INTEGER + 2]) {
      clearGenesisMemo();
      network.use(sim(U1, { balance: { confirmed: v, finalized: 0 } }));
      await expect(observe(mkEnv(), t(), SOL), String(v)).rejects.toThrow();
    }
  });
  it("a null or missing balance value throws", async () => {
    for (const result of [{ context: { slot: 1 }, value: null }, { context: { slot: 1 } }, 5]) {
      clearGenesisMemo();
      network.use(sim(U1, { fail: { getBalance: () => HttpResponse.json({ jsonrpc: "2.0", id: 1, result }) } }));
      await expect(observe(mkEnv(), t(), SOL), JSON.stringify(result)).rejects.toThrow();
    }
  });
  it("unexpected: the USDC token sum under sol:usdc, only when above 0", async () => {
    network.use(sim(U1, { balance: { confirmed: 1, finalized: 1 }, tokens: { confirmed: [acct("40"), acct("2", { mint: "So11111111111111111111111111111111111111112" })], finalized: [] } }));
    expect((await observe(mkEnv(), t(), SOL)).unexpected).toEqual({ "sol:usdc": 40n });
    clearGenesisMemo();
    network.use(sim(U1, { balance: { confirmed: 1, finalized: 1 } }));
    expect(await observe(mkEnv(), t(), SOL)).not.toHaveProperty("unexpected");
  });
  it("a failing token read omits unexpected but still credits the SOL", async () => {
    network.use(sim(U1, { balance: { confirmed: 7, finalized: 7 }, fail: { getTokenAccountsByOwner: () => HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } }) } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = await observe(mkEnv(), t(), SOL);
    warn.mockRestore();
    expect(o).toEqual({ received: 7n, final: 7n, txids: [] });
  });
});

describe("RPC: fail closed, fall back, mainnet only", () => {
  const t = () => target({ asset: "sol:sol" });
  const ok = { balance: { confirmed: 3, finalized: 3 } };
  it("a non-2xx answer throws (never 0)", async () => {
    network.use(sim(U1, { ...ok, fail: { getBalance: () => new HttpResponse(null, { status: 503 }) } }));
    await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow();
  });
  it("a JSON-RPC error throws", async () => {
    network.use(sim(U1, { ...ok, fail: { getBalance: () => HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "behind" } }) } }));
    await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow();
  });
  it("a body that is not JSON-RPC (no result) throws", async () => {
    for (const body of [{}, [], "x", { jsonrpc: "2.0", id: 1 }]) {
      clearGenesisMemo();
      network.use(sim(U1, { ...ok, fail: { getBalance: () => HttpResponse.json(body as never) } }));
      await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow();
    }
  });
  it("a hung node times out", async () => {
    network.use(sim(U1, { ...ok, fail: { getBalance: async () => (await delay("infinite"), new HttpResponse(null)) } }));
    await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow();
  });
  it("confirmed succeeds but finalized fails on every URL: rejects, never 0", async () => {
    const h = (url: string) =>
      http.post(url, async ({ request }) => {
        const b = (await request.json()) as { id: number; method: string; params: unknown[] };
        if (b.method === "getGenesisHash") return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: SOL_MAINNET_GENESIS });
        const c = (b.params[1] as { commitment: string }).commitment;
        if (c === "finalized") return new HttpResponse(null, { status: 500 });
        return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: 9 } });
      });
    network.use(h(U1), h(U2));
    await expect(observe(mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` }), t(), SOL)).rejects.toThrow();
  });
  it("U1 answers only confirmed, U2 only finalized and lags: received is the max, final is U2's", async () => {
    const h = (url: string, only: string, value: number) =>
      http.post(url, async ({ request }) => {
        const b = (await request.json()) as { id: number; method: string; params: unknown[] };
        if (b.method === "getGenesisHash") return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: SOL_MAINNET_GENESIS });
        if (b.method === "getTokenAccountsByOwner") return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: [] } });
        if ((b.params[1] as { commitment: string }).commitment !== only) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value } });
      });
    network.use(h(U1, "confirmed", 10), h(U2, "finalized", 4));
    expect(await observe(mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` }), t(), SOL)).toEqual({ received: 10n, final: 4n, txids: [] });
  });
  it("a URL that failed is skipped for 60 s, then tried again; as a last resort it is tried even in the cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let u1Up = false;
      network.use(
        sim(U1, { ...ok, fail: { getGenesisHash: () => (u1Up ? HttpResponse.json({ jsonrpc: "2.0", id: 1, result: SOL_MAINNET_GENESIS }) : new HttpResponse(null, { status: 500 })) } }),
        sim(U2, ok),
      );
      const env = mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` });
      const n1 = () => calls.filter((c) => c.url === U1).length;
      await observe(env, t(), SOL);
      const first = n1();
      expect(first).toBeGreaterThan(0);
      await observe(env, t(), SOL); // within the cooldown: U1 is not asked
      expect(n1()).toBe(first);
      vi.advanceTimersByTime(61_000);
      await observe(env, t(), SOL); // cooldown over: asked again (still down)
      expect(n1()).toBeGreaterThan(first);
      // last resort: U2 goes down while U1 is in its cooldown and back up
      u1Up = true;
      network.use(sim(U2, { fail: { getBalance: () => new HttpResponse(null, { status: 500 }), getGenesisHash: () => new HttpResponse(null, { status: 500 }) } }));
      clearGenesisMemo();
      calls.length = 0;
      u1Up = false;
      await expect(observe(env, t(), SOL)).rejects.toThrow(); // both fail, both are tried
      expect(calls.some((c) => c.url === U1)).toBe(true);
      expect(calls.some((c) => c.url === U2)).toBe(true);
      u1Up = true;
      expect((await observe(env, t(), SOL)).received).toBe(3n); // U1 is in cooldown, U2 is down: U1 still tried as a last resort
    } finally {
      vi.useRealTimers();
    }
  });
  it("a wrong-cluster URL is never retried, not even as a last resort", async () => {
    network.use(sim(U1, { ...ok, genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }), sim(U2, { fail: { getGenesisHash: () => new HttpResponse(null, { status: 500 }) } }));
    const env = mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` });
    await expect(observe(env, t(), SOL)).rejects.toThrow();
    calls.length = 0;
    await expect(observe(env, t(), SOL)).rejects.toThrow();
    expect(calls.some((c) => c.url === U1)).toBe(false);
  });
  it("the thrown error has no cause (a fetch TypeError can carry the URL)", async () => {
    network.use(http.post(U1, () => HttpResponse.error()));
    const err = (await observe(mkEnv(), t(), SOL).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBeUndefined();
  });
  it("falls back to the next URL when the first fails", async () => {
    network.use(sim(U1, { fail: { getGenesisHash: () => new HttpResponse(null, { status: 502 }) } }), sim(U2, ok));
    expect((await observe(mkEnv({ SOLANA_RPC_URL: `${U1}, ${U2}` }), t(), SOL)).received).toBe(3n);
  });
  it("falls back when the first answers the call with an error", async () => {
    network.use(sim(U1, { fail: { getBalance: () => new HttpResponse(null, { status: 500 }) } }), sim(U2, ok));
    expect((await observe(mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` }), t(), SOL)).received).toBe(3n);
  });
  it("skips a URL on another cluster's genesis hash, and asks each URL's genesis only on a cold start", async () => {
    network.use(sim(U1, { ...ok, genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }), sim(U2, ok));
    const env = mkEnv({ SOLANA_RPC_URL: `${U1},${U2}` });
    expect((await observe(env, t(), SOL)).received).toBe(3n);
    const g = (u: string) => calls.filter((c) => c.url === u && c.method === "getGenesisHash").length;
    const cold = [g(U1), g(U2)]; // concurrent cold-start reads may each ask
    expect((await observe(env, t(), SOL)).received).toBe(3n);
    expect([g(U1), g(U2)]).toEqual(cold); // cached afterwards
    expect(calls.filter((c) => c.url === U1 && c.method !== "getGenesisHash")).toHaveLength(0); // never asked for balances
  });
  it("throws when every URL is on the wrong cluster", async () => {
    network.use(sim(U1, { ...ok, genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }));
    await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow(/genesis/i);
    expect(calls.filter((c) => c.method !== "getGenesisHash")).toHaveLength(0);
  });
  it("a malformed genesis answer is a failure, not a pass", async () => {
    network.use(sim(U1, { ...ok, fail: { getGenesisHash: () => HttpResponse.json({ jsonrpc: "2.0", id: 1, result: 5 }) } }));
    await expect(observe(mkEnv(), t(), SOL)).rejects.toThrow();
  });
  it("does not remember a failed genesis check (an outage is retried)", async () => {
    let up = false;
    network.use(sim(U1, { ...ok, fail: { getGenesisHash: () => (up ? HttpResponse.json({ jsonrpc: "2.0", id: 1, result: SOL_MAINNET_GENESIS }) : new HttpResponse(null, { status: 500 })) } }));
    const env = mkEnv();
    await expect(observe(env, t(), SOL)).rejects.toThrow();
    up = true;
    expect((await observe(env, t(), SOL)).received).toBe(3n);
  });
  it("errors never carry the RPC URL (it is a secret)", async () => {
    network.use(sim("https://sol.test/rpc/SECRET-KEY-123", { ...ok, fail: { getBalance: () => new HttpResponse(null, { status: 500 }) } }));
    const err = await observe(mkEnv({ SOLANA_RPC_URL: "https://sol.test/rpc/SECRET-KEY-123" }), t(), SOL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    let e: unknown = err;
    while (e instanceof Error) {
      expect(e.message).not.toContain("SECRET-KEY-123");
      e = e.cause;
    }
  });
});

describe("deriveAddress and paymentUri", () => {
  it("deriveAddress is the deposit key address", async () => {
    const a = solanaAdapter(mkEnv());
    expect(a.chain).toBe("sol");
    expect(await a.deriveAddress(0)).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    expect(await a.deriveAddress(3)).toBe(solDepositKey(SEED, 3).address);
  });
  it("USDC URI matches exactly", () => {
    expect(solanaAdapter(mkEnv()).paymentUri(target(), USD, 50_000_000n)).toBe(
      `solana:${ADDR}?amount=50&spl-token=${USDC}&reference=${REF}&label=pay.example.com`,
    );
  });
  it("SOL URI has no spl-token; the amount has no trailing zeros", () => {
    expect(solanaAdapter(mkEnv()).paymentUri(target({ asset: "sol:sol" }), SOL, 1_230_000_000n)).toBe(`solana:${ADDR}?amount=1.23&reference=${REF}&label=pay.example.com`);
    expect(solanaAdapter(mkEnv()).paymentUri(target({ asset: "sol:sol" }), SOL, 1n)).toContain("amount=0.000000001&");
  });
  it("each parameter is URL-encoded; label is the host (with a port)", () => {
    const uri = solanaAdapter(mkEnv({ PUBLIC_URL: "https://pay.example.com:8443/base" })).paymentUri(target({ reference: "a b&c" }), SOL, 1_000_000_000n);
    expect(uri).toBe(`solana:${ADDR}?amount=1&reference=a%20b%26c&label=pay.example.com%3A8443`);
  });
  it("omits reference when the payment has none", () => {
    expect(solanaAdapter(mkEnv()).paymentUri(target({ reference: undefined }), USD, 1_000_000n)).toBe(`solana:${ADDR}?amount=1&spl-token=${USDC}&label=pay.example.com`);
  });
});

describe("configuration", () => {
  const full = { ALLOW_SEED_CUSTODY: "true", SOLANA_RPC_URL: "https://sol.example/key", MASTER_SEED: SEED };
  it("is usable only with custody, https RPC URLs and a valid seed", () => {
    expect(chainConfigError(full, "sol")).toBeNull();
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: " https://a.example , https://b.example " }, "sol")).toBeNull();
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "https://a.example,,https://b.example," }, "sol")).toBeNull();
  });
  it("names what is missing", () => {
    expect(chainConfigError({ ...full, ALLOW_SEED_CUSTODY: undefined }, "sol")).toMatch(/ALLOW_SEED_CUSTODY/);
    expect(chainConfigError({ ...full, ALLOW_SEED_CUSTODY: "yes" }, "sol")).toMatch(/ALLOW_SEED_CUSTODY/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: undefined }, "sol")).toMatch(/SOLANA_RPC_URL/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "" }, "sol")).toMatch(/SOLANA_RPC_URL/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: " , " }, "sol")).toMatch(/SOLANA_RPC_URL/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "http://a.example" }, "sol")).toMatch(/SOLANA_RPC_URL.*https/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "https://a.example,http://b.example" }, "sol")).toMatch(/https/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "not a url" }, "sol")).toMatch(/https/);
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "wss://a.example" }, "sol")).toMatch(/https/);
    expect(chainConfigError({ ...full, MASTER_SEED: "not a mnemonic" }, "sol")).toMatch(/MASTER_SEED/);
    expect(chainConfigError({ ...full, MASTER_SEED: undefined }, "sol")).toMatch(/MASTER_SEED/);
  });
  it("rejects URLs with credentials (username or password), echoing nothing", () => {
    for (const u of ["https://user:pw@a.example", "https://user@a.example", "https://:pw@a.example", "https://b.example,https://u:p@a.example"]) {
      const msg = chainConfigError({ ...full, SOLANA_RPC_URL: u }, "sol");
      expect(msg, u).toMatch(/SOLANA_RPC_URL/);
      expect(msg).not.toMatch(/pw|u:p|user[:@]/);
    }
  });
  it("the error never echoes the RPC URL", () => {
    expect(chainConfigError({ ...full, SOLANA_RPC_URL: "http://secret-key-host.example/KEY" }, "sol")).not.toContain("KEY");
  });
  it("counterKey is sol and the start index 0", () => {
    expect(counterKey("sol")).toBe("sol");
    expect(startIndex(full, "sol")).toBe(0);
  });
  it("getAdapter refuses an unconfigured sol and builds a configured one", () => {
    expect(() => getAdapter(mkEnv({ SOLANA_RPC_URL: "" }), "sol")).toThrow(/SOLANA_RPC_URL/);
    expect(getAdapter(mkEnv(), "sol").chain).toBe("sol");
  });
  it("assets are enabled with full config and left out (warned) without", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(enabledAssets({ ENABLED_ASSETS: "sol:sol,sol:usdc", ...full }).map((a) => a.id)).toEqual(["sol:sol", "sol:usdc"]);
    expect(enabledAssets({ ENABLED_ASSETS: "sol:usdc", ...full, SOLANA_RPC_URL: "" })).toEqual([]);
    warn.mockRestore();
  });
});
