import type { Env } from "../env";

/*
 * Chain-neutral routing configuration (Plan 4). The EVM gas reserve stays with the EVM chain table
 * (chains/evm/config.ts GAS_RESERVE); the Trocador legs' hot-wallet reserves live here.
 */

/**
 * What the Tron and Solana hot wallets always keep when they pay a Trocador route leg (src/routing/swap.ts), in
 * atomic units: 50 TRX (sun) and 0.05 SOL (lamports). A send that would leave less is refused and alerted.
 */
export const ROUTE_GAS_RESERVE = { tron: 50_000_000n, sol: 50_000_000n } as const;

/** Own (change/refund) addresses checked per routing plan: fits the explorer subrequest budget. */
export const OWN_CHECKS_PER_RUN = 10;
/** Of those, at most this many go to addresses that were funded at their last check; the rest rotate by oldest check. */
export const OWN_FUNDED_SLOTS = 5;

/** Payment sources (UTXO deposits) checked per routableInputs call (src/routing/sources.ts). */
export const PAYMENT_CHECKS_PER_RUN = 20;
/** Of those, at most this many go to sources funded at their last check; the rest rotate by oldest check. */
export const PAYMENT_FUNDED_SLOTS = 10;

/** The router's lease (router_lock): a run that died holds it at most this long. */
export const ROUTER_LOCK_TTL_MS = 10 * 60_000;
/** No router step starts once this much wall time of the run has passed (the sweepers' discipline). */
export const ROUTER_DEADLINE_MS = 20_000;
/** Executing batches of one asset visited per run (a rotating window: least recently visited first). */
export const EXECUTE_PER_ASSET = 20;
/** Batches with a leg in flight polled per asset per run (a rotating window, likewise). */
export const POLL_PER_ASSET = 50;

/**
 * The Railgun live gates for `chain`, or null when shielding there is allowed: RAILGUN_GOLDEN_OK must be "1" (the
 * master switch) AND the chain must be listed in RAILGUN_GOLDEN_OK_CHAINS (comma-separated chain ids, e.g.
 * "base,arb"; case and spaces ignored). docs/railgun-spike.md: spike each chain (and its native wrap) before listing it.
 */
export function railgunGate(env: Pick<Env, "RAILGUN_GOLDEN_OK" | "RAILGUN_GOLDEN_OK_CHAINS">, chain: string): string | null {
  if (env.RAILGUN_GOLDEN_OK !== "1") return 'RAILGUN_GOLDEN_OK is not "1" (docs/railgun-spike.md)';
  const listed = (env.RAILGUN_GOLDEN_OK_CHAINS ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  if (!listed.includes(chain)) return `${chain} is not listed in RAILGUN_GOLDEN_OK_CHAINS (spike each chain and its native wrap first: docs/railgun-spike.md)`;
  return null;
}
