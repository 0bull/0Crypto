/**
 * Verification of node-built Tron transactions before anything is signed. TronGrid builds our unsigned txs, so a
 * compromised or malicious API could try to redirect funds: we decode `raw_data_hex` ourselves (the bytes whose
 * sha256 is the txID we sign) and refuse anything that is not exactly the transfer we asked for. The `raw_data` JSON
 * a node returns next to it is never read.
 *
 * Only `Transaction.raw` with one TransferContract (type 1) or TriggerSmartContract (type 31) is understood:
 *   raw:      1 ref_block_bytes, 3 ref_block_num, 4 ref_block_hash, 8 expiration, 11 contract, 14 timestamp, 18 fee_limit
 *             (9 auths, 10 data/memo, 12 scripts and anything else are refused)
 *   Contract: 1 type, 2 parameter (google.protobuf.Any: 1 type_url, 2 value); 3 provider, 4 ContractName, 5 Permission_id refused
 *   TransferContract:     1 owner_address, 2 to_address, 3 amount
 *   TriggerSmartContract: 1 owner_address, 2 contract_address, 3 call_value (must be 0), 4 data; 5 call_token_value, 6 token_id refused
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { getAsset } from "../../core/assets";
import { tronBase58ToHex, tronHexToBase58 } from "./address";

export class TxMismatch extends Error {
  constructor(readonly reason: string) {
    super(`tron tx mismatch: ${reason}`);
    this.name = "TxMismatch";
  }
}

/**
 * The node built the tx with an expiration that has already passed (a lagging or stale node). Not an attack: the
 * caller retries on the next run, without a security alert. Still a TxMismatch, so a careless caller never signs it.
 * Only thrown once every content check has passed.
 */
export class StaleTx extends TxMismatch {
  constructor() {
    super("expiration is in the past");
    this.name = "StaleTx";
  }
}

/**
 * A sweep tops a deposit up below this, with exactly this much (sun): bandwidth for its USDT transfer. Defined here
 * once: the sweeper sends it and the Tron signer allows a guard `energy` proof to cover only this amount.
 */
export const TOPUP_SUN = 500_000n;
/** The most TRX a sweep tx may burn for energy (fee_limit), in sun: 5 TRX. */
export const MAX_FEE_LIMIT_SUN = 5_000_000n;
/** A node sets expiration ~60 s ahead; anything further than this is refused. */
export const MAX_EXPIRATION_AHEAD_MS = 24 * 3_600_000;

export type TronTxType = "TransferContract" | "TriggerSmartContract";
export interface DecodedTronTx {
  type: TronTxType;
  /** Base58 addresses. */
  owner: string;
  /** TransferContract only. */
  to?: string;
  amount?: bigint;
  /** TriggerSmartContract only: the called contract and the calldata (lowercase hex, no 0x). */
  contract?: string;
  data?: string;
  callValue?: bigint;
  expiration: number;
  timestamp?: number;
  /** Absent means 0. */
  feeLimit?: bigint;
}
export interface TronTxExpect {
  type: TronTxType;
  owner: string;
  /** TRX recipient, or the TRC-20 recipient inside the calldata. */
  to: string;
  /** Sun, or TRC-20 atomic units. */
  amount: bigint;
  /** TriggerSmartContract: the token contract (must be USDT). */
  contract?: string;
}

const fail = (reason: string): never => {
  throw new TxMismatch(reason);
};

const INT64_MAX = (1n << 63n) - 1n;
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

type Field = { num: number; wire: number; varint?: bigint; bytes?: Uint8Array };

/**
 * Minimal strict protobuf reader: varint, fixed64/32 and length-delimited fields. Truncated input, varints longer
 * than 10 bytes, non-minimal or above-uint64 varints, field number 0 and wire types 3/4 (groups) and 6/7 throw.
 */
function readFields(buf: Uint8Array, what: string): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let v = 0n;
    for (let k = 0; ; k++) {
      if (k >= 10) fail(`${what}: overlong varint`);
      if (i >= buf.length) fail(`${what}: truncated varint`);
      const b = buf[i++]!;
      if (k === 9 && b > 1) fail(`${what}: varint above uint64`);
      v |= BigInt(b & 0x7f) << BigInt(7 * k);
      if (!(b & 0x80)) {
        if (b === 0 && k > 0) fail(`${what}: non-minimal varint`);
        return v;
      }
    }
  };
  const take = (n: number): Uint8Array => {
    if (n > buf.length - i) fail(`${what}: truncated field`);
    const b = buf.subarray(i, i + n);
    i += n;
    return b;
  };
  while (i < buf.length) {
    const tag = varint();
    const wire = Number(tag & 7n);
    const num = tag >> 3n;
    if (num === 0n || num > 536_870_911n) fail(`${what}: bad field number`);
    const f: Field = { num: Number(num), wire };
    if (wire === WIRE_VARINT) f.varint = varint();
    else if (wire === WIRE_LEN) {
      const len = varint();
      if (len > BigInt(buf.length)) fail(`${what}: truncated field`);
      f.bytes = take(Number(len));
    } else if (wire === WIRE_FIXED64) f.bytes = take(8);
    else if (wire === WIRE_FIXED32) f.bytes = take(4);
    else fail(`${what}: unsupported wire type ${wire}`);
    out.push(f);
  }
  return out;
}

