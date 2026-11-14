import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM, findAta, TOKEN_PROGRAM } from "../../src/chains/solana/pda";
import { USDC_MINT } from "../../src/chains/solana/sweeptx";
import { tronBase58ToHex, tronHexToBase58 } from "../../src/chains/tron/address";
import { decodeTronRawData } from "../../src/chains/tron/txcheck";
import { accountFromSeed, deriveUtxoAddress } from "../../src/chains/utxo/derive";
import { scriptAddress } from "../../src/chains/utxo/spend";
import { formatDecimal } from "../../src/core/money";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { parseLegs, type SwapLeg } from "../../src/routing/legs";
import { allocateOwnAddress } from "../../src/routing/own";
import { OWN_CHECKS_PER_RUN } from "../../src/routing/config";
import { CLAIM_STALE_MS, EXPIRY_MARGIN_MS, executeSwapChunk, MAX_ABANDONS, parseExpiry, pollSwapLegs, ROUTE_GAS_RESERVE, routableInputs, STUCK_AFTER_MS, updateLeg } from "../../src/routing/swap";
import { DOGE_FEE_RATE } from "../../src/chains/utxo/spend";
import { resumeBatch } from "../../src/routing/operator";
import { TrocadorNotVerified } from "../../src/routing/trocador";
import { solDepositKey, solHotKey, tronDepositKey, tronHotKey } from "../../src/signing/keys";
import { ENERGY_NEW_HOLDER, rentAmount } from "../../src/sweep/tron";
import { contract, nodeTx, rawBytes, transferData, triggerParam } from "../chains/tron/pb";
import { offline } from "../offline";

// The guard is the real one; the wrapper records each mint and lets a test act just before it.
const hooks = vi.hoisted(() => ({ calls: [] as Array<{ chain: string; to: string; ctx: Record<string, unknown> }>, beforeMint: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../src/routing/guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/routing/guard")>();
  return {
    ...real,
    allowedDestination: async (...a: Parameters<typeof real.allowedDestination>) => {
      hooks.calls.push({ chain: a[1], to: a[2], ctx: { ...(a[3] ?? {}) } });
      if (hooks.beforeMint) await hooks.beforeMint();
      return real.allowedDestination(...a);
    },
  };
});

const e = env as unknown as Env;
const MN = e.MASTER_SEED!;
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const XMR_A = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const XMR_B = "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H";
const T0 = 1_900_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const TROC = "https://api.trocador.app";
const ESP = "https://mempool.space/api";
const TG = "https://api.trongrid.io";
const TS = "https://api.tronsave.io";
const SOL = "https://sol.test/rpc";
const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_HOT = tronHotKey(MN).address;
const SOL_HOT = solHotKey(MN);
const TRON_DEP = tronDepositKey(OTHER, 0).address;
const SOL_DEP = solDepositKey(OTHER, 0).address;
const BTC_DEP = deriveUtxoAddress(accountFromSeed(OTHER, "btc"), "btc", 0);
const btcAddr = (i: number) => deriveUtxoAddress(accountFromSeed(MN, "btc"), "btc", i);
const saved = { TROCADOR_LIVE_OK: e.TROCADOR_LIVE_OK, TROCADOR_API_KEY: e.TROCADOR_API_KEY, TRONGRID_API_KEY: e.TRONGRID_API_KEY, TRONSAVE_API_KEY: e.TRONSAVE_API_KEY, SOLANA_RPC_URL: e.SOLANA_RPC_URL, XMR_ADDRESS: e.XMR_ADDRESS };

interface Sim {
  now: number;
  fee: number;
  utxos: Record<string, { txid: string; vout: number; value: number; confirmed: boolean }[]>;
  btcBroadcasts: string[];
  btcBroadcastFails?: boolean;
  /** Every POST /tx, accepted or not. */
  btcPosts: number;
  addrTxs: Record<string, string[]>;
  tradeCalls: URLSearchParams[];
  trades: Record<string, string>;
  deposit: string;
  expiresIn: number | null;
  /** Served verbatim as expiresAt instead of the computed ISO time. */
  expiresRaw?: string;
  /** Explorer view of tx status: confirmed flag per txid (broadcast txs are known, unconfirmed, by default). */
  confirmed: Record<string, boolean>;
  /** The fee endpoint waits here (barrier) when set. */
  feeGate?: Promise<void>;
  /** Tron: seconds-ahead of a built tx's expiration (default 60 s); broadcasthex answer override (JSON or HTTP status). */
  tronExpAhead?: number;
  tronReply?: Record<string, unknown> | number;
  /** Solana sendTransaction: "lost" answers HTTP 500, "rejected" a JSON-RPC error. */
  solSend?: "lost" | "rejected";
  refundEcho?: string;
  onBroadcast?: () => Promise<void>;
  /** Runs at each utxo listing; a Response returned is served instead (400: no fallback explorer is tried). */
  onUtxo?: () => Promise<Response | void>;
  // Tron
  trx: Record<string, bigint>;
  usdt: Record<string, bigint>;
  energy: Record<string, number>;
  solid: Record<string, unknown>;
  tronBroadcasts: { txID: string; raw: string; sig: string }[];
  buys: Record<string, unknown>[];
  rentDelivers: boolean;
  // Solana
  lamports: Record<string, bigint>;
  hotUsdc: bigint;
  solSends: string[];
  sigStatus: Record<string, unknown>;
  height: number;
}
let sim: Sim;
let seq = 0;

const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  Object.assign(e, { TROCADOR_LIVE_OK: "1", TROCADOR_API_KEY: "test-trocador-key", TRONGRID_API_KEY: "tg-key", TRONSAVE_API_KEY: "ts-key", SOLANA_RPC_URL: SOL, XMR_ADDRESS: XMR_B });
  await insertInvoice(e.DB, {
    id: "inv_s", created_at: T0 - 2 * HOUR, expires_at: T0 + HOUR, price_minor: 2500n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 2500n,
  });
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  for (const t of ["payments", "route_batches", "alerts", "events", "derivation_counters", "own_addresses"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  const { keys } = await e.KV.list({ prefix: "trocador:" });
  await Promise.all(keys.map((k) => e.KV.delete(k.name)));
  hooks.calls = [];
  hooks.beforeMint = undefined;
  delete (e as { BTC_XPUB?: string }).BTC_XPUB;
  sim = {
    now: T0, fee: 5, utxos: {}, btcBroadcasts: [], addrTxs: {}, tradeCalls: [], trades: {}, deposit: BTC_DEP, expiresIn: 30 * MIN, confirmed: {}, btcPosts: 0,
    trx: { [TRON_HOT]: 100_000_000n }, usdt: { [TRON_HOT]: 1_000_000_000n }, energy: {}, solid: {}, tronBroadcasts: [], buys: [], rentDelivers: true,
    lamports: { [SOL_HOT.address]: 1_000_000_000n }, hotUsdc: 1_000_000_000n, solSends: [], sigStatus: {}, height: 900,
  };
  network.use(...trocadorHandlers(), ...esploraHandlers(), ...tronHandlers(), solHandler(), ...offline());
});

// ---- simulated services --------------------------------------------------------------------------------------------

const NETWORKS: Record<string, string> = { btc: "Mainnet", ltc: "Mainnet", doge: "Mainnet", sol: "Mainnet", xmr: "Mainnet", usdt: "TRC20", usdc: "Solana" };
const MINIMUM: Record<string, string> = { btc: "0.0005", ltc: "0.01", doge: "20", sol: "0.1", xmr: "0.01", usdt: "10", usdc: "10" };
function trocadorHandlers() {
  return [
    http.get(`${TROC}/coin`, ({ request }) => {
      const t = new URL(request.url).searchParams.get("ticker")!;
      return HttpResponse.json([{ name: t, ticker: t, network: NETWORKS[t], memo: "False", minimum: MINIMUM[t], maximum: "100000" }]);
    }),
    http.get(`${TROC}/new_rate`, () =>
      HttpResponse.json({ trade_id: "RATE1", provider: "ProviderA", fixed: "True", amount_to: "0.25", quotes: [{ provider: "ProviderA", kycrating: "A", amount_to: "0.25", fixed: "True" }] }),
    ),
    http.get(`${TROC}/new_trade`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      expect(request.headers.get("API-Key")).toBe("test-trocador-key");
      sim.tradeCalls.push(q);
      const id = `TRADE${sim.tradeCalls.length}`;
      sim.trades[id] = "new";
      return HttpResponse.json({
        trade_id: id, ticker_from: q.get("ticker_from"), network_from: q.get("network_from"), ticker_to: "xmr", network_to: "Mainnet",
        amount_from: q.get("amount_from"), amount_to: "0.25", provider: q.get("provider"), fixed: "True", status: "new",
        address_provider: sim.deposit, address_provider_memo: "None", address_user: q.get("address"), refund_address: sim.refundEcho ?? q.get("refund"),
        id_provider: `PROV-${id}`,
        ...(sim.expiresRaw !== undefined ? { expiresAt: sim.expiresRaw } : sim.expiresIn === null ? {} : { expiresAt: new Date(sim.now + sim.expiresIn).toISOString() }),
      });
    }),
    http.get(`${TROC}/trade`, ({ request }) => {
      const id = new URL(request.url).searchParams.get("id")!;
      return HttpResponse.json({ trade_id: id, status: sim.trades[id] ?? "waiting", quotes: { support: `https://support.example/${id}` }, details: { hashout: "ab".repeat(32) } });
    }),
  ];
}

