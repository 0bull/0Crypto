import { utxoExplorer } from "../chains/registry";
import type { UtxoChain } from "../chains/utxo/networks";
import { getAsset } from "../core/assets";
import type { Env } from "../env";
import { MAX_ABANDONS, parseLegs, readBatch, updateLeg, wornChunk, type BatchRow, type SwapLeg } from "./legs";
import { acquireRouterLock, releaseRouterLock } from "./router";

export { wornChunk };

/*
 * Operator actions on route batches (the /admin/privacy dashboard, each behind CSRF and a passkey confirmation). Every
 * one holds the router lease while it runs (so no router run, refund or other action interleaves), is a compare-and-set
 * on the batch state it was checked against, and is written to routing_actions in the same transaction.
 *   resolve   a failed or stuck batch becomes `resolved` (terminal). Nothing is done on chain: the operator has looked
 *             at the chain (or the provider) and settled it by hand. Funds the batch had committed become available to
 *             new batches.
 *   release   a UTXO leg whose signed tx never landed: allowed only when the trade has expired, the explorer does not
 *             know the tx (txStatus), and every one of the leg's inputs is still an unspent output. The leg becomes
 *             `abandoned` (its tx kept as releasedTx), so its inputs are no longer reserved, and routed_at is cleared on
 *             the payments it spent: they are routed again. Also the recovery for routed_at set by a leg that never
 *             landed (a `sent` or `failed` leg passes the same checks).
 *   resume    a batch stopped by the MAX_ABANDONS backoff: its abandoned legs are marked `resumed` (they stop counting),
 *             and its legs without a tx that are not terminal are abandoned too, so their inputs are planned afresh.
 */

/** A trade with no expiry from Trocador counts as expired this long after its leg was created. */
export const NO_EXPIRY_RELEASE_MS = 24 * 3_600_000;
/** An executing batch with no change for this long is flagged stuck on the dashboard. */
export const IDLE_STUCK_MS = 24 * 3_600_000;

export type ActionResult = { ok: true; detail: string } | { ok: false; code: 404 | 409; reason: string };
const no = (code: 404 | 409, reason: string): ActionResult => ({ ok: false, code, reason });
const BUSY = "the router (or another operator action) is running: try again in a minute";

type Row = BatchRow & { progress: string; stuck_at: number | null };

const UTXO_CHAINS = new Set(["btc", "ltc", "doge"]);
/** The leg's trade has expired (no expiry from Trocador: NO_EXPIRY_RELEASE_MS after the leg was created). */
const tradeExpired = (leg: SwapLeg, now: number) => (leg.expiresAt !== undefined ? now >= leg.expiresAt : now >= leg.createdAt + NO_EXPIRY_RELEASE_MS);
/** The static half of "Release stuck UTXO leg" (the explorer half is checked when it runs). */
const releaseShape = (asset: string, leg: SwapLeg) => UTXO_CHAINS.has(asset.split(":")[0] ?? "") && !!leg.tx && (leg.step === "sending" || leg.step === "sent" || leg.step === "failed");
/**
 * Whether "Release stuck UTXO leg" may be offered now: a UTXO leg with a signed tx that did not finish, whose trade
 * has expired. The dashboard shows the button, and flags a `sending` leg stuck, on exactly this; releaseLeg then also
 * needs the explorer not to know the tx and every input to be unspent.
 */
export function releasable(asset: string, leg: SwapLeg, now: number): boolean {
  return releaseShape(asset, leg) && tradeExpired(leg, now);
}

