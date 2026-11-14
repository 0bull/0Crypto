import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { derivePath } from "ed25519-hd-key";
import { expect, it } from "vitest";
import { slip10Node, solDepositKey, solHotKey } from "../../src/signing/keys";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Independent derivation: ed25519-hd-key (devDependency, used only here) is a separate SLIP-10 implementation.
// The addresses are the well-known Phantom/Solflare/solana-keygen first account for this mnemonic.
const seedHex = bytesToHex(mnemonicToSeedSync(SEED));
const addrOf = (path: string) => base58.encode(ed25519.getPublicKey(derivePath(path, seedHex).key));

it("deposit 0 (m/44'/501'/0'/0') is the pinned address, derived independently", () => {
  expect(addrOf("m/44'/501'/0'/0'")).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  expect(solDepositKey(SEED, 0).address).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
});

it("hot (m/44'/501'/2147483646'/0') matches the independent derivation and the pin", () => {
  const independent = addrOf("m/44'/501'/2147483646'/0'");
  expect(solHotKey(SEED).address).toBe(independent);
  expect(independent).toBe("DZJcJWPaEvx8DB2naCC9CEDxpWcdRuiSg88N8uXRR3zo");
});

it("deposit indexes match ed25519-hd-key, keys and addresses", () => {
  for (const i of [1, 2, 7, 1000, 2147483645]) {
    const k = solDepositKey(SEED, i);
    const ref = derivePath(`m/44'/501'/${i}'/0'`, seedHex);
    expect(bytesToHex(k.priv)).toBe(bytesToHex(ref.key));
    expect(k.address).toBe(base58.encode(ed25519.getPublicKey(ref.key)));
  }
});

it("slip10Node chain codes match ed25519-hd-key along the wallet path", () => {
  for (const p of ["m/44'", "m/44'/501'", "m/44'/501'/9'", "m/44'/501'/9'/0'"]) {
    const ref = derivePath(p, seedHex);
    const n = slip10Node(hexToBytes(seedHex), p);
    expect([bytesToHex(n.key), bytesToHex(n.chainCode)]).toEqual([bytesToHex(ref.key), bytesToHex(ref.chainCode)]);
  }
});