function esploraHandlers() {
  return [
    http.get(`${ESP}/address/:a/utxo`, async ({ params }) => {
      const over = sim.onUtxo ? await sim.onUtxo() : undefined;
      if (over) return over;
      return HttpResponse.json((sim.utxos[params.a as string] ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: u.confirmed ? { confirmed: true, block_height: 800_000, block_time: 1 } : { confirmed: false } })));
    }),
    http.get(`${ESP}/address/:a/txs`, ({ params }) => HttpResponse.json((sim.addrTxs[params.a as string] ?? []).map((txid) => ({ txid, vout: [], status: { confirmed: false } })))),
    http.get(`${ESP}/v1/fees/recommended`, async () => {
      if (sim.feeGate) await sim.feeGate;
      return HttpResponse.json({ fastestFee: sim.fee * 2, halfHourFee: sim.fee, hourFee: 1 });
    }),
    http.get(`${ESP}/tx/:txid/status`, ({ params }) => {
      const id = params.txid as string;
      const known = sim.confirmed[id] !== undefined || sim.btcBroadcasts.some((h) => Transaction.fromRaw(hexToBytes(h)).id === id);
      return known ? HttpResponse.json({ confirmed: sim.confirmed[id] ?? false }) : new HttpResponse("Transaction not found", { status: 404 });
    }),
    http.post(`${ESP}/tx`, async ({ request }) => {
      const hex = await request.text();
      sim.btcPosts++;
      if (sim.onBroadcast) await sim.onBroadcast();
      if (sim.btcBroadcastFails) return new HttpResponse("bad-txns", { status: 400 });
      sim.btcBroadcasts.push(hex);
      return HttpResponse.text(Transaction.fromRaw(hexToBytes(hex)).id);
    }),
  ];
}

const H = (a: string) => tronBase58ToHex(a);
const body20 = (a: string) => H(a).slice(2);
const pad = (h: string) => h.padStart(64, "0");
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function tronHandlers() {
  return [
    http.get(`${TG}/v1/accounts/:addr`, ({ params }) => {
      const a = params.addr as string;
      return HttpResponse.json({ success: true, data: sim.trx[a] === undefined ? [] : [{ address: H(a), balance: Number(sim.trx[a]) }] });
    }),
    http.post(`${TG}/wallet/triggersmartcontract`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      const p = b.parameter as string;
      const to = tronHexToBase58(`41${p.slice(24, 64)}`);
      const amount = BigInt(`0x${p.slice(64)}`);
      const t = nodeTx(
        rawBytes({
          contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(b.owner_address as string), contract: H(b.contract_address as string), data: transferData(H(to), amount) }))],
          expiration: sim.now + (sim.tronExpAhead ?? MIN), timestamp: sim.now, feeLimit: BigInt(b.fee_limit as number),
        }),
      );
      return HttpResponse.json({ result: { result: true }, transaction: { txID: t.txID, raw_data_hex: t.raw_data_hex } });
    }),
    http.post(`${TG}/wallet/triggerconstantcontract`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      const a = tronHexToBase58(`41${(b.parameter as string).slice(-40)}`);
      return HttpResponse.json({ result: { result: true }, constant_result: [pad((sim.usdt[a] ?? 0n).toString(16))] });
    }),
    http.post(`${TG}/wallet/getaccountresource`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      const n = sim.energy[b.address as string];
      return HttpResponse.json(n ? { EnergyLimit: n } : {});
    }),
    http.post(`${TG}/wallet/broadcasthex`, async ({ request }) => {
      const hex = ((await request.json()) as { transaction: string }).transaction;
      const bytes = hexToBytes(hex);
      let i = 1, len = 0, shift = 0;
      for (;;) {
        const c = bytes[i++]!;
        len |= (c & 0x7f) << shift;
        shift += 7;
        if (!(c & 0x80)) break;
      }
      const raw = bytesToHex(bytes.subarray(i, i + len));
      sim.tronBroadcasts.push({ txID: bytesToHex(sha256(hexToBytes(raw))), raw, sig: bytesToHex(bytes.subarray(i + len + 2)) });
      if (typeof sim.tronReply === "number") return new HttpResponse("upstream error", { status: sim.tronReply });
      return HttpResponse.json(sim.tronReply ?? { result: true });
    }),
    http.post(`${TG}/walletsolidity/gettransactioninfobyid`, async ({ request }) => HttpResponse.json(sim.solid[((await request.json()) as { value: string }).value] ?? {})),
    http.post(`${TG}/wallet/gettransactioninfobyid`, async ({ request }) => HttpResponse.json(sim.solid[((await request.json()) as { value: string }).value] ?? {})),
    http.post(`${TS}/v2/estimate-buy-resource`, async ({ request }) => {
      const b = (await request.json()) as Record<string, number>;
      return HttpResponse.json({ error: false, data: { unitPrice: 60, durationSec: 3600, estimateTrx: 60 * b.resourceAmount!, availableResource: 10_000_000 } });
    }),
    http.post(`${TS}/v2/buy-resource`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      sim.buys.push(b);
      if (sim.rentDelivers) sim.energy[b.receiver as string] = b.resourceAmount as number;
      return HttpResponse.json({ error: false, data: { orderId: `ord_${sim.buys.length}` } });
    }),
  ];
}
/** Mines a broadcast USDT transfer into a solid block. */
function landTron(txID: string) {
  const d = decodeTronRawData(sim.tronBroadcasts.find((b) => b.txID === txID)!.raw);
  const to = tronHexToBase58(`41${d.data!.slice(32, 72)}`);
  const amount = BigInt(`0x${d.data!.slice(72)}`);
  sim.usdt[d.owner] = (sim.usdt[d.owner] ?? 0n) - amount;
  sim.usdt[to] = (sim.usdt[to] ?? 0n) + amount;
  sim.solid[txID] = { id: txID, blockNumber: 2, receipt: { result: "SUCCESS" }, log: [{ address: body20(USDT), topics: [TRANSFER_TOPIC, pad(body20(d.owner)), pad(body20(to))], data: pad(amount.toString(16)) }] };
}

function solHandler() {
  return http.post(SOL, async ({ request }) => {
    const { method, params } = (await request.json()) as { method: string; params: unknown[] };
    const ok = (result: unknown) => HttpResponse.json({ jsonrpc: "2.0", id: 1, result });
    const ctx = { context: { slot: 1 } };
    switch (method) {
      case "getGenesisHash":
        return ok("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      case "getAccountInfo":
        return ok({ ...ctx, value: null });
      case "getLatestBlockhash":
        return ok({ ...ctx, value: { blockhash: BH, lastValidBlockHeight: 1000 } });
      case "getBalance":
        return ok({ ...ctx, value: Number(sim.lamports[params[0] as string] ?? 0n) });
      case "getTokenAccountsByOwner": {
        const owner = params[0] as string;
        return ok({
          ...ctx,
          value: owner === SOL_HOT.address
            ? [{ pubkey: findAta(owner, USDC_MINT)[0], account: { owner: TOKEN_PROGRAM, data: { parsed: { type: "account", info: { mint: USDC_MINT, owner, state: "initialized", tokenAmount: { amount: sim.hotUsdc.toString() } } } } } }]
            : [],
        });
      }
      case "sendTransaction":
        sim.solSends.push(params[0] as string);
        if (sim.solSend === "lost") return new HttpResponse("gateway timeout", { status: 504 });
        if (sim.solSend === "rejected") return HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } });
        return ok("sig");
      case "getBlockHeight":
        return ok(sim.height);
      case "getSignatureStatuses":
        return ok({ ...ctx, value: (params[0] as string[]).map((s) => sim.sigStatus[s] ?? null) });
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    }
  });
}

