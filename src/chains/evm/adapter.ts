import type { Address } from "viem";
import { chainAssets } from "../../core/assets";
import type { AssetId, AssetInfo, ChainAdapter, DepositTarget, Observation } from "../../core/types";
import type { Env } from "../../env";
import { evmDepositSalt, evmHotAddress } from "../../signing/addresses";
import { EVM_CHAINS, finalTarget as finalTargetOf, type EvmChain } from "./config";

// viem is large: it is imported inside the methods, never at module scope, so Worker startup (and every
// request that never touches an EVM chain) does not load it. Only type imports above.

/** Multicall3 is deployed at this address on every supported chain. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const BALANCE_OF = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const GET_ETH_BALANCE = [
  { type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Balance-based EVM adapter: a payment is whatever sits at its deposit address. `received` is the payment
 * asset's balance at `latest`, `final` its balance at `finalized` (zero on Polygon until the finalized block is
 * at least `minDepth` behind the head). Transfer and Flushed logs are never read: anyone can emit a fake one.
 */
export function evmAdapter(env: Env, chain: EvmChain): ChainAdapter {
  const info = EVM_CHAINS[chain];

  /**
   * Balances at one block: native plus every given token, keyed by asset id. A failed entry is absent, except the
   * payment's own asset (`ownId`): that one, or the whole call failing, throws (with `cause`) so it can never read as 0.
   */
  async function balances(
    client: import("viem").PublicClient,
    owner: Address,
    assets: AssetInfo[],
    block: bigint | "latest",
    ownId: AssetId,
  ): Promise<Map<AssetId, bigint>> {
    const calls = assets.map((a) =>
      a.contract
        ? { address: a.contract as Address, abi: BALANCE_OF, functionName: "balanceOf" as const, args: [owner] as const }
        : { address: MULTICALL3, abi: GET_ETH_BALANCE, functionName: "getEthBalance" as const, args: [owner] as const },
    );
    const failed = (cause: unknown) => new Error(`${chain}: balance read failed for ${ownId} at block ${block}`, { cause });
    // batchSize 0: always one eth_call, so the whole read comes from one block.
    const results = await client
      .multicall({
        contracts: calls,
        ...(block === "latest" ? { blockTag: "latest" as const } : { blockNumber: block }),
        multicallAddress: MULTICALL3,
        batchSize: 0,
      })
      .catch((e: unknown) => {
        throw failed(e);
      });
    const out = new Map<AssetId, bigint>();
    results.forEach((r, i) => {
      const id = assets[i]!.id;
      if (r.status === "success") out.set(id, r.result as bigint);
      else if (id === ownId) throw failed(r.error);
    });
    return out;
  }

  return {
    chain,

    async deriveAddress(index: number): Promise<string> {
      // A secret salt (evmDepositSalt): nobody can list other payments' deposit addresses from this one.
      const [hot, { factoryAddress, predictForwarder }] = await Promise.all([evmHotAddress(env), import("./predict")]);
      return predictForwarder(factoryAddress(hot), evmDepositSalt(env.MASTER_SEED ?? "", index));
    },

    async observe(t: DepositTarget, asset: AssetInfo): Promise<Observation> {
      const { evmClient } = await import("./chains");
      const client = await evmClient(env, chain);
      const owner = t.address as Address;

      // The payment's own asset plus every registry asset of the chain (native included), enabled or not: any other
      // non-zero balance is an unexpected deposit, recorded so the sweep can move it and the dashboard can show it.
      const wanted = new Map<AssetId, AssetInfo>([[asset.id, asset]]);
      for (const a of chainAssets(chain)) wanted.set(a.id, a);
      const assets = [...wanted.values()];

      // The latest read uses the "latest" tag, not the head number: a load-balanced RPC may not have that block yet.
      const latest = await balances(client, owner, assets, "latest", asset.id);
      const own = latest.get(asset.id)!;
      const unexpected: Record<AssetId, bigint> = {};
      for (const [id, v] of latest) if (id !== asset.id && v > 0n) unexpected[id] = v;

      // Nothing of the payment's asset at latest: `final` (never above `received`) is 0 whatever the finalized block
      // holds, so the head, finalized block and pinned reads are skipped. One request for an empty or swept address.
      // A confirmed or swept payment keeps its credit regardless: step's monotone guard ignores a lower observation.
      if (own === 0n) return { received: 0n, final: 0n, txids: [], unexpected };

      // The finalized read is pinned to a block number, so a failover between nodes cannot change its block. It is at
      // min(finalized block, head - minDepth): Polygon's finalized tag tracks close to the head, so requiring the tag
      // itself to be minDepth behind would never confirm; reading state minDepth blocks deep gives the same safety.
      const [head, finBlock] = await Promise.all([client.getBlockNumber(), client.getBlock({ blockTag: "finalized" })]);
      // A finalized block without a number is a broken answer: fail closed rather than read it as "nothing final".
      if (finBlock.number === null) throw new Error(`${chain}: finalized block has no number`);
      const finalTarget = finalTargetOf(head, finBlock.number, info.minDepth);
      const finalized = finalTarget < 0n ? null : await balances(client, owner, assets, finalTarget, asset.id);
      const fin = finalized?.get(asset.id) ?? 0n;

      // `final` never exceeds `received` (a transfer that finalized and was then swept or reorged reads lower now).
      return { received: own, final: fin < own ? fin : own, txids: [], unexpected };
    },

    paymentUri(t: DepositTarget, asset: AssetInfo, amount: bigint): string {
      // EIP-681: native value in wei; a token is a transfer(address,uint256) call on the token contract.
      return asset.contract
        ? `ethereum:${asset.contract}${info.eip681}/transfer?address=${t.address}&uint256=${amount}`
        : `ethereum:${t.address}${info.eip681}?value=${amount}`;
    },
  };
}
