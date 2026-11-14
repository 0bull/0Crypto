import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { hexToBytes } from "@noble/hashes/utils.js";
import { p2pkh, Transaction } from "@scure/btc-signer";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountFromSeed, deriveUtxoAddress } from "../../../src/chains/utxo/derive";
import { UTXO_NETWORKS, type UtxoChain } from "../../../src/chains/utxo/networks";
import {
  DOGE_FEE_RATE, DUST, FeeRateUnavailable, MAX_FEE_RATE, MAX_OUTPUT_SCRIPT, outputScript, ownScriptLength, planUtxoSpend, routeFeeRate, scriptAddress, spendFee, spendVsize,
  type SpendInput,
} from "../../../src/chains/utxo/spend";
import { allocateOwnAddress } from "../../../src/routing/own";
import type { Env } from "../../../src/env";
import { allowedDestination, DestinationNotAllowed, type Allowed } from "../../../src/routing/guard";
import { buildUtxoSpend } from "../../../src/signing/utxo";

const e = env as unknown as Env;
const MN = e.MASTER_SEED!;
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const T0 = 1_900_000_000_000;
const addr = (c: UtxoChain, i: number, mn = MN) => deriveUtxoAddress(accountFromSeed(mn, c), c, i);
const tx = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const net = (c: UtxoChain) => {
  const n = UTXO_NETWORKS[c];
  return { bech32: n.bech32 ?? "", pubKeyHash: n.pubKeyHash, scriptHash: n.scriptHash, wif: n.wif };
};

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
beforeEach(async () => {
  for (const t of ["route_batches", "derivation_counters", "own_addresses"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
});

/** A batch whose only leg is claimed for sending `amount` to `to`, and the guard's swap proof for it. */
async function legProof(chain: UtxoChain, to: string, amount: bigint, id = `bat_${chain}_${amount}`): Promise<Allowed> {
  await e.DB.prepare("INSERT OR REPLACE INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(id, `${chain}:${chain}`, amount.toString(), JSON.stringify([amount.toString()]), "xmr", T0, "executing", T0, T0, JSON.stringify([{ chunk: 0, step: "sending", depositAddress: to, amount: amount.toString() }]))
    .run();
  return allowedDestination(e, chain, to, { batchId: id });
}
async function changeProof(chain: UtxoChain): Promise<{ index: number; address: string; proof: Allowed }> {
  const { index, address } = await allocateOwnAddress(e, chain, "change", T0);
  return { index, address, proof: await allowedDestination(e, chain, address, { changeIndex: index }) };
}
const three = [50_000n, 30_000n, 20_000n].map((value, i) => ({ txid: tx(i + 1), vout: i, value, index: 10 + i }));

describe("buildUtxoSpend (src/signing/utxo.ts)", () => {
  it("3 BTC UTXOs, all minus the fee at 5 sat/vB: one output to `to`, fee = 5 x vsize, parses with btc-signer", async () => {
    const to = addr("btc", 0, OTHER);
    const vsize = spendVsize("btc", 3, [outputScript("btc", to).length]);
    const fee = 5n * vsize;
    const amount = 100_000n - fee;
    const r = buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount, feeRate: 5n }, [await legProof("btc", to, amount)]);
    expect(r.fee).toBe(fee);
    const t = Transaction.fromRaw(hexToBytes(r.hex));
    expect(t.outputsLength).toBe(1);
    expect(t.getOutput(0).amount).toBe(amount);
    expect(scriptAddress("btc", t.getOutput(0).script!)).toBe(to);
    expect(t.inputsLength).toBe(3);
    expect(t.id).toBe(r.txid);
    // The largest size is what the fee pays for; low-R signatures make the signed tx exactly that size here.
    expect(BigInt(t.vsize)).toBeLessThanOrEqual(vsize);
    expect(BigInt(r.vsize)).toBe(vsize);
    // Each input is signed by its own index's key (the witness pubkey is the derived one).
    const acct = accountFromSeed(MN, "btc").deriveChild(0);
    three.forEach((u, i) => expect(Buffer.from(t.getInput(i).finalScriptWitness![1]!).toString("hex")).toBe(Buffer.from(acct.deriveChild(u.index).publicKey!).toString("hex")));
  });

  it("an LTC spend pays an ltc1 output", async () => {
    const to = addr("ltc", 0, OTHER);
    expect(to.startsWith("ltc1")).toBe(true);
    const fee = 5n * spendVsize("ltc", 1, [22]);
    const amount = 1_000_000n - fee;
    const r = buildUtxoSpend(MN, { chain: "ltc", utxos: [{ txid: tx(9), vout: 0, value: 1_000_000n, index: 3 }], to, amount, feeRate: 5n }, [await legProof("ltc", to, amount)]);
    const t = Transaction.fromRaw(hexToBytes(r.hex));
    expect(scriptAddress("ltc", t.getOutput(0).script!)).toBe(to);
    expect(r.fee).toBe(fee);
  });

  it("a partial amount: change to a freshly allocated index of ours, the rest after the fee", async () => {
    const to = addr("btc", 0, OTHER);
    const ch = await changeProof("btc");
    const r = buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: 60_000n, feeRate: 5n, changeTo: ch.address }, [await legProof("btc", to, 60_000n), ch.proof]);
    const t = Transaction.fromRaw(hexToBytes(r.hex));
    expect(t.outputsLength).toBe(2);
    expect(scriptAddress("btc", t.getOutput(1).script!)).toBe(addr("btc", ch.index));
    expect(r.fee).toBe(5n * spendVsize("btc", 3, [22, 22]));
    expect(t.getOutput(1).amount).toBe(100_000n - 60_000n - r.fee);
  });

  it("refuses: no proof, the wrong amount, a second tx on the same proof, change without a change proof", async () => {
    const to = addr("btc", 1, OTHER);
    const fee = 5n * spendVsize("btc", 3, [22]);
    const amount = 100_000n - fee;
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount, feeRate: 5n }, [])).toThrow(DestinationNotAllowed);
    const p = await legProof("btc", to, amount - 1n, "bat_wrong");
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount, feeRate: 5n }, [p])).toThrow(/does not pay exactly/);
    const good = await legProof("btc", to, amount, "bat_twice");
    buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount, feeRate: 5n }, [good]);
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three.slice().reverse(), to, amount, feeRate: 5n }, [good])).toThrow(/already used/);
    const ch = addr("btc", 77);
    const p2 = await legProof("btc", to, 50_000n, "bat_nochange");
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: 50_000n, feeRate: 5n, changeTo: ch }, [p2])).toThrow(DestinationNotAllowed);
  });

  it("refuses change below the chain's dust floor", async () => {
    const to = addr("btc", 3, OTHER);
    const ch = await changeProof("btc");
    const fee = 5n * spendVsize("btc", 3, [22, 22]);
    const amount = 100_000n - fee - DUST.btc + 1n;
    const p = await legProof("btc", to, amount, "bat_dust");
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount, feeRate: 5n, changeTo: ch.address }, [p, ch.proof])).toThrow(/dust/);
    const ok = await legProof("btc", to, amount - 1n, "bat_dust_ok");
    expect(buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: amount - 1n, feeRate: 5n, changeTo: ch.address }, [ok, ch.proof]).fee).toBe(fee);
  });

  it("caps the fee: a rate above MAX_FEE_RATE, or a no-change amount that leaves a windfall fee, is refused", async () => {
    const to = addr("btc", 2, OTHER);
    const p = await legProof("btc", to, 10_000n, "bat_cap");
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: 10_000n, feeRate: MAX_FEE_RATE.btc + 1n }, [p])).toThrow(/fee rate/);
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: 10_000n, feeRate: 5n }, [p])).toThrow(/exceed the rate/);
    expect(() => buildUtxoSpend(MN, { chain: "btc", utxos: three, to, amount: 100_000n, feeRate: 5n }, [p])).toThrow(/do not cover/);
  });

  it("DOGE (P2PKH): signs against the full previous tx, which must hash to the txid and hold exactly that value", async () => {
    const ours = addr("doge", 4);
    const prev = new Transaction({ allowUnknownOutputs: true });
    prev.addInput({ txid: tx(0xaa), index: 0 });
    prev.addOutputAddress(ours, 500_000_000n, net("doge"));
    const prevHex = prev.hex;
    const to = addr("doge", 0, OTHER);
    const fee = DOGE_FEE_RATE * spendVsize("doge", 1, [25]);
    const amount = 500_000_000n - fee;
    const p = await legProof("doge", to, amount);
    const u = { txid: prev.id, vout: 0, value: 500_000_000n, index: 4 };
    expect(() => buildUtxoSpend(MN, { chain: "doge", utxos: [u], to, amount, feeRate: DOGE_FEE_RATE }, [p])).toThrow(/previous tx/);
    expect(() => buildUtxoSpend(MN, { chain: "doge", utxos: [{ ...u, value: 400_000_000n, prevTx: prevHex }], to, amount: 400_000_000n - fee, feeRate: DOGE_FEE_RATE }, [p])).toThrow();
    expect(() => buildUtxoSpend(MN, { chain: "doge", utxos: [{ ...u, txid: tx(0xbb), prevTx: prevHex }], to, amount, feeRate: DOGE_FEE_RATE }, [p])).toThrow(/hash to/);
    const r = buildUtxoSpend(MN, { chain: "doge", utxos: [{ ...u, prevTx: prevHex }], to, amount, feeRate: DOGE_FEE_RATE }, [p]);
    const t = Transaction.fromRaw(hexToBytes(r.hex));
    expect(scriptAddress("doge", t.getOutput(0).script!)).toBe(to);
    expect(r.fee).toBe(fee);
    expect(BigInt(t.vsize)).toBeLessThanOrEqual(spendVsize("doge", 1, [25]));
    expect(p2pkh(accountFromSeed(MN, "doge").deriveChild(0).deriveChild(4).publicKey!, net("doge")).address).toBe(ours);
  });
});

