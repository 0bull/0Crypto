/**
 * Trocador swap client (https://api.trocador.app, header `API-Key`). Swaps received BTC/LTC/DOGE/Tron USDT/SOL/Solana USDC
 * to XMR. Built from the public docs (see test/fixtures/trocador/README.md) and NOT yet verified live: `trade()` refuses
 * unless TROCADOR_LIVE_OK === "1" (docs/trocador-spike.md).
 *
 * Fail closed: non-2xx, malformed JSON, missing fields and unknown statuses all throw. The API key travels only in the
 * `API-Key` header and never appears in a URL, error, log or KV entry. Requests carry only amounts and addresses.
 */
import { formatDecimal, parseDecimal } from "../core/money";
import type { AssetId } from "../core/types";
import type { Env } from "../env";
import { EXPLORER_TIMEOUT_MS, explorerFetch } from "../chains/utxo/explorer";
import { validateAssetAddress } from "./addr";
import { validateXmrAddress } from "./xmr";

export const TROCADOR_BASE = "https://api.trocador.app";
const COIN_TTL_S = 24 * 60 * 60;
export const XMR_DECIMALS = 12;

export type Coin = { ticker: string; network: string };

/**
 * EXPECTED ticker/network per routed asset. Only BTC/LTC/DOGE/SOL "Mainnet" follow the docs' example; USDT-Tron "TRC20" and
 * USDC-Solana "Solana" are ASSUMPTIONS. Every quote/trade first resolves the pair through `/coin?ticker=` and requires exactly
 * one entry with this network, so a wrong guess fails with TrocadorPairUnverified instead of mis-routing.
 */
export const TROCADOR_TICKERS: Record<AssetId, Coin> = {
  "btc:btc": { ticker: "btc", network: "Mainnet" },
  "ltc:ltc": { ticker: "ltc", network: "Mainnet" },
  "doge:doge": { ticker: "doge", network: "Mainnet" },
  "tron:usdt": { ticker: "usdt", network: "TRC20" },
  "sol:sol": { ticker: "sol", network: "Mainnet" },
  "sol:usdc": { ticker: "usdc", network: "Solana" },
};
export const XMR_COIN: Coin = { ticker: "xmr", network: "Mainnet" };

export class TrocadorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrocadorError";
  }
}
export class TrocadorNotVerified extends TrocadorError {
  constructor() {
    super("Trocador trades are disabled until the live spike passes (set TROCADOR_LIVE_OK=1, see docs/trocador-spike.md)");
    this.name = "TrocadorNotVerified";
  }
}
export class TrocadorPairUnverified extends TrocadorError {
  constructor(message: string) {
    super(message);
    this.name = "TrocadorPairUnverified";
  }
}
/** The created trade does not match the quote it was bound to (provider or amount_to differ: Trocador re-quoted). */
export class TradeQuoteMismatch extends TrocadorError {
  constructor(what: string) {
    super(`Trocador trade does not match the quote: ${what}`);
    this.name = "TradeQuoteMismatch";
  }
}
export class NoAcceptableQuote extends TrocadorError {
  constructor(minKyc: string) {
    super(`no Trocador quote with a KYC rating of ${minKyc} or better`);
    this.name = "NoAcceptableQuote";
  }
}
export class UnknownTradeStatus extends TrocadorError {
  constructor(status: string) {
    super(`unknown Trocador trade status: ${JSON.stringify(status.slice(0, 40))}`);
    this.name = "UnknownTradeStatus";
  }
}

export type TradeStatus = "new" | "waiting" | "confirming" | "sending" | "paid_partially" | "finished" | "failed" | "expired" | "halted" | "refunded";
/** The documented enum. "paid partially" (AnonPay/cards only) is explicit and never counts as finished. */
const STATUSES: Record<string, TradeStatus> = {
  new: "new",
  waiting: "waiting",
  confirming: "confirming",
  sending: "sending",
  "paid partially": "paid_partially",
  finished: "finished",
  failed: "failed",
  expired: "expired",
  halted: "halted",
  refunded: "refunded",
};

