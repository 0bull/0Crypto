import { isRateLimited } from "../backoff";
export interface AddressTx {
  txid: string;
  height: number | null;
  /** Block time in unix seconds; null while unconfirmed. */
  time: number | null;
  valueToAddr: bigint;
}

/** An unspent output of an address. */
export interface Utxo {
  txid: string;
  vout: number;
  /** Atomic units. */
  value: bigint;
  confirmed: boolean;
  /** Block height; null while unconfirmed. */
  height: number | null;
}

export interface UtxoExplorer {
  tipHeight(): Promise<number>;
  addressTxs(addr: string): Promise<AddressTx[]>;
  /** The address's unspent outputs. Malformed data throws ExplorerParseError: never read as "none". */
  utxos(addr: string): Promise<Utxo[]>;
  /** The raw tx (lowercase hex). Callers verify it hashes to the txid. */
  txHex(txid: string): Promise<string>;
  /**
   * Whether the explorer knows the tx (mempool or chain) and whether it is confirmed. Only an explicit "not found"
   * answer is { known: false }; any other failure or malformed answer throws (never read as unknown or confirmed).
   */
  txStatus(txid: string): Promise<{ known: boolean; confirmed: boolean }>;
  broadcast(hex: string): Promise<string>;
}

export class ExplorerUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExplorerUnavailable";
  }
}

export class ExplorerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExplorerHttpError";
  }
}

export class ExplorerNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExplorerNetworkError";
  }
}

/** Malformed or inconsistent explorer data. Never retriable: a data bug is not an outage. */
export class ExplorerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorerParseError";
  }
}

export const EXPLORER_TIMEOUT_MS = 10_000;

const TXID = /^[0-9a-fA-F]{64}$/;
const isIndex = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** One UTXO (txid lowercased), or ExplorerParseError. `value` must already be a bigint; `height` is required when confirmed. */
export function checkedUtxo(who: string, u: { txid: unknown; vout: unknown; value: bigint; confirmed: boolean; height: unknown }): Utxo {
  if (typeof u.txid !== "string" || !TXID.test(u.txid)) throw new ExplorerParseError(`${who}: utxo without a txid`);
  if (!isIndex(u.vout)) throw new ExplorerParseError(`${who}: utxo ${u.txid} has a bad vout`);
  if (u.confirmed && (!isIndex(u.height) || u.height === 0)) throw new ExplorerParseError(`${who}: confirmed utxo ${u.txid} without a block height`);
  return { txid: u.txid.toLowerCase(), vout: u.vout, value: u.value, confirmed: u.confirmed, height: u.confirmed ? (u.height as number) : null };
}

/** The list, or ExplorerParseError if an outpoint (txid, vout) appears twice: never counted twice. */
export function uniqueUtxos(who: string, list: Utxo[]): Utxo[] {
  const seen = new Set<string>();
  for (const u of list) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new ExplorerParseError(`${who}: utxo ${k} listed twice`);
    seen.add(k);
  }
  return list;
}

/** A JSON body that must be an array of objects, or ExplorerParseError. */
export async function jsonArray(who: string, res: Response): Promise<Record<string, unknown>[]> {
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new ExplorerParseError(`${who}: response is not JSON`);
  }
  if (!Array.isArray(j) || j.some((x) => typeof x !== "object" || x === null || Array.isArray(x))) throw new ExplorerParseError(`${who}: expected an array of objects`);
  return j as Record<string, unknown>[];
}

/** Raw tx hex as an explorer gave it, lowercased, or ExplorerParseError. */
export function checkedHex(who: string, v: unknown): string {
  if (typeof v !== "string" || !/^([0-9a-fA-F]{2})+$/.test(v.trim())) throw new ExplorerParseError(`${who}: raw tx is not hex`);
  return v.trim().toLowerCase();
}

/** Lowercase bech32 addresses only; base58 is case-sensitive. */
export const normalizeAddr = (a: string): string => (/^(bc|ltc)1/i.test(a) ? a.toLowerCase() : a);

/** Fetch and require 2xx. Transport failures/timeouts throw ExplorerNetworkError; non-2xx throws ExplorerHttpError. */
export async function explorerFetch(url: string, init?: RequestInit, timeoutMs = EXPLORER_TIMEOUT_MS): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ExplorerNetworkError("explorer network error", { cause: e });
  }
  if (!res.ok) {
    // Release the connection; the error body is never read.
    await res.body?.cancel().catch(() => {});
    throw new ExplorerHttpError(res.status, `explorer HTTP ${res.status}`);
  }
  return res;
}

const isRetriable = (e: unknown): boolean =>
  e instanceof ExplorerNetworkError || (e instanceof ExplorerHttpError && (e.status === 429 || e.status >= 500));

/**
 * Fall back to `secondary` on network error, HTTP 429 or >= 500. Other non-2xx
 * responses throw immediately. When no explorer can answer, throws ExplorerUnavailable.
 */
export function withFallback(primary: UtxoExplorer, secondary?: UtxoExplorer): UtxoExplorer {
  async function run<T>(f: (x: UtxoExplorer) => Promise<T>): Promise<T> {
    try {
      return await f(primary);
    } catch (e) {
      if (!isRetriable(e)) throw e;
      if (!secondary) throw new ExplorerUnavailable("explorer unavailable", { cause: e });
      try {
        return await f(secondary);
      } catch (e2) {
        if (!isRetriable(e2)) throw e2;
        // Keep a 429 visible to the per-chain backoff even when the secondary failed differently.
        throw new ExplorerUnavailable("all explorers unavailable", { cause: isRateLimited(e) && !isRateLimited(e2) ? e : e2 });
      }
    }
  }
  return {
    tipHeight: () => run((x) => x.tipHeight()),
    addressTxs: (a) => run((x) => x.addressTxs(a)),
    utxos: (a) => run((x) => x.utxos(a)),
    txHex: (t) => run((x) => x.txHex(t)),
    txStatus: (t) => run((x) => x.txStatus(t)),
    broadcast: (h) => run((x) => x.broadcast(h)),
  };
}
