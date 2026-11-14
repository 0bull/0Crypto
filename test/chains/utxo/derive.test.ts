import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { accountFromSeed, accountFromXpub, deriveUtxoAddress } from "../../../src/chains/utxo/derive";
import { utxoSeedAccount } from "../../../src/signing/keys";
import { UTXO_NETWORKS, type UtxoChain } from "../../../src/chains/utxo/networks";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const b58c = createBase58check(sha256);

// BTC: official BIP84 test vectors. LTC/DOGE: produced by scripts/vectors.mjs
// (bitcoinjs-lib, independent of @scure), which reproduces the BTC vectors below.
const VECTORS: Record<UtxoChain, [string, string]> = {
  btc: ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"],
  ltc: ["ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh", "ltc1qwlezpr3890hcp6vva9twqh27mr6edadreqvhnn"],
  doge: ["DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC", "DAcDAtJRztxBHyA6D6h8du1HguyTR43Mas"],
};
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

/** Re-serialize an extended key with a different 4-byte version. */
function withVersion(key: string, version: number): string {
  const raw = b58c.decode(key);
  new DataView(raw.buffer, raw.byteOffset).setUint32(0, version);
  return b58c.encode(raw);
}

describe("seed derivation vectors", () => {
  for (const chain of ["btc", "ltc", "doge"] as const) {
    it(`${chain} index 0 and 1 match independent vectors`, () => {
      const account = accountFromSeed(MNEMONIC, chain);
      expect(deriveUtxoAddress(account, chain, 0)).toBe(VECTORS[chain][0]);
      expect(deriveUtxoAddress(account, chain, 1)).toBe(VECTORS[chain][1]);
    });
  }
  it("network table has the spec values", () => {
    expect(UTXO_NETWORKS.btc).toMatchObject({ bech32: "bc", path: "m/84'/0'/0'", type: "p2wpkh", pubKeyHash: 0, scriptHash: 5, wif: 0x80 });
    expect(UTXO_NETWORKS.ltc).toMatchObject({ bech32: "ltc", pubKeyHash: 48, scriptHash: 50, path: "m/84'/2'/0'", type: "p2wpkh" });
    expect(UTXO_NETWORKS.doge).toMatchObject({ pubKeyHash: 30, scriptHash: 22, wif: 158, path: "m/44'/3'/0'", type: "p2pkh", bip32: { public: 0x02facafd, private: 0x02fac398 } });
  });
  it("ltc decodes as bech32 hrp ltc with a 20-byte program", () => {
    const a = deriveUtxoAddress(accountFromSeed(MNEMONIC, "ltc"), "ltc", 0);
    expect(a.startsWith("ltc1q")).toBe(true);
    const d = bech32.decode(a as `ltc1${string}`);
    expect(d.prefix).toBe("ltc");
    expect(d.words[0]).toBe(0);
    expect(bech32.fromWords(d.words.slice(1)).length).toBe(20);
  });
  it("doge is base58check with version byte 30", () => {
    const a = deriveUtxoAddress(accountFromSeed(MNEMONIC, "doge"), "doge", 0);
    expect(a.startsWith("D")).toBe(true);
    const raw = b58c.decode(a);
    expect(raw[0]).toBe(30);
    expect(raw.length).toBe(21);
  });
});

