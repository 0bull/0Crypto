import { Address, OutScript } from "@scure/btc-signer";
import type { Env } from "../../env";
import { EXPLORER_TIMEOUT_MS, explorerFetch } from "./explorer";
import { UTXO_NETWORKS, type UtxoChain } from "./networks";

/*
 * Size and fee arithmetic of a routing spend (src/signing/utxo.ts buildUtxoSpend signs it). Pure: no keys here.
 *
 * Our inputs are all the chain's own deposit type: P2WPKH on BTC and LTC, P2PKH on DOGE. Signatures are low-R and
 * low-S (btc-signer `lowR: true`), so a DER signature is at most 70 bytes, 71 with the sighash byte: the size below
 * is the largest the signed tx can be, and the signed tx is never bigger (a rarely shorter signature only makes it
 * smaller, so the fee rate paid is never below the one asked for).
 *   P2WPKH input: 41 bytes (outpoint 36, empty scriptSig 1, sequence 4) + witness 107 (count 1, sig 1+71, pubkey 1+33)
 *   P2PKH input:  147 bytes (outpoint 36, scriptSig 1+106 (push 71 sig, push 33 pubkey), sequence 4)
 *   tx overhead:  10 bytes (version 4, input and output counts 1 each, locktime 4) + 2 witness weight units (segwit)
 *   output:       8 (value) + 1 + script length
 * Counts stay below 253 (MAX_INPUTS), so each count is one byte.
 *
 * Fee rates are atomic units per vbyte (sat/vB):
 *   BTC, LTC  the explorer's `/api/v1/fees/recommended` halfHourFee (mempool.space, litecoinspace.org), capped at
 *             MAX_FEE_RATE: a rate above the cap is clamped to it (the tx may confirm later; it never overpays)
 *   DOGE      fixed 0.01 DOGE/kB = 1,000 koinu per byte (Dogecoin Core's recommended minimum relay fee)
 */

/** Most inputs one routing spend takes. */
export const MAX_INPUTS = 100;
/** Highest fee rate (sat/vB) a routing spend may pay: BTC 200 (a congested mempool's top), LTC 50, DOGE the fixed rate. */
export const MAX_FEE_RATE: Record<UtxoChain, bigint> = { btc: 200n, ltc: 50n, doge: 1000n };
/** 0.01 DOGE per 1000 bytes, in koinu per byte. */
export const DOGE_FEE_RATE = 1000n;
/** Smallest change output we create (below it the change goes to the fee): above every chain's dust limit. */
export const DUST: Record<UtxoChain, bigint> = { btc: 1_000n, ltc: 10_000n, doge: 100_000_000n };
/** The longest standard output script (P2TR / P2WSH: 34 bytes): a trade deposit address is sized as this before it is known. */
export const MAX_OUTPUT_SCRIPT = 34;

/**
 * Vbytes over the exact size a no-change spend may pay for (the signer refuses more): the planner sizes the unknown
 * deposit output as MAX_OUTPUT_SCRIPT, at most 12 bytes over the shortest standard one.
 */
export const MAX_SLACK_VB = 16n;

/** Script length of our own (change) output type. */
export const ownScriptLength = (chain: UtxoChain): number => (UTXO_NETWORKS[chain].type === "p2wpkh" ? 22 : 25);

const network = (chain: UtxoChain) => {
  const n = UTXO_NETWORKS[chain];
  return { bech32: n.bech32 ?? "", pubKeyHash: n.pubKeyHash, scriptHash: n.scriptHash, wif: n.wif };
};

/** The output script of a mainnet address of `chain` (throws on anything else). */
export function outputScript(chain: UtxoChain, address: string): Uint8Array {
  return OutScript.encode(Address(network(chain)).decode(address));
}

/** The address an output script pays on `chain` (bech32 lowercase), or throws for a non-standard script. */
export function scriptAddress(chain: UtxoChain, script: Uint8Array): string {
  return Address(network(chain)).encode(OutScript.decode(script));
}

/** The largest vsize of a spend of `nIn` of our inputs to outputs with these script lengths (see the module comment). */
export function spendVsize(chain: UtxoChain, nIn: number, outScriptLengths: number[]): bigint {
  if (!Number.isInteger(nIn) || nIn < 1 || nIn > MAX_INPUTS) throw new RangeError(`a routing spend takes 1 to ${MAX_INPUTS} inputs`);
  if (outScriptLengths.length < 1 || outScriptLengths.length > 2) throw new RangeError("a routing spend has one or two outputs");
  const outs = outScriptLengths.reduce((s, l) => s + 9 + l, 0);
  if (UTXO_NETWORKS[chain].type === "p2pkh") return BigInt(10 + outs + nIn * 147);
  const weight = 4 * (10 + outs + nIn * 41) + 2 + nIn * 107;
  return BigInt(Math.ceil(weight / 4));
}