// ---- fixtures --------------------------------------------------------------------------------------------------------

async function btcPayment(index: number, values: number[]): Promise<PaymentRow> {
  const address = btcAddr(index);
  const p: PaymentRow = {
    id: `pay_s${seq++}`, invoice_id: "inv_s", asset: "btc:btc", chain: "btc", address, derivation_index: index, reference: null, expected: 1n, price_e8: 10n ** 8n,
    rate_locked_until: 0, received: 1n, final: 1n, txids: [], status: "confirmed", created_at: T0 - HOUR + index, detected_at: T0 - HOUR, confirmed_at: T0 - HOUR + index,
    credited_minor: 1n, credit_price_e8: 10n ** 8n, unexpected: null,
  };
  await insertPayment(e.DB, p);
  sim.utxos[address] = values.map((value, vout) => ({ txid: bytesToHex(sha256(new TextEncoder().encode(`${p.id}:${vout}`))), vout, value, confirmed: true }));
  // Indexes up to here are allocated (as invoice creation would have).
  await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('btc',?1) ON CONFLICT(chain) DO UPDATE SET next=max(next,?1)").bind(index + 1).run();
  return p;
}
async function batch(asset: string, chunks: bigint[], o: { legs?: SwapLeg[]; destination?: string; status?: string } = {}): Promise<string> {
  const id = `bat_${seq++}`;
  await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(id, asset, chunks.reduce((a, b) => a + b, 0n).toString(), JSON.stringify(chunks.map(String)), o.destination ?? XMR_A, T0, o.status ?? "executing", T0, T0, JSON.stringify(o.legs ?? []))
    .run();
  return id;
}
const legsOf = async (id: string) => parseLegs((await e.DB.prepare("SELECT legs FROM route_batches WHERE id=?").bind(id).first<{ legs: string }>())!.legs);
const routedAt = async (id: string) => (await e.DB.prepare("SELECT routed_at FROM payments WHERE id=?").bind(id).first<{ routed_at: number | null }>())!.routed_at;
const alerts = async (kind: string) => (await e.DB.prepare("SELECT * FROM alerts WHERE kind=?").bind(kind).all()).results;
const events = async (type: string) => (await e.DB.prepare("SELECT * FROM events WHERE type=?").bind(type).all<{ id: string; payload: string; invoice_id: string }>()).results;
const run = (id: string, chunk = 0, now = sim.now) => {
  sim.now = now;
  return executeSwapChunk(e, { id }, chunk, { now });
};
/** Tampers with a leg in D1, as another run would. */
const tamper = async (id: string, idx: number, f: (l: SwapLeg) => SwapLeg) => {
  const legs = await legsOf(id);
  legs[idx] = f(legs[idx]!);
  await e.DB.prepare("UPDATE route_batches SET legs=? WHERE id=?").bind(JSON.stringify(legs), id).run();
};

// ---- tests ------------------------------------------------------------------------------------------------------------

describe("gates", () => {
  it("refuses everything unless TROCADOR_LIVE_OK is 1 (before any read or call)", async () => {
    const id = await batch("btc:btc", [100_000n]);
    for (const v of [undefined, "", "0", "true"]) {
      await expect(executeSwapChunk({ ...e, TROCADOR_LIVE_OK: v } as Env, { id }, 0, { now: T0 })).rejects.toBeInstanceOf(TrocadorNotVerified);
    }
    expect(sim.tradeCalls).toHaveLength(0);
    expect(await legsOf(id)).toEqual([]);
  });
  it("a batch whose destination is not a valid XMR address is refused", async () => {
    const id = await batch("btc:btc", [100_000n], { destination: "4notanaddress" });
    await expect(run(id)).rejects.toThrow(/XMR/);
  });
  it("a watch-mode (xpub) chain is never routed: skipped, no trade, no explorer read", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [400_000n]);
    (e as { BTC_XPUB?: string }).BTC_XPUB = "xpub-configured";
    const r = await run(id);
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/watch mode/) });
    expect(await routableInputs(e, "btc")).toEqual([]);
    expect(sim.tradeCalls).toHaveLength(0);
    expect(await legsOf(id)).toEqual([]);
  });
});

