import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountFromSeed, deriveUtxoAddress } from "../../src/chains/utxo/derive";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { parseLegs, type SwapLeg } from "../../src/routing/legs";
import { markResolved, NO_EXPIRY_RELEASE_MS, releasable, releaseLeg, resumeBatch, stuckReason } from "../../src/routing/operator";
import { acquireRouterLock, releaseRouterLock } from "../../src/routing/router";
import { MAX_ABANDONS, reservedOutpoints } from "../../src/routing/swap";
import { offline } from "../offline";

const e = env as unknown as Env;
const T0 = 1_900_000_000_000;
const HOUR = 3_600_000;
const ESP = "https://mempool.space/api";
const XMR_A = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const addr = (i: number) => deriveUtxoAddress(accountFromSeed(e.MASTER_SEED!, "btc"), "btc", i);
const TXID = "aa".repeat(32);
const IN = { txid: "11".repeat(32), vout: 0, value: "500000", index: 5, address: addr(5), paymentId: "pay_o1" };

let explorer: { known: Set<string>; utxos: Record<string, { txid: string; vout: number; value: number }[]>; down?: boolean };
let seq = 0;
const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await insertInvoice(e.DB, {
    id: "inv_o", created_at: T0, expires_at: T0 + HOUR, price_minor: 1n, currency: "USD", order_id: null, metadata: null, success_url: null, allowed_assets: null,
    status: "paid", late: false, overpaid: false, paid_minor: 1n,
  });
  const p: PaymentRow = {
    id: "pay_o1", invoice_id: "inv_o", asset: "btc:btc", chain: "btc", address: addr(5), derivation_index: 5, reference: null, expected: 1n, price_e8: 1n, rate_locked_until: 0,
    received: 500_000n, final: 500_000n, txids: [], status: "confirmed", created_at: T0, detected_at: T0, confirmed_at: T0, credited_minor: 1n, credit_price_e8: 1n, unexpected: null,
  };
  await insertPayment(e.DB, p);
});
afterAll(() => network.disable());
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  for (const t of ["route_batches", "router_lock", "routing_actions"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  await e.DB.prepare("UPDATE payments SET routed_at=? WHERE id='pay_o1'").bind(T0).run();
  explorer = { known: new Set(), utxos: { [addr(5)]: [{ txid: IN.txid, vout: 0, value: 500_000 }] } };
  network.use(
    http.get(`${ESP}/tx/:txid/status`, ({ params }) => explorer.down ? new HttpResponse("upstream", { status: 502 }) : (explorer.known.has(params.txid as string) ? HttpResponse.json({ confirmed: false }) : new HttpResponse("Transaction not found", { status: 404 }))),
    http.get(`${ESP}/address/:a/utxo`, ({ params }) =>
      explorer.down ? new HttpResponse("upstream", { status: 502 }) : HttpResponse.json((explorer.utxos[params.a as string] ?? []).map((u) => ({ ...u, status: { confirmed: true, block_height: 800_000, block_time: 1 } }))),
    ),
    http.get("https://blockstream.info/api/*", () => new HttpResponse("upstream", { status: 502 })),
    ...offline(),
  );
});

const leg = (chunk: number, step: SwapLeg["step"], extra: Partial<SwapLeg> = {}): SwapLeg => ({ chunk, step, amount: "490000", createdAt: T0, updatedAt: T0, ...extra });
const stuckUtxoLeg = (extra: Partial<SwapLeg> = {}) => leg(0, "sending", { tradeId: "TR1", depositAddress: "bc1qdeposit", expiresAt: T0 + HOUR, inputs: [IN], tx: TXID, raw: "00", claim: "c", claimedAt: T0, ...extra });

async function batch(o: { asset?: string; status?: string; legs?: SwapLeg[]; stuckAt?: number; updatedAt?: number } = {}): Promise<string> {
  const id = `rb_o${seq++}`;
  await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs,stuck_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, o.asset ?? "btc:btc", "490000", JSON.stringify(["490000"]), XMR_A, T0, o.status ?? "executing", T0, o.updatedAt ?? T0, JSON.stringify(o.legs ?? []), o.stuckAt ?? null)
    .run();
  return id;
}
type Row = { status: string; legs: string; resolved_at: number | null; progress: string; stuck_at: number | null; updated_at: number } & Record<string, unknown>;
const row = async (id: string) => (await e.DB.prepare("SELECT * FROM route_batches WHERE id=?").bind(id).first<Row>())!;
const audit = async () => (await e.DB.prepare("SELECT action, batch_id, leg, detail FROM routing_actions ORDER BY created_at").all<{ action: string; batch_id: string; leg: number | null; detail: string }>()).results;
const routedAt = async () => (await e.DB.prepare("SELECT routed_at FROM payments WHERE id='pay_o1'").first<{ routed_at: number | null }>())!.routed_at;

