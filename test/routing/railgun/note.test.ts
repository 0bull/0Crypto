import { env } from "cloudflare:workers";
import { bech32, bech32m } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hotAccount } from "../../../src/signing/evmkeys";
import type { Env } from "../../../src/env";
import { decode0zk, encode0zk, validateRailgunDestination } from "../../../src/routing/railgun/address";
import { buildShieldRequest, getSharedSymmetricKey, shieldPrivateKeyFromHot } from "../../../src/routing/railgun/note";
import golden from "../../fixtures/railgun/golden.json";

// Golden vectors come from the real @railgun-community/engine (tools/railgun-golden/gen.mjs). They are the arbiter.
const e = env as unknown as Env;
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));

const ADDR = golden.addresses[0]!.address;
// Re-encodes the 73-byte payload of an address with the given codec/prefix/payload edits.
function reencode(edit: (data: Uint8Array) => Uint8Array, opts: { prefix?: string; codec?: typeof bech32m; limit?: number } = {}) {
  const { words } = bech32m.decode(ADDR as `${string}1${string}`, 127);
  const data = edit(Uint8Array.from(bech32m.fromWords(words)));
  return (opts.codec ?? bech32m).encode(opts.prefix ?? "0zk", (opts.codec ?? bech32m).toWords(data), opts.limit ?? 127);
}

const goldenInput = (n: (typeof golden.notes)[number]) => ({
  receiver0zk: n.inputs.receiver0zk,
  token: n.inputs.token as `0x${string}`,
  value: BigInt(n.inputs.value),
  shieldPrivateKey: bytes(n.inputs.shieldPrivateKey),
  random: bytes(n.inputs.random),
  gcmIv: bytes(n.inputs.gcmIv),
  ctrIv: bytes(n.inputs.ctrIv),
});

describe("buildShieldRequest matches the Railgun engine byte for byte", () => {
  it("has five golden vectors and four addresses from engine 9.9.1, including the leading-zero cases", () => {
    expect(golden.notes).toHaveLength(5);
    expect(golden.addresses).toHaveLength(4);
    expect(golden.addresses.some((a) => BigInt(a.masterPublicKey) < 1n << 248n)).toBe(true);
    expect(golden.notes.some((n) => n.expected.npk.startsWith("0x00"))).toBe(true);
    expect(golden.notes.some((n) => /^0+$/.test(n.inputs.random))).toBe(true);
    expect(golden.notes.some((n) => n.inputs.token === "0x0000000000085d4780B73119b644AE5ecd22b376")).toBe(true);
    expect(golden.versions["@railgun-community/engine"]).toBe("9.9.1");
  });

  for (const n of golden.notes) {
    it(`${n.name}: npk, encryptedBundle, shieldKey, token and value`, async () => {
      const req = await buildShieldRequest(goldenInput(n));
      expect(req.preimage.npk).toBe(n.expected.npk);
      expect(req.ciphertext.encryptedBundle).toEqual(n.expected.encryptedBundle);
      expect(req.ciphertext.shieldKey).toBe(n.expected.shieldKey);
      expect(req.preimage.value).toBe(BigInt(n.expected.value));
      expect(req.preimage.token.tokenType).toBe(n.expected.token.tokenType);
      expect(req.preimage.token.tokenAddress).toBe(n.expected.token.tokenAddress); // lowercased, as the engine does
      expect(req.preimage.token.tokenSubID).toBe(BigInt(n.expected.token.tokenSubID));
    });

    it(`${n.name}: shared symmetric key`, async () => {
      const { viewingPublicKey } = decode0zk(n.inputs.receiver0zk);
      expect(hex(await getSharedSymmetricKey(bytes(n.inputs.shieldPrivateKey), viewingPublicKey))).toBe(n.expected.sharedKey);
    });
  }

  it("draws both IVs from crypto.getRandomValues by default, and the note decrypts with the shared key", async () => {
    const n = golden.notes[0]!;
    const { gcmIv: _g, ctrIv: _c, ...input } = goldenInput(n);
    const spy = vi.spyOn(crypto, "getRandomValues");
    const a = await buildShieldRequest(input);
    const drawn = spy.mock.calls.map(([arr]) => hex(arr as Uint8Array));
    spy.mockRestore();
    // The first two draws are the GCM and CTR IVs (later draws are noble's scalar-multiply blinding, result-independent).
    expect(drawn.slice(0, 2).map((h) => h.length)).toEqual([32, 32]);
    expect(a.ciphertext.encryptedBundle[0].slice(2, 34)).toBe(drawn[0]);
    expect(a.ciphertext.encryptedBundle[1].slice(34)).toBe(drawn[1]);
    const b = await buildShieldRequest(input);
    expect(a.ciphertext.encryptedBundle[0].slice(2, 34)).not.toBe(b.ciphertext.encryptedBundle[0].slice(2, 34)); // GCM IV
    expect(a.ciphertext.encryptedBundle[1].slice(34)).not.toBe(b.ciphertext.encryptedBundle[1].slice(34)); // CTR IV
    expect(a.preimage.npk).toBe(n.expected.npk); // npk does not depend on the IVs
    // Decrypt the random as the receiver's wallet does (engine ShieldNote.decryptRandom): AES-256-GCM, 16-byte IV.
    const [b0, b1] = a.ciphertext.encryptedBundle.map(bytes) as [Uint8Array, Uint8Array];
    const key = await crypto.subtle.importKey("raw", bytes(n.expected.sharedKey), "AES-GCM", false, ["decrypt"]);
    const ct = new Uint8Array([...b1.subarray(0, 16), ...b0.subarray(16, 32)]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b0.subarray(0, 16), tagLength: 128 }, key, ct));
    expect(hex(pt)).toBe(n.inputs.random);
  });
});

