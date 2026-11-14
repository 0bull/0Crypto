import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32m } from "@scure/base";

// Railgun `0zk` addresses: a port of @railgun-community/engine 9.9.1 dist/key-derivation/bech32.js (encodeAddress /
// decodeAddress), checked against the engine's own encodings in test/fixtures/railgun/golden.json.
//
// Payload (73 bytes, bech32m, hrp "0zk", length limit 127):
//   [0]      version, must be 1 (engine ADDRESS_VERSION)
//   [1..33]  masterPublicKey, big-endian uint256
//   [33..41] networkID XOR "railgun" (7 bytes; buffer-xor 2.0.2 xors over the longer input, so byte 8 is unchanged)
//   [41..73] viewingPublicKey (ed25519, 32 bytes)
// networkID is ff..ff (8 bytes) for "all chains", else 1 byte chain type + 7 bytes big-endian chain id.

const PREFIX = "0zk";
const LENGTH_LIMIT = 127;
const VERSION = 1;
const PAYLOAD_BYTES = 73;
const RAILGUN = new TextEncoder().encode("railgun");
/** BN254 scalar field: a master public key is a Poseidon output, so it is always below this. */
export const SNARK_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface RailgunChain {
  type: number;
  id: number;
}

export interface RailgunAddress {
  masterPublicKey: bigint;
  viewingPublicKey: Uint8Array;
  /** Undefined when the address is valid on all chains (the usual form). */
  chain?: RailgunChain;
}

export class InvalidRailgunAddress extends Error {
  override name = "InvalidRailgunAddress";
  constructor(reason: string) {
    super(`invalid Railgun address: ${reason}`);
  }
}

const xorRailgun = (net: Uint8Array): Uint8Array => Uint8Array.from(net, (b, i) => (i < RAILGUN.length ? b ^ RAILGUN[i]! : b));

const bytesToBigInt = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

function bigIntToBytes(n: bigint, len: number): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(8 * len)) throw new RangeError(`value does not fit in ${len} bytes`);
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

/** Decodes a `0zk` address. Throws InvalidRailgunAddress on anything the engine would reject, and on a few things more. */
export function decode0zk(addr: string): RailgunAddress {
  if (typeof addr !== "string" || !addr.includes("1")) throw new InvalidRailgunAddress("not a bech32 string");
  let prefix: string;
  let data: Uint8Array;
  try {
    // bech32m only: a plain-bech32 checksum fails here like any other bad checksum.
    const decoded = bech32m.decode(addr as `${string}1${string}`, LENGTH_LIMIT);
    prefix = decoded.prefix;
    data = bech32m.fromWords(decoded.words);
  } catch {
    throw new InvalidRailgunAddress("bad bech32m encoding or checksum");
  }
  if (prefix !== PREFIX) throw new InvalidRailgunAddress(`prefix must be "${PREFIX}"`);
  if (data.length !== PAYLOAD_BYTES) throw new InvalidRailgunAddress(`payload must be ${PAYLOAD_BYTES} bytes, got ${data.length}`);
  if (data[0] !== VERSION) throw new InvalidRailgunAddress(`unsupported version ${data[0]}`);
  const masterPublicKey = bytesToBigInt(data.subarray(1, 33));
  if (masterPublicKey >= SNARK_PRIME) throw new InvalidRailgunAddress("master public key is outside the BN254 scalar field");
  const net = xorRailgun(data.subarray(33, 41));
  const viewingPublicKey = data.slice(41, 73);
  if (net.every((b) => b === 0xff)) return { masterPublicKey, viewingPublicKey };
  const id = bytesToBigInt(net.subarray(1, 8));
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidRailgunAddress("chain id is out of range");
  return { masterPublicKey, viewingPublicKey, chain: { type: net[0]!, id: Number(id) } };
}

/** Encodes a `0zk` address (engine encodeAddress). Used by tests for round-trips; 0Crypto never mints addresses. */
export function encode0zk(a: RailgunAddress): string {
  if (a.viewingPublicKey.length !== 32) throw new RangeError("viewing public key must be 32 bytes");
  const net = a.chain
    ? new Uint8Array([...bigIntToBytes(BigInt(a.chain.type), 1), ...bigIntToBytes(BigInt(a.chain.id), 7)])
    : new Uint8Array(8).fill(0xff);
  const payload = new Uint8Array([VERSION, ...bigIntToBytes(a.masterPublicKey, 32), ...xorRailgun(net), ...a.viewingPublicKey]);
  return bech32m.encode(PREFIX, bech32m.toWords(payload), LENGTH_LIMIT);
}

/**
 * A shielding destination check (used by the routing config check): the address decodes, its viewing public key is a
 * valid ed25519 point (strict decoding, as the shared-key derivation needs), and, when both the caller and the address
 * name a chain, they are the same chain. Returns the decoded address; throws InvalidRailgunAddress otherwise.
 */
export function validateRailgunDestination(addr: string, chain?: RailgunChain): RailgunAddress {
  const a = decode0zk(addr);
  try {
    ed25519.Point.fromBytes(a.viewingPublicKey);
  } catch {
    throw new InvalidRailgunAddress("viewing public key is not a valid ed25519 point");
  }
  if (chain && a.chain && (a.chain.type !== chain.type || a.chain.id !== chain.id)) {
    throw new InvalidRailgunAddress(`address is for chain ${a.chain.type}:${a.chain.id}, not ${chain.type}:${chain.id}`);
  }
  return a;
}
