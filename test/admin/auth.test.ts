import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { deriveJs, hashPassword, verifyPassword } from "../../src/admin/password";

describe("password", () => {
  it("verifies the right password only", async () => {
    const { hash, salt } = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash, salt)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash, salt)).toBe(false);
  });
  it("uses 600,000 PBKDF2-SHA256 iterations and a 16-byte salt", async () => {
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    const { salt } = await hashPassword("some long password");
    const params = spy.mock.calls[0]![0] as { iterations: number; hash: string };
    spy.mockRestore();
    expect(params.iterations).toBe(600_000);
    expect(params.hash).toBe("SHA-256");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("pbkdf2 platform cap fallback", () => {
  it("pure-JS derivation is byte-identical to WebCrypto", async () => {
    const salt = new Uint8Array(16).fill(7);
    const { hash } = await hashPassword("same password", salt);
    expect(bytesToHex(await deriveJs("same password", salt))).toBe(hash);
  }, 60_000);

  it("falls back to JS when WebCrypto rejects the iteration count, and still verifies", async () => {
    const { hash, salt } = await hashPassword("limit password");
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("iteration counts above 100000 are not supported"));
    try {
      expect(await verifyPassword("limit password", hash, salt)).toBe(true);
      expect(await verifyPassword("other password", hash, salt)).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("rethrows unrelated WebCrypto errors", async () => {
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("boom"));
    try {
      await expect(hashPassword("x".repeat(12))).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
  });
});
