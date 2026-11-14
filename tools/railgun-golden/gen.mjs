// Golden vectors for 0Crypto's Workers port of the Railgun shield note (src/routing/railgun/).
//
//   cd tools/railgun-golden && npm ci && node gen.mjs > ../../test/fixtures/railgun/golden.json
//
// Everything below is computed by the real @railgun-community/engine (pinned in package.json); nothing is hand-crafted.
//
// Randomness stub (the only one). ShieldNote.serialize (engine dist/note/shield-note.js:58-86) draws two IVs:
//   1. AES.encryptGCM (dist/utils/encryption/aes.js:27) -> AES.getRandomIV() -> ByteUtils.randomHex(16)  (the GCM IV)
//   2. AES.encryptCTR (dist/utils/encryption/aes.js:108) -> AES.getRandomIV() -> ByteUtils.randomHex(16) (the CTR IV)
// ByteUtils.randomHex (dist/utils/bytes.js:300-304) is crypto.randomBytes in Node. We replace the static method
// ByteUtils.randomHex with a queue holding exactly [gcmIv, ctrIv] for one serialize call; it throws on any other length
// or on a third call, and the queue must be empty afterwards, so no other randomness can slip into the output. The
// note's `random` is an explicit constructor argument (no stub needed). Each vector is then checked by decrypting it
// back with the engine's own AES / getSharedSymmetricKey, and by serializing twice (identical output).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const engine = require("@railgun-community/engine");
const dist = dirname(require.resolve("@railgun-community/engine"));
// Not exported from the package index; loaded by path (same CJS module instances the engine itself uses).
const { encodeAddress, decodeAddress } = require(join(dist, "key-derivation/bech32.js"));
const { deriveNodes, WalletNode } = require(join(dist, "key-derivation/wallet-node.js"));
const { AES } = require(join(dist, "utils/encryption/aes.js"));
const { getSharedSymmetricKey } = require(join(dist, "utils/keys-utils.js"));
const scalarMult = require(join(dist, "utils/scalar-multiply.js"));
const poseidonMod = require(join(dist, "utils/poseidon.js"));
const circomlibjs = require("@railgun-community/circomlibjs");
const { ethers } = require("ethers");

const { ShieldNote, ShieldNoteERC20, ByteUtils } = engine;
// Read from node_modules directly: the engine's "exports" map hides package.json.
const pkgVersion = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`golden self-check failed: ${msg}`);
};
const hex = (u8) => Buffer.from(u8).toString("hex");
const fixedBytes = (label, n) => createHash("sha256").update(`paygate-railgun-golden:${label}`).digest().subarray(0, n);

await poseidonMod.initPoseidonPromise;
await scalarMult.initCurve25519Promise;

// --- Randomness stub ----------------------------------------------------------------------------------------------
const realRandomHex = ByteUtils.randomHex;
let ivQueue = null;
ByteUtils.randomHex = (length = 32) => {
  if (ivQueue === null) return realRandomHex.call(ByteUtils, length);
  assert(length === 16, `unexpected randomHex(${length}) during serialize`);
  assert(ivQueue.length > 0, "serialize drew more than two IVs");
  return ivQueue.shift();
};
async function serializeWithIvs(note, shieldPrivateKey, viewingPublicKey, gcmIv, ctrIv) {
  ivQueue = [gcmIv, ctrIv];
  try {
    const out = await note.serialize(shieldPrivateKey, viewingPublicKey);
    assert(ivQueue.length === 0, "serialize drew fewer than two IVs");
    return out;
  } finally {
    ivQueue = null;
  }
}

// --- Receivers: real wallet keys from fixed mnemonics, via the engine's derivation -----------------------------
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_MNEMONIC = "test test test test test test test test test test test junk";

async function receiver(mnemonic, index, chain) {
  const { spending, viewing } = deriveNodes(mnemonic, index);
  const spendingPublicKey = spending.getSpendingKeyPair().pubkey;
  const nullifyingKey = await viewing.getNullifyingKey();
  const masterPublicKey = WalletNode.getMasterPublicKey(spendingPublicKey, nullifyingKey);
  const { pubkey: viewingPublicKey } = await viewing.getViewingKeyPair();
  const address = encodeAddress({ masterPublicKey, viewingPublicKey, chain });
  const decoded = decodeAddress(address);
  assert(decoded.masterPublicKey === masterPublicKey, "engine decode mpk");
  assert(hex(decoded.viewingPublicKey) === hex(viewingPublicKey), "engine decode vpk");
  return {
    mnemonic,
    index,
    address,
    masterPublicKey: masterPublicKey.toString(),
    viewingPublicKey: hex(viewingPublicKey),
    chain: decoded.chain ?? null,
  };
}

