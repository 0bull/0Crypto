import { applyD1Migrations, createExecutionContext, createMessageBatch, createScheduledController, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { http, HttpResponse } from "msw";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, numberToHex, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accountFromSeed, deriveUtxoAddress } from "../../src/chains/utxo/derive";
import { getAsset } from "../../src/core/assets";
import { recordAlert } from "../../src/db/alerts";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env, WebhookJob } from "../../src/env";
import { parseLegs, type SwapLeg } from "../../src/routing/legs";
import type { ShieldOptions, ShieldProgress, ShieldResult } from "../../src/routing/railgun/execute";
import { acquireRouterLock, committedAmount, planAsset, releaseRouterLock, runRouter, type RouterOptions, type RouterReport } from "../../src/routing/router";
import { ROUTER_DEADLINE_MS, ROUTER_LOCK_TTL_MS } from "../../src/routing/config";
import { handleWebhookBatch } from "../../src/webhooks/consumer";
import { verifyWebhook } from "../../src/webhooks/sign";
import worker from "../../src/index";
import golden from "../fixtures/railgun/golden.json";
import { offline } from "../offline";
import { putPrice, dropPrice } from "../prices/seed";

// shieldOnEvm is replaced by a scripted fake (the executor has its own tests); executeSwapChunk is the real one, spied.
const shield = vi.hoisted(() => ({
  calls: [] as Array<{ chain: string; asset: string; amount: bigint; progress?: ShieldProgress }>,
  next: [] as Array<(o: ShieldOptions) => Promise<ShieldResult>>,
}));
vi.mock("../../src/routing/railgun/execute", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/routing/railgun/execute")>();
  return {
    ...real,
    shieldOnEvm: vi.fn(async (_env: Env, chain: string, asset: string, amount: bigint, o: ShieldOptions) => {
      shield.calls.push({ chain, asset, amount, ...(o.progress ? { progress: o.progress } : {}) });
      const f = shield.next.shift();
      if (!f) throw new Error("no scripted shield step");
      return f(o);
    }),
  };
});
vi.mock("../../src/routing/swap", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/routing/swap")>();
  return { ...real, executeSwapChunk: vi.fn(real.executeSwapChunk) };
});
const swapMod = await import("../../src/routing/swap");

const e = env as unknown as Env;
const MN = e.MASTER_SEED!;
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const XMR_A = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const XMR_B = "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H";
const ZK_A = golden.addresses[0]!.address;
const ZK_B = golden.addresses[3]!.address;
const T0 = 1_900_000_000_000;
/**
 * Runs the router with a frozen clock unless the test passes its own: a slow step under load (a first viem import, say)
 * then cannot trip ROUTER_DEADLINE_MS, and every such run asserts that the deadline did not stop it.
 */
async function route(env: Env, now: number, o: RouterOptions = {}): Promise<RouterReport> {
  const r = await runRouter(env, now, { clock: () => 0, ...o });
  if (o.clock === undefined) expect(r.deadline).toBe(false);
  return r;
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const TROC = "https://api.trocador.app";
const ESP = "https://mempool.space/api";
const BASE_RPC = "https://base.test/rpc";
const BASE_USDC = getAsset("base:usdc").contract!.toLowerCase();
const BASE_DAI = getAsset("base:dai").contract!.toLowerCase();
const BTC_DEP = deriveUtxoAddress(accountFromSeed(OTHER, "btc"), "btc", 0);
const btcAddr = (i: number) => deriveUtxoAddress(accountFromSeed(MN, "btc"), "btc", i);
const half = () => 0.5;
const saved = Object.fromEntries(
  ["ENABLED_ASSETS", "TROCADOR_LIVE_OK", "TROCADOR_API_KEY", "XMR_ADDRESS", "RAILGUN_GOLDEN_OK", "RAILGUN_GOLDEN_OK_CHAINS", "RAILGUN_0ZK_ADDRESS", "EVM_RPC_BASE", "WEBHOOK_URL", "HOT_CAP_USD", "ROUTE_MIN_BATCH_USD"].map((k) => [k, (e as unknown as Record<string, unknown>)[k]]),
);

interface Sim {
  utxos: Record<string, { txid: string; vout: number; value: number; confirmed: boolean }[]>;
  broadcasts: string[];
  tradeCalls: URLSearchParams[];
  trades: Record<string, string>;
  /** Every request the handlers saw, by origin (the "nothing happens" tests). */
  requests: string[];
  usdc: bigint;
  /** The hot wallet's base DAI and native ETH (wei). */
  dai?: bigint;
  eth?: bigint;
  /** Runs after each new_trade answer is built (a test acts mid-run). */
  onTrade?: () => Promise<void>;
}
let sim: Sim;
let seq = 0;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  // Warm the lazily imported EVM modules once, outside any test's timing.
  await Promise.all([import("viem"), import("../../src/chains/evm/chains")]);
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await insertInvoice(e.DB, {
    id: "inv_r", created_at: T0 - 2 * HOUR, expires_at: T0 + HOUR, price_minor: 600_000n, currency: "USD", order_id: "order-42",
    metadata: { email: "customer@example.com" }, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 600_000n,
  });
  // Importing viem cold can take over 10 s while the whole suite loads in parallel.
}, 60_000);
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  for (const t of ["payments", "route_batches", "alerts", "events", "derivation_counters", "own_addresses", "router_lock", "routing_actions", "deliveries"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  for (const p of ["trocador:", "prices"]) {
    const { keys } = await e.KV.list({ prefix: p });
    await Promise.all(keys.map((k) => e.KV.delete(k.name)));
  }
  Object.assign(e, { ENABLED_ASSETS: "btc:btc", TROCADOR_LIVE_OK: "1", TROCADOR_API_KEY: "test-trocador-key", XMR_ADDRESS: XMR_A, RAILGUN_GOLDEN_OK: "", RAILGUN_GOLDEN_OK_CHAINS: "", RAILGUN_0ZK_ADDRESS: "", EVM_RPC_BASE: "", HOT_CAP_USD: "5000", ROUTE_MIN_BATCH_USD: "200" });
  shield.calls = [];
  shield.next = [];
  vi.mocked(swapMod.executeSwapChunk).mockClear();
  sim = { utxos: {}, broadcasts: [], tradeCalls: [], trades: {}, requests: [], usdc: 0n };
  await price("BTC", 100_000n);
  await price("USDC", 1n);
  network.use(
    http.all("*", ({ request }) => {
      sim.requests.push(new URL(request.url).origin);
      return undefined; // fall through to the real handlers below
    }),
    ...trocadorHandlers(),
    ...esploraHandlers(),
    baseRpc(),
    ...offline(),
  );
});

/** A fresh USD price in the cache (whole dollars). */
const price = (symbol: string, usd: bigint) => putPrice(e, "USD", symbol, usd * 10n ** 8n);

