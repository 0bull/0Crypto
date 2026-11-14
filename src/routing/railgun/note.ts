import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { poseidon2 } from "poseidon-lite/poseidon2";
import type { Address, Hex } from "viem";
import { decode0zk } from "./address";

// The Railgun shield note, built without the engine (Workers-safe: noble, poseidon-lite and WebCrypto; no Buffer).
// A port of @railgun-community/engine 9.9.1:
//   ShieldNote.serialize            dist/note/shield-note.js:58-86
//   ShieldNote.getNotePublicKey     dist/note/shield-note.js:36-38 (npk = poseidon(mpk, random))
//   getSharedSymmetricKey           dist/utils/keys-utils.js:154-167 (+ getPrivateScalarFromPrivateKey :75-87)
//   AES.encryptGCM / encryptCTR     dist/utils/encryption/aes.js:21-47, 97-126 (16-byte IVs)
// Proven byte for byte against the engine by test/routing/railgun/note.test.ts (goldens: tools/railgun-golden/gen.mjs).
// Poseidon: the engine uses circomlibjs-compatible Poseidon over BN254 (poseidon-hash-wasm, circomlibjs fallback);
// poseidon-lite implements the same circomlib parameters (t = 3 here: 8 full rounds, 57 partial).

/** The RailgunSmartWallet `shield(ShieldRequest[])` argument, as viem encodes it (V2.1 ABI). */
export interface ShieldRequest {
  preimage: {
    npk: Hex;
    token: { tokenType: 0; tokenAddress: Address; tokenSubID: 0n };
    value: bigint;
  };
  ciphertext: { encryptedBundle: [Hex, Hex, Hex]; shieldKey: Hex };
}

export interface ShieldInput {
  /** The receiver's `0zk` address (RAILGUN_0ZK_ADDRESS). */
  receiver0zk: string;
  /** ERC-20 token. */
  token: Address;
  /** Atomic units; the contract field is uint120. */
  value: bigint;
  /** 32 bytes: shieldPrivateKeyFromHot(). */
  shieldPrivateKey: Uint8Array;
  /** 16 bytes, fresh per note: the note's blinding random. */
  random: Uint8Array;
  /** 16-byte AES-GCM IV; defaults to crypto.getRandomValues. Passed only by shieldRequestFor (a note's own) and the golden test. */
  gcmIv?: Uint8Array;
  /** 16-byte AES-CTR IV; defaults to crypto.getRandomValues. Passed only by shieldRequestFor (a note's own) and the golden test. */
  ctrIv?: Uint8Array;
}

/** Engine ShieldNote.getShieldPrivateKeySignatureMessage() (dist/note/shield-note.js:32-35). DO NOT MODIFY. */
export const SHIELD_SIGNATURE_MESSAGE = "RAILGUN_SHIELD";
const UINT120_MAX = (1n << 120n) - 1n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const hex0x = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
function assertBytes(name: string, v: unknown, len: number): asserts v is Uint8Array {
  if (!(v instanceof Uint8Array) || v.length !== len) throw new TypeError(`${name} must be ${len} bytes`);
}
// Copies into a fresh ArrayBuffer-backed array (WebCrypto's BufferSource typing rejects SharedArrayBuffer views).
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/**
 * The shield private key: keccak256 of the hot account's EIP-191 signature of "RAILGUN_SHIELD". This is how Railway
 * derives it (Railway-Wallet desktop/src/views/screens/drawer/shield/ShieldTokens/ShieldConfirm/ShieldConfirm.tsx:119-126,
 * `keccak256(await wallet.signMessage(getShieldPrivateKeySignatureMessage()))`). Holding it lets the sender recover the
 * receiver's `0zk` address from its own past shields (engine shield-note.js:30-31: the CTR bundle decrypts with it); the
 * receiver cannot learn the sender from shieldKey. Deterministic (RFC 6979), so derived from MASTER_SEED, never stored.
 */