/** An env whose DB runs `tamper` right before every batch() (another writer between our read and our write). */
function racing(tamper: () => Promise<unknown>): Env {
  const db = new Proxy(e.DB, {
    get(t, k) {
      if (k === "batch") return async (s: D1PreparedStatement[]) => (await tamper(), t.batch(s));
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...e, DB: db } as Env;
}

describe("mark resolved", () => {
  it("a failed batch becomes resolved (nothing on chain), audited", async () => {
    const id = await batch({ status: "failed" });
    const r = await markResolved(e, id, T0 + HOUR);
    expect(r).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ status: "resolved", resolved_at: T0 + HOUR });
    expect(await audit()).toEqual([{ action: "resolve", batch_id: id, leg: null, detail: "resolved by the operator from failed" }]);
  });

  it("an executing batch only when stuck (stuck_at, a stuck leg, a closed window with a signed tx, the backoff, or 24 h idle)", async () => {
    const healthy = await batch({ legs: [leg(0, "sent", { tx: "t" })] });
    expect(await markResolved(e, healthy, T0 + HOUR)).toMatchObject({ ok: false, code: 409 });
    expect((await row(healthy)).status).toBe("executing");
    const cases = [
      await batch({ stuckAt: T0 }),
      await batch({ legs: [leg(0, "sent", { tx: "t", stuckAt: T0 })] }),
      await batch({ legs: [stuckUtxoLeg()] }),
      await batch({ legs: Array.from({ length: MAX_ABANDONS }, () => leg(0, "abandoned")) }),
      await batch({ updatedAt: T0 - 25 * HOUR }),
    ];
    for (const id of cases) expect(stuckReason(await row(id) as never, T0 + HOUR), id).not.toBeNull();
    for (const id of cases) expect(await markResolved(e, id, T0 + HOUR), id).toMatchObject({ ok: true });
    for (const s of ["completed", "scheduled", "resolved"]) expect(await markResolved(e, await batch({ status: s }), T0), s).toMatchObject({ ok: false, code: 409 });
    expect(await markResolved(e, "rb_nope", T0)).toMatchObject({ ok: false, code: 404 });
  });

  it("compare-and-set: a batch that changed after the check is not resolved, and nothing is audited", async () => {
    const id = await batch({ status: "failed" });
    const env2 = racing(() => e.DB.prepare("UPDATE route_batches SET legs=? WHERE id=?").bind(JSON.stringify([leg(0, "failed")]), id).run());
    expect(await markResolved(env2, id, T0 + HOUR)).toMatchObject({ ok: false, code: 409 });
    expect((await row(id)).status).toBe("failed");
    expect(await audit()).toEqual([]);
  });

  it("refused while the router (or another action) holds the lease", async () => {
    const id = await batch({ status: "failed" });
    expect(await acquireRouterLock(e.DB, "router", T0)).toBe(true);
    expect(await markResolved(e, id, T0 + 1)).toMatchObject({ ok: false, code: 409, reason: expect.stringMatching(/router/) });
    await releaseRouterLock(e.DB, "router");
    expect(await markResolved(e, id, T0 + 2)).toMatchObject({ ok: true });
  });
});

