import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { tronAddressFromPubkey } from "../chains/tron/address";
import { UTXO_NETWORKS, type UtxoChain } from "../chains/utxo/networks";
import { assertValidMnemonic } from "../core/mnemonic";

/*
 * Private key material: every function that yields private keys (Tron, Solana, UTXO; EVM is in ./evmkeys, loaded
 * dynamically because it needs viem/accounts). Internal to src/signing: nothing outside it may import this module
 * (test/node/signing-perimeter.test.ts). Callers elsewhere use ./addresses (addresses and public keys only) and the
 * signers, which take a KeySpec and derive the key themselves.
 */

// ---- Tron: m/44'/195'/0'/0/i deposits, m/44'/195'/1'/0/0 hot ----
export type TronKey = { priv: Uint8Array; address: string };

// PBKDF2 (2048 rounds) runs once per normalised seed and path per isolate; only branch keys are kept, never the master key.
const branches32 = new Map<string, HDKey>();

function bip32Branch(seed: string, path: string): HDKey {
  const m = assertValidMnemonic(seed);
  const key = `${path}:${m}`;
  let b = branches32.get(key);
  if (!b) {
    b = HDKey.fromMasterSeed(mnemonicToSeedSync(m)).derive(path);
    branches32.set(key, b);
  }
  return b;
}

function tronKeyAt(account: HDKey, i: number): TronKey {
  const priv = account.deriveChild(i).privateKey;
  if (!priv) throw new Error("no private key");
  return { priv, address: tronAddressFromPubkey(secp256k1.getPublicKey(priv, false)) };
}

/** Deposit key m/44'/195'/0'/0/i. */
export function tronDepositKey(seed: string, i: number): TronKey {
  if (!Number.isInteger(i) || i < 0 || i >= 0x80000000) throw new Error("derivation index out of range");
  return tronKeyAt(bip32Branch(seed, "m/44'/195'/0'/0"), i);
}

/** Hot wallet key m/44'/195'/1'/0/0. */
export function tronHotKey(seed: string): TronKey {
  return tronKeyAt(bip32Branch(seed, "m/44'/195'/1'/0"), 0);
}

/**
 * secp256k1 over a 32-byte digest (no prehash), deterministic RFC 6979, low-S, as hex r || s || v with v = recovery +
 * 27 (TronWeb's ECKeySign: tronweb 6.5.1 lib/esm/utils/crypto.js:168-173). Internal: only signTronTx calls it, after
 * its destination checks (and the TronWeb oracle test pins it on edge digests).
 */
export function tronSignDigest(digestHex: string, priv: Uint8Array): string {
  if (!/^[0-9a-fA-F]{64}$/.test(digestHex)) throw new Error("digest must be 32 bytes of hex");
  const rec = secp256k1.sign(hexToBytes(digestHex), priv, { prehash: false, lowS: true, format: "recovered" });
  return bytesToHex(rec.subarray(1)) + (rec[0]! + 27).toString(16).padStart(2, "0");
}

// ---- Solana: SLIP-0010 ed25519, m/44'/501'/i'/0' deposits, m/44'/501'/2147483646'/0' hot ----
/** A SLIP-10 ed25519 node: the 32-byte private key (the ed25519 seed) and the chain code. */
export type Slip10Node = { key: Uint8Array; chainCode: Uint8Array };
export type SolKey = { priv: Uint8Array; pub: Uint8Array; address: string };

const HARDENED = 0x80000000;
const MASTER_KEY = new TextEncoder().encode("ed25519 seed");
/** The sweeper's hot wallet account index: no deposit may use it. */
const HOT_ACCOUNT = 0x7ffffffe;

function split(i: Uint8Array): Slip10Node {
  return { key: i.slice(0, 32), chainCode: i.slice(32) };
}

/** SLIP-0010 master node of a seed. */
function master(seed: Uint8Array): Slip10Node {
  return split(hmac(sha512, MASTER_KEY, seed));
}

/** Hardened child `index` (0 .. 2^31-1, without the hardened bit) of a node. ed25519 has no other kind. */
function hardenedChild(parent: Slip10Node, index: number): Slip10Node {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error("derivation index out of range");
  const data = new Uint8Array(37);
  data.set(parent.key, 1); // data[0] = 0x00
  new DataView(data.buffer).setUint32(33, index + HARDENED);
  return split(hmac(sha512, parent.chainCode, data));
}

const SEGMENT = /^(0|[1-9]\d{0,9})'$/;

/** The node at `path` (`m` or `m/a'/b'/...`, hardened segments only; anything else throws). */
export function slip10Node(seed: Uint8Array, path: string): Slip10Node {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("invalid derivation path");
  const indexes = parts.slice(1).map((p) => {
    const m = SEGMENT.exec(p);
    const n = m ? Number(m[1]) : NaN;
    if (!(n < HARDENED)) throw new Error("invalid derivation path: hardened segments only (0..2147483647')");
    return n;
  });
  return indexes.reduce(hardenedChild, master(seed));
}

/** SLIP-0010 ed25519 private key (32 bytes) at a hardened-only path. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  return slip10Node(seed, path).key;
}

// PBKDF2 (2048 rounds) runs once per normalised seed per isolate; only the m/44'/501' node is kept, never the master key.
const branches = new Map<string, Slip10Node>();

function coinNode(seed: string): Slip10Node {
  const m = assertValidMnemonic(seed);
  let b = branches.get(m);
  if (!b) {
    b = slip10Node(mnemonicToSeedSync(m), "m/44'/501'");
    branches.set(m, b);
  }
  return b;
}

function solKeyAt(seed: string, account: number): SolKey {
  const { key } = hardenedChild(hardenedChild(coinNode(seed), account), 0);
  const pub = ed25519.getPublicKey(key);
  return { priv: key, pub, address: base58.encode(pub) };
}

/** Deposit key m/44'/501'/i'/0'. `i` stops short of the hot wallet's account index. */
export function solDepositKey(seed: string, i: number): SolKey {
  if (!Number.isInteger(i) || i < 0 || i >= HOT_ACCOUNT) throw new Error("derivation index out of range");
  return solKeyAt(seed, i);
}

/** Hot wallet key m/44'/501'/2147483646'/0'. */
export function solHotKey(seed: string): SolKey {
  return solKeyAt(seed, HOT_ACCOUNT);
}

// ---- UTXO ----

/** Account-level key (m/84'/0'/0' etc.) derived from a BIP39 mnemonic, private part included (signing only). */
export function utxoSeedAccount(mnemonic: string, chain: UtxoChain): HDKey {
  const net = UTXO_NETWORKS[chain];
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(assertValidMnemonic(mnemonic)), net.bip32);
  return root.derive(net.path);
}

// ---- EVM deposit salts ----

/** BIP32 path of the salt key: purpose 7703' is no wallet standard, so this key never holds or signs for funds. */
const EVM_SALT_PATH = "m/7703'/60'/0'";

/**
 * The HMAC key behind EVM deposit forwarder salts (evmDepositSalt in ./addresses). It spends nothing: it only keeps
 * deposit addresses from being computed by anyone without MASTER_SEED.
 */
export function evmSaltKey(seed: string): Uint8Array {
  const priv = bip32Branch(seed, EVM_SALT_PATH).privateKey;
  if (!priv) throw new Error("no private key");
  return priv;
}
