import type { EventRow } from "../db/repo";
import type { Env } from "../env";
import { enqueueEvents } from "../webhooks/outbox";

const SWEEP_LIMIT = 500;

/**
 * Expires open invoices past `expires_at` that never got a payment (no watcher exists for them).
 * Invoices with payments are left to their watcher. Run from the cron.
 */
export async function expireStaleInvoices(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM invoices i WHERE status='open' AND expires_at < ? AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id) ORDER BY expires_at LIMIT ?",
  )
    .bind(now, SWEEP_LIMIT)
    .all<{ id: string }>();
  if (results.length === 0) return;

  const events: EventRow[] = results.map(({ id }) => ({
    id: `invoice.expired:${id}:1`,
    created_at: now,
    type: "invoice.expired",
    invoice_id: id,
    payload: JSON.stringify({ invoice_id: id, status: "expired", paid_minor: "0" }),
  }));
  // Re-check the conditions in the UPDATE: a payment created since the SELECT keeps the invoice open.
  const res = await env.DB.batch(
    events.flatMap((e) => [
      env.DB.prepare(
        "UPDATE invoices SET status='expired' WHERE id=? AND status='open' AND expires_at < ? AND NOT EXISTS (SELECT 1 FROM payments WHERE invoice_id=?)",
      ).bind(e.invoice_id, now, e.invoice_id),
      env.DB.prepare(
        "INSERT INTO events(id,created_at,type,invoice_id,payload) SELECT ?,?,?,?,? WHERE changes() > 0 ON CONFLICT(id) DO NOTHING",
      ).bind(e.id, e.created_at, e.type, e.invoice_id, e.payload),
    ]),
  );
  const expired = events.filter((_, i) => (res[2 * i]?.meta.changes ?? 0) > 0);
  await enqueueEvents(env, expired, now).catch((e) =>
    console.warn("enqueue invoice.expired failed:", e instanceof Error ? e.name : "Error"),
  );
}
