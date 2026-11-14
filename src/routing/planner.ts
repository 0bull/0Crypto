import { fiatMinorFromAtomic } from "../core/money";
import type { AssetInfo } from "../core/types";
import type { Env } from "../env";

/** Batch-routing knobs. Money is USD minor units (bigint); delays are hours. */
export type RouteCfg = { minBatchUsdMinor: bigint; delayMinH: number; delayMaxH: number; hotCapUsdMinor: bigint; maxChunks: 3; avoidPct: 2 };

export class RouteConfigError extends Error {
  constructor(varName: string, problem: string) {
    super(`${varName} ${problem}`); // names the var, never its value
    this.name = "RouteConfigError";
  }
}

type RouteEnv = Partial<Pick<Env, "ROUTE_MIN_BATCH_USD" | "ROUTE_DELAY_MIN_H" | "ROUTE_DELAY_MAX_H" | "HOT_CAP_USD">>;

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

/** Non-negative decimal USD (at most 2 places) to minor units, integer-only. */
function usdMinor(name: string, raw: string | undefined, dflt: string): bigint {
  const s = blank(raw) ? dflt : raw!.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RouteConfigError(name, "must be a non-negative decimal USD amount with at most 2 places");
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

function hours(name: string, raw: string | undefined, dflt: string): number {
  const s = blank(raw) ? dflt : raw!.trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) throw new RouteConfigError(name, "must be a non-negative decimal number of hours");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new RouteConfigError(name, "must be a non-negative decimal number of hours");
  return n;
}

export function routeCfg(env: RouteEnv): RouteCfg {
  const minBatchUsdMinor = usdMinor("ROUTE_MIN_BATCH_USD", env.ROUTE_MIN_BATCH_USD, "200");
  const delayMinH = hours("ROUTE_DELAY_MIN_H", env.ROUTE_DELAY_MIN_H, "2");
  const delayMaxH = hours("ROUTE_DELAY_MAX_H", env.ROUTE_DELAY_MAX_H, "24");
  const hotCapUsdMinor = usdMinor("HOT_CAP_USD", env.HOT_CAP_USD, "5000");
  if (delayMinH > delayMaxH) throw new RouteConfigError("ROUTE_DELAY_MIN_H", "must not exceed ROUTE_DELAY_MAX_H");
  if (minBatchUsdMinor > hotCapUsdMinor) throw new RouteConfigError("ROUTE_MIN_BATCH_USD", "must not exceed HOT_CAP_USD");
  return { minBatchUsdMinor, delayMinH, delayMaxH, hotCapUsdMinor, maxChunks: 3, avoidPct: 2 };
}

/** Production randomness, uniform in [0, 1). Tests inject a seeded rng instead. */
export const defaultRng = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

export type PlanInput = {
  asset: AssetInfo;
  available: bigint;
  paymentAmounts: bigint[];
  priceE8: bigint;
  existingDueAt?: number;
  now: number;
  cfg: RouteCfg;
  minimum: bigint;
  rng: () => number;
};
export type Plan = { action: "wait" } | { action: "schedule"; dueAt: number } | { action: "execute"; chunks: bigint[] };

const HOUR_MS = 3_600_000;
const MAX_TRIES = 20;

/** True when `chunk` is within +-pct% of `payment`, integer only: |chunk - p| * 100 <= pct * p. */
function near(chunk: bigint, payment: bigint, pct: number): boolean {
  const d = chunk > payment ? chunk - payment : payment - chunk;
  return d * 100n <= BigInt(pct) * payment;
}

/** One candidate split into k chunks. rng floats become integer weights at once; the remainder goes to the last chunk. */
function split(available: bigint, k: number, rng: () => number): bigint[] {
  if (k === 1) return [available];
  const w = Array.from({ length: k }, () => BigInt(Math.floor((0.2 + 0.6 * rng()) * 1e6)));
  const total = w.reduce((a, b) => a + b, 0n);
  const chunks = w.slice(0, k - 1).map((wi) => (available * wi) / total);
  chunks.push(available - chunks.reduce((a, b) => a + b, 0n));
  return chunks;
}

/**
 * Decides whether to wait, schedule a delayed batch, or execute now, and how to chunk the amount.
 *
 * Accepted residual: if no split in MAX_TRIES avoids every payment amount (or the minimum allows only one chunk),
 * the whole balance goes out as one chunk, and that chunk may itself be within 2% of a payment. A batch holding one
 * payment of exactly the whole balance cannot be disguised by amount; only the delay helps there.
 */
export function planBatch(i: PlanInput): Plan {
  const { available, minimum, cfg } = i;
  if (available < 0n || minimum < 0n || i.priceE8 < 0n || i.paymentAmounts.some((p) => p < 0n)) throw new RangeError("planBatch: negative input");
  if (available === 0n || available < minimum) return { action: "wait" }; // even above the hot cap: only an alert helps
  const value = fiatMinorFromAtomic(available, i.asset.decimals, i.priceE8);
  if (value >= cfg.hotCapUsdMinor) return { action: "execute", chunks: chunk(i) };
  if (value < cfg.minBatchUsdMinor) return { action: "wait" };
  if (i.existingDueAt === undefined) {
    const hrs = cfg.delayMinH + i.rng() * (cfg.delayMaxH - cfg.delayMinH);
    return { action: "schedule", dueAt: i.now + Math.floor(hrs * HOUR_MS) };
  }
  if (i.now >= i.existingDueAt) return { action: "execute", chunks: chunk(i) };
  return { action: "wait" };
}

function chunk(i: PlanInput): bigint[] {
  const { available, minimum, cfg } = i;
  const kCap = minimum === 0n ? cfg.maxChunks : Number(available / minimum > BigInt(cfg.maxChunks) ? BigInt(cfg.maxChunks) : available / minimum);
  const maxK = Math.max(1, kCap);
  for (let t = 0; t < MAX_TRIES; t++) {
    const k = Math.min(1 + Math.floor(i.rng() * cfg.maxChunks), maxK);
    const chunks = split(available, k, i.rng);
    if (chunks.every((c) => c > 0n && c >= minimum && !i.paymentAmounts.some((p) => near(c, p, cfg.avoidPct)))) return chunks;
  }
  return [available];
}
