import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { buildShieldRequest, shieldPrivateKeyFromHot } from "../../src/routing/railgun/note";
import golden from "../fixtures/railgun/golden.json";

// Cross-check in plain Node: viem's Node build vs the golden (computed by ethers in tools/railgun-golden/gen.mjs).
const g = golden.shieldPrivateKey;

it("shieldPrivateKey of the hot account matches ethers (golden) and viem's own keccak256(signMessage)", async () => {
  const hot = mnemonicToAccount(g.mnemonic, { path: g.path as `m/44'/60'/${string}` });
  expect(hot.address).toBe(g.hotAddress);
  const sig = await hot.signMessage({ message: "RAILGUN_SHIELD" });
  expect(sig).toBe(g.signature);
  expect(keccak256(sig)).toBe(g.shieldPrivateKey);
  const key = await shieldPrivateKeyFromHot(hot);
  expect(`0x${Buffer.from(key).toString("hex")}`).toBe(g.shieldPrivateKey);
});

it("the golden notes also hold under Node's WebCrypto", async () => {
  const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
  for (const n of golden.notes) {
    const req = await buildShieldRequest({
      receiver0zk: n.inputs.receiver0zk,
      token: n.inputs.token as `0x${string}`,
      value: BigInt(n.inputs.value),
      shieldPrivateKey: b(n.inputs.shieldPrivateKey),
      random: b(n.inputs.random),
      gcmIv: b(n.inputs.gcmIv),
      ctrIv: b(n.inputs.ctrIv),
    });
    expect(req.preimage.npk).toBe(n.expected.npk);
    expect(req.ciphertext.encryptedBundle).toEqual(n.expected.encryptedBundle);
    expect(req.ciphertext.shieldKey).toBe(n.expected.shieldKey);
  }
});