function trocadorHandlers() {
  const NET: Record<string, string> = { btc: "Mainnet", xmr: "Mainnet" };
  return [
    http.get(`${TROC}/coin`, ({ request }) => {
      const t = new URL(request.url).searchParams.get("ticker")!;
      return HttpResponse.json([{ name: t, ticker: t, network: NET[t], memo: "False", minimum: t === "btc" ? "0.0005" : "0.01", maximum: "100000" }]);
    }),
    http.get(`${TROC}/new_rate`, () => HttpResponse.json({ trade_id: "RATE1", provider: "ProviderA", fixed: "True", amount_to: "0.25", quotes: [{ provider: "ProviderA", kycrating: "A", amount_to: "0.25", fixed: "True" }] })),
    http.get(`${TROC}/new_trade`, async ({ request }) => {
      const q = new URL(request.url).searchParams;
      sim.tradeCalls.push(q);
      if (sim.onTrade) await sim.onTrade();
      const id = `TRADE${sim.tradeCalls.length}`;
      sim.trades[id] = "waiting";
      return HttpResponse.json({
        trade_id: id, ticker_from: q.get("ticker_from"), network_from: q.get("network_from"), ticker_to: "xmr", network_to: "Mainnet", amount_from: q.get("amount_from"),
        amount_to: "0.25", provider: q.get("provider"), fixed: "True", status: "new", address_provider: BTC_DEP, address_provider_memo: "None", address_user: q.get("address"),
        refund_address: q.get("refund"), id_provider: `PROV-${id}`, expiresAt: new Date(T0 + 10 * HOUR).toISOString(),
      });
    }),
    http.get(`${TROC}/trade`, ({ request }) => {
      const id = new URL(request.url).searchParams.get("id")!;
      return HttpResponse.json({ trade_id: id, status: sim.trades[id] ?? "waiting", quotes: { support: `https://support.example/${id}` }, details: { hashout: "ab".repeat(32) } });
    }),
  ];
}

function esploraHandlers() {
  return [
    http.get(`${ESP}/address/:a/utxo`, ({ params }) =>
      HttpResponse.json((sim.utxos[params.a as string] ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: u.confirmed ? { confirmed: true, block_height: 800_000, block_time: 1 } : { confirmed: false } }))),
    ),
    http.get(`${ESP}/v1/fees/recommended`, () => HttpResponse.json({ fastestFee: 10, halfHourFee: 5, hourFee: 1 })),
    http.get(`${ESP}/tx/:txid/status`, ({ params }) =>
      sim.broadcasts.some((h) => Transaction.fromRaw(hexToBytes(h)).id === params.txid) ? HttpResponse.json({ confirmed: false }) : new HttpResponse("Transaction not found", { status: 404 }),
    ),
    http.post(`${ESP}/tx`, async ({ request }) => {
      const hex = await request.text();
      sim.broadcasts.push(hex);
      return HttpResponse.text(Transaction.fromRaw(hexToBytes(hex)).id);
    }),
  ];
}

