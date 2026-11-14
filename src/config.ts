import { isEvmChain } from "./chains/evm/config";
import { lightningRefused } from "./chains/lightning/adapter";
import { chainConfigError, type ChainEnv } from "./chains/registry";
import { getAsset } from "./core/assets";
import type { AssetInfo } from "./core/types";
import type { Env } from "./env";

const warned = new Set<string>();

/**
 * Assets listed in ENABLED_ASSETS that this configuration can actually serve. An unusable one
 * (e.g. no xpub and no custody opt-in) is left out and logged once per isolate, so checkout and the
 * API never offer it. Throws on an unknown asset id.
 */
export function enabledAssets(env: Pick<Env, "ENABLED_ASSETS"> & ChainEnv): AssetInfo[] {
  return env.ENABLED_ASSETS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(getAsset)
    .filter((a) => {
      const problem = a.detectionOnly ? "detection-only, never offered for payment" : chainConfigError(env, a.chain);
      if (problem && !warned.has(a.id)) {
        warned.add(a.id);
        console.warn(`0crypto: ${a.id} is disabled: ${problem}`);
      }
      return problem === null;
    });
}

/**
 * `enabledAssets` minus the assets of EVM chains whose forwarder factory is not deployed (payments there could be
 * received but never swept), and minus Lightning when its NWC connection was refused (cached get_info verdict, one KV
 * read, no relay call). Reads the EVM health check through its in-isolate memo and KV cache, so a request normally costs no RPC call and no KV read.
 */
export async function usableAssets(env: Env): Promise<AssetInfo[]> {
  let assets = enabledAssets(env);
  if (assets.some((a) => a.chain === "ln") && (await lightningRefused(env))) assets = assets.filter((a) => a.chain !== "ln");
  const chains = [...new Set(assets.map((a) => a.chain).filter(isEvmChain))];
  if (chains.length === 0) return assets;
  const { evmHealth } = await import("./chains/evm/health");
  const ok = new Map(await Promise.all(chains.map(async (c) => [c, (await evmHealth(env, c)).factoryDeployed] as const)));
  return assets.filter((a) => !isEvmChain(a.chain) || ok.get(a.chain) === true);
}