describe("UTXO (BTC) legs", () => {
  it("quote -> trade -> spend: the leg is recorded before the send, the guard gets the batch id, one output pays the deposit, routed_at is set", async () => {
    const [p1, p2, p3] = [await btcPayment(20, [500_000]), await btcPayment(21, [300_000]), await btcPayment(22, [200_000])];
    const id = await batch("btc:btc", [1_000_000n]);
    let atBroadcast: { leg: SwapLeg; routed: (number | null)[] } | undefined;
    sim.onBroadcast = async () => {
      atBroadcast = { leg: (await legsOf(id))[0]!, routed: [await routedAt(p1.id), await routedAt(p2.id), await routedAt(p3.id)] };
    };
    const r = await run(id);
    expect(r.status).toBe("sent");
    // Recorded before the send: claimed, with the signed tx persisted, and nothing routed yet.
    expect(atBroadcast!.leg).toMatchObject({ step: "sending", tx: r.tx, tradeId: "TRADE1", depositAddress: BTC_DEP });
    expect(atBroadcast!.routed).toEqual([null, null, null]);
    // The guard was asked for the trade deposit with this batch's id.
    expect(hooks.calls).toEqual([{ chain: "btc", to: BTC_DEP, ctx: { batchId: id } }]);
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sent", tx: r.tx, sentAt: T0, withChange: false });
    const t = Transaction.fromRaw(hexToBytes(sim.btcBroadcasts[0]!));
    expect(t.inputsLength).toBe(3);
    expect(t.outputsLength).toBe(1);
    expect(scriptAddress("btc", t.getOutput(0).script!)).toBe(BTC_DEP);
    expect(t.getOutput(0).amount).toBe(BigInt(leg.amount));
    expect(BigInt(leg.fee!)).toBe(1_000_000n - BigInt(leg.amount));
    expect(BigInt(leg.fee!) / BigInt(t.vsize)).toBeGreaterThanOrEqual(5n);
    // The trade: amount, the frozen destination, a fresh deposit-chain refund address.
    const q = sim.tradeCalls[0]!;
    expect(q.get("amount_from")).toBe(formatDecimal(BigInt(leg.amount), 8));
    expect(q.get("address")).toBe(XMR_A);
    expect(leg.refundIndex).toBeGreaterThan(22);
    expect(q.get("refund")).toBe(btcAddr(leg.refundIndex!));
    expect(leg.refundAddress).toBe(btcAddr(leg.refundIndex!));
    for (const p of [p1, p2, p3]) expect(await routedAt(p.id)).toBe(T0);
    // Unconfirmed: the same bytes are re-broadcast while the trade allows; confirmed: done, nothing more is sent.
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect(sim.btcBroadcasts).toEqual([sim.btcBroadcasts[0], sim.btcBroadcasts[0]]);
    sim.confirmed[r.tx!] = true;
    expect((await run(id, 0, T0 + 2 * MIN)).status).toBe("done");
    expect(sim.btcBroadcasts).toHaveLength(2);
    expect(hooks.calls).toHaveLength(1);
  });

  it("uses the batch's frozen destination even after XMR_ADDRESS changed", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n], { destination: XMR_A });
    expect(e.XMR_ADDRESS).toBe(XMR_B);
    await run(id);
    expect(sim.tradeCalls[0]!.get("address")).toBe(XMR_A);
  });

  it("a partial chunk spends whole payments with change to a fresh index; the rest stays unrouted", async () => {
    const p1 = await btcPayment(20, [500_000]);
    const p2 = await btcPayment(21, [300_000]);
    const id = await batch("btc:btc", [400_000n, 390_000n]);
    const r = await run(id, 0);
    expect(r.status).toBe("sent");
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sent", amount: "400000", withChange: true });
    const t = Transaction.fromRaw(hexToBytes(sim.btcBroadcasts[0]!));
    expect(t.outputsLength).toBe(2);
    expect(t.getOutput(0).amount).toBe(400_000n);
    expect(leg.change!.index).toBeGreaterThan(leg.refundIndex!);
    expect(scriptAddress("btc", t.getOutput(1).script!)).toBe(btcAddr(leg.change!.index));
    expect(t.getOutput(1).amount).toBe(BigInt(leg.change!.amount!));
    expect(500_000n - 400_000n - BigInt(leg.fee!)).toBe(BigInt(leg.change!.amount!));
    expect(hooks.calls.map((c) => c.ctx)).toEqual([{ batchId: id }, { changeIndex: leg.change!.index }]);
    expect(await routedAt(p1.id)).toBe(T0);
    expect(await routedAt(p2.id)).toBeNull();
    // The second chunk cannot reuse what the first leg holds: it takes the other payment.
    const r2 = await run(id, 1);
    expect(r2.status).toBe("sent");
    const leg2 = (await legsOf(id))[1]!;
    expect(leg2.inputs!.map((i) => i.paymentId)).toEqual([p2.id]);
    expect(await routedAt(p2.id)).toBe(T0);
  });

  it("a lost compare-and-set before the claim signs nothing; one after signing broadcasts nothing", async () => {
    const p = await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    // Another run touches the leg while this one checks the inputs (after the trade, before the claim).
    let once = true;
    sim.onUtxo = async () => {
      const legs = await legsOf(id);
      if (once && legs[0]?.step === "traded") {
        once = false;
        await tamper(id, 0, (l) => ({ ...l, updatedAt: l.updatedAt + 1 }));
      }
    };
    expect((await run(id)).status).toBe("skipped");
    expect(hooks.calls).toHaveLength(0);
    expect(sim.btcBroadcasts).toHaveLength(0);
    // Now the leg changes between the claim and the persisted tx (while the proof is minted).
    sim.onUtxo = undefined;
    hooks.beforeMint = async () => tamper(id, 0, (l) => ({ ...l, claim: "another-run" }));
    expect((await run(id)).status).toBe("skipped");
    expect(hooks.calls).toHaveLength(1);
    expect(sim.btcBroadcasts).toHaveLength(0);
    expect((await legsOf(id))[0]).toMatchObject({ step: "sending", claim: "another-run" });
    expect((await legsOf(id))[0]!.tx).toBeUndefined();
    expect(await routedAt(p.id)).toBeNull();
  });

  it("routed_at is set in the same transaction as `sent`: a lost update leaves it unset", async () => {
    const p = await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.onBroadcast = async () => tamper(id, 0, (l) => ({ ...l, updatedAt: l.updatedAt + 1 }));
    expect((await run(id)).status).toBe("skipped");
    expect(sim.btcBroadcasts).toHaveLength(1);
    expect((await legsOf(id))[0]!.step).toBe("sending");
    expect(await routedAt(p.id)).toBeNull();
    // The next run sees the tx at the deposit and settles both together.
    sim.onBroadcast = undefined;
    sim.addrTxs[BTC_DEP] = [Transaction.fromRaw(hexToBytes(sim.btcBroadcasts[0]!)).id];
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("sent");
    expect(await routedAt(p.id)).toBe(T0 + MIN);
    expect(sim.btcBroadcasts).toHaveLength(1);
  });

  it("a failed broadcast keeps the signed tx and re-broadcasts the same bytes, never a new tx", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.btcBroadcastFails = true;
    expect((await run(id)).status).toBe("waiting");
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sending" });
    expect(await alerts("routing.failing")).toHaveLength(1);
    sim.btcBroadcastFails = false;
    expect((await run(id, 0, T0 + MIN)).status).toBe("sent");
    expect(sim.btcBroadcasts).toEqual([leg.raw]);
    expect(hooks.calls).toHaveLength(1);
  });

  it("abandons a leg whose trade expires within 10 minutes, before sending anything; the next call makes a new trade", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.expiresIn = EXPIRY_MARGIN_MS - MIN;
    const r = await run(id);
    expect(r.status).toBe("abandoned");
    expect(sim.btcBroadcasts).toHaveLength(0);
    expect(hooks.calls).toHaveLength(0);
    expect((await legsOf(id))[0]).toMatchObject({ step: "abandoned", tradeId: "TRADE1" });
    sim.expiresIn = 30 * MIN;
    expect((await run(id, 0, T0 + MIN)).status).toBe("sent");
    const legs = await legsOf(id);
    expect(legs.map((l) => [l.step, l.tradeId])).toEqual([["abandoned", "TRADE1"], ["sent", "TRADE2"]]);
  });

  it("never sends after expiry: a traded leg found past its window is abandoned", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.onUtxo = async () => {
      if ((await legsOf(id))[0]?.step === "traded") return new HttpResponse("bad request", { status: 400 });
    };
    await expect(run(id)).rejects.toThrow();
    expect((await legsOf(id))[0]!.step).toBe("traded");
    sim.onUtxo = undefined;
    expect((await run(id, 0, T0 + 25 * MIN)).status).toBe("abandoned");
    expect(sim.btcBroadcasts).toHaveLength(0);
  });

  it("passes a refund address and refuses a trade that echoes another one (nothing is sent)", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.refundEcho = BTC_DEP;
    const r = await run(id);
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/refunds to a different address/) });
    expect((await legsOf(id))[0]!.step).toBe("abandoned");
    expect(sim.tradeCalls[0]!.get("refund")).toMatch(/^bc1q/);
    expect(sim.btcBroadcasts).toHaveLength(0);
  });

  it("refuses a chunk below the Trocador minimum (no trade)", async () => {
    await btcPayment(20, [40_000]);
    const id = await batch("btc:btc", [40_000n]);
    expect(await run(id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/minimum/) });
    expect(sim.tradeCalls).toHaveLength(0);
  });
});

