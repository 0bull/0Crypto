import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";

const b58c = createBase58check(sha256);
const PREFIX = 0x41;

/** Tron address of a 65-byte uncompressed secp256k1 pubkey: base58check(0x41 || keccak256(pub[1:])[12:]). */
export function tronAddressFromPubkey(uncompressed65: Uint8Array): string {
  if (uncompressed65.length !== 65 || uncompressed65[0] !== 0x04) throw new Error("expected a 65-byte uncompressed public key");
  const body = keccak_256(uncompressed65.subarray(1)).subarray(12);
  const raw = new Uint8Array(21);
  raw[0] = PREFIX;
  raw.set(body, 1);
  return b58c.encode(raw);
}

/** 42-char hex (0x41 + 20 bytes, optional "0x", any case) to base58check. Throws on anything else. */
export function tronHexToBase58(hex41: string): string {
  const h = hex41.startsWith("0x") || hex41.startsWith("0X") ? hex41.slice(2) : hex41;
  if (!/^[0-9a-fA-F]{42}$/.test(h) || h.slice(0, 2) !== "41") throw new Error("invalid tron hex address");
  return b58c.encode(hexToBytes(h));
}

/** Base58check Tron address to lowercase 42-char hex (no 0x). Throws unless 21 bytes, 0x41 prefix, valid checksum. */
export function tronBase58ToHex(addr: string): string {
  let raw: Uint8Array;
  try {
    raw = b58c.decode(addr);
  } catch {
    throw new Error("invalid tron address");
  }
  if (raw.length !== 21 || raw[0] !== PREFIX) throw new Error("invalid tron address");
  return bytesToHex(raw);
}
