/** Sweep rows (the `sweeps` table) and the payment "sweep lock" (`payments.sweep_tx`). */

import type { Env } from "../env";
import { recordAlert } from "./alerts";

/** Consecutive failed sweeps on a chain before sweep.failing is raised. */
const FAILING_STREAK = 3;

/** After a failure: three failed sweeps in a row on the chain raise sweep.failing (EVM and Tron sweepers). */
export async function checkFailing(env: Env, chain: string, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT status FROM sweeps WHERE chain=? ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(chain, FAILING_STREAK).all<{ status: string }>();
  if (results.length === FAILING_STREAK && results.every((r) => r.status === "failed"))
    await recordAlert(env.DB, "sweep.failing", chain, `the last ${FAILING_STREAK} sweeps on ${chain} failed`, now);
}

/** A pending sweep older than this has had its replacement window and shows on the dashboard. */
export const STUCK_AFTER_MS = 3_600_000;

/**
 * Releases the lock of payments whose sweep never reached the chain: clears `sweep_tx` only where it still equals one
 * of the sweep's tx hashes (a newer sweep's lock is left alone) and only for payments not yet marked swept.
 */
export async function clearSweepLock(db: D1Database, paymentIds: string[], hashes: string[]): Promise<void> {
  if (paymentIds.length === 0 || hashes.length === 0) return;
  const marks = hashes.map(() => "?").join(",");
  await db.batch(
    paymentIds.map((id) => db.prepare(`UPDATE payments SET sweep_tx=NULL WHERE id=? AND swept_at IS NULL AND sweep_tx IN (${marks})`).bind(id, ...hashes)),
  );
}

/** Replacements per sweep: each one raises the fees by 30%, so they are bounded. */
export const MAX_REPLACEMENTS = 3;

export interface StuckSweep {
  id: string;
  chain: string;
  /** Every tx hash broadcast for the sweep. */
  txs: string[];
  /** When the latest of them was broadcast. */
  lastBroadcast: number;
}

type PendingRow = { id: string; chain: string; tx: string | null; txs: string | null; req: string | null; created_at: number; payment_ids: string };
const toStuck = (r: PendingRow): StuckSweep => ({
  id: r.id,
  chain: r.chain,
  txs: r.txs ? (JSON.parse(r.txs) as string[]) : r.tx ? [r.tx] : [],
  lastBroadcast: r.req ? ((JSON.parse(r.req) as { at?: number }).at ?? r.created_at) : r.created_at,
});
/** Stuck = the last broadcast was an hour ago or more, or the replacement cap is reached (more fee bumps will not come). */
const isStuck = (w: StuckSweep, now: number) => w.lastBroadcast <= now - STUCK_AFTER_MS || w.txs.length - 1 >= MAX_REPLACEMENTS;

export async function listStuckSweeps(db: D1Database, now: number): Promise<StuckSweep[]> {
  const { results } = await db.prepare("SELECT id,chain,tx,txs,req,created_at,payment_ids FROM sweeps WHERE status='pending' ORDER BY created_at").all<PendingRow>();
  return results.map(toStuck).filter((w) => isStuck(w, now));
}

/**
 * Admin action: marks a stuck pending sweep failed, which unblocks the chain. The payments' lock (`sweep_tx`) is left
 * alone on purpose: one of the txs may still mine, and the next send overwrites the lock anyway.
 */
export async function failStuckSweep(db: D1Database, id: string, now: number): Promise<"failed" | "not_found" | "not_stuck"> {
  const row = await db.prepare("SELECT id,chain,tx,txs,req,created_at,payment_ids,status FROM sweeps WHERE id=?").bind(id).first<PendingRow & { status: string }>();
  if (!row) return "not_found";
  if (row.status !== "pending" || !isStuck(toStuck(row), now)) return "not_stuck";
  const r = await db.prepare("UPDATE sweeps SET status='failed', error='marked failed by an admin' WHERE id=? AND status='pending'").bind(id).run();
  return (r.meta.changes ?? 0) === 0 ? "not_stuck" : "failed";
}