describe("Tron USDT legs", () => {
  const AMT = 25_000_000n;
  beforeEach(() => {
    sim.deposit = TRON_DEP;
  });

  it("rents energy for the hot wallet, signs transfer(deposit, amount) from hot under the leg proof, `sent` once solid", async () => {
    const id = await batch("tron:usdt", [AMT]);
    const r = await run(id);
    expect(r.status).toBe("sent");
    expect(sim.tradeCalls[0]!.get("refund")).toBe(TRON_HOT);
    expect(sim.buys).toEqual([expect.objectContaining({ receiver: TRON_HOT, resourceAmount: rentAmount(ENERGY_NEW_HOLDER) })]);
    expect(sim.tronBroadcasts).toHaveLength(1);
    const d = decodeTronRawData(sim.tronBroadcasts[0]!.raw);
    expect(d).toMatchObject({ type: "TriggerSmartContract", owner: TRON_HOT, contract: USDT });
    expect(d.data).toBe(transferData(H(TRON_DEP), AMT));
    expect(d.feeLimit).toBeLessThanOrEqual(5_000_000n);
    // The signature recovers to the hot wallet.
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const sig = hexToBytes(sim.tronBroadcasts[0]!.sig);
    const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(hexToBytes(sim.tronBroadcasts[0]!.txID)).toBytes(false);
    const { tronAddressFromPubkey } = await import("../../src/chains/tron/address");
    expect(tronAddressFromPubkey(pub)).toBe(TRON_HOT);
    expect(hooks.calls).toEqual([{ chain: "tron", to: TRON_DEP, ctx: { batchId: id } }]);
    expect((await legsOf(id))[0]).toMatchObject({ step: "sending", tx: sim.tronBroadcasts[0]!.txID, energy: { need: ENERGY_NEW_HOLDER, paid: true, orderId: "ord_1" } });
    // Not solid yet: waiting, nothing new signed.
    expect((await run(id, 0, T0 + 30_000)).status).toBe("waiting");
    landTron(sim.tronBroadcasts[0]!.txID);
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]).toMatchObject({ step: "sent", sentAt: T0 + MIN });
    expect(hooks.calls).toHaveLength(1);
  });

  it("waits for rented energy that has not arrived, and abandons the leg after 45 minutes (window permitting)", async () => {
    sim.rentDelivers = false;
    sim.expiresIn = 2 * HOUR;
    const id = await batch("tron:usdt", [AMT]);
    expect((await run(id)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("energy_wait");
    expect((await run(id, 0, T0 + 15 * MIN)).status).toBe("waiting");
    expect(sim.buys).toHaveLength(1);
    expect((await run(id, 0, T0 + 46 * MIN)).status).toBe("abandoned");
    expect(sim.tronBroadcasts).toHaveLength(0);
  });

  it("refuses a send that would leave the hot wallet under its 50 TRX reserve, and alerts (nothing rented)", async () => {
    sim.trx[TRON_HOT] = ROUTE_GAS_RESERVE.tron + 4_000_000n;
    const id = await batch("tron:usdt", [AMT]);
    expect(await run(id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/reserve/) });
    expect(await alerts("sweep.insufficient_gas")).toHaveLength(1);
    expect(sim.buys).toHaveLength(0);
    expect(sim.tronBroadcasts).toHaveLength(0);
  });

  it("a dropped transfer (expired, unknown) goes back to `traded` and is signed again inside the window", async () => {
    sim.energy[TRON_HOT] = 200_000;
    const id = await batch("tron:usdt", [AMT]);
    expect((await run(id)).status).toBe("sent");
    expect(sim.buys).toHaveLength(0);
    expect((await run(id, 0, T0 + 12 * MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("traded");
    expect((await run(id, 0, T0 + 13 * MIN)).status).toBe("sent");
    expect(sim.tronBroadcasts).toHaveLength(2);
    expect(sim.tronBroadcasts[0]!.txID).not.toBe(sim.tronBroadcasts[1]!.txID);
  });
});

describe("Solana legs", () => {
  beforeEach(() => {
    sim.deposit = SOL_DEP;
  });

  it("USDC: creates the provider owner's ATA (payer hot) and transferChecked to it, signed by hot; `sent` once confirmed", async () => {
    const id = await batch("sol:usdc", [20_000_000n]);
    const r = await run(id);
    expect(r.status).toBe("sent");
    expect(sim.tradeCalls[0]!.get("refund")).toBe(SOL_HOT.address);
    expect(hooks.calls).toEqual([{ chain: "sol", to: SOL_DEP, ctx: { batchId: id } }]);
    const k = await import("@solana/kit");
    const wire = base64.decode(sim.solSends[0]!);
    const tx = k.getTransactionDecoder().decode(wire) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array> };
    const m = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { staticAccounts: string[]; instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[] };
    const acc = m.staticAccounts;
    const ixs = m.instructions.map((ix) => ({ program: acc[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map((i) => acc[i]), data: ix.data }));
    const ata = ixs.find((i) => i.program === ASSOCIATED_TOKEN_PROGRAM)!;
    expect(ata.accounts).toEqual([SOL_HOT.address, findAta(SOL_DEP, USDC_MINT)[0], SOL_DEP, USDC_MINT, "11111111111111111111111111111111", TOKEN_PROGRAM]);
    const xfer = ixs.find((i) => i.program === TOKEN_PROGRAM)!;
    expect(xfer.accounts).toEqual([findAta(SOL_HOT.address, USDC_MINT)[0], USDC_MINT, findAta(SOL_DEP, USDC_MINT)[0], SOL_HOT.address]);
    expect(new DataView(xfer.data!.buffer, xfer.data!.byteOffset).getBigUint64(1, true)).toBe(20_000_000n);
    expect(acc[0]).toBe(SOL_HOT.address);
    expect(ed25519.verify(tx.signatures[SOL_HOT.address]!, tx.messageBytes, SOL_HOT.pub)).toBe(true);
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sending", tx: base58.encode(tx.signatures[SOL_HOT.address]!) });
    sim.sigStatus[leg.tx!] = { confirmationStatus: "confirmed", err: null };
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]).toMatchObject({ step: "sent", sentAt: T0 + MIN });
  });

  it("SOL: refuses a send that would leave less than 0.05 SOL, and alerts", async () => {
    sim.lamports[SOL_HOT.address] = 200_000_000n + ROUTE_GAS_RESERVE.sol - 1n;
    const id = await batch("sol:sol", [200_000_000n]);
    expect(await run(id)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/reserve/) });
    expect(await alerts("sweep.insufficient_gas")).toHaveLength(1);
    expect(sim.solSends).toHaveLength(0);
    expect(hooks.calls).toHaveLength(0);
  });

  it("SOL: a blockhash that expired without the tx landing goes back to `traded` (never two txs in flight)", async () => {
    const id = await batch("sol:sol", [200_000_000n]);
    expect((await run(id)).status).toBe("sent");
    sim.height = 1001;
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("traded");
    expect((await run(id, 0, T0 + 2 * MIN)).status).toBe("sent");
    expect(sim.solSends).toHaveLength(2);
  });
});

