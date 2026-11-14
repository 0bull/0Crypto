import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn, type AdminTestSession } from "../admin-session";
import { tronAddressFromPubkey, tronBase58ToHex, tronHexToBase58 } from "../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../src/signing/keys";
import { decodeTronRawData } from "../../src/chains/tron/txcheck";
import { recordAlert } from "../../src/db/alerts";
import { listStuckSweeps } from "../../src/db/sweeps";
import { getPayment, insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { runSweeps } from "../../src/sweep/cron";
import {
  ENERGY_NEW_HOLDER, ENERGY_NORMAL, ENERGY_PRICE_CAP_SUN_PER_UNIT, NEEDS_ADMIN, rentAmount, runTronSweep, TOPUP_SUN, TRON_MAX_PENDING, TRONSAVE_MISSING,
} from "../../src/sweep/tron";
import { contract, nodeTx, rawBytes, transferData, transferParam, triggerParam } from "../chains/tron/pb";
import { offline } from "../offline";

const e = env as unknown as Env;
const API = "https://api.trongrid.io";
const TS = "https://api.tronsave.io";
const BASE = "https://pay.test";
/** The signed-in admin session (set in beforeAll) and its CSRF token. */
let S: AdminTestSession;
let CSRF = "";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const HOT = tronHotKey(e.MASTER_SEED!).address;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_900_000_000_000;
const AMT = 25_000_000n;
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const H = (a: string) => tronBase58ToHex(a);
const body20 = (a: string) => H(a).slice(2);
const saved = { ENABLED_ASSETS: e.ENABLED_ASSETS, TRONGRID_API_KEY: e.TRONGRID_API_KEY, TRONSAVE_API_KEY: e.TRONSAVE_API_KEY };

type Effect = { kind: "trx"; from: string; to: string; amount: bigint } | { kind: "usdt"; from: string; to: string; amount: bigint };
type Tx = { txID: string; raw_data_hex: string };
interface Barrier {
  path: string;
  n: number;
  arrived: number;
  met: boolean;
  release: () => void;
  wait: Promise<void>;
}
interface Sim {
  now: number;
  trx: Record<string, bigint>;
  usdt: Record<string, bigint>;
  energy: Record<string, { limit: number; used: number }>;
  solid: Record<string, unknown>;
  /** What the full node (/wallet/gettransactioninfobyid) knows. */
  full: Record<string, unknown>;
  effects: Record<string, Effect>;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  broadcasts: Array<{ txID: string; raw: string; sig: string; lockAtBroadcast: string | null }>;
  /** TronSave sun per energy (the estimate is unitPrice x amount unless `estimate` overrides it). */
  unitPrice: number;
  rentDelivers: boolean;
  /** Energy delivered per rental (default: the amount rented). */
  deliverAmount?: number;
  tamperTrigger?: (t: Tx) => Tx;
  tamperCreate?: (t: Tx) => Tx;
  broadcastReply?: Record<string, unknown>;
  /** HTTP status for broadcasthex (the tx is still accepted: a lost answer). */
  broadcastStatus?: number;
  buyReply?: () => Response | Promise<Response>;
  onResource?: () => Promise<void>;
  onSolid?: () => Promise<void>;
  barrier?: Barrier;
}
let sim: Sim;
let seq = 100;
let lockOf: string | null = null; // payment id whose sweep_tx is read at each broadcast

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e);
  CSRF = S.csrf;
  Object.assign(e, { ENABLED_ASSETS: "tron:usdt", TRONGRID_API_KEY: "test-trongrid-key", TRONSAVE_API_KEY: "test-tronsave-key" });
  await insertInvoice(e.DB, {
    id: "inv_tron", created_at: T0 - 2 * HOUR, expires_at: T0 + HOUR, price_minor: 2500n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 2500n,
  });
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  for (const t of ["payments", "sweeps", "alerts"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  sim = { now: T0, trx: { [HOT]: 50_000_000n }, usdt: {}, energy: {}, solid: {}, full: {}, effects: {}, calls: [], broadcasts: [], unitPrice: 60, rentDelivers: false };
  lockOf = null;
  network.use(...handlers(), ...offline());
});

/** The first `n` callers of `path` wait for each other (proves two runs really overlapped there). */
function barrier(path: string, n = 2): Barrier {
  let release = () => {};
  const wait = new Promise<void>((r) => (release = r));
  const b: Barrier = { path, n, arrived: 0, met: false, release, wait };
  sim.barrier = b;
  return b;
}
async function gate(path: string) {
  const b = sim.barrier;
  if (!b || b.path !== path || b.arrived >= b.n) return;
  b.arrived++;
  if (b.arrived === b.n) {
    b.met = true;
    b.release();
  } else await Promise.race([b.wait, new Promise((r) => setTimeout(r, 2000))]);
}