describe("fee rate", () => {
  it("BTC/LTC: halfHourFee from /api/v1/fees/recommended, rounded up, clamped to MAX_FEE_RATE; DOGE fixed 0.01 DOGE/kB", async () => {
    network.use(http.get("https://mempool.space/api/v1/fees/recommended", () => HttpResponse.json({ fastestFee: 30, halfHourFee: 12.2, hourFee: 8 })));
    expect(await routeFeeRate(e, "btc")).toBe(13n);
    network.use(http.get("https://mempool.space/api/v1/fees/recommended", () => HttpResponse.json({ halfHourFee: 5000 })));
    expect(await routeFeeRate(e, "btc")).toBe(MAX_FEE_RATE.btc);
    network.use(http.get("https://litecoinspace.org/api/v1/fees/recommended", () => HttpResponse.json({ halfHourFee: 3 })));
    expect(await routeFeeRate(e, "ltc")).toBe(3n);
    expect(await routeFeeRate(e, "doge")).toBe(1000n);
    expect(DOGE_FEE_RATE * 1000n).toBe(1_000_000n); // 0.01 DOGE per 1000 bytes
  });
  it("fails closed: no estimate is never a guessed rate", async () => {
    for (const body of [{}, { halfHourFee: "12" }, { halfHourFee: 0 }, { halfHourFee: -3 }]) {
      network.use(http.get("https://mempool.space/api/v1/fees/recommended", () => HttpResponse.json(body)));
      await expect(routeFeeRate(e, "btc")).rejects.toBeInstanceOf(FeeRateUnavailable);
    }
    network.use(http.get("https://mempool.space/api/v1/fees/recommended", () => new HttpResponse(null, { status: 503 })));
    await expect(routeFeeRate(e, "btc")).rejects.toBeInstanceOf(FeeRateUnavailable);
  });
});

