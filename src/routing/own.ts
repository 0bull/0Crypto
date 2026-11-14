import { accountFromSeed, deriveUtxoAddress } from "../chains/utxo/derive";
import type { UtxoChain } from "../chains/utxo/networks";
import { startIndex } from "../chains/registry";
import type { Env } from "../env";

/*
 * Our own UTXO change and refund addresses (migration 0012, table own_addresses). Each is a fresh deposit-chain index
 * allocated from the chain's derivation counter; the counter step and the own_addresses row are written in ONE D1
 * batch (a transaction), so an index the executor reserved is never left unrecorded (and its funds never forgotten).
 */

export type OwnPurpose = "change" | "refund";

/** Attempts before giving up when the counter keeps moving under us (another allocation won each time). */
const MAX_ATTEMPTS = 5;

/**
 * Allocates the next index of `chain`'s derivation counter for our own use and records the address in
 * own_addresses, atomically: the counter is advanced by compare-and-set from the value read, and the row is inserted
 * only if that advance happened (changes() = 1) in the same transaction. A lost race retries with the new counter.
 * A failed insert (say the address is already recorded) rolls the counter back with it.
 */
export async function allocateOwnAddress(env: Pick<Env, "DB" | "MASTER_SEED"> & Parameters<typeof startIndex>[0], chain: UtxoChain, purpose: OwnPurpose, now: number): Promise<{ index: number; address: string }> {
  const account = accountFromSeed(env.MASTER_SEED ?? "", chain);
  const start = startIndex(env, chain);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const row = await env.DB.prepare("SELECT next FROM derivation_counters WHERE chain=?").bind(chain).first<{ next: number }>();
    const index = Math.max(row?.next ?? 0, start);
    const address = deriveUtxoAddress(account, chain, index);
    const [advance] = await env.DB.batch([
      env.DB.prepare("INSERT INTO derivation_counters(chain,next) VALUES(?1,?2+1) ON CONFLICT(chain) DO UPDATE SET next=?2+1 WHERE derivation_counters.next IS ?3").bind(chain, index, row?.next ?? null),
      env.DB.prepare("INSERT INTO own_addresses(chain,address,derivation_index,purpose,created_at) SELECT ?1,?2,?3,?4,?5 WHERE changes()=1").bind(chain, address, index, purpose, now),
    ]);
    if ((advance!.meta.changes ?? 0) === 1) {
      const rec = await env.DB.prepare("SELECT 1 AS ok FROM own_addresses WHERE address=? AND derivation_index=?").bind(address, index).first<{ ok: number }>();
      if (!rec) throw new Error(`own address ${index} on ${chain} was allocated but not recorded`);
      return { index, address };
    }
  }
  throw new Error(`could not allocate an own ${chain} address: the derivation counter kept moving`);
}

export interface OwnSource {
  address: string;
  index: number;
}

/**
 * The own addresses of `chain` to check this run: up to `fundedSlots` that were funded at their last check (oldest
 * check first), then the rest of `n` by oldest checked_at (never checked first, then by age): a rotating cursor, so
 * every own address is checked within ceil(count / (n - fundedSlots)) runs whatever its age.
 */
export async function ownSourcesToCheck(db: D1Database, chain: UtxoChain, n: number, fundedSlots: number): Promise<OwnSource[]> {
  const funded = (
    await db
      .prepare("SELECT address, derivation_index FROM own_addresses WHERE chain=? AND last_seen_funded_at IS NOT NULL AND last_seen_funded_at=checked_at ORDER BY checked_at, address LIMIT ?")
      .bind(chain, Math.min(fundedSlots, n))
      .all<{ address: string; derivation_index: number }>()
  ).results;
  const rest = (
    await db
      .prepare(
        `SELECT address, derivation_index FROM own_addresses WHERE chain=?1 AND address NOT IN (SELECT value FROM json_each(?2))
         ORDER BY COALESCE(checked_at, -1), created_at, address LIMIT ?3`,
      )
      .bind(chain, JSON.stringify(funded.map((f) => f.address)), n - funded.length)
      .all<{ address: string; derivation_index: number }>()
  ).results;
  return [...funded, ...rest].map((r) => ({ address: r.address, index: r.derivation_index }));
}

/** Records a check: checked_at = now, and last_seen_funded_at = now when spendable funds were found. */
export function markOwnChecked(db: D1Database, address: string, funded: boolean, now: number): D1PreparedStatement {
  return db.prepare("UPDATE own_addresses SET checked_at=?1, last_seen_funded_at=CASE WHEN ?2 THEN ?1 ELSE last_seen_funded_at END WHERE address=?3").bind(now, funded ? 1 : 0, address);
}