/** Picks the allowed fields of a message: each at most once, with the expected wire type; anything else throws. */
function pick(fields: Field[], what: string, allowed: Record<number, number>, refused: Record<number, string> = {}): Map<number, Field> {
  const m = new Map<number, Field>();
  for (const f of fields) {
    if (refused[f.num]) fail(`${what}: ${refused[f.num]} (field ${f.num}) is not allowed`);
    const wire = allowed[f.num];
    if (wire === undefined) fail(`${what}: unknown field ${f.num}`);
    if (f.wire !== wire) fail(`${what}: field ${f.num} has wire type ${f.wire}`);
    if (m.has(f.num)) fail(`${what}: duplicate field ${f.num}`);
    m.set(f.num, f);
  }
  return m;
}

const int64 = (f: Field | undefined, what: string): bigint | undefined => {
  if (!f) return undefined;
  if (f.varint! > INT64_MAX) fail(`${what}: value out of int64 range`);
  return f.varint!;
};
const address = (f: Field | undefined, what: string): string => {
  if (!f) fail(`${what}: missing`);
  const b = f!.bytes!;
  if (b.length !== 21 || b[0] !== 0x41) fail(`${what}: not a 21-byte 0x41 address`);
  return tronHexToBase58(bytesToHex(b));
};

const TYPE_NUM: Record<TronTxType, number> = { TransferContract: 1, TriggerSmartContract: 31 };
const TYPE_URL = (t: TronTxType) => `type.googleapis.com/protocol.${t}`;

function decodeHex(rawHex: string): Uint8Array {
  if (typeof rawHex !== "string" || rawHex.length === 0 || rawHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(rawHex)) fail("raw_data_hex is not hex");
  return hexToBytes(rawHex);
}

/** Decodes `Transaction.raw` (see the module comment for what is accepted). Throws TxMismatch on anything else. */
export function decodeTronRawData(rawHex: string): DecodedTronTx {
  const fields = readFields(decodeHex(rawHex), "raw");
  if (fields.filter((f) => f.num === 11).length > 1) fail("raw: more than one contract");
  const raw = pick(fields, "raw", { 1: WIRE_LEN, 3: WIRE_VARINT, 4: WIRE_LEN, 8: WIRE_VARINT, 11: WIRE_LEN, 14: WIRE_VARINT, 18: WIRE_VARINT }, {
    9: "auths",
    10: "memo (raw.data)",
    12: "scripts",
  });
  const expiration = int64(raw.get(8), "raw.expiration");
  const timestamp = int64(raw.get(14), "raw.timestamp");
  const feeLimit = int64(raw.get(18), "raw.fee_limit");
  int64(raw.get(3), "raw.ref_block_num");
  const c = raw.get(11);
  if (!c) fail("raw: no contract");
  if (raw.get(1)?.bytes?.length !== 2) fail("raw: ref_block_bytes is not 2 bytes");
  if (raw.get(4)?.bytes?.length !== 8) fail("raw: ref_block_hash is not 8 bytes");
  const ct = pick(readFields(c!.bytes!, "contract"), "contract", { 1: WIRE_VARINT, 2: WIRE_LEN }, { 3: "provider", 4: "ContractName", 5: "permission_id" });
  const typeNum = Number(ct.get(1)?.varint ?? 0n);
  const type = (Object.keys(TYPE_NUM) as TronTxType[]).find((t) => TYPE_NUM[t] === typeNum) ?? fail(`contract: type ${typeNum} is not a transfer`);
  const anyF = ct.get(2) ?? fail("contract: no parameter");
  const any = pick(readFields(anyF.bytes!, "parameter"), "parameter", { 1: WIRE_LEN, 2: WIRE_LEN });
  let url: string;
  try {
    url = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(any.get(1)?.bytes ?? new Uint8Array());
  } catch {
    return fail("parameter: type_url is not UTF-8");
  }
  if (url !== TYPE_URL(type)) fail(`parameter: type_url ${JSON.stringify(url.slice(0, 80))} does not match contract type ${type}`);
  const value = any.get(2)?.bytes ?? fail("parameter: no value");

  if (expiration === undefined) fail("raw: no expiration");
  const out: DecodedTronTx = {
    type,
    owner: "",
    expiration: Number(expiration),
    ...(timestamp !== undefined ? { timestamp: Number(timestamp) } : {}),
    ...(feeLimit !== undefined ? { feeLimit } : {}),
  };
  if (type === "TransferContract") {
    const p = pick(readFields(value, "TransferContract"), "TransferContract", { 1: WIRE_LEN, 2: WIRE_LEN, 3: WIRE_VARINT });
    out.owner = address(p.get(1), "TransferContract.owner_address");
    out.to = address(p.get(2), "TransferContract.to_address");
    out.amount = int64(p.get(3), "TransferContract.amount") ?? 0n;
  } else {
    const p = pick(readFields(value, "TriggerSmartContract"), "TriggerSmartContract", { 1: WIRE_LEN, 2: WIRE_LEN, 3: WIRE_VARINT, 4: WIRE_LEN }, {
      5: "call_token_value",
      6: "token_id",
    });
    out.owner = address(p.get(1), "TriggerSmartContract.owner_address");
    out.contract = address(p.get(2), "TriggerSmartContract.contract_address");
    out.callValue = int64(p.get(3), "TriggerSmartContract.call_value") ?? 0n;
    out.data = bytesToHex(p.get(4)?.bytes ?? new Uint8Array());
  }
  return out;
}

