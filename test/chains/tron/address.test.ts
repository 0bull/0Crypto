import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { tronAddressFromPubkey, tronBase58ToHex, tronHexToBase58 } from "../../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../../src/signing/keys";
import { counterKey, chainConfigError } from "../../../src/chains/registry";
import { enabledAssets } from "../../../src/config";
import { CONFIRM_TIME, networkWarning } from "../../../src/web/checkout";
import { getAsset } from "../../../src/core/assets";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

describe("tron address encoding", () => {
  it("round-trips the USDT contract", () => {
    expect(tronBase58ToHex(USDT)).toBe(USDT_HEX);
    expect(tronHexToBase58(USDT_HEX)).toBe(USDT);
  });
  it("hex input: optional 0x, any case", () => {
    expect(tronHexToBase58("0x" + USDT_HEX)).toBe(USDT);
    expect(tronHexToBase58(USDT_HEX.toUpperCase())).toBe(USDT);
    expect(tronHexToBase58("0X" + USDT_HEX.toUpperCase())).toBe(USDT);
  });
  it("tronHexToBase58 rejects bad input", () => {
    expect(() => tronHexToBase58("")).toThrow();
    expect(() => tronHexToBase58(USDT_HEX.slice(2))).toThrow(); // 40 chars
    expect(() => tronHexToBase58(USDT_HEX + "00")).toThrow(); // 44 chars
    expect(() => tronHexToBase58("42" + USDT_HEX.slice(2))).toThrow(); // wrong prefix
    expect(() => tronHexToBase58("41" + "zz" + USDT_HEX.slice(4))).toThrow(); // non-hex
    expect(() => tronHexToBase58("0x0x" + USDT_HEX)).toThrow();
  });
  it("tronBase58ToHex rejects bad checksum, length, prefix, junk", () => {
    expect(() => tronBase58ToHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toThrow(); // bad checksum
    expect(() => tronBase58ToHex("")).toThrow();
    expect(() => tronBase58ToHex("0OIl")).toThrow(); // not base58
    expect(() => tronBase58ToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toThrow(); // valid BTC address: 0x00 prefix
    expect(() => tronBase58ToHex(USDT + USDT.slice(0, 3))).toThrow();
  });
  it("tronBase58ToHex rejects 20- and 22-byte payloads with a valid checksum and 0x41 prefix", () => {
    const b58c = createBase58check(sha256);
    for (const n of [20, 22]) {
      const raw = new Uint8Array(n).fill(7);
      raw[0] = 0x41;
      expect(() => tronBase58ToHex(b58c.encode(raw))).toThrow("invalid tron address");
    }
  });
  it("tronAddressFromPubkey rejects a 65-byte key not starting with 0x04", () => {
    const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    pub[0] = 0x05;
    expect(() => tronAddressFromPubkey(pub)).toThrow();
  });
  it("tronAddressFromPubkey rejects non-uncompressed keys", () => {
    expect(() => tronAddressFromPubkey(new Uint8Array(33))).toThrow();
  });
  it("address from an uncompressed pubkey", () => {
    const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    const addr = tronAddressFromPubkey(pub);
    expect(addr).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(tronHexToBase58(tronBase58ToHex(addr))).toBe(addr);
  });
});

describe("tron keys", () => {
  // Both vectors are cross-checked against viem's independent HD code in test/node/tron-viem-xcheck.test.ts.
  it("deposit index 0 of the abandon seed", () => {
    expect(tronDepositKey(SEED, 0).address).toBe("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
    expect(tronDepositKey(SEED, 0).priv).toHaveLength(32);
  });
  it("hot key is m/44'/195'/1'/0/0", () => {
    expect(tronHotKey(SEED).address).toBe("TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4");
  });
  it("indexes differ; seed is normalised; bad seed and index throw", () => {
    expect(tronDepositKey(SEED, 1).address).not.toBe(tronDepositKey(SEED, 0).address);
    expect(tronDepositKey(`  ${SEED.toUpperCase()}  `, 0).address).toBe(tronDepositKey(SEED, 0).address);
    expect(() => tronDepositKey("not a mnemonic", 0)).toThrow("not a valid BIP39 mnemonic");
    expect(() => tronHotKey("nope")).toThrow("not a valid BIP39 mnemonic");
    expect(() => tronDepositKey(SEED, -1)).toThrow();
    expect(() => tronDepositKey(SEED, 1.5)).toThrow();
    expect(() => tronDepositKey(SEED, 0x80000000)).toThrow();
  });
});

describe("tron:usdt asset", () => {
  it("registry entry", () => {
    expect(getAsset("tron:usdt")).toMatchObject({
      chain: "tron",
      symbol: "USDT",
      decimals: 6,
      contract: USDT,
      priceSymbol: "USDT",
      confirmations: 0,
    });
  });
  it("is enabled and usable with custody, TRONGRID_API_KEY and a valid seed", () => {
    const env = { ENABLED_ASSETS: "tron:usdt", ALLOW_SEED_CUSTODY: "true", MASTER_SEED: SEED, TRONGRID_API_KEY: "k" };
    expect(chainConfigError(env, "tron")).toBeNull();
    expect(enabledAssets(env).map((a) => a.id)).toEqual(["tron:usdt"]);
  });
  it("counterKey('tron') is 'tron'", () => {
    expect(counterKey("tron")).toBe("tron");
  });
});

describe("tron checkout text", () => {
  it("warning and confirm time", () => {
    expect(networkWarning({ chain: "tron", symbol: "USDT" })).toBe("Only send USDT on Tron (TRC-20). Other networks can't be credited automatically.");
    expect(CONFIRM_TIME.tron).toBe("About 1 minute");
  });
  it("keeps the other warnings", () => {
    expect(networkWarning({ chain: "eth", symbol: "USDC" })).toBe("Only send USDC on Ethereum. Other networks can't be credited automatically.");
    expect(networkWarning({ chain: "btc", symbol: "BTC" })).toBe("Only send BTC on the Bitcoin network. Other coins or networks can't be credited automatically.");
  });
});