describe("planUtxoSpend", () => {
  const src = (pid: string, ...values: bigint[]): SpendInput[] => values.map((value, i) => ({ txid: tx(pid.charCodeAt(0) + i), vout: 0, value, index: pid.charCodeAt(0), address: `a_${pid}`, paymentId: pid }));
  it("everything (minus the fee, no change) when the chunk is at least what is available", () => {
    const p = planUtxoSpend("btc", [src("A", 500_000n), src("B", 300_000n, 200_000n)], 1_000_000n, 5n)!;
    expect(p.inputs).toHaveLength(3);
    expect(p.change).toBe(false);
    expect(p.fee).toBe(spendFee("btc", 3, [MAX_OUTPUT_SCRIPT], 5n));
    expect(p.amount).toBe(1_000_000n - p.fee);
  });
  it("a smaller chunk takes whole sources until the chunk, the fee and change of at least DUST are covered", () => {
    const p = planUtxoSpend("btc", [src("A", 500_000n), src("B", 300_000n, 200_000n)], 600_000n, 5n)!;
    expect(p.inputs.map((i) => i.paymentId)).toEqual(["A", "B", "B"]);
    expect(p.change).toBe(true);
    expect(p.amount).toBe(600_000n);
    expect(p.fee).toBe(spendFee("btc", 3, [MAX_OUTPUT_SCRIPT, ownScriptLength("btc")], 5n));
  });
  it("change below DUST goes to the deposit instead (a little over the chunk)", () => {
    const fee1 = spendFee("btc", 1, [MAX_OUTPUT_SCRIPT], 5n);
    const p = planUtxoSpend("btc", [src("A", 500_000n), src("B", 300_000n)], 500_000n - fee1 - DUST.btc + 1n, 5n)!;
    expect(p.change).toBe(false);
    expect(p.inputs).toHaveLength(1);
    expect(p.amount).toBe(500_000n - fee1);
  });
  it("nothing to spend: null", () => {
    expect(planUtxoSpend("btc", [], 1n, 5n)).toBeNull();
    expect(planUtxoSpend("btc", [src("A", 100n)], 1_000n, 5n)).toBeNull();
  });
});