const pad = (h: string) => h.padStart(64, "0");
const addrFromWord = (w: string) => tronHexToBase58(`41${w.slice(-40)}`);
function handlers() {
  const rec = async (request: { method: string; json(): Promise<unknown> }, path: string) => {
    const b = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    sim.calls.push({ path, body: b });
    await gate(path);
    return b;
  };
  return [
    http.get(`${API}/v1/accounts/:addr`, async ({ request, params }) => {
      await rec(request, "account");
      const a = params.addr as string;
      return HttpResponse.json({ success: true, data: sim.trx[a] === undefined ? [] : [{ address: H(a), balance: Number(sim.trx[a]) }] });
    }),
    http.post(`${API}/wallet/createtransaction`, async ({ request }) => {
      const b = await rec(request, "createtransaction");
      const [from, to, amount] = [b.owner_address as string, b.to_address as string, BigInt(b.amount as number)];
      let t = nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(from), to: H(to), amount }))], expiration: sim.now + MIN, timestamp: sim.now }));
      if (sim.tamperCreate) t = sim.tamperCreate(t);
      sim.effects[nodeTx(t.raw_data_hex).txID] = { kind: "trx", from, to, amount };
      return HttpResponse.json({ visible: true, txID: t.txID, raw_data: { note: "never read" }, raw_data_hex: t.raw_data_hex });
    }),
    http.post(`${API}/wallet/triggersmartcontract`, async ({ request }) => {
      const b = await rec(request, "triggersmartcontract");
      expect(b.function_selector).toBe("transfer(address,uint256)");
      const p = b.parameter as string;
      const [to, amount] = [addrFromWord(p.slice(0, 64)), BigInt(`0x${p.slice(64)}`)];
      const from = b.owner_address as string;
      let t = nodeTx(
        rawBytes({
          contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(from), contract: H(b.contract_address as string), data: transferData(H(to), amount) }))],
          expiration: sim.now + MIN, timestamp: sim.now, feeLimit: BigInt(b.fee_limit as number),
        }),
      );
      if (sim.tamperTrigger) t = sim.tamperTrigger(t);
      sim.effects[nodeTx(t.raw_data_hex).txID] = { kind: "usdt", from, to, amount };
      return HttpResponse.json({ result: { result: true }, transaction: { visible: true, txID: t.txID, raw_data: {}, raw_data_hex: t.raw_data_hex } });
    }),
    http.post(`${API}/wallet/triggerconstantcontract`, async ({ request }) => {
      const b = await rec(request, "balanceOf");
      expect(b.function_selector).toBe("balanceOf(address)");
      expect(b.contract_address).toBe(USDT);
      const a = addrFromWord(b.parameter as string);
      return HttpResponse.json({ result: { result: true }, constant_result: [pad((sim.usdt[a] ?? 0n).toString(16))] });
    }),
    http.post(`${API}/wallet/getaccountresource`, async ({ request }) => {
      const b = await rec(request, "getaccountresource");
      if (sim.onResource) await sim.onResource();
      const r = sim.energy[b.address as string];
      return HttpResponse.json(r ? { freeNetLimit: 600, EnergyLimit: r.limit, ...(r.used ? { EnergyUsed: r.used } : {}) } : { freeNetLimit: 600 });
    }),
    http.post(`${API}/wallet/broadcasthex`, async ({ request }) => {
      const b = await rec(request, "broadcasthex");
      const hex = b.transaction as string;
      // Transaction { raw_data = 1 (len), signature = 2 (65 bytes) }.
      const bytes = hexToBytes(hex);
      expect(bytes[0]).toBe(0x0a);
      let i = 1, len = 0, shift = 0;
      for (;;) {
        const c = bytes[i++]!;
        len |= (c & 0x7f) << shift;
        shift += 7;
        if (!(c & 0x80)) break;
      }
      const raw = bytesToHex(bytes.subarray(i, i + len));
      expect(bytes[i + len]).toBe(0x12);
      expect(bytes[i + len + 1]).toBe(65);
      const sig = bytesToHex(bytes.subarray(i + len + 2));
      const { txID } = nodeTx(raw);
      const lock = lockOf ? ((await e.DB.prepare("SELECT sweep_tx FROM payments WHERE id=?").bind(lockOf).first<{ sweep_tx: string | null }>())?.sweep_tx ?? null) : null;
      sim.broadcasts.push({ txID, raw, sig, lockAtBroadcast: lock });
      if (sim.broadcastStatus) return new HttpResponse("upstream timeout", { status: sim.broadcastStatus });
      return HttpResponse.json(sim.broadcastReply ?? { result: true, txid: txID });
    }),
    http.post(`${API}/walletsolidity/gettransactioninfobyid`, async ({ request }) => {
      const b = await rec(request, "solid");
      if (sim.onSolid) await sim.onSolid();
      return HttpResponse.json(sim.solid[b.value as string] ?? {});
    }),
    http.post(`${API}/wallet/gettransactioninfobyid`, async ({ request }) => {
      const b = await rec(request, "full");
      return HttpResponse.json(sim.full[b.value as string] ?? sim.solid[b.value as string] ?? {});
    }),
    http.post(`${TS}/v2/estimate-buy-resource`, async ({ request }) => {
      expect(request.headers.get("apikey")).toBe("test-tronsave-key");
      const b = await rec(request, "estimate");
      const amount = b.resourceAmount as number;
      return HttpResponse.json({ error: false, message: "Success", data: { unitPrice: sim.unitPrice, durationSec: 3600, estimateTrx: sim.unitPrice * amount, availableResource: 10_000_000 } });
    }),
    http.post(`${TS}/v2/buy-resource`, async ({ request }) => {
      expect(request.headers.get("apikey")).toBe("test-tronsave-key");
      const b = await rec(request, "buy");
      if (sim.rentDelivers) sim.energy[b.receiver as string] = { limit: sim.deliverAmount ?? (b.resourceAmount as number), used: 0 };
      if (sim.buyReply) return sim.buyReply();
      return HttpResponse.json({ error: false, message: "Success", data: { orderId: `ord_${sim.calls.length}` } });
    }),
  ];
}

/** Mines a broadcast tx into a solid block: balances move and the solidity node reports it. */
function land(txID: string, o: { revert?: boolean } = {}) {
  const fx = sim.effects[txID]!;
  if (fx.kind === "trx") {
    sim.trx[fx.from] = (sim.trx[fx.from] ?? 0n) - fx.amount - (sim.trx[fx.to] === undefined ? 1_100_000n : 0n);
    sim.trx[fx.to] = (sim.trx[fx.to] ?? 0n) + fx.amount;
    sim.solid[txID] = { id: txID, blockNumber: 1, blockTimeStamp: sim.now, receipt: { net_usage: 268 } };
    return;
  }
  const r = sim.energy[fx.from];
  if (r) r.used = r.limit; // the transfer burns the rented energy either way
  if (o.revert) {
    sim.solid[txID] = { id: txID, blockNumber: 2, receipt: { result: "REVERT", energy_usage_total: 1 }, result: "FAILED" };
    return;
  }
  sim.usdt[fx.from] = (sim.usdt[fx.from] ?? 0n) - fx.amount;
  sim.usdt[fx.to] = (sim.usdt[fx.to] ?? 0n) + fx.amount;
  sim.solid[txID] = {
    id: txID, blockNumber: 2, receipt: { result: "SUCCESS", energy_usage_total: 64_285 },
    log: [{ address: body20(USDT), topics: [TRANSFER_TOPIC, pad(body20(fx.from)), pad(body20(fx.to))], data: pad(fx.amount.toString(16)) }],
  };
}

async function mk(o: Partial<PaymentRow> = {}): Promise<PaymentRow> {
  const i = seq++;
  const p: PaymentRow = {
    id: `pay_tr${i}`, invoice_id: "inv_tron", asset: "tron:usdt", chain: "tron", address: tronDepositKey(e.MASTER_SEED!, i).address, derivation_index: i,
    reference: null, expected: AMT, price_e8: 10n ** 8n, rate_locked_until: 0, received: AMT, final: AMT, txids: ["aa"], status: "confirmed",
    created_at: T0 - 2 * HOUR, detected_at: T0 - 2 * HOUR, confirmed_at: T0 - HOUR + i, credited_minor: 2500n, credit_price_e8: 10n ** 8n, unexpected: null,
    swept_at: null, sweep_tx: null, sweep_error: null, sweep_retry_at: null, ...o,
  };
  await insertPayment(e.DB, p);
  sim.usdt[p.address] = AMT;
  return p;
}
const run = (t: number) => {
  sim.now = t;
  return runTronSweep(e, t);
};
const sweeps = async () => (await e.DB.prepare("SELECT * FROM sweeps ORDER BY created_at, rowid").all<Record<string, string | number | null>>()).results;
const pendingRows = async () => (await sweeps()).filter((r) => r.status === "pending");
const alerts = async () => (await e.DB.prepare("SELECT * FROM alerts ORDER BY created_at").all<Record<string, string | number | null>>()).results;
const READS = ["account", "balanceOf", "getaccountresource", "solid", "full"];
const paths = () => sim.calls.map((c) => c.path).filter((p) => !READS.includes(p));
const count = (p: string) => sim.calls.filter((c) => c.path === p).length;
/** The signer of a broadcast: recovers the pubkey from r||s||v over txID. */
const signer = (b: { txID: string; sig: string }) => {
  const s = hexToBytes(b.sig);
  return tronAddressFromPubkey(secp256k1.Signature.fromBytes(s.subarray(0, 64), "compact").addRecoveryBit(s[64]! - 27).recoverPublicKey(hexToBytes(b.txID)).toBytes(false));
};

