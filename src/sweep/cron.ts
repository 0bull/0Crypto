import { EVM_CHAINS, isEvmChain, type EvmChain } from "../chains/evm/config";
import { chainConfigError } from "../chains/registry";
import type { ChainId } from "../core/types";
import { recordAlert } from "../db/alerts";
import { enqueueNonInvoiceEvents } from "../webhooks/outbox";
import { SWEEP_AFTER_EXPIRY_MS } from "../db/repo";
import type { Env } from "../env";
import { FACTORY_NOT_DEPLOYED, runEvmSweep } from "./evm";
import { runSolanaSweep } from "./solana";
import { runTronSweep } from "./tron";

/** What one chain's sweeper did in one run (EVM, Tron and Solana sweepers). */
export type SweepResult = {
  status: "idle" | "sent" | "skipped" | "failed";
  tx?: string;
  reason?: string;
  paymentIds: string[];
};

/** Confirmed deposits unswept for this long on a chain that cannot sweep raise sweep.stuck (as do due partial and
 * expired-with-unexpected payments, past expiry + 7 days + 1 hour). */
const STUCK_AFTER_MS = 86_400_000;

/**
 * Runs every configured chain's sweeper (cron, every 15 minutes). A chain that throws is logged (chain and error name
 * only) and reported as failed; it never stops the others. Also raises sweep.stuck for chains that hold unswept deposits
 * that are due (confirmed over 24 hours ago; partial, or expired with unexpected deposits, past the sweep window) but
 * cannot sweep (not configured, or no factory). Tron and Solana run only when their chainConfigError is null, after every
 * EVM chain has finished.
 */
export async function runSweeps(env: Env, now: number): Promise<Partial<Record<ChainId, SweepResult>>> {
  const all: (EvmChain | "tron" | "sol")[] = [...(Object.keys(EVM_CHAINS) as EvmChain[]), "tron", "sol"];
  const configured = all.filter((c) => chainConfigError(env, c) === null);
  const out: Partial<Record<ChainId, SweepResult>> = {};
  // Wall time, for the Tron and Solana deadline (RUN_DEADLINE_MS from here); `now` is the run's logical time.
  const startedAt = Date.now();
  const one = async (chain: EvmChain | "tron" | "sol") => {
    try {
      out[chain] =
        chain === "tron" ? await runTronSweep(env, now, { startedAt }) : chain === "sol" ? await runSolanaSweep(env, now, { startedAt }) : await runEvmSweep(env, chain, now);
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      console.warn(`0crypto: sweep ${chain} failed: ${name}`);
      out[chain] = { status: "failed", reason: name, paymentIds: [] };
    }
  };
  // EVM chains in parallel first, then Tron and Solana: a Worker has only a few simultaneous outgoing connections, and
  // a queued TronSave buy or Solana send must not time out behind hung EVM RPC connections. Tron and Solana start no
  // new step once RUN_DEADLINE_MS (20 s) of this run's wall time have passed, EVM time included.
  await Promise.all(configured.filter(isEvmChain).map(one));
  await Promise.all(configured.filter((c) => !isEvmChain(c)).map(one));
  for (const chain of all) {
    // Tron raises its own deduped sweep.stuck when TRONSAVE_API_KEY is missing (runTronSweep).
    if (configured.includes(chain) && out[chain]?.reason !== FACTORY_NOT_DEPLOYED) continue;
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.chain=?1 AND p.swept_at IS NULL AND (
           (p.status='confirmed' AND COALESCE(p.confirmed_at,p.created_at)<?2)
           OR (p.status='partial' AND i.expires_at+?4<?3)
           OR (p.status='expired' AND p.unexpected IS NOT NULL AND i.expires_at+?4<?3))`,
      )
        .bind(chain, now - STUCK_AFTER_MS, now, SWEEP_AFTER_EXPIRY_MS)
        .first<{ n: number }>();
      if (row && row.n > 0)
        await recordAlert(env.DB, "sweep.stuck", chain, `${row.n} deposit(s) on ${chain} are due for a sweep (confirmed over 24 hours ago, or partial/expired past the sweep window) but ${chain} ${configured.includes(chain) ? "has no forwarder factory deployed" : "is not configured"}`, now);
    } catch (e) {
      console.warn(`0crypto: stuck check ${chain} failed: ${e instanceof Error ? e.name : "Error"}`);
    }
  }
  // sweep.insufficient_gas alerts are webhooks too: enqueue them now that they are committed.
  await enqueueNonInvoiceEvents(env, now).catch((e) => console.warn(`0crypto: enqueueing sweep events failed: ${e instanceof Error ? e.name : "Error"}`));
  return out;
}
