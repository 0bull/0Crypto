import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const PBKDF2_ITERATIONS = 600_000;

/** Pure-JS PBKDF2, byte-identical to WebCrypto; used when the platform caps WebCrypto iterations. */
export const deriveJs = (pw: string, salt: Uint8Array): Promise<Uint8Array> =>
  pbkdf2Async(sha256, new TextEncoder().encode(pw), salt, { c: PBKDF2_ITERATIONS, dkLen: 32 });

// Production Workers have capped WebCrypto PBKDF2 iterations (workerd #1346); fall back to JS on that error only.
async function derive(pw: string, salt: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
    return new Uint8Array(bits);
  } catch (e) {
    if (e instanceof Error && /iteration/i.test(e.message)) return deriveJs(pw, salt);
    throw e;
  }
}

/** Constant-time equality for equal-length byte arrays (length mismatch is not secret). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function hashPassword(pw: string, salt?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  return { hash: bytesToHex(await derive(pw, s)), salt: bytesToHex(s) };
}

export async function verifyPassword(pw: string, hash: string, salt: string): Promise<boolean> {
  let expected: Uint8Array, s: Uint8Array;
  try {
    expected = hexToBytes(hash);
    s = hexToBytes(salt);
  } catch {
    return false;
  }
  return timingSafeEqual(await derive(pw, s), expected);
}