describe("runTronSweep: the full multi-run sweep", () => {
  it("inactive deposit: top-up, wait for solid, rent, wait for energy, transfer, reconcile -> swept", async () => {
    const p = await mk();
    lockOf = p.id;
    // Run 1: the deposit has no TRX: the hot wallet sends exactly 0.5 TRX, nothing else.
    expect((await run(T0)).status).toBe("sent");
    expect(sim.broadcasts).toHaveLength(1);
    const top = sim.broadcasts[0]!;
    expect(decodeTronRawData(top.raw)).toMatchObject({ type: "TransferContract", owner: HOT, to: p.address, amount: TOPUP_SUN });
    expect(signer(top)).toBe(HOT);
    expect(paths()).toEqual(["createtransaction", "broadcasthex"]);
    let [row] = await sweeps();
    expect(row).toMatchObject({ chain: "tron", status: "pending", step: "topup", tx: top.txID, payment_ids: JSON.stringify([p.id]) });
    expect(JSON.parse(row!.req as string)).toEqual({ at: T0 });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();

    // Run 2 (inside the top-up's expiry + 10 min): not solid yet, so no rental.
    await run(T0 + 5 * MIN);
    expect(paths()).not.toContain("buy");

    // Run 3: solid. The hot wallet never held USDT: 131k energy is needed, rented with a 2% margin; not there yet.
    land(top.txID);
    await run(T0 + 15 * MIN);
    const buy = sim.calls.filter((c) => c.path === "buy");
    expect(buy).toHaveLength(1);
    expect(buy[0]!.body).toMatchObject({ receiver: p.address, resourceType: "ENERGY", resourceAmount: rentAmount(ENERGY_NEW_HOLDER), durationSec: 3600 });
    expect(rentAmount(ENERGY_NEW_HOLDER)).toBe(133_620);
    expect(sim.broadcasts).toHaveLength(1);
    [row] = await sweeps();
    expect(row!.step).toBe("rented");
    expect(JSON.parse(row!.req as string)).toEqual({ at: T0 + 15 * MIN });

    // Run 4: the needed energy is there (the margin is not required): the deposit signs its whole USDT balance, lock first.
    sim.energy[p.address] = { limit: ENERGY_NEW_HOLDER, used: 0 };
    expect((await run(T0 + 30 * MIN)).status).toBe("sent");
    expect(sim.broadcasts).toHaveLength(2);
    const xfer = sim.broadcasts[1]!;
    expect(decodeTronRawData(xfer.raw)).toMatchObject({ type: "TriggerSmartContract", owner: p.address, contract: USDT, data: transferData(H(HOT), AMT), feeLimit: 5_000_000n });
    expect(signer(xfer)).toBe(p.address);
    expect(xfer.lockAtBroadcast).toBe(xfer.txID);
    [row] = await sweeps();
    expect(row).toMatchObject({ status: "pending", step: "transfer", tx: xfer.txID });
    expect(JSON.parse(row!.txs as string)).toEqual([top.txID, xfer.txID]);

    // Run 5: not solid yet. Run 6: solid with exactly the amount to the hot wallet: swept.
    await run(T0 + 31 * MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
    land(xfer.txID);
    await run(T0 + 45 * MIN);
    [row] = await sweeps();
    expect(row!.status).toBe("confirmed");
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBe(T0 + 45 * MIN);
    expect(after.sweep_tx).toBe(xfer.txID);
    expect(paths()).toEqual(["createtransaction", "broadcasthex", "estimate", "buy", "triggersmartcontract", "broadcasthex"]);
    expect(await alerts()).toEqual([]);
  });

  it("an activated deposit with TRX skips the top-up; energy that arrives at once is used in the same run (65k: hot already holds USDT)", async () => {
    const p = await mk();
    sim.trx[p.address] = 600_000n;
    sim.usdt[HOT] = 1n;
    sim.rentDelivers = true;
    expect((await run(T0)).status).toBe("sent");
    expect(paths()).toEqual(["estimate", "buy", "triggersmartcontract", "broadcasthex"]);
    expect(sim.calls.find((c) => c.path === "buy")!.body.resourceAmount).toBe(rentAmount(ENERGY_NORMAL));
    expect(rentAmount(ENERGY_NORMAL)).toBe(66_300);
  });

  it("an activated deposit below 0.5 TRX is topped up", async () => {
    const p = await mk();
    sim.trx[p.address] = 499_999n;
    await run(T0);
    expect(paths()).toEqual(["createtransaction", "broadcasthex"]);
  });

  it("energy already at the deposit is not rented again", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 10_000 };
    await run(T0);
    expect(paths()).toEqual(["triggersmartcontract", "broadcasthex"]);
  });

  it("signs and stores the locally computed lowercase sha256, never the node's txID string", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    sim.tamperTrigger = (t) => ({ ...t, txID: t.txID.toUpperCase() });
    await run(T0);
    const local = bytesToHex(sha256(hexToBytes(sim.broadcasts[0]!.raw)));
    expect((await sweeps())[0]!.tx).toBe(local);
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(local);
    expect(signer(sim.broadcasts[0]!)).toBe(p.address);
  });
});

describe("runTronSweep: never broadcasts without energy", () => {
  it("defers while the rented energy has not arrived; alerts and fails the sweep after 45 minutes", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 131_000, used: 131_000 - 64_999 }; // 64,999 left: one short
    sim.usdt[HOT] = 5n;
    await run(T0);
    expect(paths()).toEqual(["estimate", "buy"]);
    await run(T0 + 30 * MIN);
    await run(T0 + 45 * MIN);
    expect(sim.broadcasts).toHaveLength(0);
    expect(await alerts()).toEqual([]);
    await run(T0 + 45 * MIN + 1);
    expect(sim.broadcasts).toHaveLength(0);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "energy did not arrive" });
    expect((await alerts()).map((a) => a.kind)).toContain("sweep.failing");
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_retry_at).toBeGreaterThan(T0 + 45 * MIN);
    expect(after.sweep_tx).toBeNull();
  });

  it("a price over the per-unit cap is not rented: alert, and the sweep waits at the energy step", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.unitPrice = ENERGY_PRICE_CAP_SUN_PER_UNIT + 1;
    await run(T0);
    expect(paths()).toEqual(["estimate"]);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "energy" });
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.too_expensive"]);
    sim.unitPrice = ENERGY_PRICE_CAP_SUN_PER_UNIT;
    sim.rentDelivers = true;
    await run(T0 + 15 * MIN);
    expect(paths()).toEqual(["estimate", "estimate", "buy", "triggersmartcontract", "broadcasthex"]);
  });
});

describe("runTronSweep: TronSave buy fails closed", () => {
  async function rentWith(reply: () => Response | Promise<Response>) {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.buyReply = reply;
    await run(T0);
    expect(count("buy")).toBe(1);
    await run(T0 + 15 * MIN);
    await run(T0 + 30 * MIN);
    return p;
  }
  for (const [name, reply] of [
    ["an unknown envelope", () => HttpResponse.json({ ok: true })],
    ["a null error field", () => HttpResponse.json({ error: null, data: { orderId: "x" } })],
    ["a missing orderId", () => HttpResponse.json({ error: false, data: {} })],
    ["a 5xx", () => new HttpResponse("bad gateway", { status: 502 })],
    ["a 404", () => new HttpResponse("nope", { status: 404 })],
    ["a non-JSON body", () => new HttpResponse("<html>", { status: 200 })],
    ["a network error", () => HttpResponse.error()],
  ] as const) {
    it(`${name} on buy is ambiguous: the sweep waits for the energy and never buys again`, async () => {
      await rentWith(reply);
      expect(count("buy")).toBe(1);
      expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "rented" });
      expect((await alerts()).map((a) => a.kind)).not.toContain("sweep.too_expensive");
    });
  }

  it("a definite refusal (error: true, or HTTP 400/401/403/429) goes back to the energy step with an alert", async () => {
    for (const reply of [() => HttpResponse.json({ error: true, message: "insufficient balance" }), () => new HttpResponse("slow down", { status: 429 })]) {
      for (const t of ["payments", "sweeps", "alerts"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
      sim.calls = [];
      sim.rentDelivers = false;
      const p = await mk();
      sim.trx[p.address] = 1_000_000n;
      sim.buyReply = reply;
      await run(T0);
      expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "energy" });
      expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.failing"]);
      sim.buyReply = undefined;
      sim.rentDelivers = true;
      await run(T0 + 15 * MIN);
      expect(count("buy")).toBe(2);
      expect(sim.broadcasts.at(-1)!.txID).toBe((await sweeps())[0]!.tx);
    }
  });

});

