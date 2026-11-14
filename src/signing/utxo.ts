import { hexToBytes } from "@noble/hashes/utils.js";
import { p2pkh, p2wpkh, Transaction } from "@scure/btc-signer";
import { DUST, MAX_FEE_RATE, MAX_INPUTS, MAX_SLACK_VB, outputScript, scriptAddress, spendVsize } from "../chains/utxo/spend";
import { UTXO_NETWORKS, type UtxoChain } from "../chains/utxo/networks";
import { assetOf, requirePays, type Allowed, type Pay } from "../routing/guard";
import { utxoSeedAccount } from "./keys";

/*
 * The only UTXO signer: a routing spend of our own deposit-chain outputs (account/0/index of MASTER_SEED, the
 * chain's routed mode) to a trade deposit, with optional change to a fresh index of ours.
 *   - Every input is signed with the key re-derived from its own index; its previous output is our script for that
 *     key (P2WPKH: witnessUtxo, the amount committed by BIP143; P2PKH: the full previous tx, `prevTx`, which must
 *     hash to the txid and carry exactly the given value there, so a lying explorer cannot hide value in the fee).
 *   - The destinations are read back from the built tx's output scripts and must be covered by `proofs`: the first
 *     output by a swap or refund proof binding exactly its amount and the chain's coin (spent by this use), the change
 *     output by a `change` proof (an address re-derived at an allocated index that no payment uses), and the change
 *     must be at least DUST[chain].
 *   - The fee is feeRate x the largest vsize of the tx (chains/utxo/spend.ts); feeRate is at most MAX_FEE_RATE. With
 *     change, the change is what is left after it (at least DUST[chain], else refused). Without, the
 *     caller's amount must leave a fee in [rate x vsize, rate x (vsize + MAX_SLACK_VB)]: never less, never a windfall
 *     for the miner.
 * Low-R signatures. Throws (signing nothing) on anything else. Errors never carry key material.
 */

export interface UtxoSpendInput {
  txid: string;
  vout: number;
  value: bigint;
  /** Derivation index (deposit chain) of the address holding it. */
  index: number;
  /** P2PKH chains: the previous tx, raw hex. */
  prevTx?: string;
}
export interface UtxoSpend {
  chain: UtxoChain;
  utxos: UtxoSpendInput[];
  to: string;
  amount: bigint;
  /** sat/vB (koinu per byte on DOGE). */
  feeRate: bigint;
  changeTo?: string;
}

const net = (chain: UtxoChain) => {
  const n = UTXO_NETWORKS[chain];
  return { bech32: n.bech32 ?? "", pubKeyHash: n.pubKeyHash, scriptHash: n.scriptHash, wif: n.wif };
};

/** Builds and signs the spend; returns the raw tx hex, its fee, its txid and its vsize. */
export function buildUtxoSpend(seed: string, s: UtxoSpend, proofs: readonly Allowed[]): { hex: string; fee: bigint; txid: string; vsize: number } {
  const { chain } = s;
  const n = UTXO_NETWORKS[chain];
  if (!n) throw new Error("utxo signer: not a UTXO chain");
  if (s.utxos.length < 1 || s.utxos.length > MAX_INPUTS) throw new Error(`utxo signer: 1 to ${MAX_INPUTS} inputs`);
  if (typeof s.feeRate !== "bigint" || s.feeRate < 1n || s.feeRate > MAX_FEE_RATE[chain]) throw new Error(`utxo signer: fee rate outside 1..${MAX_FEE_RATE[chain]}`);
  if (typeof s.amount !== "bigint" || s.amount <= 0n) throw new Error("utxo signer: amount must be positive");
  const seen = new Set<string>();
  for (const u of s.utxos) {
    const k = `${u.txid.toLowerCase()}:${u.vout}`;
    if (seen.has(k)) throw new Error("utxo signer: an input appears twice");
    seen.add(k);
    if (typeof u.value !== "bigint" || u.value <= 0n) throw new Error("utxo signer: input value must be positive");
  }
  const total = s.utxos.reduce((a, u) => a + u.value, 0n);
  const toScript = outputScript(chain, s.to);
  const lens = s.changeTo === undefined ? [toScript.length] : [toScript.length, outputScript(chain, s.changeTo).length];
  const vsize = spendVsize(chain, s.utxos.length, lens);
  const need = s.feeRate * vsize;
  let change = 0n;
  if (s.changeTo !== undefined) {
    change = total - s.amount - need;
    if (change < DUST[chain]) throw new Error(`utxo signer: the change would be below the ${chain} dust floor (${DUST[chain]})`);
  } else {
    const fee = total - s.amount;
    if (fee < need) throw new Error("utxo signer: the inputs do not cover the amount and the fee");
    if (fee > s.feeRate * (vsize + MAX_SLACK_VB)) throw new Error("utxo signer: the fee would exceed the rate asked for");
  }

  const account = utxoSeedAccount(seed, chain).deriveChild(0);
  const tx = new Transaction({ lowR: true });
  const keys: Uint8Array[] = [];
  for (const u of s.utxos) {
    const node = account.deriveChild(u.index);
    if (!node.privateKey || !node.publicKey) throw new Error("utxo signer: no key at that index");
    keys.push(node.privateKey);
    const script = n.type === "p2wpkh" ? p2wpkh(node.publicKey, net(chain)).script : p2pkh(node.publicKey, net(chain)).script;
    if (n.type === "p2wpkh") {
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: u.value } });
    } else {
      if (!u.prevTx) throw new Error("utxo signer: a P2PKH input needs its previous tx");
      const prev = Transaction.fromRaw(hexToBytes(u.prevTx), { allowUnknownOutputs: true, disableScriptCheck: true });
      if (prev.id !== u.txid.toLowerCase()) throw new Error("utxo signer: the previous tx does not hash to the input's txid");
      const out = u.vout < prev.outputsLength ? prev.getOutput(u.vout) : undefined;
      if (!out || out.amount !== u.value || !out.script || !same(out.script, script)) throw new Error("utxo signer: the previous output is not this value at our address");
      tx.addInput({ txid: u.txid, index: u.vout, nonWitnessUtxo: hexToBytes(u.prevTx) });
    }
  }
  tx.addOutput({ script: toScript, amount: s.amount });
  if (s.changeTo !== undefined) tx.addOutput({ script: outputScript(chain, s.changeTo), amount: change });

  // The destinations, read back from the outputs being signed.
  const asset = assetOf(chain, null);
  const pays: Pay[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new Error("utxo signer: malformed output");
    const address = scriptAddress(chain, o.script);
    pays.push(i === 0 ? { address, kinds: ["swap", "refund"], what: "trade deposit", asset, amount: o.amount } : { address, kinds: ["change"], what: "change output", asset, amount: o.amount });
  }
  requirePays(proofs, chain, pays);

  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  const fee = total - s.amount - change;
  if (BigInt(tx.vsize) > vsize) throw new Error("utxo signer: the signed tx is larger than its fee was computed for");
  return { hex: tx.hex, fee, txid: tx.id, vsize: tx.vsize };
}

const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);