describe("accountFromXpub", () => {
  it("BIP84 zpub derives the BIP84 index 0 and 1 addresses", () => {
    const acct = accountFromXpub(BIP84_ZPUB, "btc");
    expect(deriveUtxoAddress(acct, "btc", 0)).toBe(VECTORS.btc[0]);
    expect(deriveUtxoAddress(acct, "btc", 1)).toBe(VECTORS.btc[1]);
  });
  for (const chain of ["btc", "ltc", "doge"] as const) {
    it(`${chain}: seed -> exported account pubkey -> accountFromXpub round-trips`, () => {
      const exported = accountFromSeed(MNEMONIC, chain).publicExtendedKey;
      const acct = accountFromXpub(exported, chain);
      for (const i of [0, 1, 7]) {
        expect(deriveUtxoAddress(acct, chain, i)).toBe(deriveUtxoAddress(accountFromSeed(MNEMONIC, chain), chain, i));
      }
      expect(acct.privateKey).toBeNull();
    });
  }
  it("accepts every supported public prefix, giving identical addresses", () => {
    const xpub = accountFromSeed(MNEMONIC, "btc").publicExtendedKey;
    const accepted: Record<UtxoChain, number[]> = {
      btc: [0x0488b21e, 0x04b24746],
      ltc: [0x019da462, 0x04b24746, 0x0488b21e],
      doge: [0x02facafd, 0x0488b21e],
    };
    for (const chain of ["btc", "ltc", "doge"] as const) {
      const expected = deriveUtxoAddress(accountFromXpub(xpub, chain), chain, 3);
      for (const v of accepted[chain]) {
        expect(deriveUtxoAddress(accountFromXpub(withVersion(xpub, v), chain), chain, 3)).toBe(expected);
      }
    }
  });
  it("refuses private keys of any known prefix", () => {
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    expect(() => accountFromXpub(xprv, "btc")).toThrow("refusing private key");
    for (const v of [0x04b2430c, 0x019d9cfe, 0x01b26792, 0x02fac398, 0x04358394, 0x049d7878]) {
      expect(() => accountFromXpub(withVersion(xprv, v), "ltc")).toThrow("refusing private key");
    }
  });
  it("refuses a private payload even under a public version", () => {
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    expect(() => accountFromXpub(withVersion(xprv, 0x0488b21e), "btc")).toThrow("refusing private key");
  });
  it("rejects unknown versions (testnet tpub, ypub, other chain's prefix)", () => {
    const xpub = accountFromSeed(MNEMONIC, "btc").publicExtendedKey;
    expect(() => accountFromXpub(withVersion(xpub, 0x043587cf), "btc")).toThrow("unsupported xpub version");
    expect(() => accountFromXpub(withVersion(xpub, 0x049d7cb2), "btc")).toThrow("unsupported xpub version");
    expect(() => accountFromXpub(withVersion(xpub, 0x019da462), "btc")).toThrow("unsupported xpub version");
    expect(() => accountFromXpub(withVersion(xpub, 0x02facafd), "ltc")).toThrow("unsupported xpub version");
  });
  it("accountFromSeed (outside src/signing) carries no private key, and matches the private account's public part", () => {
    for (const chain of ["btc", "ltc", "doge"] as const) {
      const pub = accountFromSeed(MNEMONIC, chain);
      expect(pub.privateKey).toBeNull();
      expect(pub.publicExtendedKey).toBe(utxoSeedAccount(MNEMONIC, chain).publicExtendedKey);
    }
  });
  it("rejects Mtub (BIP49 P2SH) for ltc, and Mtpv as a private key", () => {
    const xpub = accountFromSeed(MNEMONIC, "ltc").publicExtendedKey;
    expect(() => accountFromXpub(withVersion(xpub, 0x01b26ef6), "ltc")).toThrow("unsupported xpub version");
    // accountFromSeed is public-only now; the private account lives in src/signing/keys.
    const xprv = utxoSeedAccount(MNEMONIC, "ltc").privateExtendedKey;
    expect(() => accountFromXpub(withVersion(xprv, 0x01b26792), "ltc")).toThrow("refusing private key");
  });
  it("rejects depth >= 4 keys but accepts shallower ones", () => {
    for (const chain of ["btc", "ltc", "doge"] as const) {
      const acct = accountFromSeed(MNEMONIC, chain);
      const external = acct.deriveChild(0); // depth 4
      expect(() => accountFromXpub(external.publicExtendedKey, chain)).toThrow("xpub depth too deep: expected an account-level key");
      const addrLevel = external.deriveChild(0);
      expect(() => accountFromXpub(addrLevel.publicExtendedKey, chain)).toThrow("xpub depth too deep");
    }
    // Electrum-style depth-1 key is still accepted
    const depth1 = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).deriveChild(0);
    expect(depth1.depth).toBe(1);
    expect(() => accountFromXpub(depth1.publicExtendedKey, "btc")).not.toThrow();
  });
  it("rejects garbage", () => {
    expect(() => accountFromXpub("not-a-key", "btc")).toThrow();
  });
});

describe("deriveUtxoAddress index validation", () => {
  const acct = accountFromSeed(MNEMONIC, "btc");
  it("rejects negative, non-integer, non-finite and hardened-range indices", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 31, 2 ** 31 + 1, 2 ** 32]) {
      expect(() => deriveUtxoAddress(acct, "btc", bad)).toThrow();
    }
  });
  it("accepts the max non-hardened index", () => {
    expect(() => deriveUtxoAddress(acct, "btc", 2 ** 31 - 1)).not.toThrow();
  });
});