/** transfer(address,uint256) calldata: a9059cbb, the 20-byte recipient left-padded to 32 bytes, the amount as uint256. */
export function trc20TransferData(to: string, amount: bigint): string {
  if (amount < 0n || amount >= 1n << 256n) fail("amount out of uint256 range");
  return `a9059cbb${"00".repeat(12)}${tronBase58ToHex(to).slice(2)}${amount.toString(16).padStart(64, "0")}`;
}

/**
 * Throws TxMismatch unless `tx` is exactly the transfer described by `expect`: txID = sha256(raw_data_hex), one
 * contract of the expected type and owner; TRX: recipient and amount; TRC-20: the USDT contract, no TRX or TRC-10
 * value attached, calldata exactly transfer(to, amount); fee_limit at most 5 TRX; an expiration at most 24 h away
 * and (checked last, as StaleTx) in the future. Returns the decoded tx.
 */
export function assertTronTx(tx: { txID: string; raw_data_hex: string }, expect: TronTxExpect, now: number = Date.now()): DecodedTronTx {
  if (typeof tx.txID !== "string" || !/^[0-9a-fA-F]{64}$/.test(tx.txID)) fail("txID is not 32 bytes of hex");
  if (bytesToHex(sha256(decodeHex(tx.raw_data_hex))) !== tx.txID.toLowerCase()) fail("txID is not sha256(raw_data_hex)");
  const d = decodeTronRawData(tx.raw_data_hex);
  if (d.type !== expect.type) fail(`type ${d.type}, expected ${expect.type}`);
  if (d.owner !== expect.owner) fail("owner differs");
  if ((d.feeLimit ?? 0n) > MAX_FEE_LIMIT_SUN) fail(`fee_limit ${d.feeLimit} is over ${MAX_FEE_LIMIT_SUN} sun`);
  if (d.expiration > now + MAX_EXPIRATION_AHEAD_MS) fail("expiration is more than 24h ahead");
  if (d.type === "TransferContract") {
    if (d.to !== expect.to) fail("to differs");
    if (d.amount !== expect.amount) fail("amount differs");
  } else {
    const usdt = getAsset("tron:usdt").contract!;
    if (expect.contract !== usdt) fail("expected contract is not USDT");
    if (d.contract !== usdt) fail("contract is not USDT");
    if (d.callValue !== 0n) fail("call_value is not 0");
    if (d.data !== trc20TransferData(expect.to, expect.amount)) fail("data is not transfer(to, amount)");
  }
  // Last: a stale-but-tampered tx is reported as the mismatch it is.
  if (d.expiration <= now) throw new StaleTx();
  return d;
}

const lenField = (num: number, b: Uint8Array): Uint8Array => {
  const len: number[] = [];
  let n = b.length;
  do {
    len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>>= 7;
  } while (n > 0);
  return concatBytes(Uint8Array.of((num << 3) | WIRE_LEN), Uint8Array.from(len), b);
};

/** A signed `Transaction` for /wallet/broadcasthex: raw_data (field 1) = the verified bytes, signature (field 2). */
export function encodeSignedTx(rawHex: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error("tron signature must be 65 bytes");
  return bytesToHex(concatBytes(lenField(1, decodeHex(rawHex)), lenField(2, sig)));
}
