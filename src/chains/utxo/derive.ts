import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2wpkh } from "@scure/btc-signer";
import { ACCEPTED_PUBLIC_VERSIONS, PRIVATE_VERSIONS, UTXO_NETWORKS, type UtxoChain } from "./networks";

const b58c = createBase58check(sha256);
/** version(4) depth(1) parent fp(4) index(4) chain code(32) key(33) */
const XKEY_LEN = 78;
const KEY_OFFSET = 45;

// Routed mode (seed) accounts come from src/signing/addresses, public part only: no private key leaves src/signing.
export { accountFromSeed } from "../../signing/addresses";

/**
 * Import an account-level extended public key, re-versioning it to the chain's
 * standard public version. Private keys are refused.
 */
export function accountFromXpub(xpub: string, chain: UtxoChain): HDKey {
  const net = UTXO_NETWORKS[chain];
  const raw = b58c.decode(xpub);
  if (raw.length !== XKEY_LEN) throw new Error("invalid extended key length");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(0);
  if (PRIVATE_VERSIONS.includes(version) || raw[KEY_OFFSET] === 0x00) throw new Error("refusing private key");
  if (!ACCEPTED_PUBLIC_VERSIONS[chain].includes(version)) throw new Error("unsupported xpub version");
  // Reject chain/address-level keys; depth 1-3 all occur in practice (Electrum zpubs sit at depth 1).
  if (raw[4] >= 4) throw new Error("xpub depth too deep: expected an account-level key");
  view.setUint32(0, net.bip32.public);
  return HDKey.fromExtendedKey(b58c.encode(raw), net.bip32);
}

/** Address on the external chain: account/0/index. */
export function deriveUtxoAddress(account: HDKey, chain: UtxoChain, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("derivation index out of range");
  }
  const net = UTXO_NETWORKS[chain];
  const pub = account.deriveChild(0).deriveChild(index).publicKey;
  if (!pub) throw new Error("no public key");
  const params = { bech32: net.bech32 ?? "", pubKeyHash: net.pubKeyHash, scriptHash: net.scriptHash, wif: net.wif };
  const address = net.type === "p2wpkh" ? p2wpkh(pub, params).address : p2pkh(pub, params).address;
  if (!address) throw new Error("address derivation failed");
  return address;
}