describe("pollSwapLegs", () => {
  const sent = (chunk: number, tradeId: string, o: Partial<SwapLeg> = {}): SwapLeg => ({
    chunk, step: "sent", amount: "1000", createdAt: T0, updatedAt: T0, tradeId, provider: "ProviderA", depositAddress: TRON_DEP, refundAddress: TRON_HOT, expiresAt: T0 + HOUR, tx: "ab".repeat(32), sentAt: T0, ...o,
  });

  it("all legs finished -> batch completed and one routing.completed event", async () => {
    const id = await batch("tron:usdt", [1000n, 1000n], { legs: [sent(0, "TA"), { ...sent(0, "TX"), step: "abandoned" }, sent(1, "TB")] });
    sim.trades.TA = "finished";
    sim.trades.TB = "sending";
    expect((await pollSwapLegs(e, { id }, { now: T0 + MIN })).batch).toBe("executing");
    sim.trades.TB = "finished";
    expect((await pollSwapLegs(e, { id }, { now: T0 + 2 * MIN })).batch).toBe("completed");
    const legs = await legsOf(id);
    expect(legs.map((l) => l.step)).toEqual(["finished", "abandoned", "finished"]);
    expect(legs[0]!.hashout).toBe("ab".repeat(32));
    await pollSwapLegs(e, { id }, { now: T0 + 3 * MIN });
    const ev = await events("routing.completed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.id).toBe(`routing.completed:${id}`);
    expect(JSON.parse(ev[0]!.payload)).toMatchObject({ batch: id, asset: "tron:usdt", legs: [{ tradeId: "TA", step: "finished" }, { tradeId: "TB", step: "finished" }] });
  });

  it("one expired leg -> batch failed and routing.failed", async () => {
    const id = await batch("tron:usdt", [1000n, 1000n], { legs: [sent(0, "TA"), sent(1, "TB")] });
    sim.trades.TA = "finished";
    sim.trades.TB = "expired";
    expect((await pollSwapLegs(e, { id }, { now: T0 + MIN })).batch).toBe("failed");
    expect((await e.DB.prepare("SELECT error FROM route_batches WHERE id=?").bind(id).first<{ error: string }>())!.error).toMatch(/chunk 1: trade expired/);
    expect(await events("routing.failed")).toHaveLength(1);
    expect(await events("routing.completed")).toHaveLength(0);
  });

  it("a refunded leg fails the batch and notes that the funds return to the refund address", async () => {
    const id = await batch("tron:usdt", [1000n], { legs: [sent(0, "TA")] });
    sim.trades.TA = "refunded";
    expect((await pollSwapLegs(e, { id }, { now: T0 + MIN })).batch).toBe("failed");
    expect((await legsOf(id))[0]!.reason).toBe(`trade refunded: the funds return to ${TRON_HOT}`);
    expect(JSON.parse((await events("routing.failed"))[0]!.payload).error).toMatch(/refunded/);
  });

  it("`sent` at T, polled at T+6h01m and again later -> routing.stuck emitted exactly once; nothing is re-sent", async () => {
    const id = await batch("tron:usdt", [1000n], { legs: [sent(0, "TA")] });
    sim.trades.TA = "waiting";
    expect((await pollSwapLegs(e, { id }, { now: T0 + STUCK_AFTER_MS - MIN })).stuck).toBe(0);
    expect((await pollSwapLegs(e, { id }, { now: T0 + 6 * HOUR + MIN })).stuck).toBe(1);
    expect((await pollSwapLegs(e, { id }, { now: T0 + 6 * HOUR + 20 * MIN })).stuck).toBe(0);
    expect(await events("routing.stuck")).toHaveLength(1);
    const a = await alerts("routing.stuck");
    expect(a).toHaveLength(1);
    expect((a[0] as { detail: string }).detail).toMatch(/TA.*support\.example\/TA/);
    expect((await legsOf(id))[0]).toMatchObject({ step: "sent", stuckAt: T0 + 6 * HOUR + MIN });
    expect(sim.tronBroadcasts).toHaveLength(0);
  });

  it("also maps a `sending` leg with a signed tx (it may have landed after the batch stopped), never one without", async () => {
    const id = await batch("tron:usdt", [1000n, 1000n], { legs: [{ ...sent(0, "TA"), step: "sending", sentAt: undefined }, { ...sent(1, "TB"), step: "sending", tx: undefined, sentAt: undefined }] });
    sim.trades.TA = "finished";
    sim.trades.TB = "finished";
    await pollSwapLegs(e, { id }, { now: T0 + MIN });
    expect((await legsOf(id)).map((l) => l.step)).toEqual(["finished", "sending"]);
  });

  it("XMR_ADDRESS is what a new batch freezes, validated", async () => {
    const { xmrDestination } = await import("../../src/routing/swap");
    expect(xmrDestination({ XMR_ADDRESS: XMR_B })).toBe(XMR_B);
    for (const bad of [undefined, "", "4abc", XMR_A.slice(0, -1) + "B"]) expect(() => xmrDestination({ XMR_ADDRESS: bad })).toThrow(/XMR/);
  });

  it("an unreadable status leaves the leg as it is (never read as finished)", async () => {
    const id = await batch("tron:usdt", [1000n], { legs: [sent(0, "TA")] });
    network.use(http.get(`${TROC}/trade`, () => new HttpResponse(null, { status: 502 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await pollSwapLegs(e, { id }, { now: T0 + MIN })).batch).toBe("executing");
    expect((await legsOf(id))[0]!.step).toBe("sent");
  });
});

// ---- fix round ---------------------------------------------------------------------------------------------------------

describe("expiry fails closed", () => {
  it("parseExpiry: only ISO-8601 with an explicit zone; absent is undefined, anything else null", () => {
    expect(parseExpiry("2026-11-13T10:30:00Z")).toBe(Date.parse("2026-11-13T10:30:00Z"));
    expect(parseExpiry("2026-11-13T10:30:00.123+02:00")).toBe(Date.parse("2026-11-13T10:30:00.123+02:00"));
    expect(parseExpiry(undefined)).toBeUndefined();
    for (const bad of ["2026-11-13T10:30:00", "2026-11-13 10:30:00Z", "1763029800", "1763029800000", "soon", "2026-13-45T99:99:99Z"]) expect(parseExpiry(bad), bad).toBeNull();
  });

  it.each([["zone-less", "2026-11-13T10:30:00"], ["malformed", "soon"], ["epoch", String(Math.floor((T0 + HOUR) / 1000))]])(
    "a %s expiresAt: the leg is abandoned before any claim, nothing is sent",
    async (_, raw) => {
      await btcPayment(20, [500_000]);
      const id = await batch("btc:btc", [500_000n]);
      sim.expiresRaw = raw;
      expect(await run(id)).toMatchObject({ status: "abandoned", reason: expect.stringMatching(/ISO-8601/) });
      expect((await legsOf(id))[0]).toMatchObject({ step: "abandoned", tradeId: "TRADE1" });
      expect(hooks.calls).toHaveLength(0);
      expect(sim.btcPosts).toBe(0);
    },
  );

  it("no expiresAt (UTXO): sent only within the call that created the trade; never re-broadcast later", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.expiresIn = null;
    sim.btcBroadcastFails = true;
    expect((await run(id)).status).toBe("waiting");
    expect(sim.btcPosts).toBe(1);
    expect((await legsOf(id))[0]!.expiresAt).toBeUndefined();
    sim.btcBroadcastFails = false;
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect(sim.btcPosts).toBe(1);
    expect(await alerts("routing.stuck")).toHaveLength(1);
  });

  it("no expiresAt (UTXO), broadcast accepted in the same call: sent", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.expiresIn = null;
    expect((await run(id)).status).toBe("sent");
  });

  it("no expiresAt (Tron): abandoned when the hot wallet needs energy (a multi-run wait); nothing rented", async () => {
    sim.deposit = TRON_DEP;
    sim.expiresIn = null;
    const id = await batch("tron:usdt", [25_000_000n]);
    expect(await run(id)).toMatchObject({ status: "abandoned", reason: expect.stringMatching(/no expiry/) });
    expect(sim.buys).toHaveLength(0);
    expect(sim.tronBroadcasts).toHaveLength(0);
  });

  it("no expiresAt (Tron), energy already there: sent in the creating call, never re-broadcast later", async () => {
    sim.deposit = TRON_DEP;
    sim.expiresIn = null;
    sim.energy[TRON_HOT] = 200_000;
    const id = await batch("tron:usdt", [25_000_000n]);
    expect((await run(id)).status).toBe("sent");
    expect((await run(id, 0, T0 + 30_000)).status).toBe("waiting");
    expect(sim.tronBroadcasts).toHaveLength(1);
  });
});

describe("Tron: never sendable after expiry; only definite refusals free the leg", () => {
  const AMT = 25_000_000n;
  beforeEach(() => {
    sim.deposit = TRON_DEP;
    sim.energy[TRON_HOT] = 200_000;
  });

  it("refuses to sign a tx expiring more than 5 minutes ahead (tx_mismatch alert, nothing sent)", async () => {
    sim.tronExpAhead = 6 * MIN;
    const id = await batch("tron:usdt", [AMT]);
    expect(await run(id)).toMatchObject({ status: "skipped", reason: "tx_mismatch" });
    expect(await alerts("sweep.tx_mismatch")).toHaveLength(1);
    expect(hooks.calls).toHaveLength(0);
    expect(sim.tronBroadcasts).toHaveLength(0);
  });

  it("refuses a tx expiring after the trade's window (expiresAt - 10 min)", async () => {
    sim.expiresIn = 12 * MIN;
    sim.tronExpAhead = 3 * MIN;
    const id = await batch("tron:usdt", [AMT]);
    expect(await run(id)).toMatchObject({ status: "skipped", reason: "tx_mismatch" });
    expect(sim.tronBroadcasts).toHaveLength(0);
    sim.tronExpAhead = MIN;
    expect((await run(id)).status).toBe("sent");
  });

  it("a definite refusal (SIGERROR) goes back to `traded` and is signed again", async () => {
    sim.tronReply = { result: false, code: "SIGERROR" };
    const id = await batch("tron:usdt", [AMT]);
    expect((await run(id)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("traded");
    sim.tronReply = undefined;
    expect((await run(id, 0, T0 + MIN)).status).toBe("sent");
    expect(sim.tronBroadcasts).toHaveLength(2);
  });

  it.each([["OTHER_ERROR", { result: false, code: "OTHER_ERROR" }], ["a missing code", { result: false }], ["a lost answer (HTTP 502)", 502]])(
    "%s keeps the tx until it provably expired (expired + grace + unknown to the node), then re-signs",
    async (_, reply) => {
      sim.tronReply = reply as never;
      const id = await batch("tron:usdt", [AMT]);
      expect((await run(id)).status).toBe("unknown");
      const leg = (await legsOf(id))[0]!;
      expect(leg).toMatchObject({ step: "sending", tx: sim.tronBroadcasts[0]!.txID });
      sim.tronReply = undefined;
      expect((await run(id, 0, T0 + 5 * MIN)).status).toBe("waiting");
      expect((await legsOf(id))[0]!.tx).toBe(leg.tx);
      expect(sim.tronBroadcasts).toHaveLength(1);
      expect((await run(id, 0, T0 + 12 * MIN)).status).toBe("waiting");
      expect((await legsOf(id))[0]!.step).toBe("traded");
      expect((await run(id, 0, T0 + 13 * MIN)).status).toBe("sent");
      expect(sim.tronBroadcasts).toHaveLength(2);
    },
  );

  it("a lost compare-and-set after the claim (while minting) broadcasts nothing", async () => {
    const id = await batch("tron:usdt", [AMT]);
    hooks.beforeMint = async () => tamper(id, 0, (l) => ({ ...l, claim: "another-run" }));
    expect((await run(id)).status).toBe("skipped");
    expect(hooks.calls).toHaveLength(1);
    expect(sim.tronBroadcasts).toHaveLength(0);
    expect((await legsOf(id))[0]!.tx).toBeUndefined();
  });
});

describe("Solana: an ambiguous answer keeps the tx", () => {
  beforeEach(() => {
    sim.deposit = SOL_DEP;
  });

  it("a lost send answer keeps the tx, re-sends the same bytes while valid, frees it only past lastValidBlockHeight", async () => {
    sim.solSend = "lost";
    const id = await batch("sol:sol", [200_000_000n]);
    expect((await run(id)).status).toBe("unknown");
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sending", validUntil: "1000" });
    sim.solSend = undefined;
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect(sim.solSends).toHaveLength(2);
    expect(sim.solSends[1]).toBe(sim.solSends[0]);
    expect((await legsOf(id))[0]!.tx).toBe(leg.tx);
    sim.height = 1001;
    expect((await run(id, 0, T0 + 2 * MIN)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("traded");
  });

  it("a JSON-RPC refusal (RpcRejected: no URL accepted it) frees the leg at once", async () => {
    sim.solSend = "rejected";
    const id = await batch("sol:sol", [200_000_000n]);
    expect((await run(id)).status).toBe("waiting");
    expect((await legsOf(id))[0]!.step).toBe("traded");
  });

  it("a lost compare-and-set after the claim (while minting) sends nothing", async () => {
    const id = await batch("sol:usdc", [20_000_000n]);
    hooks.beforeMint = async () => tamper(id, 0, (l) => ({ ...l, claim: "another-run" }));
    expect((await run(id)).status).toBe("skipped");
    expect(sim.solSends).toHaveLength(0);
  });
});

describe("UTXO: settling and races", () => {
  it("a sending leg with a tx past its window: no re-broadcast, a stuck alert", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.btcBroadcastFails = true;
    expect((await run(id)).status).toBe("waiting");
    expect(sim.btcPosts).toBe(1);
    sim.btcBroadcastFails = false;
    expect((await run(id, 0, T0 + 30 * MIN - EXPIRY_MARGIN_MS)).status).toBe("waiting");
    expect(sim.btcPosts).toBe(1);
    expect(await alerts("routing.stuck")).toHaveLength(1);
    expect((await legsOf(id))[0]!.step).toBe("sending");
  });

  it("a stale claim (CLAIM_STALE_MS, no tx) is taken over; the old run's later persist fails", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    hooks.beforeMint = async () => {
      throw new Error("crash");
    };
    await expect(run(id)).rejects.toThrow("crash");
    hooks.beforeMint = undefined;
    expect((await legsOf(id))[0]!.step).toBe("traded");
    await tamper(id, 0, (l) => ({ ...l, step: "sending", claim: "old-run", claimedAt: T0 }));
    const old = (await legsOf(id))[0]!;
    expect(await run(id, 0, T0 + MIN)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/another run is sending/) });
    expect((await run(id, 0, T0 + CLAIM_STALE_MS + 1)).status).toBe("sent");
    expect(await updateLeg(e.DB, id, 0, old, { ...old, tx: "ff".repeat(32), raw: "00" }, { now: T0 + CLAIM_STALE_MS + 2 })).toBe(false);
    expect((await legsOf(id))[0]).toMatchObject({ step: "sent" });
    expect(sim.btcPosts).toBe(1);
  });

  it("concurrent appends for two chunks of one batch: one wins, the other retries with disjoint inputs", async () => {
    await btcPayment(20, [500_000]);
    await btcPayment(21, [300_000]);
    const id = await batch("btc:btc", [400_000n, 290_000n]);
    let arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    network.use(
      http.get(`${ESP}/v1/fees/recommended`, async () => {
        if (++arrived === 2) release();
        await gate; // both runs have planned before either appends: a real overlap, not a timeout

        return HttpResponse.json({ halfHourFee: 5 });
      }),
    );
    const rs = await Promise.all([run(id, 0), run(id, 1)]);
    expect(arrived).toBe(2);
    expect(rs.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(await legsOf(id)).toHaveLength(1);
    const lost = rs.findIndex((r) => r.status === "skipped");
    expect((await run(id, lost, T0 + MIN)).status).toBe("sent");
    const legs = await legsOf(id);
    expect(legs).toHaveLength(2);
    const outs = legs.flatMap((l) => l.inputs!.map((i) => `${i.txid}:${i.vout}`));
    expect(new Set(outs).size).toBe(outs.length);
  });

  it(`after ${MAX_ABANDONS} abandoned legs in a row for a chunk, the batch takes no new legs and routing.failing is raised`, async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [500_000n]);
    sim.expiresIn = 5 * MIN;
    for (let i = 0; i < MAX_ABANDONS; i++) expect((await run(id, 0, T0 + i * MIN)).status).toBe("abandoned");
    sim.expiresIn = 30 * MIN;
    expect(await run(id, 0, T0 + 10 * MIN)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/abandoned 3 times/) });
    expect(sim.tradeCalls).toHaveLength(MAX_ABANDONS);
    expect(await alerts("routing.failing")).toHaveLength(1);
    // The operator's "resume batch" marks those legs resumed (src/routing/operator.ts): they stop counting.
    expect(await resumeBatch(e, id, T0 + 11 * MIN)).toMatchObject({ ok: true });
    expect((await run(id, 0, T0 + 12 * MIN)).status).toBe("sent");
    expect(sim.tradeCalls).toHaveLength(MAX_ABANDONS + 1);
  });

  it.each(["finished", "expired"])("poll: a UTXO leg with a tx leaving `sending` (%s) sets routed_at in the same update", async (status) => {
    const p = await btcPayment(20, [500_000]);
    const leg: SwapLeg = {
      chunk: 0, step: "sending", amount: "490000", createdAt: T0, updatedAt: T0, tradeId: "TU", depositAddress: BTC_DEP, expiresAt: T0 + HOUR, tx: "cd".repeat(32), raw: "00",
      inputs: [{ txid: sim.utxos[p.address]![0]!.txid, vout: 0, value: "500000", index: 20, address: p.address, paymentId: p.id }],
    };
    const id = await batch("btc:btc", [500_000n], { legs: [leg] });
    sim.trades.TU = status;
    await pollSwapLegs(e, { id }, { now: T0 + MIN });
    expect((await legsOf(id))[0]!.step).toBe(status === "finished" ? "finished" : "failed");
    expect(await routedAt(p.id)).toBe(T0 + MIN);
  });
});

