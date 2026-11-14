import { enabledAssets } from "../config";
import type { Env } from "../env";
import { fetchCoinGecko } from "./coingecko";
import { CURRENCIES, fetchKraken, type Currency } from "./kraken";

export const PRICE_MAX_AGE_MS = 300_000;

export class PriceUnavailable extends Error {
  constructor(
    public readonly symbol: string,
    public readonly currency: string,
  ) {
    super(`price unavailable: ${symbol}/${currency}`);
    this.name = "PriceUnavailable";
  }
}

/** The one KV key holding every cached price: `Record<"CUR:SYMBOL", { e8: string; at: number }>` as JSON. */
export const PRICES_KEY = "prices";

type PriceRecord = Record<string, { e8: string; at: number }>;

async function readRecord(env: Env): Promise<PriceRecord> {
  const raw = await env.KV.get(PRICES_KEY);
  if (!raw) return {};
  try {
    const rec = JSON.parse(raw) as unknown;
    return rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as PriceRecord) : {};
  } catch {
    return {};
  }
}

/**
 * True while an unexpired invoice can still be paid; the minute cron refreshes prices only then. An open or partially
 * paid invoice past its expiry (abandoned, or awaiting a late payment) does not count: a late credit refreshes inline.
 */
export async function hasOpenInvoices(db: D1Database, now = Date.now()): Promise<boolean> {
  const sql = "SELECT 1 FROM invoices WHERE status IN ('open','partially_paid') AND expires_at > ? LIMIT 1";
  return (await db.prepare(sql).bind(now).first()) !== null;
}

/**
 * Fetches and caches prices for `symbols`, by default the price symbols of the enabled assets (so a
 * stablecoin is priced only once one is enabled). Merges what it fetched into the cached record (each entry keeps
 * its own `at`) and writes it once. Returns what it fetched, keyed "CUR:SYMBOL".
 */
export async function refreshPrices(env: Env, symbols?: string[]): Promise<Map<string, bigint>> {
  const wanted = symbols ?? [...new Set(enabledAssets(env).map((a) => a.priceSymbol))];
  if (wanted.length === 0) return new Map();
  const prices = await fetchKraken(wanted);
  if (env.COINGECKO_KEY) {
    const missing = new Set<string>();
    for (const s of wanted) for (const c of CURRENCIES) if (!prices.has(`${c}:${s}`)) missing.add(`${c}:${s}`);
    if (missing.size > 0) {
      for (const [k, v] of await fetchCoinGecko(env.COINGECKO_KEY, missing)) prices.set(k, v);
    }
  }
  if (prices.size === 0) return prices;
  try {
    const rec = await readRecord(env);
    const at = Date.now();
    for (const [k, e8] of prices) rec[k] = { e8: e8.toString(), at };
    await env.KV.put(PRICES_KEY, JSON.stringify(rec));
  } catch (e) {
    // leave the previous record untouched
    console.warn(`price cache write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return prices;
}

/** A fresh cached price, or null if missing, stale or unreadable. */
async function cachedPrice(env: Env, priceSymbol: string, currency: Currency): Promise<bigint | null> {
  const entry = (await readRecord(env))[`${currency}:${priceSymbol}`];
  if (!entry) return null;
  try {
    if (typeof entry.at !== "number" || Date.now() - entry.at > PRICE_MAX_AGE_MS) return null;
    return BigInt(entry.e8);
  } catch {
    return null;
  }
}

/**
 * The cached price, or, when there is no fresh one (a fresh deploy or `wrangler dev` before the first cron,
 * or a stalled cron), one inline refresh of that symbol. Throws PriceUnavailable if that fails too.
 */
export async function getPriceE8(env: Env, priceSymbol: string, currency: Currency): Promise<bigint> {
  const cached = await cachedPrice(env, priceSymbol, currency);
  if (cached !== null) return cached;
  const fetched = (await refreshPrices(env, [priceSymbol])).get(`${currency}:${priceSymbol}`);
  if (fetched === undefined) throw new PriceUnavailable(priceSymbol, currency);
  return fetched;
}
