import type { UtxoChain } from "../chains/utxo/networks";
import { dueSql, SWEEP_AFTER_EXPIRY_MS } from "../db/repo";

/*
 * UTXO routing sources: the payments whose deposit outputs a route leg may spend (migration 0016). They are picked
 * the way own_addresses are (src/routing/own.ts): per call at most PAYMENT_CHECKS_PER_RUN, of which up to
 * PAYMENT_FUNDED_SLOTS go to sources funded at their last check (oldest check first), the rest a rotating cursor by
 * oldest route_checked_at (never checked first, then oldest confirmation). Every check stamps route_checked_at (and
 * route_funded_at when spendable outputs were there), so every source is checked within
 * ceil(count / (PAYMENT_CHECKS_PER_RUN - funded slots in use)) calls, whatever its age.
 *
 * A candidate is a payment of the chain's coin, not routed (routed_at NULL), not refunded, and due as for a sweep
 * (dueSql: confirmed; partial or expired with deposits once its invoice expired SWEEP_AFTER_EXPIRY_MS ago).
 *
 * Configuration never retires anything: with an xpub set the chain's sources are not read at all (routableInputs
 * returns nothing, writes nothing), and a source whose address does not derive from MASTER_SEED is skipped (stamped,
 * with a deduped routing.config_error alert): fixing the seed brings it back by itself.
 *
 * Retirement (permanent, idempotent, audited) needs evidence: two reads of the deposit, at least
 * RETIRE_CONFIRM_MS apart, both more than RETIRE_EMPTY_AFTER_MS after the source became due, that found no output at
 * all (confirmed or not). The first sets route_empty_at; any output clears it. Then routed_at is set with route_note,
 * a routing_actions row (action source_retire) is written only by the update that set it, and a deduped
 * routing.source_retired alert gives the count. Funds that reach a retired address later are not routed (the
 * operator can clear routed_at and route_note by hand; the note says why it was set).
 */

/** A source empty this long after it became due may be retired... */
export const RETIRE_EMPTY_AFTER_MS = 7 * 86_400_000;
/** ...once a second empty read at least this long after the first confirms it. */
export const RETIRE_CONFIRM_MS = 86_400_000;

export interface PaymentSource {
  id: string;
  address: string;
  index: number;
  /** When it became due: its confirmation (or sweep), or for partial/expired its invoice expiry + SWEEP_AFTER_EXPIRY_MS. */
  dueAt: number;
  /** The first of the current run of empty reads (route_empty_at), or null. */
  emptyAt: number | null;
}

type Row = { id: string; address: string; derivation_index: number; due_at: number; route_empty_at: number | null };

const SELECT = `SELECT p.id, p.address, p.derivation_index, p.route_empty_at,
       CASE WHEN p.status='confirmed' THEN COALESCE(p.swept_at, p.confirmed_at, p.created_at) ELSE i.expires_at+?4 END AS due_at
     FROM payments p JOIN invoices i ON i.id=p.invoice_id
     WHERE p.chain=?1 AND p.asset=?2 AND p.routed_at IS NULL AND p.refunded_at IS NULL AND ${dueSql("?3", "?4")}`;

/** The payment sources of `chain` to check now: funded-at-last-check slots first, then the rotating cursor. */
export async function paymentSourcesToCheck(db: D1Database, chain: UtxoChain, now: number, n: number, fundedSlots: number): Promise<PaymentSource[]> {
  const asset = `${chain}:${chain}`;
  const funded = (
    await db
      .prepare(`${SELECT} AND p.route_funded_at IS NOT NULL AND p.route_funded_at=p.route_checked_at ORDER BY p.route_checked_at, p.id LIMIT ?5`)
      .bind(chain, asset, now, SWEEP_AFTER_EXPIRY_MS, Math.min(fundedSlots, n))
      .all<Row>()
  ).results;
  const rest = (
    await db
      .prepare(`${SELECT} AND p.id NOT IN (SELECT value FROM json_each(?5)) ORDER BY COALESCE(p.route_checked_at, -1), COALESCE(p.confirmed_at, p.created_at), p.id LIMIT ?6`)
      .bind(chain, asset, now, SWEEP_AFTER_EXPIRY_MS, JSON.stringify(funded.map((f) => f.id)), n - funded.length)
      .all<Row>()
  ).results;
  return [...funded, ...rest].map((r) => ({ id: r.id, address: r.address, index: r.derivation_index, dueAt: r.due_at, emptyAt: r.route_empty_at }));
}

/**
 * Records a check: route_checked_at = now, route_funded_at = now when spendable outputs were found, and route_empty_at:
 * `empty` "start" keeps it (or sets it to now), "keep" leaves it, "clear" (outputs seen) clears it.
 */
export function markSourceChecked(db: D1Database, id: string, funded: boolean, now: number, empty: "start" | "keep" | "clear" = "keep"): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE payments SET route_checked_at=?1, route_funded_at=CASE WHEN ?2 THEN ?1 ELSE route_funded_at END,
       route_empty_at=CASE ?4 WHEN 'start' THEN COALESCE(route_empty_at, ?1) WHEN 'clear' THEN NULL ELSE route_empty_at END WHERE id=?3`,
    )
    .bind(now, funded ? 1 : 0, id, empty);
}

/** Retires a source (see the module comment): the update, and its audit row only if the update applied. */
export function retireSource(db: D1Database, id: string, note: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE payments SET routed_at=?1, route_note=?2, route_checked_at=?1 WHERE id=?3 AND routed_at IS NULL AND refunded_at IS NULL").bind(now, `retired: ${note}`, id),
    db
      .prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) SELECT ?1,?2,'source_retire',NULL,NULL,NULL,?3 WHERE changes()=1")
      .bind(`act_${crypto.randomUUID().replaceAll("-", "")}`, now, `payment ${id} retired from routing: ${note}`),
  ];
}

export const RETIRE_EMPTY = "the deposit held no output on two reads 24 hours apart, both more than 7 days after it became due";
