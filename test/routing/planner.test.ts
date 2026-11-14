import { describe, expect, it } from "vitest";
import { ASSETS } from "../../src/core/assets";
import { defaultRng, planBatch, routeCfg, type RouteCfg } from "../../src/routing/planner";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USD = (n: number) => BigInt(n) * 100n;
const H = 3_600_000;
const cfg: RouteCfg = { minBatchUsdMinor: USD(200), delayMinH: 2, delayMaxH: 24, hotCapUsdMinor: USD(5000), maxChunks: 3, avoidPct: 2 };
const asset = ASSETS["eth:usdc"]!; // 6 decimals
const PRICE = 100_000_000n; // $1.00 per coin => atomic/1e6 USD
const usdc = (usd: number) => BigInt(usd) * 1_000_000n; // atomic for $usd
const base = { asset, priceE8: PRICE, now: 1_000_000, cfg, minimum: 0n, paymentAmounts: [] as bigint[] };

describe("planBatch decision order", () => {
  it("waits when value is below minBatch", () => {
    expect(planBatch({ ...base, available: usdc(150), rng: mulberry32(42) })).toEqual({ action: "wait" });
  });
  it("waits when available is below the provider minimum, even above the hot cap", () => {
    expect(planBatch({ ...base, available: usdc(300), minimum: usdc(301), rng: mulberry32(42) })).toEqual({ action: "wait" });
    expect(planBatch({ ...base, available: usdc(6000), minimum: usdc(6001), rng: mulberry32(42) })).toEqual({ action: "wait" });
  });
  it("available exactly equal to minimum is not below it", () => {
    const r = planBatch({ ...base, available: usdc(6000), minimum: usdc(6000), rng: mulberry32(42) });
    expect(r).toMatchObject({ action: "execute", chunks: [usdc(6000)] });
  });
  it("schedules within [now+delayMin, now+delayMax] hours when above minBatch with no due time", () => {
    for (const rv of [0, 0.5, 0.999999]) {
      const r = planBatch({ ...base, available: usdc(300), rng: () => rv });
      expect(r.action).toBe("schedule");
      if (r.action === "schedule") {
        expect(r.dueAt).toBeGreaterThanOrEqual(base.now + 2 * H);
        expect(r.dueAt).toBeLessThanOrEqual(base.now + 24 * H);
        expect(Number.isInteger(r.dueAt)).toBe(true);
      }
    }
    expect(planBatch({ ...base, available: usdc(300), rng: () => 0 })).toEqual({ action: "schedule", dueAt: base.now + 2 * H });
  });
  it("value exactly equal to minBatch is not below it", () => {
    expect(planBatch({ ...base, available: usdc(200), rng: () => 0 }).action).toBe("schedule");
    expect(planBatch({ ...base, available: usdc(200) - 1n, rng: () => 0 }).action).toBe("wait");
  });
  it("executes at the hot cap regardless of due time, and at exactly the cap", () => {
    expect(planBatch({ ...base, available: usdc(6000), rng: mulberry32(42) }).action).toBe("execute");
    expect(planBatch({ ...base, available: usdc(5000), rng: mulberry32(42) }).action).toBe("execute");
    expect(planBatch({ ...base, available: usdc(5000) - 1_000_000n, rng: mulberry32(42) }).action).toBe("schedule");
  });
  it("waits before dueAt, executes at exactly dueAt and after", () => {
    const due = base.now + 5 * H;
    expect(planBatch({ ...base, available: usdc(300), existingDueAt: due, now: due - 1, rng: mulberry32(42) })).toEqual({ action: "wait" });
    expect(planBatch({ ...base, available: usdc(300), existingDueAt: due, now: due, rng: mulberry32(42) }).action).toBe("execute");
    expect(planBatch({ ...base, available: usdc(300), existingDueAt: due, now: due + 1, rng: mulberry32(42) }).action).toBe("execute");
  });
  it("a due batch whose value fell below minBatch still waits", () => {
    expect(planBatch({ ...base, available: usdc(150), existingDueAt: base.now - 1, rng: mulberry32(42) })).toEqual({ action: "wait" });
  });
  it("execute splits $300 with no chunk within 2% of $100/$200 payments", () => {
    const pays = [usdc(100), usdc(200)];
    for (let seed = 1; seed <= 50; seed++) {
      const r = planBatch({ ...base, available: usdc(300), paymentAmounts: pays, existingDueAt: 0, now: 1, rng: mulberry32(seed) });
      expect(r.action).toBe("execute");
      if (r.action !== "execute") continue;
      expect(r.chunks.reduce((a, b) => a + b, 0n)).toBe(usdc(300));
      if (r.chunks.length > 1) for (const c of r.chunks) for (const p of pays) expect(c > p ? c - p : p - c).toSatisfy((d: bigint) => d * 100n > 2n * p);
    }
  });
  it("falls back to a single chunk when no split can avoid the payments", () => {
    const r = planBatch({ ...base, available: usdc(300), paymentAmounts: [usdc(100)], existingDueAt: 0, now: 1, rng: () => 0.99 }); // always 3 equal chunks of $100
    expect(r).toEqual({ action: "execute", chunks: [usdc(300)] });
  });
  it("limits chunk count so every chunk can meet the minimum", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = planBatch({ ...base, available: usdc(300), minimum: usdc(200), existingDueAt: 0, now: 1, rng: mulberry32(seed) });
      expect(r).toEqual({ action: "execute", chunks: [usdc(300)] });
    }
  });
});

