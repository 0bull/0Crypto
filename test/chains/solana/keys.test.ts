import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { slip10Ed25519, slip10Node, solDepositKey, solHotKey } from "../../../src/signing/keys";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const V1 = hexToBytes("000102030405060708090a0b0c0d0e0f");
const V2 = hexToBytes(
  "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542",
);

// SLIP-0010 ed25519 test vectors (https://github.com/satoshilabs/slips/blob/master/slip-0010.md): [path, chain code, private key].
const VECTOR1: [string, string, string][] = [
  ["m", "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb", "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"],
  ["m/0'", "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69", "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"],
  ["m/0'/1'", "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14", "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2"],
  ["m/0'/1'/2'", "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c", "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9"],
  ["m/0'/1'/2'/2'", "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc", "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662"],
  ["m/0'/1'/2'/2'/1000000000'", "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230", "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793"],
];
const VECTOR2: [string, string, string][] = [
  ["m", "ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b", "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012"],
  ["m/0'", "0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d", "1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635"],
];

describe("SLIP-10 ed25519", () => {
  it.each(VECTOR1)("vector 1 %s", (path, chain, priv) => {
    const n = slip10Node(V1, path);
    expect(bytesToHex(n.chainCode)).toBe(chain);
    expect(bytesToHex(n.key)).toBe(priv);
    expect(bytesToHex(slip10Ed25519(V1, path))).toBe(priv);
  });
  it.each(VECTOR2)("vector 2 %s", (path, chain, priv) => {
    const n = slip10Node(V2, path);
    expect(bytesToHex(n.chainCode)).toBe(chain);
    expect(bytesToHex(n.key)).toBe(priv);
  });
  it("rejects non-hardened segments and malformed paths", () => {
    for (const p of ["", "m/0", "m/0'/1", "0'", "m/", "m//0'", "m/0'/", "M/0'", "m/-1'", "m/1.5'", "m/0x1'", "m/01'", "m/2147483648'", "m/4294967296'", "m/0h", "m/ 0'", "m/0' ", "m/'", "m/1''"])
      expect(() => slip10Ed25519(V1, p), JSON.stringify(p)).toThrow();
  });
  it("accepts the largest hardened index", () => {
    expect(slip10Ed25519(V1, "m/2147483647'")).toHaveLength(32);
  });
});

describe("Solana keys", () => {
  it("deposit 0 is the pinned address (also cross-checked against ed25519-hd-key in test/node)", () => {
    const k = solDepositKey(SEED, 0);
    expect(k.address).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    expect(k.priv).toHaveLength(32);
    expect(k.pub).toHaveLength(32);
  });
  it("hot key is the pinned address", () => {
    expect(solHotKey(SEED).address).toBe("DZJcJWPaEvx8DB2naCC9CEDxpWcdRuiSg88N8uXRR3zo");
  });
  it("addresses are distinct per index; the hot key is none of the early deposits", () => {
    const set = new Set([0, 1, 2, 3, 1000].map((i) => solDepositKey(SEED, i).address));
    expect(set.size).toBe(5);
    expect(set.has(solHotKey(SEED).address)).toBe(false);
  });
  it("normalises the mnemonic and rejects an invalid one without echoing it", () => {
    expect(solDepositKey(`  ${SEED.toUpperCase()}  `, 0).address).toBe(solDepositKey(SEED, 0).address);
    expect(() => solDepositKey("not a mnemonic secret-words", 0)).toThrow(/MASTER_SEED/);
    try {
      solHotKey("not a mnemonic secret-words");
    } catch (e) {
      expect(String(e)).not.toContain("secret-words");
    }
  });
  it("rejects indexes outside the hardened range or colliding with the hot account", () => {
    for (const i of [-1, 1.5, NaN, 2147483646, 2147483647, 2147483648]) expect(() => solDepositKey(SEED, i), String(i)).toThrow(/index/);
    expect(solDepositKey(SEED, 2147483645).address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it("repeat calls (the per-isolate branch cache) give the same keys", () => {
    expect(bytesToHex(solDepositKey(SEED, 5).priv)).toBe(bytesToHex(solDepositKey(SEED, 5).priv));
    const a = solDepositKey(SEED, 5);
    a.priv.fill(0); // a caller scribbling on its copy must not corrupt the cache
    expect(solDepositKey(SEED, 5).priv.some((b) => b !== 0)).toBe(true);
  });
});
