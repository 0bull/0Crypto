import { parseInvoiceBody } from "../api/invoices";
import { formatFiat } from "../core/money";
import { insertInvoiceIfChanged, type EventRow } from "../db/repo";
import type { Env } from "../env";
import { enqueueEvents } from "../webhooks/outbox";
import { currentPeriod } from "./schedule";
import { recordAlert } from "../db/alerts";
import { deactivateSubscriptionRow, listDue, type SubRow } from "./store";

/** The row can never be billed as stored (its price, currency or metadata no longer passes invoice validation). */
export class InvalidSubscription extends Error {
  override name = "InvalidSubscription";
}

export const SUB_RUN_LIMIT = 100;
/** Stop starting new subscriptions after this long; the rest wait for the next hourly run. */
export const SUB_RUN_BUDGET_MS = 25_000;
const INVOICE_TTL_SEC = 7 * 86_400;

/**
 * Bills one due subscription, atomically, and returns the committed event (null: another runner already advanced it).
 *
 * One D1 batch (a transaction), each statement conditioned on the previous one's `changes()=1`:
 *   1. CAS   UPDATE subscriptions SET next_at=<new> WHERE id=? AND next_at=<old> AND active=1
 *   2. guard INSERT subscription_periods(subscription_id, period_start, invoice_id)   (PRIMARY KEY = second line of defence;
 *            a duplicate throws and rolls back the whole batch)
 *   3. INSERT invoices    4. INSERT events
 * If the CAS loses (a concurrent run, a deactivation), nothing at all is inserted.
 *
 * Missed periods: if several periods are overdue (cron outage), ONE invoice is made, for the latest overdue period, and
 * next_at jumps to the first due time after `now`. Earlier periods are skipped, never billed as a burst.
 */
export async function fireSubscription(env: Env, sub: SubRow, now: number): Promise<EventRow | null> {
  const { period, next } = currentPeriod(sub.interval, sub.anchor_day, sub.next_at, now);
  const parsed = parseInvoiceBody(
    {
      price_amount: formatFiat(sub.price_minor),
      price_currency: sub.currency,
      metadata: { ...(sub.metadata ?? {}), subscription_id: sub.id },
      expires_in_sec: INVOICE_TTL_SEC,
    },
    env,
    now,
    INVOICE_TTL_SEC,
  );
  if (!parsed.ok) throw new InvalidSubscription("subscription cannot be billed"); // message names no merchant data
  const { inv } = parsed;
  const event: EventRow = {
    id: `subscription.invoice_created:${inv.id}:1`,
    created_at: now,
    type: "subscription.invoice_created",
    invoice_id: inv.id,
    payload: JSON.stringify({ subscription_id: sub.id, invoice_id: inv.id, status: inv.status, paid_minor: "0" }),
  };
  const db = env.DB;
  const res = await db.batch([
    db.prepare("UPDATE subscriptions SET next_at=? WHERE id=? AND next_at=? AND active=1").bind(next, sub.id, sub.next_at),
    db.prepare("INSERT INTO subscription_periods(subscription_id,period_start,invoice_id) SELECT ?,?,? WHERE changes()=1").bind(sub.id, period, inv.id),
    insertInvoiceIfChanged(db, inv),
    db
      .prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) SELECT ?,?,?,?,? WHERE changes()=1")
      .bind(event.id, event.created_at, event.type, event.invoice_id, event.payload),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1 ? event : null;
}

/**
 * Hourly cron: bills up to 100 active subscriptions with next_at <= now, oldest first. A per-subscription failure is
 * logged by error name only and the run continues. Events are enqueued after each commit; a failed enqueue is left for
 * requeuePendingEvents (the webhook outbox), so the invoice and its event are never lost.
 */
export async function runSubscriptions(env: Env, now: number, opts: { limit?: number; budgetMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.budgetMs ?? SUB_RUN_BUDGET_MS);
  const { due, corrupt } = await listDue(env.DB, now, opts.limit ?? SUB_RUN_LIMIT);
  // Rows that can never be billed (corrupt, or no longer valid invoices) are deactivated with one deduplicated alert,
  // so they do not fail, and take a slot, every hour. Transient errors (D1, queue) leave the row active for the next run.
  const invalid: string[] = [...corrupt];
  for (const sub of due) {
    if (Date.now() >= deadline) {
      console.warn("runSubscriptions: deadline reached, remaining subscriptions wait for the next run");
      break;
    }
    try {
      const event = await fireSubscription(env, sub, now);
      if (event) await enqueueEvents(env, [event], now).catch((e) => console.warn("enqueue subscription.invoice_created failed:", e instanceof Error ? e.name : "Error"));
    } catch (e) {
      console.warn(`runSubscriptions: ${sub.id} failed:`, e instanceof Error ? e.name : "Error");
      if (e instanceof InvalidSubscription) invalid.push(sub.id);
    }
  }
  await retireInvalid(env, invalid, now);
}

async function retireInvalid(env: Env, ids: string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) await deactivateSubscriptionRow(env.DB, id).catch((e) => console.warn(`runSubscriptions: deactivating ${id} failed:`, e instanceof Error ? e.name : "Error"));
  await recordAlert(
    env.DB,
    "subscription.invalid",
    null,
    `${ids.length === 1 ? "A subscription" : `${ids.length} subscriptions`} could not be billed and ${ids.length === 1 ? "was" : "were"} deactivated (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", ..." : ""}). Its stored price, currency or metadata is not valid any more: check it under Subscriptions and create a new one.`,
    now,
  ).catch(() => false);
}
