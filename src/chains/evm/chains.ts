import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, bsc, mainnet, polygon } from "viem/chains";
import { ChainIdMismatch, EVM_CHAINS, reportedChainIds, rpcUrls, type EvmChain, type EvmRpcVar } from "./config";

// The registry data lives in ./config (no viem import) so chain configuration checks stay cheap to load.
export * from "./config";

export const VIEM_CHAINS: Record<EvmChain, Chain> = { eth: mainnet, base, arb: arbitrum, polygon, bsc };

// No transport-level retries: the fallback list is the retry, and the watcher's own backoff covers the rest.
// No JSON-RPC batching either: an RPC that refuses batches would fail every batched read while single calls (and the
// health check) still succeed.
const transport = (url: string) => http(url, { timeout: 10_000, retryCount: 0 });

/**
 * A viem public client over the chain's RPC URLs that report the chain's id, tried in order. Each URL's eth_chainId is
 * asked once per isolate (memoised by URL). A URL on another chain is dropped with a warning (naming the variable and
 * the URL's position, never the URL: it may hold an API key). A URL that cannot be asked is left out this time and
 * asked again next time. Throws when none is configured, ChainIdMismatch when no URL is left and at least one is on
 * another chain, and the RPC error when every URL was unreachable. So every read and send fails closed.
 */
export async function evmClient(env: Partial<Record<EvmRpcVar, string>>, chain: EvmChain): Promise<PublicClient> {
  const info = EVM_CHAINS[chain];
  const urls = rpcUrls(env, chain);
  if (urls.length === 0) throw new Error(`${info.rpcVar} is not set (no RPC URL for ${chain})`);
  let unreachable: unknown = null;
  await Promise.all(
    urls.map(async (url, i) => {
      if (reportedChainIds.has(url)) return;
      try {
        const id = await createPublicClient({ transport: transport(url) }).getChainId();
        reportedChainIds.set(url, id);
        if (id !== info.chainId) console.warn(`0crypto: ${info.rpcVar} URL #${i + 1} is on chain id ${id}, expected ${info.chainId} (${chain}); it is not used`);
      } catch (e) {
        unreachable ??= e;
      }
    }),
  );
  const good = urls.filter((u) => reportedChainIds.get(u) === info.chainId);
  if (good.length === 0) {
    if (urls.some((u) => reportedChainIds.has(u))) throw new ChainIdMismatch(`no ${info.rpcVar} URL is on chain id ${info.chainId} (${chain})`);
    throw unreachable;
  }
  return createPublicClient({ chain: VIEM_CHAINS[chain], transport: fallback(good.map(transport), { retryCount: 0 }) }) as PublicClient;
}