const KYC_ORDER = ["A", "B", "C", "D"] as const; // A best
const KYC_KEYS = ["kycrating", "kyc_rating", "kycRating", "KYC", "kyc"];
const AMOUNT_KEYS = ["amount_to"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (what: string): never => {
  throw new TrocadorError(`malformed Trocador response: ${what}`);
};

function str(o: Json, key: string): string {
  const v = o[key];
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return bad(`${key} missing`);
}
function optStr(o: Json, key: string): string | undefined {
  const v = o[key];
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}
/** JSON booleans or the docs' "True"/"False" strings; anything else is malformed. */
function bool(v: unknown, what: string): boolean {
  if (v === true || v === "True") return true;
  if (v === false || v === "False") return false;
  return bad(`${what} is not a boolean`);
}
/** Plain decimal text only (no exponent, sign or whitespace); the same grammar parseDecimal enforces. */
const DECIMAL = /^\d+(\.\d+)?$/;
const decimalText = (o: Json, key: string): string => {
  const s = str(o, key);
  if (!DECIMAL.test(s)) bad(`${key} is not a plain decimal`);
  return s;
};

export function minKycFrom(env: Pick<Env, "TROCADOR_MIN_KYC">): (typeof KYC_ORDER)[number] {
  const raw = env.TROCADOR_MIN_KYC;
  if (raw === undefined || raw === "") return "A";
  if ((KYC_ORDER as readonly string[]).includes(raw)) return raw as (typeof KYC_ORDER)[number];
  throw new TrocadorError("TROCADOR_MIN_KYC must be one of A, B, C, D");
}
const kycOk = (rating: string, min: string) => KYC_ORDER.indexOf(rating as never) >= 0 && KYC_ORDER.indexOf(rating as never) <= KYC_ORDER.indexOf(min as never);

type Cfg = Pick<Env, "KV" | "TROCADOR_API_KEY" | "TROCADOR_MIN_KYC" | "TROCADOR_LIVE_OK">;
export interface ResolvedCoin {
  minimum: string;
  maximum: string | null;
}

export interface Quote {
  rateId: string;
  amountTo: string;
  amountToAtomic: bigint;
  provider: string;
  kycRating: string;
}
export interface TradeArgs {
  rateId: string;
  provider: string;
  from: Coin;
  amountFrom: bigint;
  decimals: number;
  xmrAddress: string;
  /** Where Trocador refunds if the swap fails: an address of the SOURCE chain that the operator controls. */
  refundAddress: string;
  /** The quote's amountToAtomic (XMR). The rate is fixed, so the trade's amount_to must equal it exactly. */
  quotedAmountTo: bigint;
}
export interface Trade {
  tradeId: string;
  providerTradeId?: string;
  provider: string;
  depositAddress: string;
  amountTo: string;
  status: TradeStatus;
  expiresAt?: string;
  support?: string;
}
export interface TradeState {
  status: TradeStatus;
  hashout?: string;
  expiresAt?: string;
  support?: string;
}

function extras(body: Json): { expiresAt?: string; support?: string } {
  const q = isObj(body.quotes) ? body.quotes : {};
  const expiresAt = optStr(q, "expiresAt") ?? optStr(body, "expiresAt");
  const s = q.support ?? body.support;
  const support = typeof s === "string" && s ? s.slice(0, 500) : isObj(s) ? JSON.stringify(s).slice(0, 500) : undefined;
  return { ...(expiresAt ? { expiresAt } : {}), ...(support ? { support } : {}) };
}

/**
 * Callers (planner, router) enforce the coin's minimum/maximum (`minimum()`); quote/trade do not.
 * Memo coins are refused everywhere, so a trade never has a deposit memo.
 */
export function trocador(env: Cfg) {
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const key = env.TROCADOR_API_KEY;
    if (!key) throw new TrocadorError("TROCADOR_API_KEY is not set");
    const url = `${TROCADOR_BASE}${path}?${new URLSearchParams(params).toString()}`;
    // Workers has no redirect "error"; "manual" returns the 3xx, which explorerFetch rejects as non-2xx. The key is never replayed to another host.
    const res = await explorerFetch(url, { headers: { "API-Key": key, accept: "application/json" }, redirect: "manual" }, EXPLORER_TIMEOUT_MS);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TrocadorError("malformed Trocador response: not JSON");
    }
    if (isObj(body) && body.error) throw new TrocadorError("Trocador returned an error");
    return body;
  }

  /** Resolves the coin through `/coin?ticker=` (24h KV cache): exactly one entry with the expected network, no memo. */
  async function resolve(coin: Coin): Promise<ResolvedCoin> {
    const cacheKey = `trocador:coin:${coin.ticker}:${coin.network}`;
    try {
      const cached = JSON.parse((await env.KV.get(cacheKey)) ?? "null");
      if (isObj(cached) && typeof cached.minimum === "string" && DECIMAL.test(cached.minimum) && (cached.maximum === null || (typeof cached.maximum === "string" && DECIMAL.test(cached.maximum)))) {
        return { minimum: cached.minimum, maximum: cached.maximum };
      }
    } catch {
      // A corrupt cache entry is a miss.
    }
    const body = await get("/coin", { ticker: coin.ticker });
    const list = Array.isArray(body) ? body : [body];
    const entries = list.filter((c): c is Json => isObj(c) && typeof c.ticker === "string" && c.ticker.toLowerCase() === coin.ticker && c.network === coin.network);
    if (entries.length !== 1) {
      throw new TrocadorPairUnverified(`Trocador /coin does not list exactly one ${coin.ticker} coin on network ${coin.network} (found ${entries.length}); check docs/trocador-spike.md`);
    }
    const entry = entries[0]!;
    if (bool(entry.memo, "memo")) throw new TrocadorPairUnverified(`Trocador coin ${coin.ticker}/${coin.network} needs a memo, which is not supported`);
    const resolved: ResolvedCoin = {
      minimum: decimalText(entry, "minimum"),
      maximum: entry.maximum === undefined || entry.maximum === null ? null : decimalText(entry, "maximum"),
    };
    await env.KV.put(cacheKey, JSON.stringify(resolved), { expirationTtl: COIN_TTL_S });
    return resolved;
  }

  async function resolvePair(from: Coin): Promise<void> {
    await resolve(from);
    await resolve(XMR_COIN);
  }

  const pairParams = (from: Coin) => ({ ticker_from: from.ticker, network_from: from.network, ticker_to: XMR_COIN.ticker, network_to: XMR_COIN.network });

  return {
    /** Minimum swap amount in the asset's atomic units (24h KV cache). Throws if it can't be read: never zero. */
    async minimum(from: Coin, decimals: number): Promise<bigint> {
      return parseDecimal((await resolve(from)).minimum, decimals);
    },

    /** Best fixed-rate quote among providers rated no worse than TROCADOR_MIN_KYC; NoAcceptableQuote when none. */
    async quote(from: Coin, amountFrom: bigint, decimals: number): Promise<Quote> {
      const minKyc = minKycFrom(env);
      if (amountFrom <= 0n) throw new TrocadorError("amount must be positive");
      await resolvePair(from);
      const body = await get("/new_rate", {
        ...pairParams(from),
        amount_from: formatDecimal(amountFrom, decimals),
        payment: "False",
        min_kycrating: minKyc,
      });
      if (!isObj(body)) bad("not an object");
      const rateId = str(body as Json, "trade_id");
      const top = body as Json;
      const quotes = Array.isArray(top.quotes) ? top.quotes.filter(isObj) : [];

      const ratingOf = (o: Json): string | undefined => {
        for (const k of KYC_KEYS) {
          const v = o[k];
          if (typeof v === "string" && /^[A-Da-d]$/.test(v.trim())) return v.trim().toUpperCase();
        }
        return undefined;
      };
      const candidates: Array<{ provider: string; rating: string; amount: bigint; text: string }> = [];
      const consider = (provider: unknown, rating: string | undefined, amountRaw: unknown, fixed: unknown) => {
        // A malformed boolean is a malformed response (throws); an unparseable amount only disqualifies that candidate.
        const isFixed = fixed === undefined ? false : bool(fixed, "fixed"); // a missing value counts as not fixed
        try {
          if (typeof provider !== "string" || !provider || !rating || !isFixed) return;
          const text = typeof amountRaw === "string" ? amountRaw : typeof amountRaw === "number" ? String(amountRaw) : "";
          if (!DECIMAL.test(text)) return;
          candidates.push({ provider, rating, amount: parseDecimal(text, XMR_DECIMALS), text });
        } catch {
          // An unparseable or non-fixed candidate is never usable.
        }
      };
      const amountOf = (o: Json) => AMOUNT_KEYS.map((k) => o[k]).find((v) => v !== undefined);
      for (const q of quotes) consider(q.provider, ratingOf(q), amountOf(q), q.fixed);
      const topRating = ratingOf(top) ?? ratingOf(quotes.find((q) => q.provider === top.provider) ?? {});
      consider(top.provider, topRating, amountOf(top), top.fixed);

      let best: (typeof candidates)[number] | undefined;
      for (const c of candidates) {
        if (!kycOk(c.rating, minKyc)) continue;
        if (!best || c.amount > best.amount) best = c;
      }
      if (!best || best.amount <= 0n) throw new NoAcceptableQuote(minKyc);
      return { rateId, provider: best.provider, kycRating: best.rating, amountTo: formatDecimal(best.amount, XMR_DECIMALS), amountToAtomic: best.amount };
    },

    /** Creates a fixed-rate swap to `xmrAddress`. Refuses unless TROCADOR_LIVE_OK === "1". Callers must refuse memos. */
    async trade(a: TradeArgs): Promise<Trade> {
      if (env.TROCADOR_LIVE_OK !== "1") throw new TrocadorNotVerified();
      const minKyc = minKycFrom(env);
      validateXmrAddress(a.xmrAddress);
      const asset = Object.entries(TROCADOR_TICKERS).find(([, c]) => c.ticker === a.from.ticker && c.network === a.from.network)?.[0];
      if (!asset) throw new TrocadorError("unsupported source coin");
      try {
        validateAssetAddress(asset, a.refundAddress);
      } catch (e) {
        throw new TrocadorError(`refund address rejected: ${e instanceof Error ? e.message : "invalid"}`);
      }
      if (a.amountFrom <= 0n || a.quotedAmountTo <= 0n) throw new TrocadorError("amounts must be positive");
      if (!a.rateId || !a.provider) throw new TrocadorError("rateId and provider are required");
      await resolvePair(a.from);
      const amountText = formatDecimal(a.amountFrom, a.decimals);
      // One rate id covers all of new_rate's quotes: new_trade takes `id` plus `provider` (docs), so the chosen provider is passed
      // alongside the id and verified on the response (provider and amount_to must match the quote).
      const body = await get("/new_trade", {
        id: a.rateId,
        ...pairParams(a.from),
        amount_from: amountText,
        address: a.xmrAddress,
        address_memo: "0",
        refund: a.refundAddress,
        refund_memo: "0",
        provider: a.provider,
        fixed: "True",
        payment: "False",
        min_kycrating: minKyc,
      });
      if (!isObj(body)) bad("not an object");
      const t = body as Json;
      const status = parseStatus(t);
      if (status !== "new" && status !== "waiting") throw new TrocadorError("unexpected creation status; refusing");
      if (!bool(t.fixed, "fixed")) throw new TrocadorError("Trocador created a non-fixed-rate trade; refusing");
      const echo = (key: string, want: string, lower = false) => {
        const got = str(t, key);
        if ((lower ? got.toLowerCase() : got) !== want) throw new TrocadorError(`Trocador trade echo mismatch on ${key}; refusing`);
      };
      echo("ticker_from", a.from.ticker, true);
      echo("network_from", a.from.network);
      echo("ticker_to", XMR_COIN.ticker, true);
      echo("network_to", XMR_COIN.network);
      if (str(t, "address_user") !== a.xmrAddress) throw new TrocadorError("Trocador trade pays out to a different address; refusing");
      const amountFromEcho = decimalText(t, "amount_from");
      if (parseDecimal(amountFromEcho, a.decimals) !== a.amountFrom) throw new TrocadorError("Trocador trade amount differs from the request; refusing");
      // A dropped or changed refund address would send a failed swap's refund somewhere we did not choose.
      const refundEcho = optStr(t, "refund_address");
      if (refundEcho !== a.refundAddress) throw new TrocadorError("Trocador trade refunds to a different address (or none); refusing");
      const provider = str(t, "provider");
      if (provider !== a.provider) throw new TradeQuoteMismatch("provider differs");
      const amountTo = decimalText(t, "amount_to");
      if (parseDecimal(amountTo, XMR_DECIMALS) !== a.quotedAmountTo) throw new TradeQuoteMismatch("amount_to differs from the quoted amount");
      const memo = optStr(t, "address_provider_memo");
      if (memo && memo !== "None" && memo !== "0") throw new TrocadorError("Trocador deposit needs a memo, which is not supported; refusing");
      let depositAddress: string;
      try {
        depositAddress = validateAssetAddress(asset, str(t, "address_provider"));
      } catch (e) {
        throw new TrocadorError(`Trocador deposit address rejected: ${e instanceof Error ? e.message : "invalid"}`);
      }
      return {
        tradeId: str(t, "trade_id"),
        ...(optStr(t, "id_provider") ? { providerTradeId: optStr(t, "id_provider")! } : {}),
        provider,
        depositAddress,
        amountTo,
        status,
        ...extras(t),
      };
    },

    /** Current trade state. Unknown statuses throw UnknownTradeStatus. hashout only when finished. */
    async status(tradeId: string): Promise<TradeState> {
      if (!tradeId) throw new TrocadorError("tradeId is required");
      let body = await get("/trade", { id: tradeId });
      if (Array.isArray(body) && body.length === 1) body = body[0];
      if (!isObj(body)) bad("not an object");
      const t = body as Json;
      if (str(t, "trade_id") !== tradeId) throw new TrocadorError("Trocador returned a different trade; refusing");
      const status = parseStatus(t);
      const hashout = isObj(t.details) ? optStr(t.details, "hashout") : undefined;
      return { status, ...(status === "finished" && hashout ? { hashout } : {}), ...extras(t) };
    },
  };
}

function parseStatus(t: Json): TradeStatus {
  const raw = t.status;
  if (typeof raw !== "string") return bad("status missing");
  const s = Object.hasOwn(STATUSES, raw.trim().toLowerCase()) ? STATUSES[raw.trim().toLowerCase()] : undefined;
  if (!s) throw new UnknownTradeStatus(raw);
  return s;
}