/** The fee of such a spend at `feeRate` sat/vB. */
export const spendFee = (chain: UtxoChain, nIn: number, outScriptLengths: number[], feeRate: bigint): bigint => feeRate * spendVsize(chain, nIn, outScriptLengths);

export class FeeRateUnavailable extends Error {
  override name = "FeeRateUnavailable";
}

const DEFAULT_FEE_API: Record<"btc" | "ltc", string> = { btc: "https://mempool.space/api", ltc: "https://litecoinspace.org/api" };

/**
 * The fee rate (sat/vB) for a routing spend now: DOGE fixed; BTC/LTC halfHourFee from `<esplora base>/v1/fees/recommended`
 * (BTC_ESPLORA_URL / LTC_ESPLORA_URL, else mempool.space / litecoinspace.org), at least 1, clamped to MAX_FEE_RATE.
 * An unreadable answer throws FeeRateUnavailable: never a guessed rate.
 */
export async function routeFeeRate(env: Pick<Env, "BTC_ESPLORA_URL" | "LTC_ESPLORA_URL">, chain: UtxoChain): Promise<bigint> {
  if (chain === "doge") return DOGE_FEE_RATE;
  const base = ((chain === "btc" ? env.BTC_ESPLORA_URL : env.LTC_ESPLORA_URL) || DEFAULT_FEE_API[chain]).replace(/\/+$/, "");
  let body: unknown;
  try {
    body = await (await explorerFetch(`${base}/v1/fees/recommended`, {}, EXPLORER_TIMEOUT_MS)).json();
  } catch (e) {
    throw new FeeRateUnavailable(`${chain}: no fee estimate (${e instanceof Error ? e.name : "error"})`);
  }
  const v = typeof body === "object" && body !== null ? (body as Record<string, unknown>).halfHourFee : undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new FeeRateUnavailable(`${chain}: malformed fee estimate`);
  const rate = BigInt(Math.max(1, Math.ceil(v)));
  return rate > MAX_FEE_RATE[chain] ? MAX_FEE_RATE[chain] : rate;
}

/** One spendable output and where it came from (a payment's deposit, or one of our change or refund addresses). */
export interface SpendInput {
  txid: string;
  vout: number;
  value: bigint;
  /** Derivation index of its address on the deposit chain (account/0/index). */
  index: number;
  address: string;
  /** The payment whose deposit holds it (absent for our change and refund addresses). */
  paymentId?: string;
}
export interface SpendPlan {
  inputs: SpendInput[];
  /** What the trade deposit receives. */
  amount: bigint;
  /** Whether a change output (to a fresh index) is planned. */
  change: boolean;
  /** The planned fee: the trade deposit sized as the longest standard output script. */
  fee: bigint;
}

/**
 * Picks inputs for a chunk of `chunk` from `groups` (all outputs of one source are spent together, in order, so a
 * payment is either fully routed or not touched). The deposit output is sized as MAX_OUTPUT_SCRIPT. When the whole of
 * what is available minus the fee does not exceed the chunk, everything goes and there is no change. Otherwise
 * sources are added until they cover chunk + fee with change of at least DUST; change below DUST is left to the fee
 * by sending sum - fee instead (a little over the chunk). Null: nothing to spend.
 */
export function planUtxoSpend(chain: UtxoChain, groups: SpendInput[][], chunk: bigint, feeRate: bigint): SpendPlan | null {
  const all: SpendInput[] = [];
  for (const g of groups) {
    if (all.length + g.length > MAX_INPUTS) break;
    all.push(...g);
  }
  if (all.length === 0 || chunk <= 0n) return null;
  const sum = (xs: SpendInput[]) => xs.reduce((s, x) => s + x.value, 0n);
  const one = (n: number) => spendFee(chain, n, [MAX_OUTPUT_SCRIPT], feeRate);
  const two = (n: number) => spendFee(chain, n, [MAX_OUTPUT_SCRIPT, ownScriptLength(chain)], feeRate);
  const whole = sum(all) - one(all.length);
  if (whole <= 0n) return null;
  if (whole <= chunk) return { inputs: all, amount: whole, change: false, fee: one(all.length) };
  const picked: SpendInput[] = [];
  for (const g of groups) {
    if (picked.length + g.length > MAX_INPUTS) break;
    picked.push(...g);
    const s = sum(picked);
    if (s - chunk - two(picked.length) >= DUST[chain]) return { inputs: [...picked], amount: chunk, change: true, fee: two(picked.length) };
    if (s - one(picked.length) >= chunk) return { inputs: [...picked], amount: s - one(picked.length), change: false, fee: one(picked.length) };
  }
  return { inputs: all, amount: whole, change: false, fee: one(all.length) };
}