describe("runTronSweep: paid attempts are capped", () => {
  it("after 2 paid failures (energy rented, then revert or timeout) the payment needs an admin; the Retry sweep button resets it", async () => {
    const p = await mk();
    lockOf = p.id;
    sim.trx[p.address] = 5_000_000n;
    sim.rentDelivers = true;
    // Attempt 1: rented, sent, reverted.
    await run(T0);
    land(sim.broadcasts.at(-1)!.txID, { revert: true });
    await run(T0 + 15 * MIN);
    let after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_retry_at).toBe(T0 + 15 * MIN + DAY);
    expect(after.sweep_error).not.toMatch(NEEDS_ADMIN);
    // Attempt 2 a day later: the energy was burned, so it is rented again; reverted again.
    await run(T0 + 15 * MIN + DAY);
    expect(count("buy")).toBe(2);
    land(sim.broadcasts.at(-1)!.txID, { revert: true });
    // An unrelated, unresolved payment_failed alert must not swallow the needs-admin one.
    await recordAlert(e.DB, "sweep.payment_failed", "tron", "some other deposit failed", T0 + 29 * MIN + DAY);
    await run(T0 + 30 * MIN + DAY);
    after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_error).toMatch(NEEDS_ADMIN);
    expect(after.sweep_retry_at).toBeGreaterThan(T0 + 365 * DAY);
    const al = (await alerts()).filter((a) => a.kind === "sweep.needs_admin").map((a) => String(a.detail));
    expect(al.some((d) => /Retry sweep/.test(d) && d.includes(p.id))).toBe(true);
    // No more automatic attempts.
    await run(T0 + 10 * DAY);
    expect(count("buy")).toBe(2);

    // The invoice page offers Retry sweep; the POST needs the CSRF token.
    const cookie = S.cookie;
    const page = await exports.default.fetch(`${BASE}/admin/invoices/inv_tron`, { headers: { cookie, "cf-connecting-ip": "10.8.0.1" } });
    const html = await page.text();
    expect(html).toContain(`/admin/payments/${p.id}/retry-sweep`);
    const post = (form: Record<string, string>) =>
      exports.default.fetch(`${BASE}/admin/payments/${p.id}/retry-sweep`, {
        method: "POST", redirect: "manual", body: new URLSearchParams(form),
        headers: { cookie, "cf-connecting-ip": "10.8.0.2", "content-type": "application/x-www-form-urlencoded" },
      });
    const path = `/admin/payments/${p.id}/retry-sweep`;
    expect((await post({})).status).toBe(403);
    expect((await post({ csrf: CSRF })).status).toBe(403); // no passkey confirmation
    expect((await post({ csrf: CSRF, assertion: await S.confirm("sweep.fail", path, {}) })).status).toBe(403); // another action
    expect((await getPayment(e.DB, p.id))!.sweep_error).toMatch(NEEDS_ADMIN);
    const ok = await post({ csrf: CSRF, assertion: await S.confirm("sweep.retry", path, {}) });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/admin/invoices/inv_tron");
    after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_error).toBeNull();
    expect(after.sweep_retry_at).toBeNull();
    expect((await e.DB.prepare("SELECT sweep_paid_attempts AS n FROM payments WHERE id=?").bind(p.id).first<{ n: number }>())!.n).toBe(0);
    await run(T0 + 11 * DAY);
    expect(count("buy")).toBe(3);
  });

  it("an energy timeout after a paid rental counts as a paid failure; a free retry (energy still there) does not", async () => {
    const p = await mk();
    sim.trx[p.address] = 5_000_000n;
    await run(T0); // rented, never arrives
    await run(T0 + 46 * MIN);
    expect((await e.DB.prepare("SELECT sweep_paid_attempts AS n FROM payments WHERE id=?").bind(p.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("a 404 on retry-sweep for an unknown payment", async () => {
    const cookie = S.cookie;
    const r = await exports.default.fetch(`${BASE}/admin/payments/pay_nope/retry-sweep`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: CSRF }),
      headers: { cookie, "cf-connecting-ip": "10.8.0.3", "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(404);
  });
});

describe("runTronSweep: reconcile failures", () => {
  async function toTransfer() {
    const p = await mk();
    lockOf = p.id;
    sim.trx[p.address] = 1_000_000n;
    sim.rentDelivers = true;
    await run(T0);
    expect(sim.broadcasts).toHaveLength(1);
    return { p, tx: sim.broadcasts[0]!.txID };
  }

  it("a solid REVERT fails the sweep, alerts, releases the lock and backs the payment off", async () => {
    const { p, tx } = await toTransfer();
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(tx);
    land(tx, { revert: true });
    await run(T0 + 15 * MIN);
    expect((await sweeps())[0]).toMatchObject({ status: "failed" });
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBeNull();
    expect(after.sweep_tx).toBeNull();
    expect(after.sweep_retry_at).toBeGreaterThan(T0 + 15 * MIN);
    expect((await alerts()).map((a) => a.kind)).toContain("sweep.payment_failed");
    await run(T0 + 30 * MIN);
    expect(await sweeps()).toHaveLength(1);
  });

  it("a solid transfer paying a different amount to the hot wallet is not marked swept", async () => {
    const { p, tx } = await toTransfer();
    land(tx);
    (sim.solid[tx] as { log: Array<{ data: string }> }).log[0]!.data = pad((AMT - 1n).toString(16));
    await run(T0 + 15 * MIN);
    expect((await sweeps())[0]!.status).toBe("failed");
    expect((await getPayment(e.DB, p.id))!.swept_at).toBeNull();
  });

  it("a transfer unknown to both nodes 10 minutes after its expiration is dropped: lock released, alert, retried from the TRX check", async () => {
    const { p } = await toTransfer();
    await run(T0 + MIN + 10 * MIN); // expiration + 10 min: still waiting
    expect((await sweeps())[0]!.status).toBe("pending");
    expect(count("full")).toBe(0);
    sim.trx[p.address] = 100_000n; // the bandwidth TRX went meanwhile
    await run(T0 + MIN + 10 * MIN + 1);
    expect(count("full")).toBe(1);
    const rows = await sweeps();
    expect(rows[0]).toMatchObject({ status: "failed", error: "dropped" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
    expect((await alerts()).map((a) => a.kind)).toContain("sweep.failing");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "pending", step: "topup" });
    expect(decodeTronRawData(sim.broadcasts.at(-1)!.raw)).toMatchObject({ type: "TransferContract", to: p.address });
  });

  it("a transfer the full node already has is not dropped: it waits for solid and is swept", async () => {
    const { p, tx } = await toTransfer();
    sim.full[tx] = { id: tx, blockNumber: 99 };
    await run(T0 + HOUR);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "transfer" });
    land(tx);
    await run(T0 + HOUR + MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + HOUR + MIN);
  });

  it("a top-up unknown to both nodes after its expiration is dropped and retried with a fresh TRX check", async () => {
    const p = await mk();
    await run(T0);
    await run(T0 + 11 * MIN + 1);
    const rows = await sweeps();
    expect(rows[0]).toMatchObject({ status: "failed", error: "dropped" });
    expect(rows[1]).toMatchObject({ status: "pending", step: "topup" });
    expect(sim.broadcasts).toHaveLength(2);
    expect(decodeTronRawData(sim.broadcasts[1]!.raw).to).toBe(p.address);
  });

  it("a top-up that failed on chain fails the sweep and backs the payment off", async () => {
    const p = await mk();
    await run(T0);
    const tx = sim.broadcasts[0]!.txID;
    sim.solid[tx] = { id: tx, blockNumber: 1, result: "FAILED" };
    await run(T0 + 5 * MIN);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "top-up failed" });
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0 + 5 * MIN);
    expect(count("buy")).toBe(0);
  });

  it("a broadcast the node refuses fails the sweep and releases the lock", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.rentDelivers = true;
    sim.broadcastReply = { result: false, code: "BANDWITH_ERROR", message: "6163636f756e74" };
    expect((await run(T0)).status).toBe("failed");
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "broadcast failed: BANDWITH_ERROR" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBeNull();
  });

  it("DUP_TRANSACTION_ERROR (already known) counts as sent", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.rentDelivers = true;
    sim.broadcastReply = { result: false, code: "DUP_TRANSACTION_ERROR", message: "6475" };
    expect((await run(T0)).status).toBe("sent");
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "transfer" });
    expect((await getPayment(e.DB, p.id))!.sweep_tx).toBe(sim.broadcasts[0]!.txID);
  });

  it("a lost broadcast answer keeps the sweep pending; it reconciles when the tx lands", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.rentDelivers = true;
    sim.broadcastStatus = 504;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await run(T0)).status).toBe("sent");
    warn.mockRestore();
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "transfer" });
    land(sim.broadcasts[0]!.txID);
    await run(T0 + 15 * MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
  });

  it("a lost broadcast answer for a tx that never landed is dropped after expiry", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.rentDelivers = true;
    sim.broadcastStatus = 504;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run(T0);
    warn.mockRestore();
    const lost = sim.broadcasts[0]!.txID;
    sim.broadcastStatus = undefined;
    await run(T0 + 12 * MIN);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "dropped" });
    // Released, then retried at once (the energy is still there): a new transfer holds the lock now.
    expect((await getPayment(e.DB, p.id))!.sweep_tx).not.toBe(lost);
    expect(sim.broadcasts).toHaveLength(2);
  });

  it("a swept-but-unmarked payment (admin marked the sweep failed, then it landed) is marked swept from its old tx, without alert or back-off", async () => {
    const { p, tx } = await toTransfer();
    await e.DB.prepare("UPDATE sweeps SET status='failed', error='marked failed by an admin'").run();
    land(tx);
    await run(T0 + 15 * MIN);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.swept_at).toBe(T0 + 15 * MIN);
    expect(after.sweep_tx).toBe(tx);
    expect(after.sweep_retry_at).toBeNull();
    expect(after.sweep_error).toBeNull();
    expect(await alerts()).toEqual([]);
    expect(await pendingRows()).toEqual([]);
  });
});