describe("DOGE end to end (blockbook)", () => {
  const BB = "https://bb.test";
  const dogeAddr = (i: number, mn = MN) => deriveUtxoAddress(accountFromSeed(mn, "doge"), "doge", i);
  const DEP = dogeAddr(0, OTHER);
  let savedBB: string | undefined;
  beforeEach(() => {
    savedBB = e.DOGE_BLOCKBOOK_URL;
    e.DOGE_BLOCKBOOK_URL = BB;
    sim.deposit = DEP;
  });
  afterEach(() => {
    e.DOGE_BLOCKBOOK_URL = savedBB ?? "";
  });

  it("plans from blockbook utxos, signs against the previous tx from blockbook txHex at the fixed fee rate, broadcasts via sendtx", async () => {
    const ours = dogeAddr(30);
    const net = { bech32: "", pubKeyHash: 30, scriptHash: 22, wif: 158 };
    const prev = new Transaction({ allowUnknownOutputs: true });
    prev.addInput({ txid: "aa".repeat(32), index: 0 });
    prev.addOutputAddress(ours, 5_000_000_000n, net);
    const sent: string[] = [];
    network.use(
      http.get(`${BB}/api/v2/utxo/:a`, ({ params }) => HttpResponse.json(params.a === ours ? [{ txid: prev.id, vout: 0, value: "5000000000", confirmations: 30, height: 100 }] : [])),
      http.get(`${BB}/api/v2/tx/:txid`, ({ params }) => {
        const t = params.txid as string;
        if (t === prev.id) return HttpResponse.json({ txid: t, hex: prev.hex, confirmations: 30 });
        if (sent.some((h) => Transaction.fromRaw(hexToBytes(h)).id === t)) return HttpResponse.json({ txid: t, confirmations: 0 });
        return HttpResponse.json({ error: `Transaction '${t}' not found` }, { status: 400 });
      }),
      http.post(`${BB}/api/v2/sendtx/`, async ({ request }) => {
        const hex = await request.text();
        sent.push(hex);
        return HttpResponse.json({ result: Transaction.fromRaw(hexToBytes(hex)).id });
      }),
    );
    await insertPayment(e.DB, {
      id: "pay_doge", invoice_id: "inv_s", asset: "doge:doge", chain: "doge", address: ours, derivation_index: 30, reference: null, expected: 1n, price_e8: 10n ** 8n,
      rate_locked_until: 0, received: 1n, final: 1n, txids: [], status: "confirmed", created_at: T0, detected_at: T0, confirmed_at: T0, credited_minor: 1n, credit_price_e8: 10n ** 8n, unexpected: null,
    });
    await e.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES('doge',31)").run();
    const id = await batch("doge:doge", [5_000_000_000n]);
    const r = await run(id);
    expect(r.status).toBe("sent");
    expect(sent).toHaveLength(1);
    const t = Transaction.fromRaw(hexToBytes(sent[0]!));
    expect(t.inputsLength).toBe(1);
    expect(t.outputsLength).toBe(1);
    expect(scriptAddress("doge", t.getOutput(0).script!)).toBe(DEP);
    const leg = (await legsOf(id))[0]!;
    expect(leg).toMatchObject({ step: "sent", feeRate: DOGE_FEE_RATE.toString() });
    expect(BigInt(leg.fee!)).toBe(5_000_000_000n - BigInt(leg.amount));
    expect(BigInt(leg.fee!) / BigInt(t.vsize)).toBeGreaterThanOrEqual(DOGE_FEE_RATE);
    expect(sim.tradeCalls[0]!.get("refund")).toBe(dogeAddr(leg.refundIndex!));
    expect(await routedAt("pay_doge")).toBe(T0);
    // Settling reads blockbook's tx status: known, unconfirmed, inside the window: the same bytes again.
    expect((await run(id, 0, T0 + MIN)).status).toBe("waiting");
    expect(sent).toEqual([sent[0], sent[0]]);
  });
});

