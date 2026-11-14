import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

// Hand-written because Kit's findAssociatedTokenPda / getProgramDerivedAddress use subtle crypto, which throws in
// workerd (no isSecureContext). Pinned against Kit's Node build in test/node/solana-ata-vector.test.ts.
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARK = new TextEncoder().encode("ProgramDerivedAddress");

const onCurve = (b: Uint8Array): boolean => {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
};

function decode32(a: string): Uint8Array {
  const b = base58.decode(a);
  if (b.length !== 32) throw new Error("not a 32-byte address");
  return b;
}

/** True when `address` is a 32-byte point on the ed25519 curve: a wallet key, never a program derived address (an ATA). */
export function isOnCurve(address: string): boolean {
  try {
    return onCurve(decode32(address));
  } catch {
    return false;
  }
}

/** Program derived address of `seeds` under `programId`: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(programId: string, seeds: Uint8Array[]): [string, number] {
  const program = decode32(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARK];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!onCurve(h)) return [base58.encode(h), bump];
  }
  throw new Error("no program address bump found");
}

/** The associated token account of `owner` for `mint` (legacy SPL Token program): [address, bump]. */
export function findAta(owner: string, mint: string): [string, number] {
  return findProgramAddress(ASSOCIATED_TOKEN_PROGRAM, [decode32(owner), decode32(TOKEN_PROGRAM), decode32(mint)]);
}