describe("runTronSweep: step-gated failure", () => {
  it("an energy timeout seen by a stale run never fails a row another run already moved to transfer", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    await run(T0); // rented, waiting
    sim.onResource = async () => {
      await e.DB.prepare("UPDATE sweeps SET step='transfer', tx='ab'||substr(id,1,2) WHERE status='pending'").run();
    };
    await run(T0 + 46 * MIN);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "transfer" });
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeNull();
  });

  it("a top-up drop seen by a stale run never fails a row another run already moved on", async () => {
    await mk();
    await run(T0);
    sim.onSolid = async () => {
      await e.DB.prepare("UPDATE sweeps SET step='energy' WHERE status='pending'").run();
    };
    await run(T0 + 11 * MIN + 1);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "energy" });
    expect(await sweeps()).toHaveLength(1);
  });
});

describe("runTronSweep: verification before signing", () => {
  it("a tampered triggersmartcontract answer fails the sweep with tx_mismatch and its own alert kind, never broadcast", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    // An unrelated, unresolved sweep.failing must not swallow the security alert.
    await recordAlert(e.DB, "sweep.failing", "tron", "benign: a top-up was dropped", T0 - MIN);
    const thief = tronDepositKey(e.MASTER_SEED!, 9999).address;
    sim.tamperTrigger = () =>
      nodeTx(rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(p.address), contract: H(USDT), data: transferData(H(thief), AMT) }))], expiration: sim.now + MIN, timestamp: sim.now, feeLimit: 5_000_000n }));
    expect((await run(T0)).status).toBe("failed");
    expect(sim.broadcasts).toHaveLength(0);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "tx_mismatch" });
    const al = await alerts();
    expect(al.map((a) => a.kind)).toEqual(["sweep.failing", "sweep.tx_mismatch"]);
    expect(al.map((a) => a.detail).join(" ")).not.toMatch(/[0-9a-f]{64}/); // no key material, ever
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0);
  });

  it("a txID that does not hash the raw bytes is refused", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    sim.tamperTrigger = (t) => ({ ...t, txID: "00".repeat(32) });
    await run(T0);
    expect(sim.broadcasts).toHaveLength(0);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "tx_mismatch" });
  });

  it("a tampered top-up (to another address) is refused before anything is broadcast", async () => {
    const p = await mk();
    sim.tamperCreate = () =>
      nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(HOT), to: H(tronDepositKey(e.MASTER_SEED!, 9999).address), amount: TOPUP_SUN }))], expiration: sim.now + MIN, timestamp: sim.now }));
    await run(T0);
    expect(sim.broadcasts).toHaveLength(0);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "tx_mismatch" });
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.tx_mismatch"]);
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0);
  });

  it("a stale node (expiration already past) is not a mismatch: no alert, no back-off, retried next run", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    sim.tamperTrigger = (t) => {
      const raw = rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(p.address), contract: H(USDT), data: transferData(H(HOT), AMT) }))], expiration: sim.now - 1, timestamp: sim.now - MIN, feeLimit: 5_000_000n });
      return nodeTx(raw);
    };
    await run(T0);
    expect(sim.broadcasts).toHaveLength(0);
    expect(await alerts()).toEqual([]);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "energy" });
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeNull();
    sim.tamperTrigger = undefined;
    await run(T0 + 15 * MIN);
    expect(sim.broadcasts).toHaveLength(1);
  });

  it("a stale top-up answer skips the payment for this run without a row or alert", async () => {
    const p = await mk();
    sim.tamperCreate = () =>
      nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(HOT), to: H(p.address), amount: TOPUP_SUN }))], expiration: sim.now - 1, timestamp: sim.now - MIN }));
    await run(T0);
    expect(await sweeps()).toEqual([]);
    expect(await alerts()).toEqual([]);
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeNull();
  });

  it("a deposit whose derived key no longer matches (seed changed mid-sweep) fails once with an alert instead of throwing every run", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    await run(T0); // rented, waiting
    await e.DB.prepare("UPDATE sweeps SET meta=json_set(meta,'$.index',9998)").run();
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    expect((await run(T0 + 15 * MIN)).status).toBe("failed");
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "deposit key mismatch" });
    expect(sim.broadcasts).toHaveLength(0);
    expect((await alerts()).map((a) => a.kind)).toContain("sweep.payment_failed");
  });
});

