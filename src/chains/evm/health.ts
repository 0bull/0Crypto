import type { Env } from "../../env";
import { evmHotAddress } from "../../signing/addresses";
import { ChainIdMismatch, EVM_CHAINS, forgetChainIds, type EvmChain } from "./config";

// viem is imported inside evmHealth, never at module scope (see adapter.ts).

export interface EvmHealth {
  factoryDeployed: boolean;
  /** Native balance of the hot wallet, in wei. */
  hotBalance: bigint;
  /** Latest block timestamp minus finalized block timestamp, in seconds; -1 when unknown. */
  finalizedLagSec: number;
}

const FRESH_MS = 600_000;
/** After a failed refresh nobody retries the RPC for this long (every checkout would otherwise wait on timeouts). */
const RETRY_MS = 60_000;
// The entry outlives its freshness so an RPC outage can still be answered with the last known value.
const KEEP_SEC = 86_400;
const key = (chain: EvmChain) => `evm:health:${chain}`;
const FALLBACK: EvmHealth = { factoryDeployed: false, hotBalance: 0n, finalizedLagSec: -1 };

/** Why the latest refresh failed: no URL on the chain's id, or the RPC could not be read. */
export type EvmHealthError = "chain_id_mismatch" | "rpc_unavailable";

/** `until`: do not call the RPC before this time (10 min after a success, 60 s after a failure). */
type Stored = {
  until: number;
  factoryAddress: string;
  chainId: number;
  factoryDeployed: boolean;
  hotBalance: string;
  finalizedLagSec: number;
  /** Time of the last successful refresh (kept across failed ones); null when there never was one. */
  checkedAt: number | null;
  /** The entry is a failure's retry window: the value is the last known one, or the fallback. */
  failed?: boolean;
  /** Set with `failed`. */
  error?: EvmHealthError | null;
};
type Entry = { until: number; factoryAddress: string; value: EvmHealth; checkedAt: number | null; failed: boolean; error: EvmHealthError | null };

/** A health value with when it was last read successfully and whether the latest refresh failed (so it may be stale). */
export interface EvmHealthDetail {
  value: EvmHealth;
  checkedAt: number | null;
  stale: boolean;
  /** Why the latest refresh failed; null after a success. */
  error: EvmHealthError | null;
}

// In-isolate memo in front of KV; cleared only by tests.
const memo = new Map<EvmChain, Entry>();
export const clearHealthMemo = () => memo.clear();

const hotCache = new Map<string, { hot: `0x${string}`; factory: `0x${string}` }>();

async function readStored(env: Env, chain: EvmChain, factory: string): Promise<Entry | null> {
  try {
    const s = await env.KV.get<Stored>(key(chain), "json");
    if (!s || typeof s.until !== "number" || s.factoryAddress !== factory || s.chainId !== EVM_CHAINS[chain].chainId) return null;
    return { until: s.until, factoryAddress: s.factoryAddress, checkedAt: s.checkedAt ?? null, failed: s.failed === true, error: s.failed === true ? (s.error ?? "rpc_unavailable") : null, value: { factoryDeployed: s.factoryDeployed, hotBalance: BigInt(s.hotBalance), finalizedLagSec: s.finalizedLagSec } };
  } catch {
    return null;
  }
}

/**
 * Whether the chain's forwarder factory is deployed, the hot wallet's native balance and how far the finalized block
 * lags the head. Memoised in the isolate and cached in KV (10 minutes). When the RPC fails, the last known value (else
 * "not deployed" with a lag of -1) is kept for 60 s without touching the RPC. When no RPC URL answers for the chain's
 * id the check fails closed: "not deployed", never the last known value, since that describes another chain's node.
 * The detail says which of the two failures it was.
 * Entries for another factory address (another seed) or chain id are ignored.
 */
export async function evmHealth(env: Env, chain: EvmChain): Promise<EvmHealth> {
  return (await evmHealthDetail(env, chain)).value;
}

/** Like evmHealth, plus when the value was last read successfully and whether the latest refresh failed. */
export async function evmHealthDetail(env: Env, chain: EvmChain): Promise<EvmHealthDetail> {
  const [hotAddress, { factoryAddress }] = await Promise.all([evmHotAddress(env), import("./predict")]);
  let who = hotCache.get(env.MASTER_SEED ?? "");
  if (!who) {
    const hot = hotAddress;
    who = { hot, factory: factoryAddress(hot) };
    hotCache.set(env.MASTER_SEED ?? "", who);
  }
  const { hot, factory } = who;

  const now = Date.now();
  const detail = (e: Entry): EvmHealthDetail => ({ value: e.value, checkedAt: e.checkedAt, stale: e.failed, error: e.error });
  const m = memo.get(chain);
  if (m && m.factoryAddress === factory && now < m.until) return detail(m);
  const stored = await readStored(env, chain, factory);
  if (stored && now < stored.until) {
    memo.set(chain, stored);
    return detail(stored);
  }

  const save = async (value: EvmHealth, until: number, checkedAt: number | null, error: EvmHealthError | null): Promise<EvmHealthDetail> => {
    const failed = error !== null;
    memo.set(chain, { until, factoryAddress: factory, value, checkedAt, failed, error });
    const s: Stored = { until, checkedAt, failed, error, factoryAddress: factory, chainId: EVM_CHAINS[chain].chainId, factoryDeployed: value.factoryDeployed, hotBalance: value.hotBalance.toString(), finalizedLagSec: value.finalizedLagSec };
    await env.KV.put(key(chain), JSON.stringify(s), { expirationTtl: KEEP_SEC }).catch(() => {});
    return { value, checkedAt, stale: failed, error };
  };

  try {
    const { evmClient } = await import("./chains");
    // evmClient keeps only URLs that reported the chain's id (asked once per isolate); asking again here catches a
    // node that switched since, and makes evmClient re-check every URL.
    const client = await evmClient(env, chain);
    const remoteId = await client.getChainId();
    if (remoteId !== EVM_CHAINS[chain].chainId) {
      forgetChainIds(env, chain);
      throw new ChainIdMismatch(`RPC for ${chain} is on chain id ${remoteId}`);
    }
    const [code, hotBalance, latest, finalized] = await Promise.all([
      client.getCode({ address: factory as `0x${string}` }),
      client.getBalance({ address: hot }),
      client.getBlock({ blockTag: "latest" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    const value: EvmHealth = {
      factoryDeployed: code !== undefined && code !== "0x",
      hotBalance,
      finalizedLagSec: Number(latest.timestamp - finalized.timestamp),
    };
    return await save(value, now + FRESH_MS, now, null);
  } catch (e) {
    console.warn(`0crypto: ${chain} health check failed: ${e instanceof Error ? e.name : "Error"}`);
    // A chain mismatch never reuses the last known value: that value describes another chain's node.
    if (e instanceof ChainIdMismatch) return await save(FALLBACK, now + RETRY_MS, null, "chain_id_mismatch");
    const last = stored ?? (m && m.factoryAddress === factory ? m : null);
    return await save(last?.value ?? FALLBACK, now + RETRY_MS, last?.checkedAt ?? null, "rpc_unavailable");
  }
}
