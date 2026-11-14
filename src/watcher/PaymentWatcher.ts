import { DurableObject } from "cloudflare:workers";
import { BACKOFF_TTL_SEC, chainBackedOff, isRateLimited, noteRateLimited } from "../chains/backoff";
import { bolt11Summary } from "../chains/lightning/nwc";
import { getAdapter } from "../chains/registry";
import { getAsset } from "../core/assets";
import { formatDecimal } from "../core/money";
import { step } from "../core/state";
import type { ChainId, DepositTarget } from "../core/types";
import {
  applyTransition,
  getInvoice,
  getPayment,
  listPayments,
  type InvoiceRow,
  type InvoiceStatus,
  type PaymentRow,
  type PaymentStatus,
  type Transition,
} from "../db/repo";
import type { Env } from "../env";
import { effectiveEnv } from "../settings";
import { getPriceE8 } from "../prices/cache";
import type { Currency } from "../prices/kraken";
import { enqueueEvents } from "../webhooks/outbox";
import { CONFIRMED_DELAY_MS, lightningPollDelay, nextPollDelay, type PollWindow } from "./schedule";

const DAY_MS = 86_400_000;
/** Stop watching this long after invoice expiry, whatever the payment status. */
const GIVE_UP_AFTER_EXPIRY_MS = 7 * DAY_MS;
const ALARM_RETRY_MS = 60_000;
/** An unfunded payment inside its rate lock gets a poll this long before the lock ends, so funds sent in time get the locked rate. */
const LOCK_EDGE_MS = 5_000;

const K_INVOICE = "invoiceId";
const K_PAYMENTS = "payments";
const pollKey = (paymentId: string) => `p:${paymentId}`;

interface PollState {
  errorStreak: number;
  lastPolledAt: number | null;
  /** Epoch ms of the next poll; 0 = due now. */
  nextAt: number;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export const toTarget = (p: PaymentRow): DepositTarget => ({
  paymentId: p.id,
  chain: p.chain,
  asset: p.asset,
  address: p.address,
  derivationIndex: p.derivation_index,
  createdAt: p.created_at,
  reference: p.reference ?? undefined,
});

/**
 * One instance per invoice (`idFromName(invoiceId)`). Polls every open payment of that invoice
 * from a single alarm, so all writes to the invoice row are serialised here.
 */
export class PaymentWatcher extends DurableObject<Env> {
  async start(invoiceId: string, paymentId: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const stored = kv.get<string>(K_INVOICE);
    if (stored !== undefined && stored !== invoiceId) {
      throw new Error(`watcher for invoice ${stored} cannot track invoice ${invoiceId}`);
    }
    kv.put(K_INVOICE, invoiceId);
    const ids = kv.get<string[]>(K_PAYMENTS) ?? [];
    if (!ids.includes(paymentId)) kv.put(K_PAYMENTS, [...ids, paymentId]);
    const now = Date.now();
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending > now) await this.ctx.storage.setAlarm(now);
  }

