import type { ChainId } from "../../core/types";

export type EvmChain = "eth" | "base" | "arb" | "polygon" | "bsc";
export type EvmRpcVar = "EVM_RPC_ETH" | "EVM_RPC_BASE" | "EVM_RPC_ARB" | "EVM_RPC_POLYGON" | "EVM_RPC_BSC";

export interface EvmChainInfo {
  chainId: number;
  nativeSymbol: "ETH" | "POL" | "BNB";
  /** Extra blocks required between the finalized block and the head (Polygon only). */
  minDepth: number;
  rpcVar: EvmRpcVar;
  /** EIP-681 chain suffix: `ethereum:<address>@<chainId>`. */
  eip681: string;
}

export const EVM_CHAINS: Record<EvmChain, EvmChainInfo> = {
  eth: { chainId: 1, nativeSymbol: "ETH", minDepth: 0, rpcVar: "EVM_RPC_ETH", eip681: "@1" },
  base: { chainId: 8453, nativeSymbol: "ETH", minDepth: 0, rpcVar: "EVM_RPC_BASE", eip681: "@8453" },
  arb: { chainId: 42161, nativeSymbol: "ETH", minDepth: 0, rpcVar: "EVM_RPC_ARB", eip681: "@42161" },
  polygon: { chainId: 137, nativeSymbol: "POL", minDepth: 64, rpcVar: "EVM_RPC_POLYGON", eip681: "@137" },
  bsc: { chainId: 56, nativeSymbol: "BNB", minDepth: 0, rpcVar: "EVM_RPC_BSC", eip681: "@56" },
};

export const isEvmChain = (chain: ChainId): chain is EvmChain => Object.hasOwn(EVM_CHAINS, chain);

/** RPC URLs configured for a chain: comma-separated, trimmed, empties dropped. */
export function rpcUrls(env: Partial<Record<EvmRpcVar, string>>, chain: EvmChain): string[] {
  return (env[EVM_CHAINS[chain].rpcVar] ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/**
 * The block whose state counts as final: the finalized block, but never closer to the head than `minDepth` blocks
 * (Polygon's finalized tag tracks close to the head, so state minDepth blocks deep gives the extra safety).
 */
export function finalTarget(head: bigint, finalized: bigint, minDepth: number): bigint {
  const deep = head - BigInt(minDepth);
  return finalized < deep ? finalized : deep;
}

/** No configured RPC URL of the chain answered with the chain's id: reads and sends fail closed. */
export class ChainIdMismatch extends Error {
  override name = "ChainIdMismatch";
}

/** The chain id each RPC URL reported, asked once per URL per isolate (see evmClient). Unreachable URLs are not kept. */
export const reportedChainIds = new Map<string, number>();
/** Tests only. */
export const clearChainIdMemo = () => reportedChainIds.clear();
/** Makes evmClient ask the chain's URLs again (after a node is seen answering for another chain). */
export function forgetChainIds(env: Partial<Record<EvmRpcVar, string>>, chain: EvmChain): void {
  for (const u of rpcUrls(env, chain)) reportedChainIds.delete(u);
}

/**
 * The official wrapped-native contract of each chain (Railgun shields ERC-20s only, so native is wrapped first):
 * - eth WETH9: etherscan.io/token/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 (the canonical WETH9 deployment)
 * - base WETH: the OP Stack predeploy 0x4200…0006 (docs.base.org, "Contract addresses"; specs.optimism.io predeploys)
 * - arb WETH: docs.arbitrum.io, "Contract addresses" (Arbitrum One WETH, L2 token of the canonical bridge)
 * - polygon WPOL (formerly WMATIC): polygonscan.com/token/0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270
 * - bsc WBNB: bscscan.com/token/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c
 * Each has deposit() (0xd0e30db0) and a receive that deposits.
 */
export const WRAPPED_NATIVE: Record<EvmChain, `0x${string}`> = {
  eth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
  arb: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
};

/** RailgunSmartWallet proxy per chain, from the spec's "Privacy routing" table. */
export const RAILGUN_PROXY: Record<EvmChain, `0x${string}`> = {
  eth: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
  arb: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
  bsc: "0x590162bf4b50f6576a459b75309ee21d92178a10",
  polygon: "0x19b620929f97b7b990801496c3b361ca5def8c71",
  base: "0x0047d1F97674614189E80566575FB615788AcF25",
};

/**
 * Native coin kept back from routing on each chain's hot wallet, for gas (plan 4 "Native gas reserve"): 0.02 ETH on
 * Ethereum, 0.002 ETH on Base and Arbitrum, 5 POL, 0.01 BNB. The router routes hot balance minus this; the Railgun
 * shield executor also refuses a wrap that would leave less than it (plus the gas still to come).
 */
export const GAS_RESERVE: Record<EvmChain, bigint> = {
  eth: 20_000_000_000_000_000n,
  base: 2_000_000_000_000_000n,
  arb: 2_000_000_000_000_000n,
  polygon: 5_000_000_000_000_000_000n,
  bsc: 10_000_000_000_000_000n,
};

/** The EVM chain of an EIP-155 chain id, or null. */
export const evmChainOf = (chainId: number): EvmChain | null => (Object.keys(EVM_CHAINS) as EvmChain[]).find((c) => EVM_CHAINS[c].chainId === chainId) ?? null;
