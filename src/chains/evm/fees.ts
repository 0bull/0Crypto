import type { PublicClient } from "viem";
import type { EvmChain } from "./config";

// EVM fee rules shared by the sweeper (sweep/evm.ts) and the Railgun shield executor (routing/railgun/execute.ts).
// No viem value import: types only.

/** A replacement tx pays the previous fees x BUMP_NUM / BUMP_DEN. */
export const BUMP_NUM = 13n;
export const BUMP_DEN = 10n;
/** Ethereum mainnet: skip when the gas costs more than this share of the value moved (percent). */
export const MAX_COST_PERCENT = 5n;

/** Fee fields of a signed request (strings: bigint in JSON). */
export interface EvmFee {
  type: "eip1559" | "legacy";
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}
export interface Quote {
  gasLimit: bigint;
  fee: EvmFee;
  /** Worst-case cost in wei: gas limit x max fee. */
  cost: bigint;
}

/**
 * EIP-1559 chains: maxFeePerGas = 2 x base fee + tip. BSC (and any node without a base fee) uses a plain gas price.
 * `gasLimit` is the estimate + 20% (added by the caller); `cost` is gas limit x max fee, i.e. estimate x fee x 1.2.
 */
export async function evmFeeQuote(client: PublicClient, chain: EvmChain, gasLimit: bigint): Promise<Quote> {
  const legacy = async (): Promise<Quote> => {
    const gasPrice = await client.getGasPrice();
    return { gasLimit, fee: { type: "legacy", gasPrice: gasPrice.toString() }, cost: gasLimit * gasPrice };
  };
  if (chain === "bsc") return legacy();
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.baseFeePerGas == null) return legacy();
  const tip = await client.estimateMaxPriorityFeePerGas({ chain: client.chain });
  const maxFee = 2n * block.baseFeePerGas + tip;
  return { gasLimit, fee: { type: "eip1559", maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: tip.toString() }, cost: gasLimit * maxFee };
}
