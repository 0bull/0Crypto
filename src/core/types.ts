export type ChainId = "btc" | "ltc" | "doge" | "eth" | "base" | "arb" | "polygon" | "bsc" | "tron" | "sol" | "ln";

/** Format: "<chain>:<symbol lowercase>", e.g. "btc:btc", "base:usdc". */
export type AssetId = string;

export interface AssetInfo {
  id: AssetId;
  chain: ChainId;
  symbol: string;
  decimals: number;
  contract?: string;
  priceSymbol: string;
  confirmations: number;
  /** Registry-only: recognised in unexpected-deposit reports (symbol, decimals) but never offered for payment. */
  detectionOnly?: true;
}

export interface DepositTarget {
  paymentId: string;
  chain: ChainId;
  asset: AssetId;
  address: string;
  derivationIndex: number;
  createdAt: number;
  reference?: string;
}

/** Cumulative amounts in atomic units; `final` <= `received`. */
export interface Observation {
  received: bigint;
  final: bigint;
  txids: string[];
  /** EVM only: balances of the address's other assets (non-zero), keyed by asset id. Never credited. */
  unexpected?: Record<AssetId, bigint>;
  /** Lightning only: when the wallet says the invoice settled (unix ms). state.ts uses it, clamped to [created, now], as the detection time. */
  settledAt?: number;
}

export interface ChainAdapter {
  chain: ChainId;
  deriveAddress(index: number): Promise<string>;
  observe(t: DepositTarget, asset: AssetInfo): Promise<Observation>;
  paymentUri(t: DepositTarget, asset: AssetInfo, amount: bigint): string;
}
