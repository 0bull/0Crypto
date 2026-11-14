import { parseDecimal } from "../core/money";
import { CURRENCIES, PRICE_FETCH_TIMEOUT_MS, PRICE_SYMBOLS } from "./kraken";

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", LTC: "litecoin", DOGE: "dogecoin", ETH: "ethereum", SOL: "solana",
  USDC: "usd-coin", USDT: "tether", DAI: "dai", POL: "polygon-ecosystem-token",
  BNB: "binancecoin", TRX: "tron",
};

/** Fetch prices for the given "CUR:SYMBOL" keys. Never throws (a timeout counts as failure); returns only what parsed cleanly. */
export async function fetchCoinGecko(apiKey: string, wanted: Set<string>, timeoutMs = PRICE_FETCH_TIMEOUT_MS): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (wanted.size === 0) return out;
  try {
    const symbols = PRICE_SYMBOLS.filter((s) => CURRENCIES.some((c) => wanted.has(`${c}:${s}`)));
    const ids = symbols.map((s) => COINGECKO_IDS[s]!).join(",");
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,eur`, {
      headers: { "x-cg-demo-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`coingecko price request failed: HTTP ${res.status}`);
      return out;
    }
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    for (const symbol of symbols) {
      for (const currency of CURRENCIES) {
        const k = `${currency}:${symbol}`;
        if (!wanted.has(k)) continue;
        const n = body[COINGECKO_IDS[symbol]!]?.[currency.toLowerCase()];
        if (typeof n !== "number" || !Number.isFinite(n)) {
          console.warn(`coingecko price missing or invalid for ${symbol}/${currency}`);
          continue;
        }
        try {
          const e8 = parseDecimal(n.toFixed(8), 8);
          if (e8 > 0n) out.set(k, e8);
        } catch (e) {
          console.warn(`coingecko price rejected for ${symbol}/${currency}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) {
    console.warn(`coingecko request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
