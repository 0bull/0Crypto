/*
 * The EVM hot wallet's nonce lease, one per chain (table hot_nonce_lease, migration 0016). Every send from the hot
 * wallet that takes a NEW nonce (an EVM sweep, a Railgun shield step, a dashboard refund) holds it from reading the
 * pending nonce until its broadcast returned, so two senders never sign the same nonce (one would replace or drop the
 * other). Replacements at a recorded nonce (fee bumps) do not need it. A holder that died keeps it at most
 * HOT_NONCE_LEASE_MS. Refunds that find it held refuse with 409; the router's shield step waits for the next run; a
 * sweep skips this run.
 */

/** How long a hot-wallet send may hold the chain's nonce lease (one nonce read, sign, broadcast: seconds). */
export const HOT_NONCE_LEASE_MS = 2 * 60_000;

export const HOT_WALLET_BUSY = "the hot wallet is sending another transaction on this chain (a sweep, shield or refund); try again in a few minutes";

/** Takes `chain`'s lease if it is free or expired; true if `holder` holds it now. */
export async function acquireHotNonce(db: D1Database, chain: string, holder: string, now: number): Promise<boolean> {
  await db
    .prepare(
      "INSERT INTO hot_nonce_lease(chain,holder,expires_at) VALUES(?1,?2,?3) ON CONFLICT(chain) DO UPDATE SET holder=?2, expires_at=?3 WHERE COALESCE(hot_nonce_lease.expires_at,0) < ?4 OR hot_nonce_lease.holder=?2",
    )
    .bind(chain, holder, now + HOT_NONCE_LEASE_MS, now)
    .run();
  const row = await db.prepare("SELECT holder FROM hot_nonce_lease WHERE chain=?").bind(chain).first<{ holder: string | null }>();
  return row?.holder === holder;
}

/** True while `holder` holds `chain`'s unexpired lease (judged at the later of `now` and the current time). */
export async function holdsHotNonce(db: D1Database, chain: string, holder: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT holder, expires_at FROM hot_nonce_lease WHERE chain=?").bind(chain).first<{ holder: string | null; expires_at: number | null }>();
  return row !== null && row.holder === holder && (row.expires_at ?? 0) > Math.max(now, Date.now());
}

/** Releases `chain`'s lease, only if `holder` still holds it. */
export async function releaseHotNonce(db: D1Database, chain: string, holder: string): Promise<void> {
  await db.prepare("UPDATE hot_nonce_lease SET holder=NULL, expires_at=0 WHERE chain=? AND holder=?").bind(chain, holder).run();
}

/** Runs `f` holding `chain`'s lease, or returns `busy` without running it. */
export async function withHotNonce<T>(db: D1Database, chain: string, holder: string, now: number, busy: () => T | Promise<T>, f: () => Promise<T>): Promise<T> {
  if (!(await acquireHotNonce(db, chain, holder, now))) return busy();
  try {
    return await f();
  } finally {
    await releaseHotNonce(db, chain, holder);
  }
}