describe("release stuck UTXO leg", () => {
  it("expired trade + tx unknown + inputs unspent: the leg is abandoned, inputs freed, routed_at cleared, audited", async () => {
    const id = await batch({ legs: [stuckUtxoLeg()] });
    expect((await reservedOutpoints(e.DB, "btc:btc")).has(`${IN.txid}:0`)).toBe(true);
    const r = await releaseLeg(e, id, 0, T0 + HOUR);
    expect(r).toMatchObject({ ok: true });
    const [l] = parseLegs((await row(id)).legs);
    expect(l).toMatchObject({ step: "abandoned", releasedTx: TXID, tradeId: "TR1" });
    expect(l!.tx).toBeUndefined();
    expect(l!.raw).toBeUndefined();
    expect((await reservedOutpoints(e.DB, "btc:btc")).has(`${IN.txid}:0`)).toBe(false);
    expect(await routedAt()).toBeNull();
    expect(await audit()).toMatchObject([{ action: "release", batch_id: id, leg: 0 }]);
  });

  it("the same recovery for a sent or failed leg whose tx never landed (routed_at set)", async () => {
    for (const step of ["sent", "failed"] as const) {
      await e.DB.prepare("UPDATE payments SET routed_at=? WHERE id='pay_o1'").bind(T0).run();
      const id = await batch({ status: step === "failed" ? "failed" : "executing", legs: [stuckUtxoLeg({ step, claim: undefined, claimedAt: undefined })] });
      expect(await releaseLeg(e, id, 0, T0 + HOUR), step).toMatchObject({ ok: true });
      expect(await routedAt()).toBeNull();
      expect((await row(id)).status).toBe(step === "failed" ? "failed" : "executing");
    }
  });

  it("preconditions: trade not expired, tx known to the explorer, an input spent, no tx, a finished leg, not UTXO", async () => {
    const check = async (legs: SwapLeg[], now: number, why: RegExp, asset = "btc:btc") => {
      const id = await batch({ legs, asset });
      expect(await releaseLeg(e, id, 0, now)).toMatchObject({ ok: false, code: 409, reason: expect.stringMatching(why) });
      expect(parseLegs((await row(id)).legs)).toEqual(legs);
    };
    await check([stuckUtxoLeg()], T0 + HOUR - 1, /not expired/);
    await check([stuckUtxoLeg({ expiresAt: undefined })], T0 + NO_EXPIRY_RELEASE_MS - 1, /not expired/);
    explorer.known.add(TXID);
    await check([stuckUtxoLeg()], T0 + HOUR, /explorer knows/);
    explorer.known.clear();
    explorer.utxos[addr(5)] = [];
    await check([stuckUtxoLeg()], T0 + HOUR, /is spent/);
    explorer.utxos[addr(5)] = [{ txid: IN.txid, vout: 0, value: 500_000 }];
    await check([stuckUtxoLeg({ tx: undefined })], T0 + HOUR, /signed tx/);
    await check([stuckUtxoLeg({ step: "finished" })], T0 + HOUR, /signed tx/);
    await check([stuckUtxoLeg()], T0 + HOUR, /only UTXO/, "sol:sol");
    expect(await releaseLeg(e, await batch({ legs: [stuckUtxoLeg()] }), 3, T0 + HOUR)).toMatchObject({ ok: false, code: 404 });
    expect(await routedAt()).toBe(T0);
    expect(await audit()).toEqual([]);
  });

  it("an explorer that cannot be read gives a 409 with the reason, not an exception", async () => {
    const id = await batch({ legs: [stuckUtxoLeg()] });
    explorer.down = true;
    expect(await releaseLeg(e, id, 0, T0 + HOUR)).toMatchObject({ ok: false, code: 409, reason: expect.stringMatching(/explorer could not be read/) });
    expect(parseLegs((await row(id)).legs)[0]!.step).toBe("sending");
    expect(await e.DB.prepare("SELECT holder FROM router_lock").first()).toEqual({ holder: null });
  });

  it("the stuck flag and the release button use the release preconditions' time rule", async () => {
    const b = async (l: SwapLeg, now: number) => ({ ...(await row(await batch({ legs: [l], updatedAt: now }))) }) as never;
    // Window closing but the trade not expired yet: not stuck, not releasable.
    expect(stuckReason(await b(stuckUtxoLeg(), T0 + HOUR - 5 * 60_000), T0 + HOUR - 5 * 60_000)).toBeNull();
    expect(releasable("btc:btc", stuckUtxoLeg(), T0 + HOUR - 1)).toBe(false);
    expect(stuckReason(await b(stuckUtxoLeg(), T0 + HOUR), T0 + HOUR)).toMatch(/release/);
    expect(releasable("btc:btc", stuckUtxoLeg(), T0 + HOUR)).toBe(true);
    // No expiry from Trocador: stuck (and releasable) 24 h after the leg was created.
    const noExp = stuckUtxoLeg({ expiresAt: undefined });
    expect(stuckReason(await b(noExp, T0 + NO_EXPIRY_RELEASE_MS - 1), T0 + NO_EXPIRY_RELEASE_MS - 1)).toBeNull();
    expect(stuckReason(await b(noExp, T0 + NO_EXPIRY_RELEASE_MS), T0 + NO_EXPIRY_RELEASE_MS)).toMatch(/release/);
    // Never for a finished leg, a leg without a tx, or a hot-pooled chain.
    expect(releasable("btc:btc", stuckUtxoLeg({ step: "finished" }), T0 + 2 * HOUR)).toBe(false);
    expect(releasable("btc:btc", stuckUtxoLeg({ tx: undefined }), T0 + 2 * HOUR)).toBe(false);
    expect(releasable("sol:sol", stuckUtxoLeg(), T0 + 2 * HOUR)).toBe(false);
  });

  it("release and resume are refused while the router holds the lease", async () => {
    const id = await batch({ legs: [stuckUtxoLeg()] });
    const worn = await batch({ legs: Array.from({ length: MAX_ABANDONS }, () => leg(0, "abandoned")) });
    expect(await acquireRouterLock(e.DB, "router", T0)).toBe(true);
    expect(await releaseLeg(e, id, 0, T0 + 1)).toMatchObject({ ok: false, code: 409, reason: expect.stringMatching(/router/) });
    expect(await resumeBatch(e, worn, T0 + 1)).toMatchObject({ ok: false, code: 409, reason: expect.stringMatching(/router/) });
    expect(parseLegs((await row(id)).legs)[0]!.step).toBe("sending");
    expect(await audit()).toEqual([]);
    await releaseRouterLock(e.DB, "router");
  });

  it("compare-and-set: a leg that changed after the checks is not released", async () => {
    const id = await batch({ legs: [stuckUtxoLeg()] });
    const env2 = racing(() => e.DB.prepare("UPDATE route_batches SET legs=? WHERE id=?").bind(JSON.stringify([stuckUtxoLeg({ step: "sent" })]), id).run());
    expect(await releaseLeg(env2, id, 0, T0 + HOUR)).toMatchObject({ ok: false, code: 409 });
    expect(parseLegs((await row(id)).legs)[0]!.step).toBe("sent");
    expect(await routedAt()).toBe(T0);
    expect(await audit()).toEqual([]);
  });
});