describe("planBatch inputs", () => {
  it("throws on negative inputs", () => {
    const ok = { ...base, available: usdc(300), rng: mulberry32(42) };
    expect(() => planBatch({ ...ok, available: -1n })).toThrow();
    expect(() => planBatch({ ...ok, minimum: -1n })).toThrow();
    expect(() => planBatch({ ...ok, priceE8: -1n })).toThrow();
    expect(() => planBatch({ ...ok, paymentAmounts: [-1n] })).toThrow();
  });
});

describe("planBatch property", () => {
  it("1000 random inputs: exact sums, minimum respected, 1-3 chunks, none near a payment when split, never throws", () => {
    const rnd = mulberry32(7);
    const big = (max: bigint) => BigInt(Math.floor(rnd() * Number(max))) ;
    for (let i = 0; i < 1000; i++) {
      const decimals = [6, 8, 18][Math.floor(rnd() * 3)]!;
      const unit = 10n ** BigInt(decimals);
      const a = { ...asset, decimals };
      const priceE8 = 1n + big(100_000n * 100_000_000n);
      const available = big(1_000_000n) * unit / 100n + big(1000n);
      const minimum = rnd() < 0.3 ? 0n : big(available / 2n + 1n);
      const paymentAmounts = Array.from({ length: Math.floor(rnd() * 5) }, () => 1n + big(available + 1n));
      const r = planBatch({ asset: a, available, paymentAmounts, priceE8, existingDueAt: 0, now: 1, cfg: { ...cfg, minBatchUsdMinor: 0n }, minimum, rng: mulberry32(i + 1) });
      if (r.action !== "execute") { expect(available < minimum || available === 0n || r.action === "wait").toBe(true); continue; }
      expect(r.chunks.reduce((s, c) => s + c, 0n)).toBe(available);
      expect(r.chunks.length).toBeGreaterThanOrEqual(1);
      expect(r.chunks.length).toBeLessThanOrEqual(3);
      for (const c of r.chunks) expect(c > 0n).toBe(true);
      if (r.chunks.length > 1) {
        for (const c of r.chunks) {
          expect(c >= minimum).toBe(true);
          for (const p of paymentAmounts) expect((c > p ? c - p : p - c) * 100n > 2n * p).toBe(true);
        }
      }
    }
  });
});

describe("routeCfg", () => {
  it("applies defaults", () => {
    expect(routeCfg({})).toEqual({ minBatchUsdMinor: 20_000n, delayMinH: 2, delayMaxH: 24, hotCapUsdMinor: 500_000n, maxChunks: 3, avoidPct: 2 });
  });
  it("reads decimals", () => {
    const c = routeCfg({ ROUTE_MIN_BATCH_USD: "12.5", ROUTE_DELAY_MIN_H: "0.5", ROUTE_DELAY_MAX_H: "1.5", HOT_CAP_USD: "100" });
    expect(c).toMatchObject({ minBatchUsdMinor: 1250n, delayMinH: 0.5, delayMaxH: 1.5, hotCapUsdMinor: 10_000n });
  });
  it.each([
    [{ ROUTE_MIN_BATCH_USD: "-1" }, "ROUTE_MIN_BATCH_USD"],
    [{ ROUTE_MIN_BATCH_USD: "abc" }, "ROUTE_MIN_BATCH_USD"],
    [{ ROUTE_DELAY_MIN_H: "-3" }, "ROUTE_DELAY_MIN_H"],
    [{ ROUTE_DELAY_MAX_H: "x9" }, "ROUTE_DELAY_MAX_H"],
    [{ HOT_CAP_USD: "1e3" }, "HOT_CAP_USD"],
    [{ ROUTE_DELAY_MIN_H: "30" }, "ROUTE_DELAY_MIN_H"],
    [{ ROUTE_MIN_BATCH_USD: "6000" }, "ROUTE_MIN_BATCH_USD"],
  ])("rejects %j naming the var but not the value", (env, name) => {
    let msg = "";
    try { routeCfg(env); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(name);
    for (const v of Object.values(env)) expect(msg).not.toContain(v);
  });
});

describe("defaultRng", () => {
  it("returns values in [0,1)", () => {
    for (let i = 0; i < 100; i++) { const v = defaultRng(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
