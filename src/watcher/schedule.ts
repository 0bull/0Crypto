import type { PaymentStatus } from "../db/repo";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_DELAY_MS = 600_000;
const MAX_BACKOFF_EXP = 5;
/** Re-check of a confirmed payment, for top-ups, until 24h after invoice expiry. */
export const CONFIRMED_DELAY_MS = HOUR_MS;
/** Poll of a payment still awaiting funds once its invoice and its rate lock have both ended (it turns expired 24h after the invoice). */
const EXPIRED_AWAITING_DELAY_MS = 600_000;

export interface PollWindow {
  now: number;
  /** The invoice's `expires_at`. */
  expiresAt: number;
  /** The payment's `rate_locked_until`. On-chain locks run from payment creation and may outlast the invoice. */
  lockedUntil: number;
}

/**
 * Milliseconds until the next poll of a payment, or null when it needs no more polling.
 * Base delay by age (<1h 15s, <6h 1min, else 5min). An awaiting payment is polled every 10min once both its invoice
 * and its rate lock have ended (inside the lock, funds must be first seen promptly to get the locked rate). Confirmed payments are re-checked every hour until 24h after invoice expiry, so later top-ups are still
 * credited (the watcher gives a confirmed payment one final observe after that, see PaymentWatcher). Doubled per
 * consecutive error (exponent capped at 5), capped at 10min or the base delay, whichever is longer.
 */
export function nextPollDelay(ageMs: number, status: PaymentStatus, errorStreak: number, w: PollWindow): number | null {
  if (status === "expired") return null;
  if (status === "confirmed" && w.now > w.expiresAt + DAY_MS) return null;
  const base =
    status === "confirmed"
      ? CONFIRMED_DELAY_MS
      : status === "awaiting" && w.now > Math.max(w.expiresAt, w.lockedUntil)
        ? EXPIRED_AWAITING_DELAY_MS
        : ageMs < HOUR_MS
          ? 15_000
          : ageMs < 6 * HOUR_MS
            ? 60_000
            : 300_000;
  return Math.min(base * 2 ** Math.min(errorStreak, MAX_BACKOFF_EXP), Math.max(base, MAX_DELAY_MS));
}

/** Polling of an awaiting Lightning payment goes on normally this long after its lock (bolt11) ends. */
export const LN_GRACE_MS = 10 * 60_000;
/** Then one final lookup this long after the bolt11 expiry, and the payment is no longer watched. */
export const LN_FINAL_AFTER_MS = HOUR_MS;

/**
 * The next poll of an awaiting Lightning payment, given the usual delay (`base`). An expired bolt11 cannot be paid (the
 * payer's wallet refuses it), so after the grace period there is one final lookup at bolt11 expiry + 1 h, in case the
 * wallet still reports it settled, and then null: stop watching this payment (not the invoice's others).
 */
export function lightningPollDelay(now: number, base: number | null, lockedUntil: number, bolt11ExpiresAt: number): number | null {
  if (base === null) return null;
  if (now < lockedUntil + LN_GRACE_MS) return base;
  const finalAt = Math.max(lockedUntil, bolt11ExpiresAt) + LN_FINAL_AFTER_MS;
  return now < finalAt ? finalAt - now : null;
}