describe("resume batch", () => {
  const worn = () => [...Array.from({ length: MAX_ABANDONS }, () => leg(0, "abandoned", { reason: "trade failed" })), leg(1, "traded", { inputs: [IN] }), leg(2, "sent", { tx: "t2" })];

  it("clears the backoff: abandoned legs are marked resumed, unsent legs re-planned (their inputs freed), sent legs kept", async () => {
    const id = await batch({ legs: worn() });
    expect((await reservedOutpoints(e.DB, "btc:btc")).has(`${IN.txid}:0`)).toBe(true);
    expect(await resumeBatch(e, id, T0 + HOUR)).toMatchObject({ ok: true });
    const legs = parseLegs((await row(id)).legs);
    expect(legs.slice(0, MAX_ABANDONS).every((l) => l.step === "abandoned" && l.resumed)).toBe(true);
    expect(legs[MAX_ABANDONS]).toMatchObject({ chunk: 1, step: "abandoned", resumed: true });
    expect(legs[MAX_ABANDONS + 1]).toEqual(worn()[MAX_ABANDONS + 1]);
    expect((await row(id)).status).toBe("executing");
    expect((await reservedOutpoints(e.DB, "btc:btc")).has(`${IN.txid}:0`)).toBe(false);
    expect(await audit()).toMatchObject([{ action: "resume", batch_id: id }]);
    // No longer stopped: resuming again is refused.
    expect(await resumeBatch(e, id, T0 + 2 * HOUR)).toMatchObject({ ok: false, code: 409 });
  });

  it("preconditions and compare-and-set", async () => {
    expect(await resumeBatch(e, await batch({ legs: [leg(0, "abandoned"), leg(0, "abandoned")] }), T0)).toMatchObject({ ok: false, code: 409 });
    expect(await resumeBatch(e, await batch({ status: "failed", legs: worn() }), T0)).toMatchObject({ ok: false, code: 409 });
    const id = await batch({ legs: worn() });
    const env2 = racing(() => e.DB.prepare("UPDATE route_batches SET legs=? WHERE id=?").bind(JSON.stringify([...worn(), leg(0, "quote")]), id).run());
    expect(await resumeBatch(env2, id, T0)).toMatchObject({ ok: false, code: 409 });
    expect(parseLegs((await row(id)).legs).some((l) => l.resumed)).toBe(false);
    expect(await audit()).toEqual([]);
  });
});
