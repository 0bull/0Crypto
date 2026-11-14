import { parseDecimal } from "../core/money";

export type Currency = "USD" | "EUR";

export const PRICE_SYMBOLS = ["BTC", "LTC", "DOGE", "ETH", "SOL", "USDC", "USDT", "DAI", "POL", "BNB", "TRX"] as const;
export const CURRENCIES: readonly Currency[] = ["USD", "EUR"];

// Request pair names (symbol -> Kraken altname base). Quote currency is appended.
const KRAKEN_BASE: Record<string, string> = {
  BTC: "XBT", LTC: "LTC", DOGE: "XDG", ETH: "ETH", SOL: "SOL",
  USDC: "USDC", USDT: "USDT", DAI: "DAI", POL: "POL", BNB: "BNB", TRX: "TRX",
};

export const KRAKEN_PAIRS: { pair: string; symbol: string; currency: Currency }[] = PRICE_SYMBOLS.flatMap((symbol) =>
  CURRENCIES.map((currency) => ({ pair: `${KRAKEN_BASE[symbol]}${currency}`, symbol, currency })),
);

// Kraken's Ticker result keys differ from request names for some pairs (legacy X/Z prefixes).
// Pinned from the live API; request names are also accepted as keys.
const RESULT_KEY_ALIASES: Record<string, string> = {
  XXBTZUSD: "XBTUSD", XXBTZEUR: "XBTEUR",
  XLTCZUSD: "LTCUSD", XLTCZEUR: "LTCEUR",
  XETHZUSD: "ETHUSD", XETHZEUR: "ETHEUR",
  USDTZUSD: "USDTUSD", USDTZEUR: "USDTEUR",
  XXDGZUSD: "XDGUSD", XXDGZEUR: "XDGEUR",
};

const BY_PAIR = new Map(KRAKEN_PAIRS.map((p) => [p.pair, p]));

/** Kraken sometimes returns more than 8 fractional digits; truncate (round down) rather than fail. */
function toE8(s: string): bigint {
  const m = /^(\d+)\.(\d+)$/.exec(s);
  const normalized = m && m[2]!.length > 8 ? `${m[1]}.${m[2]!.slice(0, 8)}` : s;
  return parseDecimal(normalized, 8);
}

export const PRICE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Returns map "CUR:SYMBOL" -> priceE8 for the requested symbols' pairs that Kraken returned and that
 * parsed cleanly. Never throws; a timeout counts as a failed request.
 */
export async function fetchKraken(symbols: readonly string[], timeoutMs = PRICE_FETCH_TIMEOUT_MS): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const pairs = KRAKEN_PAIRS.filter((p) => symbols.includes(p.symbol));
  if (pairs.length === 0) return out;
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs.map((p) => p.pair).join(",")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      console.warn(`kraken ticker failed: HTTP ${res.status}`);
      return out;
    }
    const body = (await res.json()) as { error?: unknown[]; result?: Record<string, { c?: unknown[] }> };
    if (!body.result) {
      console.warn(`kraken ticker returned no result: ${JSON.stringify(body.error ?? []).slice(0, 200)}`);
      return out;
    }
    for (const [key, ticker] of Object.entries(body.result)) {
      const entry = BY_PAIR.get(RESULT_KEY_ALIASES[key] ?? key);
      const last = ticker?.c?.[0];
      if (!entry || !symbols.includes(entry.symbol) || typeof last !== "string") continue;
      try {
        const e8 = toE8(last);
        if (e8 > 0n) out.set(`${entry.currency}:${entry.symbol}`, e8);
      } catch (e) {
        // skip this symbol, keep its previous cache entry
        console.warn(`kraken price rejected for ${entry.symbol}/${entry.currency} (${key}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    // network/parse failure: caller falls back
    console.warn(`kraken ticker request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
