/**
 * Test-only protobuf writer for Tron `Transaction.raw`, so msw can serve node-built transactions with any values.
 * It is independent of src/chains/tron/txcheck.ts and is itself checked against TronWeb's encoder in
 * test/node/tron-oracle.test.ts (same field order: proto3 omits zero values, fields in number order).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

const varint = (v: bigint): Uint8Array => {
  const out: number[] = [];
  let n = v < 0n ? v + (1n << 64n) : v;
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Uint8Array.from(out);
};
const tag = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
export const fVarint = (field: number, v: bigint | number) => concatBytes(tag(field, 0), varint(BigInt(v)));
export const fBytes = (field: number, b: Uint8Array) => concatBytes(tag(field, 2), varint(BigInt(b.length)), b);
export const fFixed64 = (field: number, b8: Uint8Array) => concatBytes(tag(field, 1), b8);
const hex = (h: string) => hexToBytes(h.replace(/^0x/, ""));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Zero is omitted (proto3), as TronWeb does. */
const opt = (field: number, v: bigint | number | undefined) => (v === undefined || BigInt(v) === 0n ? new Uint8Array() : fVarint(field, v));

export function transferParam(o: { owner: string; to: string; amount: bigint; extra?: Uint8Array }): Uint8Array {
  return concatBytes(fBytes(1, hex(o.owner)), fBytes(2, hex(o.to)), opt(3, o.amount), o.extra ?? new Uint8Array());
}

export function triggerParam(o: { owner: string; contract: string; data: string; callValue?: bigint; callTokenValue?: bigint; tokenId?: bigint; extra?: Uint8Array }): Uint8Array {
  return concatBytes(
    fBytes(1, hex(o.owner)),
    fBytes(2, hex(o.contract)),
    opt(3, o.callValue),
    fBytes(4, hex(o.data)),
    opt(5, o.callTokenValue),
    opt(6, o.tokenId),
    o.extra ?? new Uint8Array(),
  );
}

const TYPES = { TransferContract: 1, TriggerSmartContract: 31 } as const;
export function contract(
  type: keyof typeof TYPES,
  param: Uint8Array,
  o: { typeNum?: number; typeUrl?: string; permissionId?: number; extra?: Uint8Array; anyExtra?: Uint8Array } = {},
): Uint8Array {
  const any = concatBytes(fBytes(1, utf8(o.typeUrl ?? `type.googleapis.com/protocol.${type}`)), fBytes(2, param), o.anyExtra ?? new Uint8Array());
  return concatBytes(fVarint(1, o.typeNum ?? TYPES[type]), fBytes(2, any), opt(5, o.permissionId), o.extra ?? new Uint8Array());
}

export interface RawOpts {
  contracts: Uint8Array[];
  expiration: number;
  timestamp?: number;
  feeLimit?: bigint;
  refBlockBytes?: string;
  refBlockHash?: string;
  /** Field 10 (memo), hex. */
  memo?: string;
  /** Appended verbatim after the known fields. */
  extra?: Uint8Array;
}
export function rawBytes(o: RawOpts): Uint8Array {
  return concatBytes(
    fBytes(1, hex(o.refBlockBytes ?? "a1b2")),
    fBytes(4, hex(o.refBlockHash ?? "0f1e2d3c4b5a6978")),
    fVarint(8, o.expiration),
    o.memo !== undefined ? fBytes(10, hex(o.memo)) : new Uint8Array(),
    ...o.contracts.map((c) => fBytes(11, c)),
    opt(14, o.timestamp),
    opt(18, o.feeLimit),
    o.extra ?? new Uint8Array(),
  );
}

/** A node answer: txID = sha256(raw_data_hex). */
export function nodeTx(raw: Uint8Array | string): { txID: string; raw_data_hex: string } {
  const b = typeof raw === "string" ? hex(raw) : raw;
  return { txID: bytesToHex(sha256(b)), raw_data_hex: bytesToHex(b) };
}

/** TRC-20 transfer(address,uint256) calldata to a hex41 recipient. */
export const transferData = (toHex41: string, amount: bigint) =>
  `a9059cbb${toHex41.replace(/^0x/, "").slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