describe("runTronSweep: guards", () => {
  it("TRONSAVE_API_KEY unset and nothing pending: skipped, one deduped alert, nothing sent", async () => {
    await mk();
    e.TRONSAVE_API_KEY = "";
    try {
      expect(await run(T0)).toMatchObject({ status: "skipped", reason: TRONSAVE_MISSING });
      await run(T0 + 15 * MIN);
    } finally {
      e.TRONSAVE_API_KEY = "test-tronsave-key";
    }
    expect(sim.calls).toEqual([]);
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.stuck"]);
  });

  it("TRONSAVE_API_KEY unset blocks only the energy step: an already-sent transfer still reconciles", async () => {
    const a = await mk();
    sim.trx[a.address] = 1_000_000n;
    sim.rentDelivers = true;
    await run(T0); // a: transfer sent
    const tx = sim.broadcasts[0]!.txID;
    const b = await mk();
    sim.trx[b.address] = 1_000_000n;
    sim.rentDelivers = false;
    sim.unitPrice = ENERGY_PRICE_CAP_SUN_PER_UNIT + 1;
    await run(T0 + MIN); // b: waits at energy (over the cap)
    expect(count("estimate")).toBe(2);
    land(tx);
    e.TRONSAVE_API_KEY = "";
    try {
      await run(T0 + 15 * MIN);
    } finally {
      e.TRONSAVE_API_KEY = "test-tronsave-key";
    }
    expect((await getPayment(e.DB, a.id))!.swept_at).toBe(T0 + 15 * MIN);
    expect(count("estimate")).toBe(2); // b did not try to rent
    expect((await pendingRows()).map((r) => r.step)).toEqual(["energy"]);
    expect((await alerts()).map((r) => r.kind)).toContain("sweep.stuck");
  });

  it("a hot wallet too poor for a top-up alerts and skips", async () => {
    await mk();
    sim.trx[HOT] = 1_000_000n;
    expect((await run(T0)).status).toBe("skipped");
    expect(sim.broadcasts).toHaveLength(0);
    expect(await sweeps()).toEqual([]);
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.insufficient_gas"]);
  });

  it("hot TRX is checked per top-up: when it runs short, deposits that need no top-up still go ahead", async () => {
    const a = await mk();
    const b = await mk();
    const c = await mk();
    sim.trx[c.address] = 1_000_000n;
    sim.energy[c.address] = { limit: 200_000, used: 0 };
    sim.trx[HOT] = 3_000_000n; // one top-up's worth
    await run(T0);
    const to = sim.broadcasts.map((x) => decodeTronRawData(x.raw));
    expect(to.filter((d) => d.type === "TransferContract").map((d) => d.to)).toEqual([a.address]);
    expect(to.filter((d) => d.type === "TriggerSmartContract").map((d) => d.owner)).toEqual([c.address]);
    expect((await pendingRows()).map((r) => JSON.parse(r.payment_ids as string)[0])).not.toContain(b.id);
    expect((await alerts()).map((r) => r.kind)).toEqual(["sweep.insufficient_gas"]);
  });

  it("a deposit without USDT on chain (and no earlier sweep tx) is skipped and backed off, no top-up", async () => {
    const p = await mk();
    sim.usdt[p.address] = 0n;
    expect((await run(T0)).status).not.toBe("sent");
    expect(sim.broadcasts).toHaveLength(0);
    expect(await sweeps()).toEqual([]);
    expect((await getPayment(e.DB, p.id))!.sweep_retry_at).toBeGreaterThan(T0);
  });

  it("the swept amount is the on-chain balance, not payment.final", async () => {
    const p = await mk();
    sim.usdt[p.address] = AMT + 7n;
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    await run(T0);
    expect(decodeTronRawData(sim.broadcasts[0]!.raw).data).toBe(transferData(H(HOT), AMT + 7n));
  });
});

describe("runTronSweep: parallel sweeps", () => {
  it("three payments progress side by side through every step", async () => {
    const ps = [await mk(), await mk(), await mk()];
    sim.usdt[HOT] = 1n;
    await run(T0);
    expect(sim.broadcasts).toHaveLength(3);
    expect(await pendingRows()).toHaveLength(3);
    for (const b of sim.broadcasts) land(b.txID);
    sim.rentDelivers = true;
    await run(T0 + 15 * MIN);
    expect(count("buy")).toBe(3);
    const xfers = sim.broadcasts.slice(3);
    expect(xfers.map((b) => decodeTronRawData(b.raw).owner).sort()).toEqual(ps.map((p) => p.address).sort());
    for (const b of xfers) land(b.txID);
    await run(T0 + 30 * MIN);
    for (const p of ps) expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 30 * MIN);
  });

  it(`at most ${TRON_MAX_PENDING} Tron sweeps are pending; the rest wait`, async () => {
    for (let i = 0; i < TRON_MAX_PENDING + 2; i++) await mk();
    await run(T0);
    expect(await pendingRows()).toHaveLength(TRON_MAX_PENDING);
    expect(sim.broadcasts).toHaveLength(TRON_MAX_PENDING);
    await run(T0 + 5 * MIN);
    expect(await pendingRows()).toHaveLength(TRON_MAX_PENDING);
    expect(sim.broadcasts).toHaveLength(TRON_MAX_PENDING);
  });

  it("a run spends about 40 subrequests at most and defers the rest to the next run", async () => {
    for (let i = 0; i < 5; i++) await mk();
    sim.usdt[HOT] = 1n;
    await run(T0);
    for (const b of sim.broadcasts) land(b.txID);
    sim.rentDelivers = true;
    const before = sim.calls.length;
    await run(T0 + 5 * MIN);
    expect(sim.calls.length - before).toBeLessThanOrEqual(40);
    const steps = (await pendingRows()).map((r) => r.step);
    expect(steps.filter((s) => s === "transfer").length).toBeGreaterThan(0);
    expect(steps.filter((s) => s === "topup").length).toBeGreaterThan(0); // deferred
    await run(T0 + 10 * MIN);
    expect((await pendingRows()).every((r) => r.step === "transfer")).toBe(true);
  });

  it("two concurrent runSweeps that really overlap give each payment exactly one sweep and one top-up", async () => {
    const a = await mk();
    const b = await mk();
    const gateAt = barrier("createtransaction");
    const [x, y] = await Promise.all([runSweeps(e, T0), runSweeps(e, T0)]);
    expect(gateAt.met).toBe(true); // both runs built a top-up for the same payment at once
    expect(count("createtransaction")).toBeGreaterThanOrEqual(3);
    const rows = await sweeps();
    expect(rows.map((r) => JSON.parse(r.payment_ids as string)[0]).sort()).toEqual([a.id, b.id].sort());
    expect(sim.broadcasts.map((t) => decodeTronRawData(t.raw).to).sort()).toEqual([a.address, b.address].sort());
    expect([x.tron!.status, y.tron!.status]).toContain("sent");
  });

  it("two concurrent runs at the energy step that really overlap rent once", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    await run(T0); // inserted at the energy step, rented, waiting
    expect(count("buy")).toBe(1);
    await e.DB.prepare("UPDATE sweeps SET step='energy'").run(); // as if a crash right after the insert
    const gateAt = barrier("getaccountresource");
    await Promise.all([runTronSweep(e, T0 + MIN), runTronSweep(e, T0 + MIN)]);
    expect(gateAt.met).toBe(true);
    expect(count("buy")).toBe(2);
  });

  it("the EVM one-pending-per-chain backstop still holds after the index change", async () => {
    await e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids) VALUES('swp_e1','base',1,'pending','[\"x\"]')").run();
    await expect(e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids) VALUES('swp_e2','base',2,'pending','[\"y\"]')").run()).rejects.toThrow(/unique/i);
    await e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids) VALUES('swp_t1','tron',1,'pending','[\"x\"]')").run();
    await e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids) VALUES('swp_t2','tron',2,'pending','[\"y\"]')").run();
    await expect(e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids) VALUES('swp_t3','tron',3,'pending','[\"y\"]')").run()).rejects.toThrow(/unique/i);
  });

  it("runSweeps runs the Tron sweeper only when Tron is configured, and isolates its failure", async () => {
    await mk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    e.TRONGRID_API_KEY = "";
    try {
      expect((await runSweeps(e, T0)).tron).toBeUndefined();
    } finally {
      e.TRONGRID_API_KEY = "test-trongrid-key";
    }
    network.use(http.get(`${API}/v1/accounts/:addr`, () => new HttpResponse(null, { status: 503 })));
    expect((await runSweeps(e, T0)).tron).toMatchObject({ status: "failed" });
    warn.mockRestore();
  });
});

