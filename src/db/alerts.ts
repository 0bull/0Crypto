/** Operator alerts (the `alerts` table). They show on the admin dashboard; sweep.insufficient_gas and refund.approved are also webhooks. */

/** sweep.tx_mismatch: a node built a tx that is not the one asked for (never signed). Its own kind, so an unrelated
 * sweep.failing alert can never dedupe a security signal away. */
/** routing.stuck: a routing tx is still unmined after every fee bump. routing.failing: a routing tx was dropped.
 * routing.over_cap: an asset's hot (or routable) value is at or over HOT_CAP_USD and routing cannot move it; its
 * `chain` column carries the asset id, so it is deduped per asset. routing.config_error: a ROUTE_* / HOT_CAP_USD var
 * is malformed (RouteConfigError; names the var, never its value), or (chain set) UTXO payment addresses do not derive
 * from MASTER_SEED. routing.source_retired: payment sources were retired after two empty reads 24 h apart (a count).
 * pos.lockout: more than 200 POS PIN attempts within an hour across all addresses; POS PIN login is locked for the hour.
 * links.budget: payment links asked for more than 40 invoices in one minute; link checkouts were refused until it ended.
 * subscription.invalid: a subscription row could not be billed (corrupt or no longer valid) and was deactivated.
 * lightning.config_error: the NWC connection does not allow make_invoice and lookup_invoice (Lightning is off).
 * lightning.spend_permission: the NWC connection also allows payments; replace it with a receive-only one.
 * admin.recovered: the admin was recovered with a recovery code from the Worker logs (passkeys replaced).
 * setup.abuse: more than 100 wrong setup or recovery codes within an hour across all addresses. Alert only: it never
 * blocks the owner (the per-address limit is what stops guessing).
 * webhook.dead: webhook events failed every delivery attempt and reached the dead-letter queue (a count and the last event id).
 * refund.approved: a dashboard refund was approved or re-approved (src/routing/refund-alert.ts), recorded before anything
 * is sent; every one (no dedupe), and a refund.approved webhook carrying the refund. */
export type AlertKind =
  | "sweep.insufficient_gas"
  | "sweep.payment_failed"
  | "sweep.failing"
  | "sweep.too_expensive"
  | "sweep.stuck"
  | "sweep.tx_mismatch"
  | "sweep.needs_admin"
  | "routing.stuck"
  | "routing.failing"
  | "routing.over_cap"
  | "routing.config_error"
  | "routing.source_retired"
  | "pos.lockout"
  | "links.budget"
  | "subscription.invalid"
  | "lightning.config_error"
  | "lightning.spend_permission"
  | "admin.recovered"
  | "setup.abuse"
  | "webhook.dead"
  | "refund.approved";
export interface AlertRow {
  id: string;
  created_at: number;
  kind: string;
  chain: string | null;
  detail: string;
  resolved_at: number | null;
}

/** No new alert of the same kind and chain while an unresolved one from the last 6 hours exists. */
export const ALERT_DEDUPE_MS = 6 * 3_600_000;

/**
 * Records an alert unless a recent unresolved one of the same kind+chain exists. Returns whether a row was inserted.
 * `dedupe: false` records every occurrence: used for sweep.needs_admin and sweep.tx_mismatch, where each one names
 * different payments and must not be swallowed by an earlier unresolved alert. `payload` replaces `{ chain }` as the
 * webhook event's payload (WEBHOOK_KINDS only).
 */
export async function recordAlert(
  db: D1Database,
  kind: AlertKind,
  chain: string | null,
  detail: string,
  now = Date.now(),
  o: { dedupe?: boolean; payload?: Record<string, string> } = {},
): Promise<boolean> {
  const id = `alt_${crypto.randomUUID().replaceAll("-", "")}`;
  const insert =
    o.dedupe === false
      ? db.prepare("INSERT INTO alerts(id,created_at,kind,chain,detail,resolved_at) VALUES(?,?,?,?,?,NULL)").bind(id, now, kind, chain, detail.slice(0, 500))
      : db
          .prepare(
            `INSERT INTO alerts(id,created_at,kind,chain,detail,resolved_at)
       SELECT ?1,?2,?3,?4,?5,NULL
       WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE kind=?3 AND chain IS ?4 AND resolved_at IS NULL AND created_at>?6)`,
          )
          .bind(id, now, kind, chain, detail.slice(0, 500), now - ALERT_DEDUPE_MS);
  // WEBHOOK_KINDS are also webhooks (src/webhooks/routing.ts): one event per alert row actually recorded, in the same
  // transaction, its id derived from the alert's (a retry never duplicates it). The payload names only the chain (the
  // detail stays on the dashboard), unless the caller gives one (refund.approved: the refund).
  const [r] = await db.batch(
    WEBHOOK_KINDS.has(kind)
      ? [
          insert,
          db
            .prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM alerts WHERE id=?) ON CONFLICT(id) DO NOTHING")
            .bind(`${kind}:${id}`, now, kind, id, JSON.stringify(o.payload ?? { chain }), id),
        ]
      : [insert],
  );
  return (r!.meta.changes ?? 0) > 0;
}

/** Alert kinds that are also delivered as webhooks (through the events outbox). */
const WEBHOOK_KINDS: ReadonlySet<AlertKind> = new Set(["sweep.insufficient_gas", "refund.approved"]);

export async function listUnresolvedAlerts(db: D1Database): Promise<AlertRow[]> {
  const { results } = await db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC, id").all<AlertRow>();
  return results;
}

export async function resolveAlert(db: D1Database, id: string, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL").bind(now, id).run();
}
