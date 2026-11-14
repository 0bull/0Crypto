import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { validateXmrAddress } from "../../src/routing/xmr";

// From the Monero docs / project donation page (mainnet primary, 4...) and the Monero docs subaddress example (8...).
const PRIMARY = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const SUB = "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H";

describe("validateXmrAddress", () => {
  it("accepts known valid primary and subaddresses", () => {
    expect(() => validateXmrAddress(PRIMARY)).not.toThrow();
    expect(() => validateXmrAddress(SUB)).not.toThrow();
  });
  it("rejects a bad checksum (one char changed)", () => {
    const bad = PRIMARY.slice(0, 50) + (PRIMARY[50] === "A" ? "B" : "A") + PRIMARY.slice(51);
    expect(() => validateXmrAddress(bad)).toThrow(/checksum/);
  });
  it("rejects wrong length, alphabet, prefix and non-strings", () => {
    expect(() => validateXmrAddress(PRIMARY.slice(1))).toThrow();
    expect(() => validateXmrAddress(PRIMARY + "A")).toThrow();
    expect(() => validateXmrAddress("4" + "0".repeat(94))).toThrow(/alphabet/);
    expect(() => validateXmrAddress("5" + PRIMARY.slice(1))).toThrow();
    expect(() => validateXmrAddress("")).toThrow();
    expect(() => validateXmrAddress(undefined as unknown as string)).toThrow();
    expect(() => validateXmrAddress(` ${PRIMARY}`)).toThrow();
  });
});

// Monero base58 encoder, only to build checksum-valid addresses on other networks.
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENC = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function encode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8) {
    const blk = bytes.slice(i, i + 8);
    let n = blk.reduce((a, b) => (a << 8n) | BigInt(b), 0n);
    let s = "";
    for (let k = 0; k < ENC[blk.length]!; k++) {
      s = ALPHA[Number(n % 58n)]! + s;
      n /= 58n;
    }
    out += s;
  }
  return out;
}
function build(prefix: number): string {
  const body = [prefix, ...Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff)];
  return encode([...body, ...keccak_256(Uint8Array.from(body)).slice(0, 4)]);
}

describe("other Monero networks are rejected even with a valid checksum", () => {
  it("encoder sanity: mainnet byte 18 builds a 95-char address that validates", () => {
    const a = build(18);
    expect(a).toHaveLength(95);
    expect(a[0]).toBe("4");
    expect(() => validateXmrAddress(a)).not.toThrow();
  });
  it.each([24, 25, 36, 53, 54, 63])("network byte %i", (b) => {
    const a = build(b);
    expect(a).toHaveLength(95);
    expect(() => validateXmrAddress(a)).toThrow(/start with 4 or 8|mainnet/);
  });
  it("a valid-checksum subaddress (network byte 42, leading 8) is accepted", () => {
    expect(() => validateXmrAddress(build(42))).not.toThrow();
  });
});
