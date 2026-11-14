/*
 * Recurrence maths for subscriptions. Pure UTC on integer ms: no local-time Date methods, no state.
 *
 * - weekly:  exactly +7 days.
 * - monthly: the same time of day on `anchorDay` of the next month, clamped to that month's length. Because every
 *   step is computed from the ORIGINAL anchor day (not from the previous, possibly clamped, date), the 31st goes
 *   Jan 31 -> Feb 28/29 -> Mar 31 and never drifts to the 28th.
 * - yearly:  the same month and clamped anchor day one year later. The anchor MONTH needs no stored column: yearly
 *   steps never change the month, so the month of `fromMs` is always the month the subscription started in
 *   (next_at is set from start_at at creation). Feb 29 therefore gives Feb 28 in common years and Feb 29 in leap years.
 * - Time of day is that of `fromMs` (the previous next_at), i.e. of the original start_at.
 */

export type Interval = "weekly" | "monthly" | "yearly";
export const INTERVALS: readonly Interval[] = ["weekly", "monthly", "yearly"];

const DAY = 86_400_000;

/** Days in `month` (0-11) of `year`, from the UTC calendar. */
const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The first due time strictly after `fromMs`, where `fromMs` is itself a due time (the period just billed). */
export function nextDue(interval: Interval, anchorDay: number, fromMs: number): number {
  if (interval === "weekly") return fromMs + 7 * DAY;
  const d = new Date(fromMs);
  const tod = ((fromMs % DAY) + DAY) % DAY;
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (interval === "yearly") y += 1;
  else if (++m === 12) {
    m = 0;
    y += 1;
  }
  return Date.UTC(y, m, Math.min(anchorDay, daysIn(y, m))) + tod;
}

/**
 * The period to bill now and the next due time. If several periods are overdue (cron down, or a start_at far in the
 * past) only the latest overdue one is billed: `period` is the last due time <= now and `next` is the first one > now.
 * There is never a backlog burst.
 */
export function currentPeriod(interval: Interval, anchorDay: number, nextAt: number, now: number): { period: number; next: number } {
  let period = nextAt;
  let next = nextDue(interval, anchorDay, period);
  for (let i = 0; next <= now && i < 200_000; i++) {
    period = next;
    next = nextDue(interval, anchorDay, period);
  }
  return { period, next };
}
