import { describe, expect, it } from "vitest";
import { atomicFromFiatMinor, fiatMinorFromAtomic, formatDecimal, parseDecimal } from "../../src/core/money";

const BTC_100K = 100_000n * 10n ** 8n; // $100,000 per BTC

describe("money", () => {
  it("atomicFromFiatMinor rounds up", () => {
    expect(atomicFromFiatMinor(5000n, 8, BTC_100K)).toBe(50_000n);
    expect(atomicFromFiatMinor(1n, 8, 3n * 10n ** 8n * 10_000n)).toBe(34n);
  });
  it("fiatMinorFromAtomic rounds down", () => {
    expect(fiatMinorFromAtomic(50_000n, 8, BTC_100K)).toBe(5000n);
    expect(fiatMinorFromAtomic(1n, 6, 1n * 10n ** 8n)).toBe(0n);
  });
  it("parseDecimal", () => {
    expect(parseDecimal("12.345", 8)).toBe(1_234_500_000n);
    expect(parseDecimal("7", 8)).toBe(700_000_000n);
    expect(() => parseDecimal("1.123456789", 8)).toThrow();
    expect(() => parseDecimal("-1", 8)).toThrow();
    expect(() => parseDecimal("", 8)).toThrow();
    expect(() => parseDecimal("1e3", 8)).toThrow();
  });
  it("formatDecimal", () => {
    expect(formatDecimal(1_234_500_000n, 8)).toBe("12.345");
    expect(formatDecimal(5n, 18)).toBe("0.000000000000000005");
    expect(formatDecimal(100n, 2)).toBe("1");
    expect(formatDecimal(0n, 8)).toBe("0");
  });
});

import { formatFiat } from "../../src/core/money";
describe("formatFiat", () => {
  it("always uses two decimals", () => {
    expect(formatFiat(5000n)).toBe("50.00");
    expect(formatFiat(5050n)).toBe("50.50");
    expect(formatFiat(0n)).toBe("0.00");
    expect(formatFiat(7n)).toBe("0.07");
    expect(() => formatFiat(-1n)).toThrow();
  });
});
