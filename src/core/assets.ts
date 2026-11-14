import { EVM_CHAINS, type EvmChain } from "../chains/evm/config";
import type { AssetId, AssetInfo, ChainId } from "./types";

type Token = { symbol: "USDC" | "USDT" | "DAI"; decimals: number; contract: string };

// Token table from the spec. No USDT on Base; bridged USDC.e is never listed; BSC stablecoins are 18 decimals.
const TOKENS: Record<EvmChain, Token[]> = {
  eth: [
    { symbol: "USDC", decimals: 6, contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "USDT", decimals: 6, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "DAI", decimals: 18, contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  ],
  base: [
    { symbol: "USDC", decimals: 6, contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { symbol: "DAI", decimals: 18, contract: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  ],
  arb: [
    { symbol: "USDC", decimals: 6, contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    { symbol: "USDT", decimals: 6, contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
    { symbol: "DAI", decimals: 18, contract: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" },
  ],
  polygon: [
    { symbol: "USDC", decimals: 6, contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
    { symbol: "USDT", decimals: 6, contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
    { symbol: "DAI", decimals: 18, contract: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
  ],
  bsc: [
    { symbol: "USDC", decimals: 18, contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    { symbol: "USDT", decimals: 18, contract: "0x55d398326f99059fF775485246999027B3197955" },
    { symbol: "DAI", decimals: 18, contract: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" },
  ],
};

/** EVM finality comes from the `finalized` block tag, so `confirmations` is 0 here. */
function evmAssets(): Record<AssetId, AssetInfo> {
  const out: Record<AssetId, AssetInfo> = {};
  for (const chain of Object.keys(EVM_CHAINS) as EvmChain[]) {
    const { nativeSymbol } = EVM_CHAINS[chain];
    const add = (info: Omit<AssetInfo, "id" | "chain" | "confirmations">) => {
      const id = `${chain}:${info.symbol.toLowerCase()}`;
      out[id] = { id, chain, confirmations: 0, ...info };
    };
    add({ symbol: nativeSymbol, decimals: 18, priceSymbol: nativeSymbol }); // native price symbol = its own symbol
    for (const t of TOKENS[chain]) add({ symbol: t.symbol, decimals: t.decimals, contract: t.contract, priceSymbol: t.symbol });
  }
  return out;
}

export const ASSETS: Record<AssetId, AssetInfo> = {
  "btc:btc": { id: "btc:btc", chain: "btc", symbol: "BTC", decimals: 8, priceSymbol: "BTC", confirmations: 2 },
  "ltc:ltc": { id: "ltc:ltc", chain: "ltc", symbol: "LTC", decimals: 8, priceSymbol: "LTC", confirmations: 6 },
  "doge:doge": { id: "doge:doge", chain: "doge", symbol: "DOGE", decimals: 8, priceSymbol: "DOGE", confirmations: 20 },
  ...evmAssets(),
  // Tron finality comes from the solidity node, so `confirmations` is 0. TRX is registered detection-only.
  "tron:usdt": {
    id: "tron:usdt",
    chain: "tron",
    symbol: "USDT",
    decimals: 6,
    contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    priceSymbol: "USDT",
    confirmations: 0,
  },
  // Solana credits at the `finalized` commitment, so `confirmations` is 0.
  "sol:sol": { id: "sol:sol", chain: "sol", symbol: "SOL", decimals: 9, priceSymbol: "SOL", confirmations: 0 },
  "sol:usdc": {
    id: "sol:usdc",
    chain: "sol",
    symbol: "USDC",
    decimals: 6,
    contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    priceSymbol: "USDC",
    confirmations: 0,
  },
  // Lightning (NWC): 11 decimals = msat. Settled means final; the funds stay in the merchant's hosted wallet (never routed).
  "ln:btc": { id: "ln:btc", chain: "ln", symbol: "BTC", decimals: 11, priceSymbol: "BTC", confirmations: 0 },
  // Detection only: TRX sent to a deposit address shows up as an unexpected deposit; it is never a payment asset.
  "tron:trx": { id: "tron:trx", chain: "tron", symbol: "TRX", decimals: 6, priceSymbol: "TRX", confirmations: 0, detectionOnly: true },
};

export function getAsset(id: AssetId): AssetInfo {
  const asset = Object.hasOwn(ASSETS, id) ? ASSETS[id] : undefined;
  if (!asset) throw new Error(`unknown asset: ${id}`);
  return asset;
}

/** Every registry asset of a chain (native first), whether or not it is enabled. */
export function chainAssets(chain: ChainId): AssetInfo[] {
  return Object.values(ASSETS).filter((a) => a.chain === chain);
}