describe("runTronSweep: final-round signals", () => {
  const thiefTx = (owner: string) => () =>
    nodeTx(rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(owner), contract: H(USDT), data: transferData(H(tronDepositKey(e.MASTER_SEED!, 9999).address), AMT) }))], expiration: sim.now + MIN, timestamp: sim.now, feeLimit: 5_000_000n }));

  it("a tx_mismatch after a paid rental is a paid failure: a compromised node cannot force a rental every day", async () => {
    const p = await mk();
    sim.trx[p.address] = 5_000_000n;
    sim.rentDelivers = true;
    sim.tamperTrigger = thiefTx(p.address);
    await run(T0);
    expect((await sweeps())[0]).toMatchObject({ status: "failed", error: "tx_mismatch" });
    sim.energy[p.address]!.used = sim.energy[p.address]!.limit; // the rental ran out
    await run(T0 + DAY);
    expect(count("buy")).toBe(2);
    expect((await getPayment(e.DB, p.id))!.sweep_error).toMatch(NEEDS_ADMIN);
    const kinds = (await alerts()).map((a) => a.kind);
    expect(kinds).toContain("sweep.tx_mismatch");
    expect(kinds).toContain("sweep.needs_admin");
    await run(T0 + 3 * DAY);
    expect(count("buy")).toBe(2);
    expect(sim.broadcasts).toHaveLength(0);
  });

  it("3 consecutive stale top-up answers raise sweep.failing (not 2)", async () => {
    const p = await mk();
    sim.tamperCreate = () =>
      nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(HOT), to: H(p.address), amount: TOPUP_SUN }))], expiration: sim.now - 1, timestamp: sim.now - MIN }));
    await run(T0);
    await run(T0 + 15 * MIN);
    expect(await alerts()).toEqual([]);
    await run(T0 + 30 * MIN);
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.failing"]);
    expect(await sweeps()).toEqual([]);
  });

  it("3 consecutive stale transfer answers raise sweep.failing (not 2)", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.energy[p.address] = { limit: 1_000_000, used: 0 };
    sim.tamperTrigger = () =>
      nodeTx(rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(p.address), contract: H(USDT), data: transferData(H(HOT), AMT) }))], expiration: sim.now - 1, timestamp: sim.now - MIN, feeLimit: 5_000_000n }));
    await run(T0);
    await run(T0 + 15 * MIN);
    expect(await alerts()).toEqual([]);
    await run(T0 + 30 * MIN);
    const al = await alerts();
    expect(al.map((a) => a.kind)).toEqual(["sweep.failing"]);
    expect(String(al[0]!.detail)).toMatch(/expired/);
    expect((await sweeps())[0]).toMatchObject({ status: "pending", step: "energy" });
  });

  it("a good answer resets the stale count", async () => {
    const p = await mk();
    const staleCount = async () => (await e.DB.prepare("SELECT sweep_stale AS n FROM payments WHERE id=?").bind(p.id).first<{ n: number }>())!.n;
    sim.tamperCreate = () =>
      nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(HOT), to: H(p.address), amount: TOPUP_SUN }))], expiration: sim.now - 1, timestamp: sim.now - MIN }));
    await run(T0);
    await run(T0 + 15 * MIN);
    expect(await staleCount()).toBe(2);
    sim.tamperCreate = undefined;
    await run(T0 + 30 * MIN);
    expect(await staleCount()).toBe(0);
    expect(sim.broadcasts).toHaveLength(1);
    expect(await alerts()).toEqual([]);
  });

  it("a definite TronSave refusal leaves req alone, so a sweep stuck at the energy step shows as stuck", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.unitPrice = ENERGY_PRICE_CAP_SUN_PER_UNIT + 1;
    await run(T0);
    await run(T0 + 2 * HOUR);
    const [row] = await sweeps();
    expect(row).toMatchObject({ status: "pending", step: "energy" });
    expect(JSON.parse(row!.req as string)).toEqual({ at: T0 });
    expect((await listStuckSweeps(e.DB, T0 + 2 * HOUR)).map((s) => s.id)).toContain(row!.id);
  });

  it("the 2% margin: 65,000 delivered against a 66,300 rental is enough and the transfer goes out", async () => {
    const p = await mk();
    sim.trx[p.address] = 1_000_000n;
    sim.usdt[HOT] = 1n;
    sim.rentDelivers = true;
    sim.deliverAmount = ENERGY_NORMAL;
    await run(T0);
    expect(sim.calls.find((c) => c.path === "buy")!.body.resourceAmount).toBe(66_300);
    expect(sim.broadcasts).toHaveLength(1);
    expect((await sweeps())[0]).toMatchObject({ step: "transfer" });
  });

  it("the SQL COUNT cap holds when two overlapping runs start different payments at once (7 candidates)", async () => {
    const ps: PaymentRow[] = [];
    for (let i = 0; i < 7; i++) ps.push(await mk());
    // 4 already pending; the two runs see different free candidates (one is due a moment later).
    for (const p of ps.slice(0, 4))
      await e.DB.prepare("INSERT INTO sweeps(id,chain,created_at,status,payment_ids,step,meta,tx,txs,req) VALUES(?,'tron',?,'pending',?,'topup',?,?,?,?)")
        .bind(`swp_pre_${p.id}`, T0 - MIN, JSON.stringify([p.id]), JSON.stringify({ deposit: p.address, index: p.derivation_index, topup: { txid: "11".repeat(32), exp: T0 + HOUR } }), "11".repeat(32), JSON.stringify(["11".repeat(32)]), JSON.stringify({ at: T0 - MIN }))
        .run();
    await e.DB.prepare("UPDATE payments SET sweep_retry_at=? WHERE id=?").bind(T0 + 1, ps[4]!.id).run();
    const gateAt = barrier("createtransaction");
    await Promise.all([runTronSweep(e, T0), runTronSweep(e, T0 + 1)]);
    expect(gateAt.met).toBe(true);
    const targets = sim.calls.filter((c) => c.path === "createtransaction").slice(0, 2).map((c) => c.body.to_address);
    expect(new Set(targets).size).toBe(2); // they really raced for two different payments
    expect(await pendingRows()).toHaveLength(TRON_MAX_PENDING);
    expect(sim.broadcasts).toHaveLength(1);
  });

  it("Retry sweep refuses (409) a payment that is not a Tron payment with a sweep error", async () => {
    const tronOk = await mk();
    const evm = await mk({ chain: "base", asset: "base:usdc" });
    await e.DB.prepare("UPDATE payments SET sweep_error='flush estimate reverted' WHERE id=?").bind(evm.id).run();
    const cookie = S.cookie;
    for (const [i, p] of [tronOk, evm].entries()) {
      const path = `/admin/payments/${p.id}/retry-sweep`;
      const r = await exports.default.fetch(`${BASE}${path}`, {
        method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: CSRF, assertion: await S.confirm("sweep.retry", path, {}) }),
        headers: { cookie, "cf-connecting-ip": `10.8.1.${i}`, "content-type": "application/x-www-form-urlencoded" },
      });
      expect(r.status).toBe(409);
      expect(await r.text()).toMatch(/only a Tron or Solana payment whose sweep stopped/i);
    }
    expect((await getPayment(e.DB, evm.id))!.sweep_error).toBe("flush estimate reverted");
  });
});