export async function shieldPrivateKeyFromHot(hot: { signMessage(args: { message: string }): Promise<Hex> }): Promise<Uint8Array> {
  const sig = await hot.signMessage({ message: SHIELD_SIGNATURE_MESSAGE });
  const raw = typeof sig === "string" && /^0x[0-9a-fA-F]*$/.test(sig) ? hexToBytes(sig.slice(2)) : new Uint8Array(0);
  if (raw.length !== 65) throw new Error("shield key signature must be 65 bytes");
  return keccak_256(raw);
}

/**
 * Engine getSharedSymmetricKey: sha256 of (viewing public key x scalar), where the scalar is the ed25519 private
 * scalar of `privateKey` (sha512 head, clamped, little-endian, mod l). Throws where the engine returns undefined.
 */
export async function getSharedSymmetricKey(privateKey: Uint8Array, viewingPublicKey: Uint8Array): Promise<Uint8Array> {
  assertBytes("private key", privateKey, 32);
  assertBytes("viewing public key", viewingPublicKey, 32);
  const head = sha512(privateKey).slice(0, 32);
  // adjustBytes25519(..., 'le'): clear the low 3 bits, clear the top bit, set the second-highest bit.
  head[0]! &= 0b11111000;
  head[31]! &= 0b01111111;
  head[31]! |= 0b01000000;
  let le = 0n;
  for (let i = 31; i >= 0; i--) le = (le << 8n) | BigInt(head[i]!);
  const l = ed25519.Point.Fn.ORDER;
  const scalar = le % l;
  // The engine maps 0 to l, which its point multiply then rejects: the same outcome as throwing here.
  if (scalar === 0n) throw new Error("shared key scalar is zero");
  const point = ed25519.Point.fromBytes(viewingPublicKey); // strict (non-ZIP-215) decoding, as noble/ed25519 1.x fromHex
  return sha256(point.multiply(scalar).toBytes());
}

/** npk = poseidon([masterPublicKey, random as a big-endian integer]), written as 32 bytes big-endian. */
function npkOf(masterPublicKey: bigint, random: Uint8Array): Hex {
  const npk = poseidon2([masterPublicKey, BigInt(`0x${bytesToHex(random)}`)]);
  return `0x${npk.toString(16).padStart(64, "0")}`;
}

/** The note public key a shield to `receiver0zk` with this 16-byte `random` (0x hex) must carry. */
export function notePublicKey(receiver0zk: string, random: Hex): Hex {
  const r = hexToBytes(random.slice(2));
  assertBytes("random", r, 16);
  return npkOf(decode0zk(receiver0zk).masterPublicKey, r);
}

/**
 * Everything one shield note is built from, except the shield key: frozen, hex strings only (immutable). It is bound
 * into the note's railgun proof (src/routing/guard.ts allowedShield) so the EVM signer can rebuild the exact request.
 */
export interface ShieldNote {
  readonly receiver0zk: string;
  /** Lowercase ERC-20 address. */
  readonly token: Address;
  readonly value: bigint;
  /** 16 bytes: the note's blinding random (npk = poseidon(mpk, random)). */
  readonly random: Hex;
  readonly gcmIv: Hex;
  readonly ctrIv: Hex;
}

/**
 * A new note for one shield: its random and both IVs fresh from crypto.getRandomValues, never reused, never chosen
 * by a caller. The only place outside buildShieldRequest's own defaults that picks IVs (test/node/railgun-iv.test.ts);
 * called only by allowedShield, which binds the note into its proof.
 */
export async function newShieldNote(receiver0zk: string, token: Address, value: bigint, shieldPrivateKey: Uint8Array): Promise<{ note: ShieldNote; request: ShieldRequest }> {
  const note: ShieldNote = Object.freeze({
    receiver0zk,
    token: token.toLowerCase() as Address,
    value,
    random: hex0x(crypto.getRandomValues(new Uint8Array(16))),
    gcmIv: hex0x(crypto.getRandomValues(new Uint8Array(16))),
    ctrIv: hex0x(crypto.getRandomValues(new Uint8Array(16))),
  });
  return { note, request: await shieldRequestFor(note, shieldPrivateKey) };
}