describe("buildShieldRequest validates its inputs", () => {
  const base = goldenInput(golden.notes[0]!);
  it.each([
    ["random of 15 bytes", { random: new Uint8Array(15) }, /random must be 16 bytes/],
    ["random of 17 bytes", { random: new Uint8Array(17) }, /random must be 16 bytes/],
    ["zero value", { value: 0n }, /value must be > 0/],
    ["negative value", { value: -1n }, /value must be > 0/],
    ["value above uint120", { value: 2n ** 120n }, /value must fit in uint120/],
    ["non-bigint value", { value: 1 as unknown as bigint }, /value must be a bigint/],
    ["short token address", { token: "0x1234" as `0x${string}` }, /token must be a 0x-prefixed 20-byte address/],
    ["token without 0x", { token: "af88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}` }, /token must be a 0x-prefixed 20-byte address/],
    ["undecodable receiver", { receiver0zk: "0zk1notanaddress" }, /invalid Railgun address/],
    ["receiver with another hrp", { receiver0zk: reencode((d) => d, { prefix: "0zx" }) }, /invalid Railgun address/],
    ["shieldPrivateKey of 31 bytes", { shieldPrivateKey: new Uint8Array(31).fill(1) }, /shieldPrivateKey must be 32 bytes/],
    ["shieldPrivateKey of 33 bytes", { shieldPrivateKey: new Uint8Array(33).fill(1) }, /shieldPrivateKey must be 32 bytes/],
    ["GCM IV of 12 bytes", { gcmIv: new Uint8Array(12) }, /gcmIv must be 16 bytes/],
    ["CTR IV of 8 bytes", { ctrIv: new Uint8Array(8) }, /ctrIv must be 16 bytes/],
  ])("rejects %s", async (_, patch, err) => {
    await expect(buildShieldRequest({ ...base, ...patch })).rejects.toThrow(err);
  });

  it("getSharedSymmetricKey rejects wrong-length keys and a viewing key that is not a curve point", async () => {
    const vpk = bytes(golden.addresses[0]!.viewingPublicKey);
    await expect(getSharedSymmetricKey(new Uint8Array(31).fill(1), vpk)).rejects.toThrow(/private key must be 32 bytes/);
    await expect(getSharedSymmetricKey(new Uint8Array(32).fill(1), vpk.subarray(0, 31))).rejects.toThrow(/viewing public key must be 32 bytes/);
    await expect(getSharedSymmetricKey(new Uint8Array(32).fill(1), new Uint8Array(33))).rejects.toThrow(/viewing public key must be 32 bytes/);
    // y = 2^255 - 1 (>= p) is not a canonical point encoding.
    await expect(getSharedSymmetricKey(new Uint8Array(32).fill(1), new Uint8Array(32).fill(0xff))).rejects.toThrow();
  });
});

describe("decode0zk", () => {
  for (const a of golden.addresses) {
    it(`decodes the engine's address ${a.address.slice(0, 12)}... and encode0zk round-trips it`, () => {
      const d = decode0zk(a.address);
      expect(d.masterPublicKey).toBe(BigInt(a.masterPublicKey));
      expect(hex(d.viewingPublicKey)).toBe(a.viewingPublicKey);
      expect(d.chain).toEqual(a.chain ?? undefined);
      expect(encode0zk(d)).toBe(a.address);
    });
  }

  it("accepts the all-uppercase form (bech32 allows it)", () => {
    expect(decode0zk(ADDR.toUpperCase()).masterPublicKey).toBe(BigInt(golden.addresses[0]!.masterPublicKey));
  });

  it("rejects a wrong hrp", () => {
    expect(() => decode0zk(reencode((d) => d, { prefix: "0zl" }))).toThrow(/prefix/);
    expect(() => decode0zk(reencode((d) => d, { prefix: "bc" }))).toThrow(/prefix/);
  });

  it("rejects a bad checksum", () => {
    const last = ADDR.at(-1) === "q" ? "p" : "q";
    expect(() => decode0zk(`${ADDR.slice(0, -1)}${last}`)).toThrow(/invalid Railgun address/);
    const mid = ADDR.length >> 1;
    expect(() => decode0zk(`${ADDR.slice(0, mid)}${ADDR[mid] === "q" ? "p" : "q"}${ADDR.slice(mid + 1)}`)).toThrow(/invalid Railgun address/);
  });

  it("rejects plain bech32 (Railgun uses bech32m)", () => {
    const plain = reencode((d) => d, { codec: bech32 as unknown as typeof bech32m });
    expect(plain.startsWith("0zk1")).toBe(true);
    expect(() => decode0zk(plain)).toThrow(/invalid Railgun address/);
  });

  it("rejects a wrong data length", () => {
    expect(() => decode0zk(reencode((d) => d.subarray(0, 72)))).toThrow(/73 bytes/);
    // 74 bytes cannot fit the 127-character limit at all: rejected by the bech32m decoder (limit 127).
    expect(() => decode0zk(reencode((d) => new Uint8Array([...d, 0]), { limit: 200 }))).toThrow(/invalid Railgun address/);
    expect(() => decode0zk(reencode(() => new Uint8Array(0)))).toThrow(/73 bytes/);
  });

  it("rejects an unsupported version byte", () => {
    for (const v of [0, 2, 0xff]) {
      expect(() => decode0zk(reencode((d) => Uint8Array.from(d, (b, i) => (i === 0 ? v : b))))).toThrow(/version/);
    }
  });

  it("rejects a master public key outside the BN254 scalar field", () => {
    expect(() => decode0zk(reencode((d) => Uint8Array.from(d, (b, i) => (i >= 1 && i <= 32 ? 0xff : b))))).toThrow(/master public key/);
  });

  it("rejects a chain id above Number.MAX_SAFE_INTEGER", () => {
    // networkID bytes 33..41 = (type 0, id 2^53) XOR "railgun".
    const net = [0, 0x20, 0, 0, 0, 0, 0, 0];
    const rail = new TextEncoder().encode("railgun");
    const edit = (d: Uint8Array) => Uint8Array.from(d, (b, i) => (i >= 33 && i < 41 ? net[i - 33]! ^ (i - 33 < 7 ? rail[i - 33]! : 0) : b));
    expect(() => decode0zk(reencode(edit))).toThrow(/chain id is out of range/);
    // ...while 2^53 - 1 itself still decodes.
    const max = [0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const ok = (d: Uint8Array) => Uint8Array.from(d, (b, i) => (i >= 33 && i < 41 ? max[i - 33]! ^ (i - 33 < 7 ? rail[i - 33]! : 0) : b));
    expect(decode0zk(reencode(ok)).chain).toEqual({ type: 0, id: Number.MAX_SAFE_INTEGER });
  });

  it("rejects non-strings and empty input", () => {
    expect(() => decode0zk("")).toThrow(/invalid Railgun address/);
    expect(() => decode0zk(undefined as unknown as string)).toThrow(/invalid Railgun address/);
    expect(() => decode0zk("0zk")).toThrow(/invalid Railgun address/);
  });
});

describe("shieldPrivateKeyFromHot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is keccak256(signMessage('RAILGUN_SHIELD')) of the EVM hot account, pinned for the test mnemonic", async () => {
    const hot = hotAccount(e);
    expect(hot.address).toBe(golden.shieldPrivateKey.hotAddress);
    const spy = vi.spyOn(hot, "signMessage");
    const key = await shieldPrivateKeyFromHot(hot);
    expect(spy).toHaveBeenCalledWith({ message: "RAILGUN_SHIELD" });
    expect(`0x${hex(key)}`).toBe(golden.shieldPrivateKey.shieldPrivateKey);
    expect(key).toHaveLength(32);
  });

  it("rejects a signature that is not 65 bytes", async () => {
    await expect(shieldPrivateKeyFromHot({ signMessage: async () => "0x1234" })).rejects.toThrow(/65 bytes/);
  });
});

describe("validateRailgunDestination", () => {
  const [allChains, arb, eth] = golden.addresses as [(typeof golden.addresses)[number], (typeof golden.addresses)[number], (typeof golden.addresses)[number]];
  const ARB = { type: 0, id: 42161 };

  it("accepts an all-chains address for any chain, and a chain-bound address for its own chain", () => {
    expect(validateRailgunDestination(allChains.address, ARB).masterPublicKey).toBe(BigInt(allChains.masterPublicKey));
    expect(validateRailgunDestination(allChains.address).chain).toBeUndefined();
    expect(validateRailgunDestination(arb.address, ARB).chain).toEqual(ARB);
    expect(validateRailgunDestination(arb.address).chain).toEqual(ARB); // no chain asked: the address's own chain is fine
  });

  it("rejects an address bound to another chain", () => {
    expect(() => validateRailgunDestination(eth.address, ARB)).toThrow(/address is for chain 0:1, not 0:42161/);
    expect(() => validateRailgunDestination(arb.address, { type: 1, id: 42161 })).toThrow(/not 1:42161/);
  });

  it("rejects a viewing public key that is not an ed25519 point, and anything decode0zk rejects", () => {
    const badPoint = reencode((d) => Uint8Array.from(d, (b, i) => (i >= 41 ? 0xff : b)));
    expect(decode0zk(badPoint).viewingPublicKey).toHaveLength(32); // decodes...
    expect(() => validateRailgunDestination(badPoint)).toThrow(/not a valid ed25519 point/); // ...but is not a point
    expect(() => validateRailgunDestination(reencode((d) => d, { prefix: "0zl" }))).toThrow(/prefix/);
  });
});