describe("runTronSweep: unexpected TRX (never moved by the sweeper)", () => {
  const counters = async (id: string) =>
    (await e.DB.prepare("SELECT unexpected_left AS left, sweep_paid_attempts AS paid, sweep_stale AS stale FROM payments WHERE id=?").bind(id).first<{ left: number; paid: number; stale: number }>())!;
  async function sweepToConfirmed(p: PaymentRow, beforeReconcile?: () => Promise<unknown>) {
    sim.trx[p.address] = 5_000_000n;
    sim.energy[p.address] = { limit: 200_000, used: 0 };
    await run(T0);
    land(sim.broadcasts.at(-1)!.txID);
    await beforeReconcile?.();
    await run(T0 + 15 * MIN);
    expect((await getPayment(e.DB, p.id))!.swept_at).toBe(T0 + 15 * MIN);
  }

  it("a swept payment whose unexpected holds tron:trx is marked unexpected_left (the TRX stays at the deposit)", async () => {
    const p = await mk({ unexpected: { "tron:trx": 3_000_000n } });
    await sweepToConfirmed(p);
    expect((await counters(p.id)).left).toBe(1);
  });

  it("a swept payment without unexpected TRX is not marked unexpected_left", async () => {
    const p = await mk();
    await sweepToConfirmed(p);
    expect((await counters(p.id)).left).toBe(0);
  });

  it("the confirm resets sweep_paid_attempts and sweep_stale, as Solana's does", async () => {
    const p = await mk();
    // Set while the transfer is in flight (the transfer step itself already resets sweep_stale).
    await sweepToConfirmed(p, () => e.DB.prepare("UPDATE payments SET sweep_paid_attempts=1, sweep_stale=2 WHERE id=?").bind(p.id).run());
    expect(await counters(p.id)).toMatchObject({ paid: 0, stale: 0 });
  });

  it("a TRX-only candidate (no USDT, e.g. expired with only TRX) is skipped without any RPC call; one alert, then never again", async () => {
    const p = await mk({ status: "expired", received: 0n, final: 0n, confirmed_at: null, credited_minor: 0n, unexpected: { "tron:trx": 2_000_000n } });
    sim.usdt[p.address] = 0n;
    const late = T0 + 8 * DAY; // past the invoice's expiry + 7 days + 1 hour
    for (let d = 0; d < 4; d++) await run(late + d * DAY);
    expect(sim.calls).toEqual([]);
    expect(await sweeps()).toEqual([]);
    const al = await alerts();
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ kind: "sweep.payment_failed", chain: "tron" });
    expect(String(al[0]!.detail)).toMatch(/TRX recovery/);
    expect((await counters(p.id)).left).toBe(1);
    // It no longer takes a candidate slot: a later USDT payment is still swept.
    const q = await mk();
    sim.trx[q.address] = 5_000_000n;
    sim.energy[q.address] = { limit: 200_000, used: 0 };
    await run(late + 5 * DAY);
    expect(sim.broadcasts.map((b) => decodeTronRawData(b.raw).owner)).toEqual([q.address]);
    expect(await alerts()).toHaveLength(1);
  });

  it("without TRONSAVE_API_KEY a TRX-only candidate is parked too and raises no sweep.stuck", async () => {
    const p = await mk({ status: "expired", received: 0n, final: 0n, confirmed_at: null, credited_minor: 0n, unexpected: { "tron:trx": 2_000_000n } });
    sim.usdt[p.address] = 0n;
    e.TRONSAVE_API_KEY = "";
    try {
      await run(T0 + 8 * DAY);
      await run(T0 + 9 * DAY);
    } finally {
      e.TRONSAVE_API_KEY = "test-tronsave-key";
    }
    expect(sim.calls).toEqual([]);
    expect((await alerts()).map((a) => a.kind)).toEqual(["sweep.payment_failed"]);
    expect((await counters(p.id)).left).toBe(1);
  });

  it("a TRX-only candidate that an admin retried is skipped again without a second alert", async () => {
    const p = await mk({ status: "expired", received: 0n, final: 0n, confirmed_at: null, credited_minor: 0n, unexpected: { "tron:trx": 2_000_000n } });
    sim.usdt[p.address] = 0n;
    await run(T0 + 8 * DAY);
    await e.DB.prepare("UPDATE payments SET sweep_error=NULL, sweep_retry_at=NULL WHERE id=?").bind(p.id).run();
    await run(T0 + 9 * DAY);
    expect(sim.calls).toEqual([]);
    expect(await alerts()).toHaveLength(1);
  });
});

describe("runTronSweep: tx_mismatch is capped per payment", () => {
  const thief = () => tronDepositKey(e.MASTER_SEED!, 9999).address;
  const kinds = async () => (await alerts()).map((a) => a.kind);

  it("a tampered top-up counts toward the cap: after 2 the payment needs an admin and no more tx_mismatch alerts follow", async () => {
    const p = await mk();
    sim.tamperCreate = () =>
      nodeTx(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(HOT), to: H(thief()), amount: TOPUP_SUN }))], expiration: sim.now + MIN, timestamp: sim.now }));
    await run(T0);
    expect((await getPayment(e.DB, p.id))!.sweep_error).not.toMatch(NEEDS_ADMIN);
    await run(T0 + DAY + MIN);
    const after = (await getPayment(e.DB, p.id))!;
    expect(after.sweep_error).toMatch(NEEDS_ADMIN);
    expect(after.sweep_retry_at).toBeGreaterThan(T0 + 365 * DAY);
    expect(await kinds()).toEqual(["sweep.tx_mismatch", "sweep.tx_mismatch", "sweep.needs_admin"]);
    expect(String((await alerts()).at(-1)!.detail)).toMatch(/not the one asked for|tampered|mismatch/i);
    for (let d = 2; d < 6; d++) await run(T0 + d * DAY + MIN);
    expect(count("createtransaction")).toBe(2);
    expect((await kinds()).filter((k) => k === "sweep.tx_mismatch")).toHaveLength(2);
    expect(sim.broadcasts).toHaveLength(0);
  });

  it("a tampered transfer counts even when no energy was paid for (energy already at the deposit)", async () => {
    const p = await mk();
    sim.trx[p.address] = 5_000_000n;
    sim.energy[p.address] = { limit: 1_000_000, used: 0 };
    sim.tamperTrigger = () =>
      nodeTx(rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(p.address), contract: H(USDT), data: transferData(H(thief()), AMT) }))], expiration: sim.now + MIN, timestamp: sim.now, feeLimit: 5_000_000n }));
    await run(T0);
    expect(count("buy")).toBe(0);
    await run(T0 + DAY + MIN);
    expect((await getPayment(e.DB, p.id))!.sweep_error).toMatch(NEEDS_ADMIN);
    for (let d = 2; d < 6; d++) await run(T0 + d * DAY + MIN);
    expect(count("triggersmartcontract")).toBe(2);
    expect((await kinds()).filter((k) => k === "sweep.tx_mismatch")).toHaveLength(2);
    expect((await kinds()).filter((k) => k === "sweep.needs_admin")).toHaveLength(1);
    expect(sim.broadcasts).toHaveLength(0);
  });
});

describe("runTronSweep: per-run deadline (wall time)", () => {
  /** A wall clock that moves 8 s every time it is read (the run's start is the first read). */
  const slowClock = () => {
    let reads = 0;
    return () => T0 + 8_000 * reads++;
  };

  it("starts no new sweep once 20 s of wall time have passed since the run began; the rest waits for the next run", async () => {
    const ps = [await mk(), await mk(), await mk()];
    sim.now = T0;
    const r = await runTronSweep(e, T0, { clock: slowClock() });
    // Checks at 8 s and 16 s pass, the one at 24 s does not.
    expect(sim.broadcasts.map((b) => decodeTronRawData(b.raw).to)).toEqual([ps[0]!.address, ps[1]!.address]);
    expect(r.status).toBe("sent");
    expect((await pendingRows()).length).toBe(2);
    await run(T0 + 15 * MIN);
    expect(sim.broadcasts.map((b) => decodeTronRawData(b.raw).to)).toContain(ps[2]!.address);
  });

  it("advances no pending sweep past the deadline (no RPC at all), and the run reports it", async () => {
    await mk();
    await run(T0); // top-up sent: one pending row
    const before = sim.calls.length;
    sim.now = T0 + 15 * MIN;
    const stopped = () => {
      let first = true;
      return () => (first ? ((first = false), T0) : T0 + 20_000);
    };
    const r = await runTronSweep(e, T0 + 15 * MIN, { clock: stopped() });
    expect(sim.calls.length).toBe(before);
    expect(r.reason).toMatch(/deadline/);
  });
});
