import { keccak_256 } from "@noble/hashes/sha3.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Monero base58 encodes 8-byte blocks as 11 chars; a final partial block of n bytes takes ENC_LEN[n] chars. */
const ENC_LEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK = 11;

export class InvalidXmrAddress extends Error {
  constructor(reason: string) {
    super(`invalid XMR address: ${reason}`);
    this.name = "InvalidXmrAddress";
  }
}

function decodeBlock(chars: string, byteLen: number): Uint8Array {
  let n = 0n;
  for (const c of chars) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new InvalidXmrAddress("character outside the base58 alphabet");
    n = n * 58n + BigInt(i);
  }
  if (n >= 1n << BigInt(8 * byteLen)) throw new InvalidXmrAddress("block overflow");
  const out = new Uint8Array(byteLen);
  for (let i = byteLen - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Validates a Monero mainnet standard address (prefix byte 18, starts with "4") or subaddress (42, starts with "8"):
 * exactly 95 chars of Monero base58, with the 4-byte Keccak-256 checksum verified. Integrated addresses are refused.
 * Throws InvalidXmrAddress; returns the address unchanged.
 */
export function validateXmrAddress(addr: string): string {
  if (typeof addr !== "string" || addr.length !== 95) throw new InvalidXmrAddress("must be 95 characters");
  if (addr[0] !== "4" && addr[0] !== "8") throw new InvalidXmrAddress("must start with 4 or 8");
  const bytes: number[] = [];
  for (let i = 0; i < addr.length; i += FULL_BLOCK) {
    const chunk = addr.slice(i, i + FULL_BLOCK);
    const byteLen = chunk.length === FULL_BLOCK ? 8 : ENC_LEN.indexOf(chunk.length);
    if (byteLen < 0) throw new InvalidXmrAddress("bad block length");
    bytes.push(...decodeBlock(chunk, byteLen));
  }
  if (bytes.length !== 69) throw new InvalidXmrAddress("bad decoded length");
  const prefix = bytes[0];
  if (!((prefix === 18 && addr[0] === "4") || (prefix === 42 && addr[0] === "8"))) throw new InvalidXmrAddress("not a mainnet standard address or subaddress");
  const sum = keccak_256(Uint8Array.from(bytes.slice(0, 65))).slice(0, 4);
  for (let i = 0; i < 4; i++) if (sum[i] !== bytes[65 + i]) throw new InvalidXmrAddress("checksum mismatch");
  return addr;
}
