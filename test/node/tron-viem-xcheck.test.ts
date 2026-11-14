import { mnemonicToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { tronBase58ToHex } from "../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../src/signing/keys";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Independent derivation: viem has its own HD code. Tron address body == EVM address bytes for the same path.
// viem types the path as m/44'/60'/..., but accepts any BIP32 path at runtime.
const evmBody = (path: string) => mnemonicToAccount(SEED, { path: path as `m/44'/60'/${string}` }).address.slice(2).toLowerCase();
const tronBody = (addr: string) => tronBase58ToHex(addr).slice(2);

it("deposit index 0 matches viem and the pinned vector", () => {
  const k = tronDepositKey(SEED, 0);
  expect(k.address).toBe("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
  expect(tronBody("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH")).toBe(evmBody("m/44'/195'/0'/0/0"));
});

it("deposit indexes 1 and 7 match viem", () => {
  for (const i of [1, 7]) expect(tronBody(tronDepositKey(SEED, i).address)).toBe(evmBody(`m/44'/195'/0'/0/${i}`));
});

it("hot key matches viem", () => {
  const HOT = "TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4";
  expect(tronHotKey(SEED).address).toBe(HOT);
  expect(tronBody(HOT)).toBe(evmBody("m/44'/195'/1'/0/0"));
});