  async alarm(): Promise<void> {
    try {
      await this.pollDue(await effectiveEnv(this.env));
    } catch (e) {
      console.warn(`watcher: alarm failed: ${errName(e)}`);
      await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
    }
    const paymentId = url.searchParams.get("payment");
    if (!paymentId) return new Response("missing payment", { status: 400 });
    const env = await effectiveEnv(this.env);
    const payment = await getPayment(env.DB, paymentId);
    const tracked = this.ctx.storage.kv.get<string>(K_INVOICE);
    if (!payment || (tracked !== undefined && payment.invoice_id !== tracked)) {
      return new Response("not found", { status: 404 });
    }
    const invoice = await getInvoice(env.DB, payment.invoice_id);
    if (!invoice) return new Response("not found", { status: 404 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [paymentId]);
    server.send(statusMessage(payment, invoice.status));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // 1005/1006 are reserved and cannot be sent back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  /**
   * Polls every due payment in order, then re-arms the alarm for the earliest next poll. The invoice and its payments are
   * read from D1 once per alarm, and only when some payment is due; each transition replaces the rows in hand, so a later
   * payment steps against the invoice an earlier one just changed.
   */
  private async pollDue(env: Env): Promise<void> {
    const kv = this.ctx.storage.kv;
    const invoiceId = kv.get<string>(K_INVOICE);
    const dropped = new Set<string>();
    const due: [string, PollState][] = [];
    for (const id of kv.get<string[]>(K_PAYMENTS) ?? []) {
      const state = kv.get<PollState>(pollKey(id)) ?? { errorStreak: 0, lastPolledAt: null, nextAt: 0 };
      if (state.nextAt <= Date.now()) due.push([id, state]);
    }

    let rows: { invoice: InvoiceRow | null; payments: PaymentRow[] } | null = null;
    // One backoff-flag read per chain per alarm; a 429 met in this alarm backs off the chain's later payments too.
    const backedOff = new Map<ChainId, Promise<boolean>>();
    for (const [id, state] of due) {
      let next: PollState | null;
      if (invoiceId === undefined) {
        next = null;
      } else {
        try {
          rows ??= await loadRows(env.DB, invoiceId);
        } catch (e) {
          // D1 read failed: age unknown, back off from the shortest tier.
          const now = Date.now();
          next = failedState(id, state.errorStreak, e, 0, "awaiting", { now, expiresAt: now, lockedUntil: now });
          if (next === null) dropped.add(id);
          else kv.put(pollKey(id), next);
          continue;
        }
        if (!rows.invoice) {
          console.warn(`watcher: payment ${id} not found, dropping`);
          next = null;
        } else {
          const r = await this.pollPayment(env, rows.invoice, rows.payments, id, state, backedOff);
          next = r.next;
          if (r.stale) rows = null; // the write may or may not have landed: re-read before the next payment steps
          else if (r.t) {
            const t = r.t;
            rows = { invoice: t.invoice, payments: rows.payments.map((p) => (p.id === t.payment.id ? t.payment : p)) };
          }
        }
      }
      if (next === null) dropped.add(id);
      else kv.put(pollKey(id), next);
    }

    // Re-read the set: start() may have added ids while this alarm awaited I/O. Rewritten only when an id was dropped.
    const current = kv.get<string[]>(K_PAYMENTS) ?? [];
    const remaining = current.filter((id) => !dropped.has(id));
    for (const id of dropped) kv.delete(pollKey(id));
    if (remaining.length !== current.length) kv.put(K_PAYMENTS, remaining);
    if (remaining.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextAt = Math.min(...remaining.map((id) => kv.get<PollState>(pollKey(id))?.nextAt ?? 0));
    await this.ctx.storage.setAlarm(Math.max(nextAt, Date.now()));
  }

  /**
   * Observe → step → apply → enqueue → broadcast for one payment, against the rows the caller holds. Returns its next poll
   * state (null to stop watching it) and the transition that was written to D1, if any. `stale` means applyTransition
   * failed, so D1 may or may not hold the transition and the caller must re-read the rows. Never throws.
   */
  private async pollPayment(
    env: Env,
    invoice: InvoiceRow,
    payments: PaymentRow[],
    paymentId: string,
    prev: PollState,
    backedOff: Map<ChainId, Promise<boolean>>,
  ): Promise<{ next: PollState | null; t: Transition | null; stale?: true }> {
    const payment = payments.find((p) => p.id === paymentId);
    if (!payment) {
      console.warn(`watcher: payment ${paymentId} not found, dropping`);
      return { next: null, t: null };
    }
    const now = Date.now();
    if (now > invoice.expires_at + GIVE_UP_AFTER_EXPIRY_MS) {
      console.warn(`watcher: payment ${paymentId} still ${payment.status} 7 days after invoice expiry, dropping`);
      return { next: null, t: null };
    }
    const age = now - payment.created_at;
    const win: PollWindow = { now, expiresAt: invoice.expires_at, lockedUntil: payment.rate_locked_until };
    // A confirmed payment past its re-check window gets this one final observe, so a top-up that arrived since the last
    // re-check is still credited (credit only rises: the monotone guard in step); the null after it then drops the payment.
    if (nextPollDelay(age, payment.status, 0, win) === null && payment.status !== "confirmed") return { next: null, t: null };

    // Any failure from here on is this payment's error only: back off, never change its state, keep polling siblings.
    let applied: Transition | null = null;
    let applying = false;
    let current = payment;
    try {
      // Another watcher of this chain was rate-limited within the last minute: wait, don't pile on. No upstream call is
      // made, so this is not a poll error: the streak stays as it was and the next poll waits the backoff out (the
      // usual delay when longer). This poll's observe was due, so it is retried even where the usual delay is null.
      let flag = backedOff.get(payment.chain);
      if (!flag) backedOff.set(payment.chain, (flag = chainBackedOff(env, payment.chain)));
      if (await flag) {
        const delay = Math.max(okDelay(payment, payment, age, win) ?? 0, BACKOFF_TTL_SEC * 1000);
        return { next: clampToLock({ errorStreak: prev.errorStreak, lastPolledAt: prev.lastPolledAt, nextAt: now + delay }, payment, now), t: null };
      }
      const asset = getAsset(payment.asset);
      const obs = await getAdapter(env, payment.chain).observe(toTarget(payment), asset);
      // The rows were read at the start of the alarm. A lower reading may come from a sweep locked or sent since (an
      // emptied address): re-read this row so step sees its sweep columns and its monotone guard keeps the amounts.
      if (obs.received < payment.received || obs.final < payment.final) current = (await getPayment(env.DB, paymentId)) ?? payment;
      const t = await step({
        invoice,
        payment: current,
        others: payments.filter((p) => p.id !== paymentId),
        obs,
        now,
        currentPriceE8: () => getPriceE8(env, asset.priceSymbol, invoice.currency as Currency),
      });
      if (t) {
        applying = true;
        await applyTransition(env.DB, t);
        applying = false;
        applied = t;
        await enqueueEvents(env, t.events);
        this.broadcast(t.payment, t.invoice.status);
      }
      const row = t?.payment ?? current;
      const next = okDelay(payment, row, age, win);
      return { next: next === null ? null : clampToLock({ errorStreak: 0, lastPolledAt: now, nextAt: now + next }, row, now), t };
    } catch (e) {
      if (isRateLimited(e)) {
        await noteRateLimited(env, payment.chain);
        backedOff.set(payment.chain, Promise.resolve(true));
      }
      // After a failed final observe a confirmed payment keeps its hourly re-check (bounded by the 7-day give-up), so a
      // top-up is not lost to one explorer error.
      const status = applied?.payment.status ?? current.status;
      const failed = failedState(paymentId, prev.errorStreak, e, age, status, win) ?? (status === "confirmed" ? retryConfirmed(prev.errorStreak, now) : null);
      const next = failed && clampToLock(failed, applied?.payment ?? current, now);
      return applying ? { next, t: null, stale: true } : { next, t: applied };
    }
  }

  private broadcast(payment: PaymentRow, invoiceStatus: InvoiceStatus): void {
    const msg = statusMessage(payment, invoiceStatus);
    for (const ws of this.ctx.getWebSockets(payment.id)) {
      try {
        ws.send(msg);
      } catch {
        // socket closing; the client reconnects and gets a fresh status
      }
    }
  }
}

/**
 * Delay after a successful poll (streak 0) given the row it left, or null to stop watching. `payment` is the row the poll
 * started from (its chain and lock), `row` the row after any transition.
 */
function okDelay(payment: PaymentRow, row: PaymentRow, age: number, win: PollWindow): number | null {
  const status = row.status;
  let next = nextPollDelay(age, status, 0, win);
  // Past the re-check window, a confirmed payment with an unconfirmed top-up stays watched until that top-up confirms
  // and is credited (bounded by the 7-day give-up).
  if (next === null && status === "confirmed" && row.received > row.final) next = CONFIRMED_DELAY_MS;
  // Lightning: an expired, unpaid bolt11 gets one final lookup after its expiry, then is no longer watched.
  if (payment.chain === "ln" && status === "awaiting") next = lightningPollDelay(win.now, next, payment.rate_locked_until, bolt11ExpiresAt(payment));
  return next;
}

/**
 * While nothing has been received and the rate lock still runs, the next poll lands no later than LOCK_EDGE_MS before
 * the lock ends, whatever the backoff: funds sent inside the lock are then first seen inside it and keep the locked rate.
 * Unchanged once the lock is within LOCK_EDGE_MS (this poll was the one just before it).
 */
function clampToLock(s: PollState, row: PaymentRow, now: number): PollState {
  const edge = row.rate_locked_until - LOCK_EDGE_MS;
  if (row.received !== 0n || edge <= now || s.nextAt <= edge) return s;
  return { ...s, nextAt: edge };
}

/** A Lightning payment's bolt11 expiry (unix ms); its lock when the bolt11 cannot be read (the lock is never later). */
function bolt11ExpiresAt(p: PaymentRow): number {
  try {
    const s = bolt11Summary(p.address);
    return (s.timestamp + s.expirySec) * 1000;
  } catch {
    return p.rate_locked_until;
  }
}

/** A confirmed payment past its re-check window whose final observe failed: retried hourly. */
function retryConfirmed(prevStreak: number, now: number): PollState {
  return { errorStreak: prevStreak + 1, lastPolledAt: now, nextAt: now + CONFIRMED_DELAY_MS };
}

async function loadRows(db: D1Database, invoiceId: string): Promise<{ invoice: InvoiceRow | null; payments: PaymentRow[] }> {
  const [invoice, payments] = await Promise.all([getInvoice(db, invoiceId), listPayments(db, invoiceId)]);
  return { invoice, payments };
}

/** Next poll state after a failed poll: streak + 1, backed off; null when the status needs no more polling. */
function failedState(
  paymentId: string,
  prevStreak: number,
  e: unknown,
  ageMs: number,
  status: PaymentStatus,
  win: PollWindow,
): PollState | null {
  const errorStreak = prevStreak + 1;
  console.warn(`watcher: poll failed for payment ${paymentId}: ${errName(e)} (streak ${errorStreak})`);
  const delay = nextPollDelay(ageMs, status, errorStreak, win);
  return delay === null ? null : { errorStreak, lastPolledAt: win.now, nextAt: win.now + delay };
}

function statusMessage(p: PaymentRow, invoiceStatus: InvoiceStatus): string {
  const { decimals } = getAsset(p.asset);
  return JSON.stringify({
    type: "status",
    payment_id: p.id,
    status: p.status,
    received: formatDecimal(p.received, decimals),
    final: formatDecimal(p.final, decimals),
    invoice_status: invoiceStatus,
  });
}
