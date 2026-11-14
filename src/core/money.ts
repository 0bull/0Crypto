// All money is bigint. Crypto: atomic units. Fiat: minor units (cents).
// priceE8 = fiat major units * 10^8 per 1 whole coin.
// Fiat minor units are 10^2 per major, so fiatMinor = atomic * priceE8 / (10^decimals * 10^6).

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Fiat minor units for an atomic amount. Rounds down. */
export function fiatMinorFromAtomic(atomic: bigint, decimals: number, priceE8: bigint): bigint {
  return (atomic * priceE8) / (pow10(decimals) * 1_000_000n);
}

/** Atomic units needed to cover a fiat minor amount. Rounds up. */
export function atomicFromFiatMinor(fiatMinor: bigint, decimals: number, priceE8: bigint): bigint {
  const num = fiatMinor * 1_000_000n * pow10(decimals);
  return (num + priceE8 - 1n) / priceE8;
}

/** Parse a non-negative decimal string ("12.345") into atomic units. Throws on bad input or excess precision. */
export function parseDecimal(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid decimal: ${s}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`too many decimals: ${s}`);
  return BigInt(m[1]!) * pow10(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format atomic units as a decimal string, trimming trailing zeros. */
export function formatDecimal(v: bigint, decimals: number): string {
  const base = pow10(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Format fiat minor units (cents) as a decimal string with exactly two decimals. */
export function formatFiat(minor: bigint): string {
  if (minor < 0n) throw new RangeError("formatFiat: negative amount");
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}