/** Why the dashboard flags a batch as stuck, or null. */
export function stuckReason(b: Row, now: number): string | null {
  if (b.status !== "executing") return null;
  if (b.stuck_at !== null) return "routing.stuck was raised for this batch";
  const legs = parseLegs(b.legs);
  const live = legs.filter((l) => l.step !== "abandoned");
  if (live.some((l) => l.stuckAt !== undefined)) return "a leg was sent hours ago and its trade has not finished";
  if (live.some((l) => l.step === "sending" && releasable(b.asset, l, now))) return "a leg's tx was signed but never seen and its trade expired: check it, then release it";
  const worn = wornChunk(legs);
  if (worn !== undefined) return `chunk ${worn} was abandoned ${MAX_ABANDONS} times in a row`;
  if (now - b.updated_at > IDLE_STUCK_MS) return "no progress for over 24 hours";
  return null;
}

/** The audit row of an action, inserted only if the batch's legs are now `legs` (the compare-and-set it follows won). */
const auditStmt = (db: D1Database, now: number, action: string, batchId: string, leg: number | null, detail: string, legs: string) =>
  db
    .prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) SELECT ?,?,?,?,?,NULL,? WHERE EXISTS (SELECT 1 FROM route_batches WHERE id=? AND legs=? AND updated_at=?)")
    .bind(`act_${crypto.randomUUID().replaceAll("-", "")}`, now, action, batchId, leg, detail.slice(0, 500), batchId, legs, now);

/** Runs `f` holding the router lease (now = wall time), or BUSY. */
async function locked(env: Env, now: number, f: () => Promise<ActionResult>): Promise<ActionResult> {
  const holder = `op_${crypto.randomUUID()}`;
  if (!(await acquireRouterLock(env.DB, holder, now))) return no(409, BUSY);
  try {
    return await f();
  } finally {
    await releaseRouterLock(env.DB, holder);
  }
}

const readRow = (db: D1Database, id: string) => db.prepare("SELECT * FROM route_batches WHERE id=?").bind(id).first<Row>();

/** "Mark resolved": a failed batch, or an executing one that is stuck, becomes `resolved`. Nothing on chain. */
export async function markResolved(env: Env, batchId: string, now: number): Promise<ActionResult> {
  return locked(env, now, async () => {
    const b = await readRow(env.DB, batchId);
    if (!b) return no(404, "no such batch");
    const stuck = stuckReason(b, now);
    if (b.status !== "failed" && !stuck) return no(409, `only a failed or stuck batch can be marked resolved (this one is ${b.status})`);
    const detail = `resolved by the operator from ${b.status}${stuck ? ` (${stuck})` : ""}`;
    const [r] = await env.DB.batch([
      env.DB.prepare("UPDATE route_batches SET status='resolved', resolved_at=?, updated_at=? WHERE id=? AND status=? AND legs=? AND progress=? AND updated_at=?").bind(now, now, b.id, b.status, b.legs, b.progress, b.updated_at),
      auditStmt(env.DB, now, "resolve", b.id, null, detail, b.legs),
    ]);
    if ((r!.meta.changes ?? 0) !== 1) return no(409, "the batch changed while it was being resolved: reload and check it again");
    return { ok: true, detail };
  });
}

