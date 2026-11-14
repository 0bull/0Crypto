import { isRateLimited } from "../backoff";
import { EXPLORER_TIMEOUT_MS, explorerFetch } from "../utxo/explorer";

/** Mainnet-beta's genesis hash: an RPC URL on any other cluster (devnet, testnet, a fork) is never used. */
export const SOL_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** RPC URLs configured: comma-separated, trimmed, empties dropped. */
export function solRpcUrls(env: { SOLANA_RPC_URL?: string }): string[] {
  return (env.SOLANA_RPC_URL ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/** An RPC URL answered, but for another cluster than mainnet-beta. */
export class GenesisMismatch extends Error {
  override name = "GenesisMismatch";
}

/** A JSON-RPC error answer (the node read the request and refused it). */
class JsonRpcError extends Error {
  override name = "JsonRpcError";
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly detail: string,
  ) {
    super(message);
  }
}

/**
 * send(): the node refused the request with a JSON-RPC error (a preflight or simulation failure for sendTransaction),
 * and no earlier URL may have received it. Definite: the request was not accepted anywhere.
 */
export class RpcRejected extends Error {
  override name = "RpcRejected";
  constructor(
    readonly code: number | undefined,
    readonly detail: string,
  ) {
    super(`solana: request refused${code === undefined ? "" : ` (${code})`}`);
  }
}

/** Counts the HTTP requests (subrequests) an RPC client makes, fallback probes and genesis checks included. */
export interface RpcMeter {
  used: number;
}

/** The genesis hash each RPC URL reported, asked once per URL per isolate. Unreachable URLs are not kept. */
const reportedGenesis = new Map<string, string>();
/** After a failed check or call a URL is skipped for this long, unless every other URL has failed too. */
const COOLDOWN_MS = 60_000;
const coolUntil = new Map<string, number>();
/** Tests only. */
export const clearGenesisMemo = () => {
  reportedGenesis.clear();
  coolUntil.clear();
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Raw JSON-RPC over fetch. The URLs are secrets (they usually carry an API key): no error message names one. Each URL
 * must report mainnet's genesis hash (checked once per URL per isolate) before it is asked anything else; a URL that
 * fails, times out, answers non-2xx, returns a JSON-RPC error or a malformed body is skipped for the next one, and when
 * none answers the call throws. A failure is never read as an empty or zero answer.
 */
export function solRpc(env: { SOLANA_RPC_URL?: string }, timeoutMs = EXPLORER_TIMEOUT_MS, meter?: RpcMeter) {
  async function post(url: string, method: string, params: unknown[]): Promise<unknown> {
    if (meter) meter.used++;
    const res = await explorerFetch(
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
      timeoutMs,
    );
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error(`solana: ${method} response is not JSON`, { cause: e });
    }
    if (!isObj(body)) throw new Error(`solana: ${method} response is not a JSON-RPC object`);
    if (body.error !== undefined) {
      const code = isObj(body.error) && typeof body.error.code === "number" ? body.error.code : undefined;
      const detail = isObj(body.error) && typeof body.error.message === "string" ? body.error.message.slice(0, 160) : "";
      throw new JsonRpcError(`solana: ${method} returned a JSON-RPC error${code === undefined ? "" : ` (${code})`}`, code, detail);
    }
    if (body.result === undefined || body.result === null) throw new Error(`solana: ${method} response has no result`);
    return body.result;
  }

  /** URLs in the order to try: healthy first, cooling ones only as a last resort. */
  function ordered(): string[] {
    const urls = solRpcUrls(env);
    if (urls.length === 0) throw new Error("solana: SOLANA_RPC_URL is not set");
    const now = Date.now();
    const ready = urls.filter((u) => (coolUntil.get(u) ?? 0) <= now);
    return [...ready, ...urls.filter((u) => !ready.includes(u))];
  }

  /** Throws unless `url` reports mainnet's genesis hash (asked once per URL per isolate). A wrong-cluster URL is never used. */
  async function checkGenesis(url: string): Promise<void> {
    let genesis = reportedGenesis.get(url);
    if (genesis === undefined) {
      const g = await post(url, "getGenesisHash", []);
      if (typeof g !== "string") throw new Error("solana: malformed genesis hash");
      genesis = g;
      reportedGenesis.set(url, g);
    }
    if (genesis !== SOL_MAINNET_GENESIS) throw new GenesisMismatch("solana: RPC URL is not on mainnet-beta (genesis hash differs)");
  }

  return {
    /** The JSON-RPC `result` of the first URL on mainnet that answers. Callers validate its shape. */
    async call(method: string, params: unknown[]): Promise<unknown> {
      let last: unknown;
      let limited = false;
      for (const url of ordered()) {
        try {
          await checkGenesis(url);
          const result = await post(url, method, params);
          coolUntil.delete(url);
          return result;
        } catch (e) {
          if (!(e instanceof GenesisMismatch)) coolUntil.set(url, Date.now() + COOLDOWN_MS);
          if (isRateLimited(e)) limited = true;
          last = e;
        }
      }
      // No real cause: a fetch TypeError can carry the (secret) URL. Only the bare 429 marker is attached, for the backoff.
      if (last instanceof GenesisMismatch) throw last;
      throw new Error(`solana: no RPC URL could answer ${method}`, limited ? { cause: { status: 429 } } : undefined);
    },

    /**
     * For a request that must not be repeated blindly (sendTransaction). Like call(), but a JSON-RPC error throws
     * RpcRejected at once (definite: refused) unless an earlier URL may have received the request (it timed out,
     * answered non-2xx or garbage): then, like every other failure, the outcome is unknown and a plain Error is thrown.
     * A URL that fails its genesis check never saw the request.
     */
    async send(method: string, params: unknown[]): Promise<unknown> {
      let maybeReceived = false;
      let last: unknown;
      for (const url of ordered()) {
        try {
          await checkGenesis(url);
        } catch (e) {
          if (!(e instanceof GenesisMismatch)) coolUntil.set(url, Date.now() + COOLDOWN_MS);
          last = e;
          continue;
        }
        try {
          const result = await post(url, method, params);
          coolUntil.delete(url);
          return result;
        } catch (e) {
          if (e instanceof JsonRpcError && !maybeReceived) throw new RpcRejected(e.code, e.detail);
          if (!(e instanceof JsonRpcError)) coolUntil.set(url, Date.now() + COOLDOWN_MS);
          maybeReceived = true;
          last = e;
        }
      }
      throw last instanceof GenesisMismatch && !maybeReceived ? last : new Error(`solana: no RPC URL could answer ${method}`);
    },
  };
}