const receivers = [
  await receiver(TEST_MNEMONIC, 0, undefined),
  await receiver(OTHER_MNEMONIC, 0, { type: 0, id: 42161 }),
  await receiver(TEST_MNEMONIC, 7, { type: 0, id: 1 }),
];
// A receiver whose master public key has a leading zero byte (mpk < 2^248): exercises the 32-byte padding of mpk.
for (let i = 1; ; i++) {
  const r = await receiver(TEST_MNEMONIC, i, undefined);
  if (BigInt(r.masterPublicKey) < 1n << 248n) {
    receivers.push(r);
    break;
  }
  assert(i < 2000, "no leading-zero mpk found");
}
const leadingZeroMpk = receivers[3];

// --- Shield private key: keccak256(signMessage("RAILGUN_SHIELD")) of the hot account, via ethers ----------------
// Railway-Wallet desktop/src/views/screens/drawer/shield/ShieldTokens/ShieldConfirm/ShieldConfirm.tsx:119-126.
const HOT_PATH = "m/44'/60'/0'/0/0";
const hot = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, HOT_PATH);
const message = ShieldNote.getShieldPrivateKeySignatureMessage();
assert(message === "RAILGUN_SHIELD", "signature message");
const hotSignature = await hot.signMessage(message);
const hotShieldPrivateKey = ethers.keccak256(hotSignature);

// --- Three note input sets -------------------------------------------------------------------------------------
// A random whose npk = poseidon(mpk, random) has a leading zero byte for receivers[1]: exercises npk padding.
let npkZeroRandom;
for (let k = 0; ; k++) {
  const cand = hex(fixedBytes(`npk-leading-zero-${k}`, 16));
  if (ShieldNote.getNotePublicKey(BigInt(receivers[1].masterPublicKey), cand) < 1n << 248n) {
    npkZeroRandom = cand;
    break;
  }
  assert(k < 5000, "no leading-zero npk found");
}

const sets = [
  {
    name: "usdc-arb-hot-key",
    receiver: receivers[0],
    token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    value: 1_000_000n,
    shieldPrivateKey: hotShieldPrivateKey.slice(2),
    random: "00a1b2c3d4e5f60718293a4b5c6d7e8f", // leading zero byte: exercises padding
    gcmIv: "000102030405060708090a0b0c0d0e0f",
    ctrIv: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  },
  {
    name: "weth-arb",
    receiver: receivers[1],
    token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    value: 1n,
    shieldPrivateKey: hex(fixedBytes("shield-key-2", 32)),
    random: hex(fixedBytes("random-2", 16)),
    gcmIv: hex(fixedBytes("gcm-iv-2", 16)),
    ctrIv: "0123456789abcdefffffffffffffffff", // CTR counter carries past the low 64 bits on block 2
  },
  {
    name: "usdt-eth-max-uint120",
    receiver: receivers[2],
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    value: 2n ** 120n - 1n,
    shieldPrivateKey: hex(fixedBytes("shield-key-3", 32)),
    random: "ffffffffffffffffffffffffffffff00",
    gcmIv: hex(fixedBytes("gcm-iv-3", 16)),
    ctrIv: "ffffffffffffffffffffffffffffffff", // full 128-bit counter wrap on block 2
  },
  {
    name: "tusd-leading-zero-mpk-zero-random",
    receiver: leadingZeroMpk,
    token: "0x0000000000085d4780B73119b644AE5ecd22b376", // leading zero bytes in the token address
    value: 123_456_789n,
    shieldPrivateKey: hex(fixedBytes("shield-key-4", 32)),
    random: "00000000000000000000000000000000", // all-zero random
    gcmIv: hex(fixedBytes("gcm-iv-4", 16)),
    ctrIv: hex(fixedBytes("ctr-iv-4", 16)),
  },
  {
    name: "usdc-leading-zero-npk",
    receiver: receivers[1],
    token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    value: 42n,
    shieldPrivateKey: hex(fixedBytes("shield-key-5", 32)),
    random: npkZeroRandom,
    gcmIv: hex(fixedBytes("gcm-iv-5", 16)),
    ctrIv: hex(fixedBytes("ctr-iv-5", 16)),
  },
];

