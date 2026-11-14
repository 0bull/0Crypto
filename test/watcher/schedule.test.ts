import { describe, expect, it } from "vitest";
import { nextPollDelay } from "../../src/watcher/schedule";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 1);
/** Invoice still open: expiry in the future. */
const open = { now: NOW, expiresAt: NOW + HOUR, lockedUntil: NOW + 20 * MIN };

describe("nextPollDelay", () => {
  it("backs off by payment age", () => {
    expect(nextPollDelay(10 * MIN, "awaiting", 0, open)).toBe(15_000);
    expect(nextPollDelay(2 * HOUR, "detected", 0, open)).toBe(60_000);
    expect(nextPollDelay(7 * HOUR, "awaiting", 0, open)).toBe(300_000);
  });

  it("switches tiers exactly at 1h and 6h", () => {
    expect(nextPollDelay(HOUR - 1, "awaiting", 0, open)).toBe(15_000);
    expect(nextPollDelay(HOUR, "awaiting", 0, open)).toBe(60_000);
    expect(nextPollDelay(6 * HOUR - 1, "awaiting", 0, open)).toBe(60_000);
    expect(nextPollDelay(6 * HOUR, "awaiting", 0, open)).toBe(300_000);
  });

  it("doubles per error, exponent capped at 5, delay capped at 600000", () => {
    expect(nextPollDelay(10 * MIN, "awaiting", 3, open)).toBe(120_000);
    expect(nextPollDelay(10 * MIN, "awaiting", 9, open)).toBe(480_000);
    expect(nextPollDelay(2 * HOUR, "partial", 5, open)).toBe(600_000);
    expect(nextPollDelay(7 * HOUR, "confirming", 1, open)).toBe(600_000);
  });

  it("re-checks confirmed payments hourly until 24h after invoice expiry, then stops", () => {
    expect(nextPollDelay(10 * MIN, "confirmed", 0, open)).toBe(3_600_000);
    const expiresAt = NOW - DAY;
    expect(nextPollDelay(10 * MIN, "confirmed", 0, { now: expiresAt + 23 * HOUR, expiresAt, lockedUntil: expiresAt })).toBe(3_600_000);
    expect(nextPollDelay(10 * MIN, "confirmed", 0, { now: NOW, expiresAt, lockedUntil: expiresAt })).toBe(3_600_000); // exactly at the end
    expect(nextPollDelay(10 * MIN, "confirmed", 0, { now: expiresAt + DAY + 1, expiresAt, lockedUntil: expiresAt })).toBeNull();
  });

  it("never cuts the 1h confirmed base down to the 10min backoff cap", () => {
    expect(nextPollDelay(10 * MIN, "confirmed", 1, open)).toBe(3_600_000);
    expect(nextPollDelay(10 * MIN, "confirmed", 3, open)).toBe(3_600_000);
    expect(nextPollDelay(10 * MIN, "confirmed", 3, { now: NOW + 2 * HOUR, expiresAt: NOW, lockedUntil: NOW })).toBe(3_600_000);
  });

  it("polls awaiting payments every 10min once the invoice expired; other states keep the age tiers", () => {
    const expired = { now: NOW + 1, expiresAt: NOW, lockedUntil: NOW - MIN };
    expect(nextPollDelay(2 * HOUR, "awaiting", 0, expired)).toBe(600_000);
    expect(nextPollDelay(10 * MIN, "awaiting", 0, expired)).toBe(600_000);
    expect(nextPollDelay(10 * MIN, "awaiting", 4, expired)).toBe(600_000);
    expect(nextPollDelay(2 * HOUR, "awaiting", 0, { now: NOW, expiresAt: NOW, lockedUntil: NOW - MIN })).toBe(60_000); // not yet past expiry
    expect(nextPollDelay(10 * MIN, "detected", 0, expired)).toBe(15_000);
    expect(nextPollDelay(2 * HOUR, "partial", 0, expired)).toBe(60_000);
    expect(nextPollDelay(7 * HOUR, "confirming", 0, expired)).toBe(300_000);
  });

  it("keeps the fast schedule for an awaiting payment past invoice expiry while its rate lock runs", () => {
    // On-chain locks run 20 min from payment creation, not clamped to invoice expiry: funds sent inside the lock must be
    // first seen inside it, or they are credited at the current price.
    const lockRunning = { now: NOW + 1, expiresAt: NOW, lockedUntil: NOW + 15 * MIN };
    expect(nextPollDelay(10 * MIN, "awaiting", 0, lockRunning)).toBe(15_000);
    expect(nextPollDelay(10 * MIN, "awaiting", 0, { now: NOW + 15 * MIN, expiresAt: NOW, lockedUntil: NOW + 15 * MIN })).toBe(15_000);
    expect(nextPollDelay(10 * MIN, "awaiting", 0, { now: NOW + 15 * MIN + 1, expiresAt: NOW, lockedUntil: NOW + 15 * MIN })).toBe(600_000);
    // Lock over but invoice still open: age tiers as before.
    expect(nextPollDelay(2 * HOUR, "awaiting", 0, { now: NOW - 1, expiresAt: NOW, lockedUntil: NOW - HOUR })).toBe(60_000);
  });

  it("stops for expired", () => {
    expect(nextPollDelay(7 * HOUR, "expired", 3, open)).toBeNull();
  });
});
