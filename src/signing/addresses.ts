import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import type { UtxoChain } from "../chains/utxo/networks";
import { UTXO_NETWORKS } from "../chains/utxo/networks";
import { evmSaltKey, solDepositKey, solHotKey, tronDepositKey, tronHotKey, utxoSeedAccount } from "./keys";

/*
 * What code outside src/signing may know about our keys: addresses and public keys, never private material. Signers
 * take a KeySpec and derive the key themselves.
 */

/** Which of our keys signs: the chain's hot wallet, or the deposit at a derivation index. */
export type KeySpec = { role: "hot" } | { role: "deposit"; index: number };

/** Tron hot wallet address (m/44'/195'/1'/0/0). */
export function tronHotAddress(seed: string): string {
  return tronHotKey(seed).address;
}
/** Tron deposit address m/44'/195'/0'/0/i. */
export function tronDepositAddress(seed: string, i: number): string {
  return tronDepositKey(seed, i).address;
}
/** Solana hot wallet address (m/44'/501'/2147483646'/0'). */
export function solHotAddress(seed: string): string {
  return solHotKey(seed).address;
}
/** Solana deposit address m/44'/501'/i'/0'. */
export function solDepositAddress(seed: string, i: number): string {
  return solDepositKey(seed, i).address;
}
/** The EVM hot wallet address (m/44'/60'/0'/0/0). Async: viem/accounts loads on demand. */
export async function evmHotAddress(env: { MASTER_SEED?: string }): Promise<`0x${string}`> {
  return (await import("./evmkeys")).hotAccount(env).address;
}
/** Domain tag of the salt HMAC: a new version means new addresses, so it never changes for existing payments. */
const SALT_TAG = new TextEncoder().encode("0crypto/evm-deposit-salt/v1");

/**
 * CREATE2 salt of the EVM deposit forwarder at index i: HMAC-SHA256(evmSaltKey, tag || uint32be(i)). Without
 * MASTER_SEED nobody can work out other payments' deposit addresses from one they saw. Not key material: a salt only
 * names a forwarder, and every forwarder pays only the hot wallet. A sweep reveals the salts it flushes, never others.
 */
export function evmDepositSalt(seed: string, i: number): `0x${string}` {
  if (!Number.isInteger(i) || i < 0 || i > 0x7fffffff) throw new Error("deposit index must be an integer from 0 to 2147483647");
  const msg = new Uint8Array(SALT_TAG.length + 4);
  msg.set(SALT_TAG);
  new DataView(msg.buffer).setUint32(SALT_TAG.length, i);
  return `0x${bytesToHex(hmac(sha256, evmSaltKey(seed), msg))}`;
}
/** Account-level UTXO key from the mnemonic, PUBLIC part only (deposit addresses in routed mode). */
export function accountFromSeed(mnemonic: string, chain: UtxoChain): HDKey {
  return HDKey.fromExtendedKey(utxoSeedAccount(mnemonic, chain).publicExtendedKey, UTXO_NETWORKS[chain].bip32);
}
