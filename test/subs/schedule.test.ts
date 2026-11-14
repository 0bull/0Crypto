import { describe, expect, it } from "vitest";
import { currentPeriod, nextDue, type Interval } from "../../src/subs/schedule";

const U = Date.UTC;
const DAY = 86_400_000;

describe("nextDue", () => {
  it("monthly on the 31st clamps to month end and never drifts", () => {
    const feb = nextDue("monthly", 31, U(2027, 0, 31));
    expect(feb).toBe(U(2027, 1, 28));
    expect(nextDue("monthly", 31, feb)).toBe(U(2027, 2, 31));
    expect(nextDue("monthly", 31, U(2027, 2, 31))).toBe(U(2027, 3, 30));
  });
  it("uses Feb 29 in leap years", () => {
    expect(nextDue("monthly", 31, U(2028, 0, 31))).toBe(U(2028, 1, 29));
  });
  it("rolls over the year end", () => {
    expect(nextDue("monthly", 15, U(2027, 11, 15))).toBe(U(2028, 0, 15));
  });
  it("weekly adds exactly 7 days", () => {
    expect(nextDue("weekly", 1, U(2027, 0, 31))).toBe(U(2027, 0, 31) + 7 * DAY);
  });
  it("yearly on Feb 29: Feb 28 in common years, Feb 29 in leap years", () => {
    const a = nextDue("yearly", 29, U(2028, 1, 29));
    expect(a).toBe(U(2029, 1, 28));
    expect(nextDue("yearly", 29, a)).toBe(U(2030, 1, 28));
    expect(nextDue("yearly", 29, U(2031, 1, 28))).toBe(U(2032, 1, 29));
  });
  it("keeps the time of day of the input", () => {
    const t = U(2027, 0, 31, 13, 45, 12, 345);
    expect(nextDue("monthly", 31, t)).toBe(U(2027, 1, 28, 13, 45, 12, 345));
    expect(nextDue("yearly", 31, t)).toBe(U(2028, 0, 31, 13, 45, 12, 345));
    expect(nextDue("weekly", 31, t)).toBe(t + 7 * DAY);
  });
});

// Deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const dim = (y: number, m: number) => new Date(U(y, m + 1, 0)).getUTCDate();

describe("nextDue property", () => {
  for (const interval of ["weekly", "monthly", "yearly"] as Interval[]) {
    it(`${interval}: 1000 random anchors and starts are strictly increasing, on min(anchorDay, month length), at most one interval ahead`, () => {
      const r = rng(interval.length * 7919);
      for (let n = 0; n < 1000; n++) {
        const anchor = 1 + Math.floor(r() * 31);
        const y = 2000 + Math.floor(r() * 100);
        const m = Math.floor(r() * 12);
        const tod = Math.floor(r() * DAY);
        // A real start: the anchor day clamped to its month, which is how subscriptions are created.
        let cur = U(y, m, Math.min(anchor, dim(y, m))) + tod;
        for (let k = 0; k < 30; k++) {
          const nxt = nextDue(interval, anchor, cur);
          expect(nxt).toBeGreaterThan(cur);
          const d = new Date(nxt);
          expect(nxt % DAY === cur % DAY).toBe(true);
          if (interval === "weekly") expect(nxt - cur).toBe(7 * DAY);
          else {
            expect(d.getUTCDate()).toBe(Math.min(anchor, dim(d.getUTCFullYear(), d.getUTCMonth())));
            expect(nxt - cur).toBeLessThanOrEqual((interval === "monthly" ? 31 : 366) * DAY);
            const c = new Date(cur);
            const months = (d.getUTCFullYear() - c.getUTCFullYear()) * 12 + d.getUTCMonth() - c.getUTCMonth();
            expect(months).toBe(interval === "monthly" ? 1 : 12);
          }
          cur = nxt;
        }
      }
    });
  }
});

describe("currentPeriod", () => {
  it("bills next_at itself when exactly one period is due (now == next_at and just after)", () => {
    const at = U(2027, 2, 10, 8);
    expect(currentPeriod("monthly", 10, at, at)).toEqual({ period: at, next: U(2027, 3, 10, 8) });
    expect(currentPeriod("monthly", 10, at, U(2027, 3, 10, 8) - 1)).toEqual({ period: at, next: U(2027, 3, 10, 8) });
  });
  it("on the next due time exactly, that one is the current period", () => {
    expect(currentPeriod("monthly", 10, U(2027, 2, 10), U(2027, 3, 10))).toEqual({ period: U(2027, 3, 10), next: U(2027, 4, 10) });
  });
  it("weekly: several missed weeks give the latest overdue week and the next one after now", () => {
    const start = U(2027, 0, 4, 9); // a Monday
    const now = start + 23 * DAY + 3_600_000; // 3 weeks and 2 days later
    expect(currentPeriod("weekly", 4, start, now)).toEqual({ period: start + 21 * DAY, next: start + 28 * DAY });
  });
  it("monthly on the 31st keeps the anchor across missed short months", () => {
    expect(currentPeriod("monthly", 31, U(2027, 0, 31), U(2027, 3, 1))).toEqual({ period: U(2027, 2, 31), next: U(2027, 3, 30) });
  });
  it("yearly from Feb 29 bills Feb 28 in common years and Feb 29 in leap years", () => {
    expect(currentPeriod("yearly", 29, U(2028, 1, 29), U(2031, 5, 1))).toEqual({ period: U(2031, 1, 28), next: U(2032, 1, 29) });
    expect(currentPeriod("yearly", 29, U(2028, 1, 29), U(2032, 1, 29))).toEqual({ period: U(2032, 1, 29), next: U(2033, 1, 28) });
  });
  it("yearly from Jan 31 stays on Jan 31", () => {
    expect(currentPeriod("yearly", 31, U(2027, 0, 31), U(2030, 0, 30))).toEqual({ period: U(2029, 0, 31), next: U(2030, 0, 31) });
  });
  it("a period in the future (not yet due) is returned as is", () => {
    expect(currentPeriod("weekly", 1, U(2030, 0, 1), U(2029, 0, 1))).toEqual({ period: U(2030, 0, 1), next: U(2030, 0, 8) });
  });
});
