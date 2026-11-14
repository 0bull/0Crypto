import { base58 } from "@scure/base";
import { Address } from "@scure/btc-signer";
import { tronBase58ToHex } from "../chains/tron/address";
import { UTXO_NETWORKS, type UtxoChain } from "../chains/utxo/networks";
import { getAsset } from "../core/assets";
import type { AssetId } from "../core/types";

/**
 * Validates an address for the source asset's chain: mainnet only, correct HRP or version byte.
 * BTC/LTC/DOGE decode with that chain's own parameters; Tron needs the 0x41 prefix and a good checksum;
 * Solana must be base58 that decodes to 32 bytes. Throws on anything else; returns the address unchanged.
 */
export function validateAssetAddress(asset: AssetId, addr: string): string {
  if (typeof addr !== "string" || addr === "" || addr !== addr.trim()) throw new Error("invalid address");
  const chain = getAsset(asset).chain;
  if (chain === "btc" || chain === "ltc" || chain === "doge") {
    const net = UTXO_NETWORKS[chain as UtxoChain];
    try {
      Address({ bech32: net.bech32 ?? "", pubKeyHash: net.pubKeyHash, scriptHash: net.scriptHash, wif: net.wif }).decode(addr);
    } catch {
      throw new Error(`invalid ${chain} address`);
    }
    return addr;
  }
  if (chain === "tron") {
    tronBase58ToHex(addr);
    return addr;
  }
  if (chain === "sol") {
    let raw: Uint8Array;
    try {
      raw = base58.decode(addr);
    } catch {
      throw new Error("invalid solana address");
    }
    if (raw.length !== 32) throw new Error("invalid solana address");
    return addr;
  }
  throw new Error(`no address validation for ${chain}`);
}