// ---- fix round 2: own addresses ------------------------------------------------------------------------------------

describe("own change/refund addresses never starve", () => {
  const fund = (address: string, value = 400_000) => {
    sim.utxos[address] = [{ txid: bytesToHex(sha256(new TextEncoder().encode(`own:${address}`))), vout: 0, value, confirmed: true }];
  };
  const offered = (groups: Awaited<ReturnType<typeof routableInputs>>, address: string) => groups.some((g) => g.some((i) => i.address === address));
  const ownRow = (address: string) => e.DB.prepare("SELECT * FROM own_addresses WHERE address=?").bind(address).first<{ checked_at: number | null; last_seen_funded_at: number | null; purpose: string }>();

  it("an old funded change address behind many newer empty refund addresses is found within ceil(total / N) runs, then stays offered", async () => {
    const change = await allocateOwnAddress(e, "btc", "change", T0 - 24 * HOUR);
    // It was checked once while still empty; its funds arrived later.
    await e.DB.prepare("UPDATE own_addresses SET checked_at=? WHERE address=?").bind(T0 - HOUR, change.address).run();
    fund(change.address);
    const refunds = 25;
    for (let i = 0; i < refunds; i++) await allocateOwnAddress(e, "btc", "refund", T0 - HOUR + i);
    const runs = Math.ceil((refunds + 1) / OWN_CHECKS_PER_RUN);
    let foundAt = -1;
    for (let k = 1; k <= runs && foundAt < 0; k++) if (offered(await routableInputs(e, "btc", { now: T0 + k * MIN }), change.address)) foundAt = k;
    expect(foundAt).toBe(runs);
    expect(await ownRow(change.address)).toMatchObject({ checked_at: T0 + runs * MIN, last_seen_funded_at: T0 + runs * MIN });
    // Funded at its last check: first in line next run.
    expect(offered(await routableInputs(e, "btc", { now: T0 + (runs + 1) * MIN }), change.address)).toBe(true);
  });

  it("empty refund addresses do not block funded ones: funded ones keep their slots while the empty ones rotate", async () => {
    const funded: string[] = [];
    for (let i = 0; i < 14; i++) await allocateOwnAddress(e, "btc", "refund", T0 - 2 * HOUR + i);
    for (let i = 0; i < 3; i++) {
      const a = await allocateOwnAddress(e, "btc", "refund", T0 - HOUR + i);
      fund(a.address, 100_000 + i);
      funded.push(a.address);
    }
    // 17 addresses, 10 per run: all funded ones found by the second run, and offered every run after.
    const seen = new Set<string>();
    for (let k = 1; k <= 2; k++) for (const g of await routableInputs(e, "btc", { now: T0 + k * MIN })) seen.add(g[0]!.address);
    expect([...seen].sort()).toEqual([...funded].sort());
    for (let k = 3; k <= 5; k++) {
      const groups = await routableInputs(e, "btc", { now: T0 + k * MIN });
      for (const a of funded) expect(offered(groups, a)).toBe(true);
    }
    // And the empty ones keep being checked (the cursor moves): every row has been checked by now.
    const unchecked = await e.DB.prepare("SELECT COUNT(*) AS n FROM own_addresses WHERE checked_at IS NULL").first<{ n: number }>();
    expect(unchecked!.n).toBe(0);
  });

  it("funded own addresses count towards a leg's inputs (available includes them)", async () => {
    const change = await allocateOwnAddress(e, "btc", "change", T0 - HOUR);
    fund(change.address, 600_000);
    const id = await batch("btc:btc", [500_000n]);
    expect((await run(id)).status).toBe("sent");
    const leg = (await legsOf(id))[0]!;
    expect(leg.inputs!.map((i) => i.address)).toEqual([change.address]);
    expect(leg.inputs![0]!.paymentId).toBeUndefined();
    // The refund and the new change are recorded own addresses, with their purpose.
    expect(await ownRow(leg.refundAddress!)).toMatchObject({ purpose: "refund" });
    expect(await ownRow(leg.change!.address)).toMatchObject({ purpose: "change" });
  });

  it("the index allocation and the own_addresses row are one transaction", async () => {
    const before = await e.DB.prepare("SELECT next FROM derivation_counters WHERE chain='btc'").first<{ next: number }>();
    expect(before).toBeNull();
    const a = await allocateOwnAddress(e, "btc", "change", T0);
    expect(a.index).toBe(0);
    expect((await e.DB.prepare("SELECT next FROM derivation_counters WHERE chain='btc'").first<{ next: number }>())!.next).toBe(1);
    expect(await ownRow(a.address)).toMatchObject({ purpose: "change" });
    // The row cannot be written (the next address is already recorded, under another index): the counter does not move.
    await e.DB.prepare("INSERT INTO own_addresses(chain,address,derivation_index,purpose,created_at) VALUES('btc',?,999,'refund',?)").bind(btcAddr(1), T0).run();
    await expect(allocateOwnAddress(e, "btc", "refund", T0)).rejects.toThrow();
    expect((await e.DB.prepare("SELECT next FROM derivation_counters WHERE chain='btc'").first<{ next: number }>())!.next).toBe(1);
    // An index an invoice took is never recorded as ours: the next free one is.
    await e.DB.prepare("DELETE FROM own_addresses WHERE derivation_index=999").run();
    const { allocateIndex } = await import("../../src/db/repo");
    expect(await allocateIndex(e.DB, "btc")).toBe(1);
    const b = await allocateOwnAddress(e, "btc", "refund", T0);
    expect(b.index).toBe(2);
    expect(await e.DB.prepare("SELECT derivation_index AS i FROM own_addresses ORDER BY i").all<{ i: number }>().then((r) => r.results.map((x) => x.i))).toEqual([0, 2]);
  });
});

describe("stale quote claim", () => {
  it("a `quote` leg from a run that died is abandoned after CLAIM_STALE_MS and the chunk gets a fresh leg", async () => {
    await btcPayment(20, [500_000]);
    const quote: SwapLeg = { chunk: 0, step: "quote", amount: "490000", createdAt: T0, updatedAt: T0 };
    const id = await batch("btc:btc", [500_000n], { legs: [quote] });
    expect(await run(id, 0, T0 + MIN)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/another run is creating/) });
    expect(sim.tradeCalls).toHaveLength(0);
    expect((await run(id, 0, T0 + CLAIM_STALE_MS + 1)).status).toBe("sent");
    const legs = await legsOf(id);
    expect(legs.map((l) => l.step)).toEqual(["abandoned", "sent"]);
    expect(legs[0]!.reason).toMatch(/did not finish/);
    expect(sim.tradeCalls).toHaveLength(1);
  });
});

describe("refund addresses across retries", () => {
  it("every retry of a chunk reuses the refund address its first attempt allocated (one own address, not one per attempt)", async () => {
    await btcPayment(20, [500_000]);
    const id = await batch("btc:btc", [400_000n]);
    let fails = 2;
    network.use(http.get(`${TROC}/new_trade`, () => (fails-- > 0 ? new HttpResponse("upstream", { status: 500 }) : undefined)));
    expect((await run(id)).status).toBe("skipped");
    expect((await run(id)).status).toBe("skipped");
    expect((await run(id)).status).toBe("sent");
    const legs = await legsOf(id);
    expect(legs.map((l) => l.step)).toEqual(["abandoned", "abandoned", "sent"]);
    const refunds = (await e.DB.prepare("SELECT address, derivation_index FROM own_addresses WHERE purpose='refund'").all<{ address: string; derivation_index: number }>()).results;
    expect(refunds).toHaveLength(1);
    expect(legs.map((l) => l.refundAddress)).toEqual([refunds[0]!.address, refunds[0]!.address, refunds[0]!.address]);
    expect(legs.map((l) => l.refundIndex)).toEqual([refunds[0]!.derivation_index, refunds[0]!.derivation_index, refunds[0]!.derivation_index]);
    expect(sim.tradeCalls.at(-1)!.get("refund")).toBe(refunds[0]!.address);
  });
});