/** Base JSON-RPC: chain id and the hot wallet's USDC balance (the router's `available` read). */
function baseRpc() {
  return http.post(BASE_RPC, async ({ request }) => {
    const { id, method, params } = (await request.json()) as { id: number; method: string; params: unknown[] };
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id, result });
    if (method === "eth_chainId") return ok(numberToHex(8453));
    if (method === "eth_getBalance") return ok(numberToHex(sim.eth ?? 0n));
    if (method === "eth_call") {
      const call = params[0] as { to: string; data: Hex };
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (call.to.toLowerCase() === BASE_USDC && functionName === "balanceOf") return ok(encodeAbiParameters([{ type: "uint256" }], [sim.usdc]));
      if (call.to.toLowerCase() === BASE_DAI && functionName === "balanceOf") return ok(encodeAbiParameters([{ type: "uint256" }], [sim.dai ?? 0n]));
    }
    return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unmocked ${method}` } });
  });
}

async function btcPayment(index: number, value: number): Promise<PaymentRow> {
  const address = btcAddr(index);
  const p: PaymentRow = {
    id: `pay_r${seq++}`, invoice_id: "inv_r", asset: "btc:btc", chain: "btc", address, derivation_index: index, reference: null, expected: BigInt(value), price_e8: 10n ** 13n,
    rate_locked_until: 0, received: BigInt(value), final: BigInt(value), txids: [], status: "confirmed", created_at: T0 - HOUR + index, detected_at: T0 - HOUR, confirmed_at: T0 - HOUR + index,
    credited_minor: 1n, credit_price_e8: 10n ** 13n, unexpected: null,
  };
  await insertPayment(e.DB, p);
  sim.utxos[address] = [{ txid: bytesToHex(sha256(new TextEncoder().encode(p.id))), vout: 0, value, confirmed: true }];
  await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',?1) ON CONFLICT(chain) DO UPDATE SET next=max(next,?1)").bind(index + 1).run();
  return p;
}

type Batch = { id: string; asset: string; total: string; chunks: string; destination: string; due_at: number | null; status: string; legs: string; progress: string; stuck_at: number | null; error: string | null };
const batches = async () => (await e.DB.prepare("SELECT * FROM route_batches ORDER BY created_at, id").all<Batch>()).results;
const events = async (type: string) => (await e.DB.prepare("SELECT * FROM events WHERE type=? ORDER BY id").bind(type).all<{ id: string; invoice_id: string; payload: string }>()).results;

async function insertBatch(asset: string, chunks: bigint[], o: { status?: string; legs?: SwapLeg[]; progress?: unknown[]; destination?: string } = {}): Promise<string> {
  const id = `rb_t${seq++}`;
  await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, asset, chunks.reduce((a, b) => a + b, 0n).toString(), JSON.stringify(chunks.map(String)), o.destination ?? XMR_A, T0, o.status ?? "executing", T0, T0, JSON.stringify(o.legs ?? []), JSON.stringify(o.progress ?? []))
    .run();
  return id;
}
const leg = (chunk: number, step: SwapLeg["step"], extra: Partial<SwapLeg> = {}): SwapLeg => ({ chunk, step, amount: "1000", createdAt: T0, updatedAt: T0, ...extra });

// ---- tests ------------------------------------------------------------------------------------------------------------

describe("gates", () => {
  it("nothing happens without the live gate, the API key or a valid destination: no batch, no request, nothing written", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const state = async () => JSON.stringify([
      (await e.DB.prepare("SELECT id, routed_at, route_note, route_checked_at, route_funded_at, route_empty_at FROM payments ORDER BY id").all()).results,
      (await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions").first()),
      (await e.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first()),
    ]);
    const before = await state();
    for (const over of [{ TROCADOR_LIVE_OK: "" }, { TROCADOR_LIVE_OK: "true" }, { TROCADOR_API_KEY: "" }, { XMR_ADDRESS: "" }, { XMR_ADDRESS: "4notanaddress" }, { BTC_XPUB: "xpub-watch-mode" }]) {
      const r = await route({ ...e, ...over } as Env, T0, { rng: half });
      expect(r, JSON.stringify(over)).toMatchObject({ ran: true, planned: {}, executed: [], polled: [] });
    }
    // No explorer read, no source stamped or retired, no audit row, no alert (UTXO deposits are not read for the cap).
    expect(sim.requests).toEqual([]);
    expect(await state()).toBe(before);
    // An executing batch of an asset that is not routed now is left alone too.
    await insertBatch("btc:btc", [1_000_000n]);
    await route({ ...e, TROCADOR_LIVE_OK: "" } as Env, T0, { rng: half });
    expect(sim.requests).toEqual([]);
    expect(sim.tradeCalls).toHaveLength(0);
    expect(sim.broadcasts).toHaveLength(0);
    expect((await batches()).map((b) => parseLegs(b.legs))).toEqual([[]]);
  });

  it("EVM needs RAILGUN_GOLDEN_OK, the chain in RAILGUN_GOLDEN_OK_CHAINS and a valid RAILGUN_0ZK_ADDRESS for the chain", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC });
    sim.usdc = 6_000_000_000n;
    for (const over of [
      { RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: "" },
      { RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: "0zk1nope" },
      { RAILGUN_GOLDEN_OK: "", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A },
      { RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "", RAILGUN_0ZK_ADDRESS: ZK_A },
      { RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "eth,arb", RAILGUN_0ZK_ADDRESS: ZK_A },
    ])
      expect((await route({ ...e, ...over } as Env, T0, { rng: half })).planned).toEqual({});
    // Balances read for the hot cap only; nothing shielded, no batch.
    expect(new Set(sim.requests)).toEqual(new Set(["https://base.test"]));
    expect(shield.calls).toHaveLength(0);
    expect(await batches()).toEqual([]);
  });
});

describe("the router lease", () => {
  it("two concurrent runs: only one executes (one trade per chunk), the other does nothing", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const [a, b] = await Promise.all([route(e, T0, { rng: half, holder: "run-a" }), route(e, T0, { rng: half, holder: "run-b" })]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    const [batch] = await batches();
    expect(batch).toMatchObject({ asset: "btc:btc", status: "executing", destination: XMR_A, chunks: JSON.stringify(["3000000", "3000000"]) });
    expect(sim.tradeCalls).toHaveLength(2);
    expect(sim.broadcasts).toHaveLength(2);
    expect(vi.mocked(swapMod.executeSwapChunk)).toHaveBeenCalledTimes(2);
    // The lease was released: the next run executes again, and the sent legs are not traded twice.
    const c = await route(e, T0 + 15 * MIN, { rng: half });
    expect(c.ran).toBe(true);
    expect(sim.tradeCalls).toHaveLength(2);
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: null });
  });

  it("an expired lease is taken over; a live one is not; only the holder releases it", async () => {
    expect(await acquireRouterLock(e.DB, "x", T0)).toBe(true);
    expect(await acquireRouterLock(e.DB, "y", T0 + ROUTER_LOCK_TTL_MS - 1)).toBe(false);
    expect((await route(e, T0 + MIN, { holder: "z" })).ran).toBe(false);
    expect(await acquireRouterLock(e.DB, "y", T0 + ROUTER_LOCK_TTL_MS + 1)).toBe(true);
    await releaseRouterLock(e.DB, "x"); // x's lease expired: it no longer releases anything
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: "y" });
    await releaseRouterLock(e.DB, "y");
    expect(await acquireRouterLock(e.DB, "w", T0 + ROUTER_LOCK_TTL_MS + 2)).toBe(true);
  });

  it("a run that lost its lease (taken over after expiry) starts no further step and does not release the new holder", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    sim.onTrade = async () => {
      sim.onTrade = undefined;
      await e.DB.prepare("UPDATE router_lock SET holder='thief', expires_at=? WHERE id=1").bind(T0 + ROUTER_LOCK_TTL_MS).run();
    };
    const r = await route(e, T0, { rng: half });
    expect(r).toMatchObject({ ran: true, lost: true, polled: [] });
    expect(sim.tradeCalls).toHaveLength(1);
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: "thief" });
  });

  it("no step starts once the 20 s deadline has passed; the lease is still released", async () => {
    await btcPayment(20, 4_000_000);
    let t = 1_000;
    const r = await route(e, T0, { rng: half, clock: () => (t += ROUTER_DEADLINE_MS) });
    expect(r).toMatchObject({ ran: true, deadline: true, planned: {}, executed: [] });
    expect(sim.tradeCalls).toHaveLength(0);
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: null });
    // The deadline passes mid-run (after the first trade): the batch's second chunk is not started, nothing is polled.
    await btcPayment(21, 2_000_000);
    const r2 = await route(e, T0, { rng: half, clock: () => (sim.tradeCalls.length >= 1 ? ROUTER_DEADLINE_MS : 0) });
    expect(r2).toMatchObject({ deadline: true, planned: { "btc:btc": "execute" }, polled: [] });
    expect(sim.tradeCalls).toHaveLength(1);
    expect(parseLegs((await batches())[0]!.legs)).toHaveLength(1);
    // The next run picks up the second chunk.
    await route(e, T0 + 15 * MIN, { rng: half });
    expect(sim.tradeCalls).toHaveLength(2);
  });
});

describe("cron", () => {
  const tick = async (iso: string, cron: string) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(iso), cron }), e, ctx);
    await waitOnExecutionContext(ctx);
  };
  it("the router runs only on the routing cron expression (sweeps have their own)", async () => {
    const runs = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM router_lock").first<{ n: number }>())!.n;
    await tick("2026-11-13T10:07:00Z", "* * * * *");
    await tick("2026-11-13T10:15:00Z", "*/15 * * * *");
    expect(await runs()).toBe(0);
    await tick("2026-11-13T10:20:00Z", "5-59/15 * * * *");
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: null });
  });
});

describe("planning", () => {
  it("schedules below the hot cap (due in the delay window), executes when due with the frozen destination", async () => {
    await btcPayment(20, 300_000); // $300
    expect((await route(e, T0, { rng: half })).planned["btc:btc"]).toBe("schedule");
    const [s] = await batches();
    expect(s).toMatchObject({ status: "scheduled", destination: XMR_A, due_at: T0 + 13 * HOUR, chunks: "[]" });
    expect(sim.tradeCalls).toHaveLength(0);
    expect((await route(e, T0 + HOUR, { rng: half })).planned["btc:btc"]).toBe("wait");
    // XMR_ADDRESS changed before it was due: the scheduled batch keeps the address it was created with.
    e.XMR_ADDRESS = XMR_B;
    expect((await route(e, T0 + 13 * HOUR, { rng: half })).planned["btc:btc"]).toBe("execute");
    const [x] = await batches();
    expect(x).toMatchObject({ id: s!.id, status: "executing", destination: XMR_A });
    expect(sim.tradeCalls.length).toBeGreaterThan(0);
    expect(sim.tradeCalls.every((q) => q.get("address") === XMR_A)).toBe(true);
  });

  it("waits without a price", async () => {
    await btcPayment(20, 4_000_000);
    await dropPrice(e, "USD", "BTC");
    network.use(http.get("https://api.kraken.com/*", () => new HttpResponse(null, { status: 500 })));
    expect((await route(e, T0, { rng: half })).planned["btc:btc"]).toBe("wait: no price");
    expect(await batches()).toEqual([]);
  });

  it("available excludes what executing batches committed and have not paid out", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const btc = getAsset("btc:btc");
    // UTXO: a chunk with no live leg is committed; one with a live leg holds its inputs (already left out).
    await insertBatch("btc:btc", [5_000_000n, 700n], { legs: [leg(1, "traded"), leg(0, "abandoned")] });
    expect(await committedAmount(e.DB, btc)).toBe(5_000_000n);
    // 6_000_000 - 5_000_000 = 0.01 BTC = $1000: under the cap, so scheduled (not executed), for exactly that total.
    expect(await planAsset(e, btc, T0, half)).toBe("schedule");
    expect((await batches()).find((b) => b.status === "scheduled")).toMatchObject({ total: "1000000" });
    // EVM: chunks without a final shield are committed.
    const usdc = getAsset("base:usdc");
    await insertBatch("base:usdc", [10n, 20n, 40n], { progress: [{ costWei: "0", done: "0xaa" }, { costWei: "0", txs: ["0xbb"] }] });
    expect(await committedAmount(e.DB, usdc)).toBe(60n);
    // Hot-pooled swaps (Solana): a chunk counts until its leg is sent; a failed batch's signed, unsettled leg counts.
    const sol = getAsset("sol:sol");
    await insertBatch("sol:sol", [100n, 200n, 400n], { legs: [leg(0, "sent", { tx: "s0" }), leg(1, "sending", { tx: "s1" })] });
    await insertBatch("sol:sol", [1000n], { status: "failed", legs: [leg(0, "sending", { tx: "s2", amount: "1000" })] });
    await insertBatch("sol:sol", [5000n], { status: "completed" });
    expect(await committedAmount(e.DB, sol)).toBe(200n + 400n + 1000n);
    // Tron USDT is hot-pooled like Solana: unsent chunks count; sent and finished ones do not.
    const usdt = getAsset("tron:usdt");
    await insertBatch("tron:usdt", [1_000n, 2_000n, 4_000n, 8_000n], {
      legs: [leg(0, "finished", { tx: "t0" }), leg(1, "energy_wait"), leg(2, "abandoned"), leg(3, "sent", { tx: "t3" })],
    });
    await insertBatch("tron:usdt", [3n], { status: "failed", legs: [leg(0, "sending", { tx: "t9", amount: "3" }), leg(0, "abandoned", { amount: "50" })] });
    expect(await committedAmount(e.DB, usdt)).toBe(2_000n + 4_000n + 3n);
  });
});

describe("execution", () => {
  it("XMR_ADDRESS A -> B: in-flight legs keep A, a new batch uses B", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    await route(e, T0, { rng: half });
    const [first] = await batches();
    expect(first!.destination).toBe(XMR_A);
    e.XMR_ADDRESS = XMR_B;
    // The first batch's second leg is abandoned (expired trade): its replacement still pays A.
    const legs = parseLegs(first!.legs);
    legs[1] = { ...legs[1]!, step: "abandoned", tx: undefined, raw: undefined, reason: "test" } as SwapLeg;
    await e.DB.prepare("UPDATE route_batches SET legs=? WHERE id=?").bind(JSON.stringify(legs), first!.id).run();
    await e.DB.prepare("UPDATE payments SET routed_at=NULL WHERE id=?").bind(legs[1]!.inputs![0]!.paymentId).run();
    // No new funds: nothing new is planned; the abandoned chunk is traded again, to A.
    await route(e, T0 + 15 * MIN, { rng: half });
    expect(await batches()).toHaveLength(1);
    expect(sim.tradeCalls.map((q) => q.get("address"))).toEqual([XMR_A, XMR_A, XMR_A]);
    // New funds: a new batch, frozen with B.
    await btcPayment(22, 7_000_000);
    await route(e, T0 + 30 * MIN, { rng: half });
    const all = await batches();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: first!.id, destination: XMR_A });
    expect(all[1]).toMatchObject({ status: "executing", destination: XMR_B });
    const addrs = sim.tradeCalls.map((q) => q.get("address"));
    expect(addrs.slice(0, 3)).toEqual([XMR_A, XMR_A, XMR_A]);
    expect(addrs.slice(3).length).toBeGreaterThan(0);
    expect(addrs.slice(3).every((a) => a === XMR_B)).toBe(true);
  });

  it("a UTXO batch runs executeSwapChunk per chunk; an EVM batch runs shieldOnEvm, chunk after chunk, and completes", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    sim.usdc = 6_000_000_000n; // $6000: over the cap
    const sent = (tx: Hex) => async (o: ShieldOptions): Promise<ShieldResult> => {
      const progress: ShieldProgress = { bind: { chain: "base", asset: "base:usdc", amount: "x", receiver0zk: ZK_A }, costWei: "1", txs: [tx], inflight: { step: "approve", nonce: 1, txs: [tx], raw: "0x00", req: {} as never } };
      expect(await o.persist(progress)).toBe(true);
      return { status: "sent", tx, txs: [tx], progress };
    };
    shield.next.push(sent("0x01"));
    const r = await route(e, T0, { rng: half });
    expect(r.planned).toEqual({ "btc:btc": "execute", "base:usdc": "execute" });
    const usdc = (await batches()).find((b) => b.asset === "base:usdc")!;
    expect(usdc).toMatchObject({ status: "executing", destination: ZK_A, chunks: JSON.stringify(["3000000000", "3000000000"]) });
    expect(shield.calls).toEqual([{ chain: "base", asset: "base:usdc", amount: 3_000_000_000n }]);
    expect(JSON.parse((await batches()).find((b) => b.asset === "base:usdc")!.progress)[0].txs).toEqual(["0x01"]);
    expect(vi.mocked(swapMod.executeSwapChunk).mock.calls.map((c) => c[2])).toEqual([0, 1]);
    expect(vi.mocked(swapMod.executeSwapChunk).mock.calls.every((c) => c[1].id !== usdc.id)).toBe(true);
    // Next run: chunk 0 gets its stored progress back and becomes final; chunk 1 starts in the same run.
    const done = (h: Hex) => async (o: ShieldOptions): Promise<ShieldResult> => ({ status: "shielded", tx: h, txs: [h], progress: { ...o.progress!, inflight: undefined, done: h } });
    shield.next.push(done("0x02"), sent("0x03"));
    await route(e, T0 + 15 * MIN, { rng: half });
    expect(shield.calls[1]!.progress!.txs).toEqual(["0x01"]);
    expect(shield.calls[2]).toEqual({ chain: "base", asset: "base:usdc", amount: 3_000_000_000n });
    shield.next.push(done("0x04"));
    sim.usdc = 0n; // shielded: the hot wallet no longer holds it
    await route(e, T0 + 30 * MIN, { rng: half });
    expect(shield.calls).toHaveLength(4);
    expect((await batches()).find((b) => b.id === usdc.id)).toMatchObject({ status: "completed" });
    const [ev] = await events("routing.completed");
    expect(ev).toMatchObject({ id: `routing.completed:${usdc.id}`, invoice_id: usdc.id });
    expect(JSON.parse(ev!.payload)).toMatchObject({ batch: usdc.id, asset: "base:usdc", chunks: 2, shields: ["0x02", "0x04"] });
    // A completed batch is not shielded again.
    await route(e, T0 + 45 * MIN, { rng: half });
    expect(shield.calls).toHaveLength(4);
  });

  it("EVM: progress that changed under the router is never overwritten (persist is a compare-and-set)", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    const id = await insertBatch("base:usdc", [500n], { destination: ZK_A });
    shield.next.push(async (o) => {
      await e.DB.prepare("UPDATE route_batches SET progress=? WHERE id=?").bind(JSON.stringify([{ costWei: "9" }]), id).run();
      const p: ShieldProgress = { costWei: "1", txs: ["0x05"] };
      expect(await o.persist(p)).toBe(false);
      return { status: "skipped", reason: "the shield progress could not be recorded; nothing was broadcast", txs: [], progress: { costWei: "0" } };
    });
    await route(e, T0, { rng: half });
    expect(JSON.parse((await batches())[0]!.progress)).toEqual([{ costWei: "9" }]);
  });

  it("EVM: a failed step fails the batch (routing.failed); a stuck one raises routing.stuck once; a changed RAILGUN_0ZK_ADDRESS starts no new chunk", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    const failing = await insertBatch("base:usdc", [500n], { destination: ZK_A });
    shield.next.push(async () => ({ status: "failed", reason: "approve tx 0x9 reverted", txs: [], progress: { costWei: "0" } }));
    await route(e, T0, { rng: half });
    expect((await batches())[0]).toMatchObject({ id: failing, status: "failed", error: "chunk 0: approve tx 0x9 reverted" });
    expect(await events("routing.failed")).toHaveLength(1);

    const stuck = await insertBatch("base:usdc", [600n], { destination: ZK_A, progress: [{ costWei: "0", txs: ["0x7"], bind: { chain: "base", asset: "base:usdc", amount: "600", receiver0zk: ZK_A } }] });
    const wait = async (o: ShieldOptions): Promise<ShieldResult> => ({ status: "waiting", reason: "the approve tx is still unmined after 3 fee bumps (0x7)", txs: ["0x7"], progress: o.progress! });
    shield.next.push(wait, wait);
    await route(e, T0 + MIN, { rng: half });
    await route(e, T0 + 2 * MIN, { rng: half });
    expect((await batches()).find((b) => b.id === stuck)).toMatchObject({ status: "executing", stuck_at: T0 + MIN });
    expect((await events("routing.stuck")).map((x) => x.id)).toEqual([`routing.stuck:${stuck}`]);

    await e.DB.prepare("UPDATE route_batches SET status='resolved' WHERE id=?").bind(stuck).run();
    const fresh = await insertBatch("base:usdc", [700n], { destination: ZK_A });
    e.RAILGUN_0ZK_ADDRESS = ZK_B;
    const before = shield.calls.length;
    await route(e, T0 + 3 * MIN, { rng: half });
    expect(shield.calls).toHaveLength(before);
    expect((await batches()).find((b) => b.id === fresh)).toMatchObject({ status: "executing", stuck_at: T0 + 3 * MIN });
  });

  it("a batch that throws is logged by name and the others go on", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const bad = await insertBatch("btc:btc", [1_000n]);
    await e.DB.prepare("UPDATE route_batches SET destination='4notanaddress', created_at=? WHERE id=?").bind(T0 - HOUR, bad).run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await route(e, T0, { rng: half });
    expect(r.errors).toEqual([`batch ${bad}: InvalidXmrAddress`]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("InvalidXmrAddress") && !String(c[0]).includes("4notanaddress"))).toBe(true);
    warn.mockRestore();
    expect(sim.tradeCalls).toHaveLength(2);
  });

  it("polls swap batches with legs in flight: all finished -> completed + routing.completed", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    await route(e, T0, { rng: half });
    for (const k of Object.keys(sim.trades)) sim.trades[k] = "finished";
    const r = await route(e, T0 + 15 * MIN, { rng: half });
    const [b] = await batches();
    expect(r.polled).toEqual([b!.id]);
    expect(b!.status).toBe("completed");
    expect(await events("routing.completed")).toHaveLength(1);
    // routed_at: set for the UTXO payments the legs spent.
    const { results } = await e.DB.prepare("SELECT routed_at FROM payments").all<{ routed_at: number | null }>();
    expect(results.every((p) => p.routed_at === T0)).toBe(true);
  });
});

describe("routing events reach the queue after commit", () => {
  const enqueued = async (type: string) => (await e.DB.prepare("SELECT enqueued_at FROM events WHERE type=?").bind(type).all<{ enqueued_at: number | null }>()).results;
  it("routing events of a run are enqueued at its end, not left for the requeue cron", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    await route(e, T0, { rng: half });
    for (const k of Object.keys(sim.trades)) sim.trades[k] = "finished";
    await route(e, T0 + 15 * MIN, { rng: half });
    const rows = await enqueued("routing.completed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enqueued_at).not.toBeNull();
  });
  it("sweep.insufficient_gas alert events are enqueued by the sweep run that raised them", async () => {
    await recordAlert(e.DB, "sweep.insufficient_gas", "tron", "x", T0);
    const { runSweeps } = await import("../../src/sweep/cron");
    await runSweeps(e, T0);
    expect((await enqueued("sweep.insufficient_gas"))[0]!.enqueued_at).not.toBeNull();
  });
});

describe("routing webhooks", () => {
  const URL_ = "https://merchant.test/hook";
  const deliver = async (ids: string[]) => {
    const bodies: { body: string; sig: string | null }[] = [];
    network.use(
      http.post(URL_, async ({ request }) => {
        bodies.push({ body: await request.text(), sig: request.headers.get("0crypto-signature") });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const batch = createMessageBatch<WebhookJob>("0crypto-webhooks", ids.map((id, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body: { eventId: id } })));
    await handleWebhookBatch(batch, { ...e, WEBHOOK_URL: URL_, WEBHOOK_SECRET: "whsec_test" });
    return bodies;
  };

  it("routing.* and sweep.insufficient_gas are delivered, signed, and carry no customer data", async () => {
    const p1 = await btcPayment(20, 4_000_000);
    const p2 = await btcPayment(21, 2_000_000);
    await route(e, T0, { rng: half });
    for (const k of Object.keys(sim.trades)) sim.trades[k] = "finished";
    await route(e, T0 + 15 * MIN, { rng: half });
    await recordAlert(e.DB, "sweep.insufficient_gas", "tron", "the Tron hot wallet THot... holds 1 sun", T0);
    await recordAlert(e.DB, "sweep.insufficient_gas", "tron", "deduped: no second alert, no second event", T0 + 1);
    const [done] = await events("routing.completed");
    const gas = await events("sweep.insufficient_gas");
    expect(gas).toHaveLength(1);
    const [b] = await batches();
    const legs = parseLegs(b!.legs);
    const out = await deliver([done!.id, gas[0]!.id]);
    expect(out).toHaveLength(2);
    for (const o of out) {
      const t = Number(/t=(\d+)/.exec(o.sig!)![1]);
      expect(await verifyWebhook("whsec_test", o.sig, o.body, t)).toBe(true);
      for (const secret of [XMR_A, "inv_r", "order-42", "customer@example.com", p1.id, p2.id, p1.address, p2.address, BTC_DEP, ...legs.map((l) => l.refundAddress!)]) expect(o.body).not.toContain(secret);
    }
    const body = JSON.parse(out[0]!.body);
    expect(body).toMatchObject({ id: done!.id, type: "routing.completed", data: { object: "route_batch", id: b!.id, asset: "btc:btc", total: b!.total, chunk_count: 2, status: "completed" } });
    expect(body.data.trade_ids).toEqual(["TRADE1", "TRADE2"]);
    expect(body.data.txids).toEqual(legs.map((l) => l.tx));
    expect(body.data.legs[0]).toMatchObject({ chunk: 0, step: "finished", trade_id: "TRADE1", provider: "ProviderA", payout_txid: "ab".repeat(32) });
    expect(JSON.parse(out[1]!.body)).toMatchObject({ type: "sweep.insufficient_gas", data: { object: "alert", kind: "sweep.insufficient_gas", chain: "tron" } });
    expect(out[1]!.body).not.toContain("THot");
  });
});

// ---- final fix wave ----------------------------------------------------------------------------------------------------

const DAY = 24 * HOUR;
/** A confirmed BTC payment with no outputs at its address (its funds were never there, or left long ago). */
async function emptyPayment(index: number, confirmedAt: number, o: { address?: string; status?: PaymentRow["status"] } = {}): Promise<PaymentRow> {
  const p: PaymentRow = {
    id: `pay_r${seq++}`, invoice_id: "inv_r", asset: "btc:btc", chain: "btc", address: o.address ?? btcAddr(index), derivation_index: index, reference: null, expected: 1n, price_e8: 10n ** 13n,
    rate_locked_until: 0, received: 1n, final: 1n, txids: [], status: o.status ?? "confirmed", created_at: confirmedAt, detected_at: confirmedAt, confirmed_at: confirmedAt,
    credited_minor: 1n, credit_price_e8: 10n ** 13n, unexpected: null,
  };
  await insertPayment(e.DB, p);
  return p;
}
const alertsOf = async (kind: string) => (await e.DB.prepare("SELECT chain, detail FROM alerts WHERE kind=? ORDER BY created_at, id").bind(kind).all<{ chain: string | null; detail: string }>()).results;
const payRow = (id: string) => e.DB.prepare("SELECT routed_at, route_note, route_checked_at FROM payments WHERE id=?").bind(id).first<{ routed_at: number | null; route_note: string | null; route_checked_at: number | null }>();

describe("UTXO payment sources: a rotating cursor, retirement (I1)", () => {
  it("50 empty old payments do not block a new funded one within ceil(total / N) runs; they are retired only after a second empty read 24 h later, audited and alerted", async () => {
    const { PAYMENT_CHECKS_PER_RUN } = await import("../../src/routing/config");
    const { routableInputs } = await import("../../src/routing/swap");
    const old: PaymentRow[] = [];
    for (let i = 0; i < 50; i++) old.push(await emptyPayment(100 + i, T0 - 8 * DAY + i));
    const fresh = await btcPayment(200, 500_000);
    const runs = Math.ceil(51 / PAYMENT_CHECKS_PER_RUN);
    let foundAt = -1;
    for (let k = 1; k <= runs && foundAt < 0; k++) if ((await routableInputs(e, "btc", { now: T0 + k * MIN })).flat().some((i) => i.paymentId === fresh.id)) foundAt = k;
    expect(foundAt).toBeGreaterThan(0);
    expect(foundAt).toBeLessThanOrEqual(runs);
    // One empty read each: none retired yet.
    for (const p of old) expect(await payRow(p.id)).toMatchObject({ routed_at: null, route_note: null });
    for (let k = 1; k <= runs; k++) await routableInputs(e, "btc", { now: T0 + 25 * HOUR + k * MIN });
    for (const p of old) expect(await payRow(p.id)).toMatchObject({ routed_at: expect.any(Number), route_note: expect.stringMatching(/^retired: the deposit held no output/) });
    const audits = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions WHERE action='source_retire'").first<{ n: number }>())!.n;
    expect(await audits()).toBe(50);
    const retiredAlerts = await alertsOf("routing.source_retired");
    expect(retiredAlerts).toHaveLength(1);
    expect(retiredAlerts[0]).toMatchObject({ chain: "btc", detail: expect.stringMatching(/^\d+ btc payment source\(s\) retired/) });
    // Idempotent: they are out of the cursor for good; nothing more is retired or audited.
    await routableInputs(e, "btc", { now: T0 + 26 * HOUR });
    expect(await audits()).toBe(50);
    expect(await payRow(fresh.id)).toMatchObject({ routed_at: null, route_note: null });
  });

  it("an empty source is retired only after a second empty read at least 24 h after the first", async () => {
    const { routableInputs } = await import("../../src/routing/swap");
    const p = await emptyPayment(100, T0 - 8 * DAY);
    await routableInputs(e, "btc", { now: T0 });
    expect(await payRow(p.id)).toMatchObject({ routed_at: null });
    expect((await e.DB.prepare("SELECT route_empty_at FROM payments WHERE id=?").bind(p.id).first<{ route_empty_at: number }>())!.route_empty_at).toBe(T0);
    await routableInputs(e, "btc", { now: T0 + 23 * HOUR });
    expect(await payRow(p.id)).toMatchObject({ routed_at: null });
    // Funds arrived meanwhile, then left again: the empty streak starts over.
    sim.utxos[p.address] = [{ txid: "cd".repeat(32), vout: 0, value: 1000, confirmed: true }];
    await routableInputs(e, "btc", { now: T0 + 24 * HOUR });
    expect((await e.DB.prepare("SELECT route_empty_at FROM payments WHERE id=?").bind(p.id).first<{ route_empty_at: number | null }>())!.route_empty_at).toBeNull();
    sim.utxos[p.address] = [];
    await routableInputs(e, "btc", { now: T0 + 25 * HOUR });
    await routableInputs(e, "btc", { now: T0 + 48 * HOUR });
    expect(await payRow(p.id)).toMatchObject({ routed_at: null });
    await routableInputs(e, "btc", { now: T0 + 49 * HOUR });
    expect(await payRow(p.id)).toMatchObject({ routed_at: T0 + 49 * HOUR, route_note: expect.stringMatching(/retired/) });
    expect(await alertsOf("routing.source_retired")).toHaveLength(1);
  });

  it("an empty source that became due less than 7 days ago, or holds an unconfirmed output, is not retired", async () => {
    const { routableInputs } = await import("../../src/routing/swap");
    const recent = await emptyPayment(100, T0 - 6 * DAY);
    const pending = await emptyPayment(101, T0 - 8 * DAY);
    sim.utxos[pending.address] = [{ txid: "cd".repeat(32), vout: 0, value: 1000, confirmed: false }];
    for (const t of [T0, T0 + 25 * HOUR]) expect(await routableInputs(e, "btc", { now: t })).toEqual([]);
    expect(await payRow(recent.id)).toMatchObject({ routed_at: null, route_checked_at: T0 + 25 * HOUR });
    expect(await payRow(pending.id)).toMatchObject({ routed_at: null, route_checked_at: T0 + 25 * HOUR });
  });

  it("with an xpub set the chain's sources are excluded: never read, stamped or retired", async () => {
    const { routableInputs } = await import("../../src/routing/swap");
    const ours = await btcPayment(20, 400_000);
    const old = await emptyPayment(100, T0 - 30 * DAY);
    const watch = { ...e, BTC_XPUB: "xpub-watch-mode" } as Env;
    for (const t of [T0, T0 + 25 * HOUR, T0 + 50 * HOUR]) expect(await routableInputs(watch, "btc", { now: t })).toEqual([]);
    for (const t of [T0 + 51 * HOUR, T0 + 76 * HOUR]) await route(watch, t, { rng: half });
    expect(sim.requests).toEqual([]);
    for (const p of [ours, old]) expect(await payRow(p.id)).toMatchObject({ routed_at: null, route_note: null, route_checked_at: null });
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions").first()).toEqual({ n: 0 });
  });

  it("a deposit that does not derive from MASTER_SEED (a wrong seed) is skipped with an alert, never retired; with the right seed it is routable again", async () => {
    const { routableInputs } = await import("../../src/routing/swap");
    const p = await emptyPayment(0, T0 - 30 * DAY, { address: BTC_DEP }); // index 0 of OTHER
    sim.utxos[BTC_DEP] = [{ txid: "ef".repeat(32), vout: 0, value: 900_000, confirmed: true }];
    for (const t of [T0, T0 + HOUR, T0 + 25 * HOUR, T0 + 50 * HOUR]) expect(await routableInputs(e, "btc", { now: t })).toEqual([]);
    expect(await payRow(p.id)).toMatchObject({ routed_at: null, route_note: null, route_checked_at: T0 + 50 * HOUR });
    expect(sim.requests).toEqual([]); // not even read
    const a = await alertsOf("routing.config_error");
    expect(a).toHaveLength(3); // deduped within the alert window (6 h): T0 + 1 h added none
    expect(a[0]).toMatchObject({ chain: "btc", detail: expect.stringMatching(/payment address does not derive from MASTER_SEED/) });
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM routing_actions").first()).toEqual({ n: 0 });
    // The seed fixed: the same deposit is offered.
    const groups = await routableInputs({ ...e, MASTER_SEED: OTHER } as Env, "btc", { now: T0 + 51 * HOUR });
    expect(groups.flat().map((i) => i.paymentId)).toEqual([p.id]);
  });

  it("one routableInputs call per asset per run: each deposit is read once to plan, then once by its leg's pre-sign check", async () => {
    const p1 = await btcPayment(20, 4_000_000);
    const p2 = await btcPayment(21, 2_000_000);
    const reads: string[] = [];
    network.use(
      http.get(`${ESP}/address/:a/utxo`, ({ params }) => {
        reads.push(params.a as string);
        return undefined;
      }),
    );
    const r = await route(e, T0, { rng: half });
    expect(r.planned["btc:btc"]).toBe("execute");
    expect(sim.broadcasts).toHaveLength(2);
    expect(reads.filter((a) => a === p1.address)).toHaveLength(2);
    expect(reads.filter((a) => a === p2.address)).toHaveLength(2);
  });
});

describe("the router interleaves assets and rotates which goes first (I1)", () => {
  it("execute/poll happens for asset A even when planning asset B is slow (fake clock)", async () => {
    Object.assign(e, { ENABLED_ASSETS: "btc:btc,base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    let slow = false;
    network.use(
      http.post(BASE_RPC, () => {
        slow = true; // planning base:usdc reads its balance: from here the run is past its deadline
        return undefined;
      }),
    );
    // A: a BTC batch whose leg was paid and whose trade has finished (execute: nothing to send; poll: completes it).
    const a = await insertBatch("btc:btc", [500_000n], { legs: [leg(0, "sent", { tradeId: "TA", tx: "aa".repeat(32), sentAt: T0 })] });
    sim.trades.TA = "finished";
    // The previous run started with BTC (offset 0): this one starts one further.
    await e.DB.prepare("INSERT INTO router_lock(id,holder,expires_at,asset_offset) VALUES(1,NULL,0,1)").run();
    const { routingScope } = await import("../../src/routing/router");
    const n = routingScope(e).length; // BTC, LTC and the base assets: each run starts one further
    const reports: Awaited<ReturnType<typeof runRouter>>[] = [];
    for (let k = 0; k < n && !reports.some((r) => r.executed.includes(a)); k++) {
      slow = false;
      reports.push(await route(e, T0 + k * 15 * MIN, { rng: half, clock: () => (slow ? ROUTER_DEADLINE_MS : 0) }));
    }
    // Run 1 did not begin with BTC and ran out of time on a base asset; a later run began with BTC.
    expect(reports[0]).toMatchObject({ deadline: true, executed: [] });
    expect(reports.flatMap((r) => r.executed)).toContain(a);
    expect(reports.flatMap((r) => r.polled)).toContain(a);
    expect((await batches()).find((b) => b.id === a)).toMatchObject({ status: "completed" });
  });
});

describe("poll and execute windows (I3)", () => {
  it("250 failed or resolved batches don't stop a new executing batch from being polled and executed", async () => {
    const stmts = [];
    for (let i = 0; i < 250; i++)
      stmts.push(
        e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,'btc:btc','1','[\"1\"]',?,?,?,?,?,?)").bind(
          `rb_dead${String(i).padStart(3, "0")}`, XMR_A, T0 - DAY, i % 10 ? "failed" : "resolved", T0 - DAY, T0 - DAY,
          JSON.stringify([leg(0, i % 3 ? "failed" : "finished", { tradeId: `D${i}`, tx: "bb".repeat(32) })]),
        ),
      );
    await e.DB.batch(stmts);
    const fresh = await insertBatch("btc:btc", [500_000n], { legs: [leg(0, "sent", { tradeId: "TN", tx: "aa".repeat(32), sentAt: T0 })] });
    const r = await route(e, T0, { rng: half });
    expect(r.executed).toContain(fresh);
    expect(r.polled).toEqual([fresh]);
  });

  it("worn executing batches rotate: a new executing batch is executed within ceil(n / window) runs", async () => {
    const { EXECUTE_PER_ASSET } = await import("../../src/routing/config");
    const worn = [leg(0, "abandoned", { reason: "x" }), leg(0, "abandoned", { reason: "x" }), leg(0, "abandoned", { reason: "x" })];
    const n = EXECUTE_PER_ASSET * 3;
    for (let i = 0; i < n; i++) await insertBatch("btc:btc", [500_000n], { legs: worn });
    const fresh = await insertBatch("btc:btc", [500_000n], { legs: [leg(0, "sent", { tradeId: "TN", tx: "aa".repeat(32), sentAt: T0 })] });
    let at = -1;
    for (let k = 1; k <= Math.ceil((n + 1) / EXECUTE_PER_ASSET) && at < 0; k++) if ((await route(e, T0 + k * MIN, { rng: half })).executed.includes(fresh)) at = k;
    expect(at).toBeGreaterThan(0);
  });
});

describe("partial and expired UTXO payments are routed (I2)", () => {
  it("partial, and expired with funds, are routing sources once their invoice expired past the sweep window", async () => {
    const { routableInputs } = await import("../../src/routing/swap");
    await insertInvoice(e.DB, {
      id: "inv_gone", created_at: T0 - 9 * DAY, expires_at: T0 - 8 * DAY, price_minor: 600_000n, currency: "USD", order_id: null,
      metadata: null, success_url: null, allowed_assets: null, status: "partially_paid", late: false, overpaid: false, paid_minor: 1n,
    });
    const fund = async (p: PaymentRow, value: number) => {
      sim.utxos[p.address] = [{ txid: bytesToHex(sha256(new TextEncoder().encode(p.id))), vout: 0, value, confirmed: true }];
    };
    const early = await emptyPayment(30, T0 - HOUR, { status: "partial" }); // invoice inv_r: expired 0 days ago
    await fund(early, 100_000);
    const partial = await emptyPayment(31, T0 - 8 * DAY, { status: "partial" });
    await e.DB.prepare("UPDATE payments SET invoice_id='inv_gone', confirmed_at=NULL WHERE id=?").bind(partial.id).run();
    await fund(partial, 200_000);
    const expired = await emptyPayment(32, T0 - 8 * DAY, { status: "expired" });
    await e.DB.prepare("UPDATE payments SET invoice_id='inv_gone', confirmed_at=NULL, received='300000', final='0' WHERE id=?").bind(expired.id).run();
    await fund(expired, 300_000);
    const ids = (await routableInputs(e, "btc", { now: T0 })).flat().map((i) => i.paymentId);
    expect(ids.sort()).toEqual([partial.id, expired.id].sort());
  });
});

describe("the EVM hot wallet's nonce lease (I4)", () => {
  it("while a sweep holds the chain's lease the shield step waits (nothing called); it shields once the lease is free", async () => {
    const { acquireHotNonce, releaseHotNonce } = await import("../../src/db/noncelease");
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    const id = await insertBatch("base:usdc", [500n], { destination: ZK_A });
    expect(await acquireHotNonce(e.DB, "base", "sweep_x", T0)).toBe(true);
    await route(e, T0, { rng: half });
    expect(shield.calls).toHaveLength(0);
    expect((await batches()).find((b) => b.id === id)).toMatchObject({ status: "executing", progress: "[]" });
    await releaseHotNonce(e.DB, "base", "sweep_x");
    shield.next.push(async () => ({ status: "skipped", reason: "x", txs: [], progress: { costWei: "0" } }));
    await route(e, T0 + MIN, { rng: half });
    expect(shield.calls).toHaveLength(1);
    expect(await e.DB.prepare("SELECT holder FROM hot_nonce_lease WHERE chain='base'").first()).toEqual({ holder: null });
  });
});


describe("routing scope is wider than ENABLED_ASSETS (I6)", () => {
  it("a registry asset holding funds is routed although ENABLED_ASSETS leaves it out; detection-only assets never are", async () => {
    const { routedAssets } = await import("../../src/routing/router");
    e.ENABLED_ASSETS = "ltc:ltc";
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const r = await route(e, T0, { rng: half });
    expect(r.planned["btc:btc"]).toBe("execute");
    expect(sim.broadcasts).toHaveLength(2);
    const tron = { ...e, TRONGRID_API_KEY: "k", ENABLED_ASSETS: "tron:usdt" } as Env;
    expect(routedAssets(tron).map((a) => a.id)).toContain("tron:usdt");
    expect(routedAssets(tron).some((a) => a.detectionOnly)).toBe(false);
  });

  it("in-flight batches are executed and polled whatever ENABLED_ASSETS says", async () => {
    e.ENABLED_ASSETS = "ltc:ltc";
    const a = await insertBatch("btc:btc", [500_000n], { legs: [leg(0, "sent", { tradeId: "TA", tx: "aa".repeat(32), sentAt: T0 })] });
    sim.trades.TA = "finished";
    const r = await route(e, T0, { rng: half });
    expect(r.executed).toEqual([a]);
    expect(r.polled).toEqual([a]);
    expect((await batches())[0]).toMatchObject({ status: "completed" });
  });

  it("EVM registry tokens swept as unexpected deposits (not enabled) are shielded too", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "1", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    await price("DAI", 1n);
    sim.dai = 6_000n * 10n ** 18n; // $6000 of DAI in the hot wallet: over the cap
    shield.next.push(async () => ({ status: "skipped", reason: "x", txs: [], progress: { costWei: "0" } }));
    const r = await route(e, T0, { rng: half });
    expect(r.planned["base:dai"]).toBe("execute");
    expect(shield.calls.map((c) => c.asset)).toEqual(["base:dai"]);
    expect((await batches()).map((b) => [b.asset, b.destination])).toEqual([["base:dai", ZK_A]]);
  });
});

describe("routing.over_cap (I5)", () => {
  it("raised once per asset when what it holds is worth HOT_CAP_USD or more and a gate is off; not below the cap; not when routing is not set up", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    sim.usdc = 6_000_000_000n; // $6000 in the hot wallet
    await route(e, T0, { rng: half });
    await route(e, T0 + 15 * MIN, { rng: half });
    const a = await alertsOf("routing.over_cap");
    expect(a).toHaveLength(1);
    expect(a[0]!.chain).toBe("base:usdc");
    expect(a[0]!.detail).toMatch(/RAILGUN_GOLDEN_OK/);
    expect(a[0]!.detail).toMatch(/per asset per chain/);
    expect(shield.calls).toHaveLength(0);
    expect(await batches()).toEqual([]);
    await e.DB.prepare("DELETE FROM alerts").run();
    // No destination configured: routing is not set up, so there is no cap and nothing is read.
    const before = sim.requests.length;
    await route({ ...e, RAILGUN_0ZK_ADDRESS: "" } as Env, T0 + 30 * MIN, { rng: half });
    expect(sim.requests.length).toBe(before);
    expect(await alertsOf("routing.over_cap")).toEqual([]);
    // A config error (an invalid destination) is a reason too.
    await route({ ...e, RAILGUN_GOLDEN_OK: "1", RAILGUN_0ZK_ADDRESS: "0zk1nope" } as Env, T0 + 45 * MIN, { rng: half });
    expect((await alertsOf("routing.over_cap"))[0]!.detail).toMatch(/RAILGUN_0ZK_ADDRESS/);
  });

  it("below the cap: no alert", async () => {
    Object.assign(e, { ENABLED_ASSETS: "base:usdc", EVM_RPC_BASE: BASE_RPC, RAILGUN_GOLDEN_OK: "", RAILGUN_GOLDEN_OK_CHAINS: "base", RAILGUN_0ZK_ADDRESS: ZK_A });
    sim.usdc = 300_000_000n; // $300
    await route(e, T0, { rng: half });
    expect(await alertsOf("routing.over_cap")).toEqual([]);
  });

  it("no price: raised (the value cannot be checked against the cap)", async () => {
    await btcPayment(20, 4_000_000);
    await dropPrice(e, "USD", "BTC");
    network.use(http.get("https://api.kraken.com/*", () => new HttpResponse(null, { status: 500 })));
    expect((await route(e, T0, { rng: half })).planned["btc:btc"]).toBe("wait: no price");
    expect((await alertsOf("routing.over_cap"))[0]!.detail).toMatch(/no USD price/);
  });

  it("a worn batch holding the funds: raised", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const worn = [leg(0, "abandoned", { reason: "x" }), leg(0, "abandoned", { reason: "x" }), leg(0, "abandoned", { reason: "x" })];
    await insertBatch("btc:btc", [6_000_000n], { legs: worn });
    const r = await route(e, T0, { rng: half });
    expect(r.planned["btc:btc"]).toBe("wait");
    expect((await alertsOf("routing.over_cap"))[0]!.detail).toMatch(/worn|stuck/);
  });

  it("below the Trocador minimum while over the cap: raised", async () => {
    await btcPayment(20, 40_000); // $40, the minimum is 0.0005 BTC
    await route({ ...e, HOT_CAP_USD: "1", ROUTE_MIN_BATCH_USD: "0" } as Env, T0, { rng: half });
    expect((await alertsOf("routing.over_cap"))[0]!.detail).toMatch(/minimum/);
  });

  it("a RouteConfigError raises routing.config_error (deduped) and nothing is planned", async () => {
    await btcPayment(20, 4_000_000);
    const bad = { ...e, HOT_CAP_USD: "lots" } as Env;
    expect((await route(bad, T0, { rng: half })).planned).toEqual({});
    await route(bad, T0 + 15 * MIN, { rng: half });
    const a = await alertsOf("routing.config_error");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatch(/HOT_CAP_USD/);
    expect(a[0]!.detail).not.toContain("lots");
    expect(await batches()).toEqual([]);
  });
});

describe("minor fixes", () => {
  it("holdsRouterLock judges expiry at the current time: a run that outlived its lease notices, though its `now` never moved", async () => {
    const { holdsRouterLock } = await import("../../src/routing/router");
    const started = Date.now() - ROUTER_LOCK_TTL_MS - 1_000; // the run began longer ago than the lease lasts
    expect(await acquireRouterLock(e.DB, "slow-run", started)).toBe(true);
    expect(await holdsRouterLock(e.DB, "slow-run", started)).toBe(false);
    await releaseRouterLock(e.DB, "slow-run");
  });

  it("an exception in one chunk does not skip the batch's later chunks", async () => {
    await btcPayment(20, 4_000_000);
    await btcPayment(21, 2_000_000);
    const id = await insertBatch("btc:btc", [3_000_000n, 1_900_000n]);
    vi.mocked(swapMod.executeSwapChunk).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await route(e, T0, { rng: half });
    warn.mockRestore();
    expect(r.errors).toContain(`batch ${id}: Error`);
    expect(vi.mocked(swapMod.executeSwapChunk).mock.calls.filter((c) => c[1].id === id).map((c) => c[2])).toEqual([0, 1]);
    expect(parseLegs((await batches()).find((b) => b.id === id)!.legs).map((l) => l.chunk)).toEqual([1]);
  });
});
