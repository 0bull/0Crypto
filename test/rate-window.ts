/**
 * Rate limits in tests count in fixed windows aligned to the wall clock (miniflare's API_RATE buckets by
 * floor(now / 60 s), and so does link_budget). A burst that straddles a minute boundary splits across two windows and
 * never reaches the limit, so a test that counts to the limit first waits out a boundary that is less than 8 s away.
 */
export async function sameMinuteWindow(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 8_000) await new Promise((r) => setTimeout(r, left + 50));
}