/** The ShieldRequest of `note` under `shieldPrivateKey` (deterministic: the note fixes the random and the IVs). */
export function shieldRequestFor(note: ShieldNote, shieldPrivateKey: Uint8Array): Promise<ShieldRequest> {
  const b = (h: Hex) => hexToBytes(h.slice(2));
  return buildShieldRequest({ receiver0zk: note.receiver0zk, token: note.token, value: note.value, shieldPrivateKey, random: b(note.random), gcmIv: b(note.gcmIv), ctrIv: b(note.ctrIv) });
}

/** Field-by-field equality of two requests (hex compared case-insensitively): for decoded, exactly re-encoded calldata. */
export function sameShieldRequest(a: ShieldRequest, b: ShieldRequest): boolean {
  const h = (x: string) => x.toLowerCase();
  const [pa, pb] = [a.preimage, b.preimage];
  return (
    h(pa.npk) === h(pb.npk) &&
    pa.token.tokenType === pb.token.tokenType &&
    h(pa.token.tokenAddress) === h(pb.token.tokenAddress) &&
    pa.token.tokenSubID === pb.token.tokenSubID &&
    pa.value === pb.value &&
    a.ciphertext.encryptedBundle.length === 3 &&
    b.ciphertext.encryptedBundle.length === 3 &&
    a.ciphertext.encryptedBundle.every((x, i) => h(x) === h(b.ciphertext.encryptedBundle[i]!)) &&
    h(a.ciphertext.shieldKey) === h(b.ciphertext.shieldKey)
  );
}

/** Builds one ShieldRequest for `RailgunSmartWallet.shield`, as the engine's ShieldNoteERC20(...).serialize does. */
export async function buildShieldRequest(input: ShieldInput): Promise<ShieldRequest> {
  const { receiver0zk, token, value, shieldPrivateKey, random } = input;
  assertBytes("random", random, 16);
  if (typeof value !== "bigint") throw new TypeError("value must be a bigint");
  if (value <= 0n) throw new RangeError("value must be > 0");
  if (value > UINT120_MAX) throw new RangeError("value must fit in uint120");
  if (typeof token !== "string" || !ADDRESS_RE.test(token)) throw new TypeError("token must be a 0x-prefixed 20-byte address");
  assertBytes("shieldPrivateKey", shieldPrivateKey, 32);
  const gcmIv = input.gcmIv ?? crypto.getRandomValues(new Uint8Array(16));
  const ctrIv = input.ctrIv ?? crypto.getRandomValues(new Uint8Array(16));
  assertBytes("gcmIv", gcmIv, 16);
  assertBytes("ctrIv", ctrIv, 16);
  const { masterPublicKey, viewingPublicKey } = decode0zk(receiver0zk);

  const npkHex = npkOf(masterPublicKey, random);

  // The random, AES-256-GCM under the ECDH shared key (16-byte IV, 16-byte tag). WebCrypto returns ciphertext || tag.
  const sharedKey = await getSharedSymmetricKey(shieldPrivateKey, viewingPublicKey);
  const gcmKey = await crypto.subtle.importKey("raw", buf(sharedKey), "AES-GCM", false, ["encrypt"]);
  const gcmOut = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(gcmIv), tagLength: 128 }, gcmKey, buf(random)));
  const encRandom = gcmOut.subarray(0, 16);
  const tag = gcmOut.subarray(16, 32);

  // The receiver's viewing public key, AES-256-CTR keyed by the shield private key itself (Node's aes-256-ctr counts
  // over the whole 128-bit block, hence length: 128).
  const ctrKey = await crypto.subtle.importKey("raw", buf(shieldPrivateKey), "AES-CTR", false, ["encrypt"]);
  const encReceiver = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: buf(ctrIv), length: 128 }, ctrKey, buf(viewingPublicKey)));

  return {
    preimage: {
      npk: npkHex,
      // Lowercased as the engine's getTokenDataERC20 does (formatToByteLength); ABI-equivalent either way.
      token: { tokenType: 0, tokenAddress: token.toLowerCase() as Address, tokenSubID: 0n },
      value,
    },
    ciphertext: {
      encryptedBundle: [hex0x(concat(gcmIv, tag)), hex0x(concat(encRandom, ctrIv)), hex0x(encReceiver)],
      shieldKey: hex0x(ed25519.getPublicKey(shieldPrivateKey)),
    },
  };
}