/** "Release stuck UTXO leg" (see the module comment). */
export async function releaseLeg(env: Env, batchId: string, idx: number, now: number): Promise<ActionResult> {
  return locked(env, now, async () => {
    const b = await readBatch(env.DB, batchId);
    if (!b) return no(404, "no such batch");
    const chain = getAsset(b.asset).chain;
    if (chain !== "btc" && chain !== "ltc" && chain !== "doge") return no(409, "only UTXO legs can be released");
    const legs = parseLegs(b.legs);
    const leg = legs[idx];
    if (!Number.isInteger(idx) || !leg) return no(404, "no such leg");
    if (!releaseShape(b.asset, leg)) return no(409, `only a leg with a signed tx that did not finish can be released (this one is ${leg.step}${leg.tx ? "" : ", no tx"})`);
    if (!releasable(b.asset, leg, now)) return no(409, "the leg's trade has not expired yet: it could still be paid");
    const inputs = leg.inputs ?? [];
    if (inputs.length === 0) return no(409, "the leg has no recorded inputs");
    const explorer = utxoExplorer(env, chain as UtxoChain);
    try {
      if ((await explorer.txStatus(leg.tx!)).known) return no(409, `the explorer knows tx ${leg.tx}: it may still confirm, so its inputs are not released`);
      for (const address of new Set(inputs.map((i) => i.address))) {
        const live = await explorer.utxos(address);
        for (const i of inputs.filter((x) => x.address === address))
          if (!live.some((u) => u.txid === i.txid && u.vout === i.vout && u.value === BigInt(i.value))) return no(409, `input ${i.txid}:${i.vout} is spent: the leg's tx (or another) used it`);
      }
    } catch (e) {
      return no(409, `the explorer could not be read (${e instanceof Error ? e.name : "Error"}): nothing was released; try again`);
    }
    const { tx, raw: _r, claim: _c, claimedAt: _a, ...rest } = leg;
    const next: SwapLeg = { ...rest, step: "abandoned", releasedTx: tx, reason: "released by the operator: the tx never landed, the trade expired, the inputs are unspent", updatedAt: now };
    const pids = [...new Set(inputs.flatMap((i) => (i.paymentId ? [i.paymentId] : [])))];
    const detail = `released leg ${idx} (chunk ${leg.chunk}, tx ${tx}, trade ${leg.tradeId ?? "?"}): ${inputs.length} input(s) unspent, routed_at cleared on ${pids.length} payment(s)`;
    const ok = await updateLeg(env.DB, b.id, idx, leg, next, {
      now,
      executing: false,
      also: (json) => [
        ...pids.map((id) => env.DB.prepare("UPDATE payments SET routed_at=NULL WHERE id=? AND EXISTS (SELECT 1 FROM route_batches WHERE id=? AND legs=?)").bind(id, b.id, json)),
        auditStmt(env.DB, now, "release", b.id, idx, detail, json),
      ],
    });
    return ok ? { ok: true, detail } : no(409, "the leg changed while it was being released: reload and check it again");
  });
}

const TERMINAL: ReadonlySet<SwapLeg["step"]> = new Set(["sent", "finished", "failed", "abandoned"]);

/** "Resume batch": clears the MAX_ABANDONS backoff of an executing batch; its legs without a tx are re-planned. */
export async function resumeBatch(env: Env, batchId: string, now: number): Promise<ActionResult> {
  return locked(env, now, async () => {
    const b = await readBatch(env.DB, batchId);
    if (!b) return no(404, "no such batch");
    if (b.status !== "executing") return no(409, `only an executing batch can be resumed (this one is ${b.status})`);
    const legs = parseLegs(b.legs);
    const worn = wornChunk(legs);
    if (worn === undefined) return no(409, `no chunk of this batch is stopped by the ${MAX_ABANDONS}-abandon backoff`);
    let replanned = 0;
    const next = legs.map((l): SwapLeg => {
      if (l.step === "abandoned") return l.resumed ? l : { ...l, resumed: true };
      if (TERMINAL.has(l.step) || l.tx) return l;
      replanned++;
      const { claim: _c, claimedAt: _a, ...rest } = l;
      return { ...rest, step: "abandoned", resumed: true, reason: "abandoned by the operator's resume: its inputs are planned again", updatedAt: now };
    });
    const json = JSON.stringify(next);
    const detail = `resumed (chunk ${worn} had ${MAX_ABANDONS} abandons; ${replanned} unsent leg(s) re-planned)`;
    const [r] = await env.DB.batch([
      env.DB.prepare("UPDATE route_batches SET legs=?, updated_at=? WHERE id=? AND status='executing' AND legs=?").bind(json, now, b.id, b.legs),
      auditStmt(env.DB, now, "resume", b.id, null, detail, json),
    ]);
    return (r!.meta.changes ?? 0) === 1 ? { ok: true, detail } : no(409, "the batch changed while it was being resumed: reload and check it again");
  });
}
