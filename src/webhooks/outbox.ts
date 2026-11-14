import type { EventRow } from "../db/repo";
import type { Env } from "../env";

/** Events still unmarked this long after creation are assumed lost between commit and enqueue. */
export const REQUEUE_AFTER_MS = 60_000;
const REQUEUE_LIMIT = 500;
const BATCH = 100; // sendBatch caps at 100 messages

/**
 * Enqueues one delivery job per event, then marks those rows `enqueued_at = now`.
 * A row is marked only after its sendBatch succeeds (with no WEBHOOK_URL nothing is sent and rows are just marked); a crash in between leaves it for requeuePendingEvents
 * (a duplicate delivery is fine: merchants dedupe by event id).
 */
export async function enqueueEvents(env: Env, events: EventRow[], now = Date.now()): Promise<void> {
  for (let i = 0; i < events.length; i += BATCH) {
    const chunk = events.slice(i, i + BATCH);
    // No webhook URL: nothing to deliver, so no queue send; the rows are still marked handled (they stay in D1 for the admin Events list).
    if (env.WEBHOOK_URL) await env.WEBHOOKS.sendBatch(chunk.map((e) => ({ body: { eventId: e.id } })));
    await env.DB.prepare("UPDATE events SET enqueued_at=? WHERE id IN (SELECT value FROM json_each(?))")
      .bind(now, JSON.stringify(chunk.map((e) => e.id)))
      .run();
  }
}

/** Event types that are not about an invoice (src/webhooks/routing.ts): written by the router, the swap executor and recordAlert. */
const NON_INVOICE_TYPES = ["routing.completed", "routing.failed", "routing.stuck", "sweep.insufficient_gas", "refund.approved"];

/**
 * Enqueues the not-yet-enqueued routing, sweep.insufficient_gas and refund.approved events (up to 500, oldest first),
 * after the run that committed them: they are written deep inside D1 batches (legs, batch status, alerts), so the
 * router, the sweeper and the refund routes call this once at the end instead of leaving them for requeuePendingEvents' 60 s grace. A failure leaves them for it.
 */
export async function enqueueNonInvoiceEvents(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id,created_at,type,invoice_id,payload FROM events WHERE enqueued_at IS NULL AND type IN (SELECT value FROM json_each(?)) ORDER BY created_at, id LIMIT ?",
  )
    .bind(JSON.stringify(NON_INVOICE_TYPES), REQUEUE_LIMIT)
    .all<EventRow>();
  await enqueueEvents(env, results, now);
}

/** Re-enqueues up to 500 never-enqueued events older than 60s, oldest first. Run from the cron. */
export async function requeuePendingEvents(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id,created_at,type,invoice_id,payload FROM events WHERE enqueued_at IS NULL AND created_at < ? ORDER BY created_at, id LIMIT ?",
  )
    .bind(now - REQUEUE_AFTER_MS, REQUEUE_LIMIT)
    .all<EventRow>();
  if (results.length > 0) console.warn(`webhooks: re-enqueueing ${results.length} pending event(s)`);
  await enqueueEvents(env, results, now);
}