const notes = [];
for (const s of sets) {
  const mpk = BigInt(s.receiver.masterPublicKey);
  const vpk = Buffer.from(s.receiver.viewingPublicKey, "hex");
  const spk = Buffer.from(s.shieldPrivateKey, "hex");
  const note = new ShieldNoteERC20(mpk, s.random, s.value, s.token);
  const out = await serializeWithIvs(note, spk, vpk, s.gcmIv, s.ctrIv);
  const again = await serializeWithIvs(new ShieldNoteERC20(mpk, s.random, s.value, s.token), spk, vpk, s.gcmIv, s.ctrIv);
  const ser = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  assert(ser(out) === ser(again), `${s.name}: serialize is not deterministic under the stub`);

  // Self-checks with the engine's own primitives: the stubbed IVs are where we expect, and everything decrypts.
  const [b0, b1, b2] = out.ciphertext.encryptedBundle.map((h) => h.slice(2));
  assert(b0.slice(0, 32) === s.gcmIv, `${s.name}: GCM IV position`);
  assert(b1.slice(32, 64) === s.ctrIv, `${s.name}: CTR IV position`);
  const sharedKey = await getSharedSymmetricKey(spk, vpk);
  assert(ShieldNote.decryptRandom(out.ciphertext.encryptedBundle, sharedKey) === s.random, `${s.name}: random decrypts`);
  const [vpkBack] = AES.decryptCTR({ iv: s.ctrIv, data: [b2] }, spk);
  assert(vpkBack === s.receiver.viewingPublicKey, `${s.name}: receiver viewing key decrypts`);
  // The receiver side: shared key from the receiver's viewing private key and the shieldKey (ECDH symmetry).
  const { viewing } = deriveNodes(s.receiver.mnemonic, s.receiver.index);
  const { privateKey: vpriv } = await viewing.getViewingKeyPair();
  const receiverShared = await getSharedSymmetricKey(vpriv, Buffer.from(out.ciphertext.shieldKey.slice(2), "hex"));
  assert(hex(receiverShared) === hex(sharedKey), `${s.name}: receiver derives the same shared key`);
  // WASM vs JavaScript implementations inside the engine agree (the engine prefers WASM).
  const npkJs = circomlibjs.poseidon([mpk, BigInt(`0x${s.random}`)]);
  assert(npkJs === ShieldNote.getNotePublicKey(mpk, s.random), `${s.name}: poseidon WASM == circomlibjs`);
  const scalar = await require(join(dist, "utils/keys-utils.js")).getPrivateScalarFromPrivateKey(spk);
  assert(hex(scalarMult.scalarMultiplyJavascript(vpk, scalar)) === hex(scalarMult.scalarMultiplyWasmFallbackToJavascript(vpk, scalar)), `${s.name}: scalar multiply WASM == JS`);

  if (s.name === "usdc-leading-zero-npk") assert(out.preimage.npk.startsWith("0x00"), "npk has a leading zero byte");
  notes.push({
    name: s.name,
    inputs: {
      receiver0zk: s.receiver.address,
      token: s.token,
      value: s.value.toString(),
      shieldPrivateKey: s.shieldPrivateKey,
      random: s.random,
      gcmIv: s.gcmIv,
      ctrIv: s.ctrIv,
    },
    expected: {
      npk: out.preimage.npk,
      token: { tokenType: out.preimage.token.tokenType, tokenAddress: out.preimage.token.tokenAddress, tokenSubID: out.preimage.token.tokenSubID },
      value: out.preimage.value.toString(),
      encryptedBundle: out.ciphertext.encryptedBundle,
      shieldKey: out.ciphertext.shieldKey,
      sharedKey: hex(sharedKey),
    },
  });
}

const golden = {
  generator: "tools/railgun-golden/gen.mjs",
  versions: {
    "@railgun-community/engine": pkgVersion("@railgun-community/engine"),
    "@railgun-community/shared-models": pkgVersion("@railgun-community/shared-models"),
    ethers: pkgVersion("ethers"),
  },
  ivStub: "ByteUtils.randomHex replaced by a queue [gcmIv, ctrIv] during each serialize (see gen.mjs header)",
  shieldPrivateKey: {
    mnemonic: TEST_MNEMONIC,
    path: HOT_PATH,
    hotAddress: hot.address,
    message,
    signature: hotSignature,
    shieldPrivateKey: hotShieldPrivateKey,
  },
  addresses: receivers.map(({ address, masterPublicKey, viewingPublicKey, chain }) => ({ address, masterPublicKey, viewingPublicKey, chain })),
  notes,
};
process.stdout.write(`${JSON.stringify(golden, null, 2)}\n`);
