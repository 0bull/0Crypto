import { formatDecimal } from "../../core/money";
import type { AssetId, AssetInfo, ChainAdapter, DepositTarget, Observation } from "../../core/types";
import type { Env } from "../../env";
import { tronDepositAddress, tronHotAddress } from "../../signing/addresses";
import { tronGrid } from "./trongrid";

const LOOKBACK_MS = 3_600_000;
export const SOLID_CACHE_MAX = 1000;
/** Transfers below 0.01 USDT are ignored entirely: address-poisoning dust that would otherwise cost a solidity lookup each. */
export const DUST_FLOOR = 10_000n;
/** Uncached solidity lookups per observe, and how many run at once (Workers subrequest budget). */
export const MAX_LOOKUPS = 40;
export const LOOKUP_CONCURRENCY = 6;
/** Incoming TRX below this (0.1 TRX) is not reported as unexpected: dust. */
export const TRX_DUST_FLOOR = 100_000n;

// Solid results only: the USDT paid to the address by a tx (0n for a revert). Null (not solid yet) is never stored.
// Per isolate and bounded; a recycled isolate only costs a re-query.
const isolateCache = new Map<string, bigint>();

function remember(cache: Map<string, bigint>, key: string, value: bigint): void {
  cache.delete(key); // re-insert so Map order is recency order
  cache.set(key, value);
  while (cache.size > SOLID_CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/**
 * Tron USDT adapter. `received` is the /v1 index's incoming TRC-20 transfers (pre-solid, so it can lag or drop rows);
 * `final` is read from the solidity node's own Transfer logs, which are irreversible and cached, so it never decreases.
 */
export function tronAdapter(env: Env, cache: Map<string, bigint> = isolateCache): ChainAdapter {
  const grid = tronGrid(env);
  return {
    chain: "tron",

    async deriveAddress(index: number): Promise<string> {
      return tronDepositAddress(env.MASTER_SEED ?? "", index);
    },

    async observe(t: DepositTarget, asset: AssetInfo): Promise<Observation> {
      const minTimestamp = Math.max(0, t.createdAt - LOOKBACK_MS);
      const [all, trx] = await Promise.all([
        grid.trc20Incoming(t.address, asset.contract!, minTimestamp),
        // Unexpected TRX is what customers sent, not the balance: the sweeper's own top-up (from the hot wallet) is not a
        // deposit. A failure must not block crediting: omit `unexpected` and the previous value stands.
        grid.trxIncoming(t.address, minTimestamp, tronHotAddress(env.MASTER_SEED ?? ""), TRX_DUST_FLOOR).catch((e: unknown) => {
          console.warn(`tron: incoming TRX read failed for ${t.address}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ]);
      const incoming = all.filter((x) => x.value >= DUST_FLOOR);

      let received = 0n;
      const perTx = new Map<string, bigint>();
      for (const x of incoming) {
        received += x.value;
        perTx.set(x.txid, (perTx.get(x.txid) ?? 0n) + x.value);
      }
      const txids = [...perTx.keys()];

      const key = (txid: string) => `${grid.base}|${txid}|${t.address}`;
      let final = 0n;
      const todo: string[] = [];
      for (const txid of txids) {
        const hit = cache.get(key(txid));
        if (hit !== undefined) {
          remember(cache, key(txid), hit);
          final += hit;
        } else todo.push(txid);
      }
      // Biggest payments first; the rest wait for a later poll and count 0 until then.
      todo.sort((a, b) => (perTx.get(b)! > perTx.get(a)! ? 1 : perTx.get(b)! < perTx.get(a)! ? -1 : 0));
      const queue = todo.slice(0, MAX_LOOKUPS);
      const worker = async () => {
        for (let txid = queue.shift(); txid !== undefined; txid = queue.shift()) {
          let info;
          try {
            info = await grid.solidTxInfo(txid, t.address);
          } catch (e) {
            queue.length = 0; // stop the other workers: the observe fails closed anyway
            throw e;
          }
          if (info === null) continue; // not solid yet: re-asked next poll
          remember(cache, key(txid), info.value);
          final += info.value;
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, worker));

      // The index lags the solidity node: never report final above received.
      if (final > received) received = final;
      const out: Observation = { received, final, txids };
      if (trx !== null && trx > 0n) out.unexpected = { ["tron:trx" as AssetId]: trx };
      return out;
    },

    paymentUri(t: DepositTarget, asset: AssetInfo, amount: bigint): string {
      return `tron:${t.address}?token=${asset.contract}&amount=${formatDecimal(amount, asset.decimals)}`;
    },
  };
}
