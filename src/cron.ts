import type { Env } from "./env";
import { checkLightning } from "./chains/lightning/adapter";
import { chainConfigError } from "./chains/registry";
import { hasOpenInvoices, refreshPrices } from "./prices/cache";
import { runRouter } from "./routing/router";
import { runSubscriptions } from "./subs/cron";
import { runSweeps } from "./sweep/cron";
import { expireStaleInvoices } from "./watcher/expiry";
import { requeuePendingEvents } from "./webhooks/outbox";

/** One cron expression per job (wrangler.jsonc `triggers.crons` lists exactly these). Cloudflare fires each as its own invocation. */
export const CRONS = {
  minute: "* * * * *",
  sweeps: "*/15 * * * *",
  routing: "5-59/15 * * * *",
  subscriptions: "0 * * * *",
  lightning: "30 * * * *",
} as const;

export type CronJob = keyof typeof CRONS;

/** The job an expression belongs to (exact match), or null with a warning for one this Worker does not schedule. */
export function jobFor(cron: string): CronJob | null {
  for (const job of Object.keys(CRONS) as CronJob[]) if (CRONS[job] === cron) return job;
  console.warn(`0crypto: unknown cron ${JSON.stringify(cron)}`);
  return null;
}

const lightningEnabled = (env: Env): boolean =>
  env.ENABLED_ASSETS.split(",").some((a) => a.trim() === "ln:btc") && chainConfigError(env, "ln") === null;

/** Runs one job, logging only the error name so one failure never stops the others. */
const guarded = (name: string, p: Promise<unknown>) => p.catch((e) => console.warn(`${name} failed:`, e?.name ?? "Error"));

/** The scheduled handler body. `env` is already the effective env (src/settings.ts). */
export async function runScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const job = jobFor(controller.cron);
  if (!job) return;
  const now = Date.now();
  switch (job) {
    case "minute":
      // Only while an invoice can still be paid; invoice creation, routing and late credits refresh inline on a stale or missing price.
      ctx.waitUntil(guarded("refreshPrices", hasOpenInvoices(env.DB, now).then((open) => (open ? refreshPrices(env) : undefined))));
      ctx.waitUntil(guarded("requeuePendingEvents", requeuePendingEvents(env, now)));
      ctx.waitUntil(guarded("expireStaleInvoices", expireStaleInvoices(env, now)));
      break;
    case "sweeps":
      ctx.waitUntil(guarded("runSweeps", runSweeps(env, now)));
      break;
    case "routing":
      ctx.waitUntil(guarded("runRouter", runRouter(env, now)));
      break;
    case "subscriptions":
      ctx.waitUntil(guarded("runSubscriptions", runSubscriptions(env, now)));
      break;
    case "lightning":
      // Re-runs the NWC get_info capability check (and its alerts) once its 24 h cache has lapsed; only when ln:btc is offered
      // (an NWC_URI alone does not turn Lightning on), within checkLightning's 20 s overall deadline.
      if (lightningEnabled(env)) ctx.waitUntil(guarded("checkLightning", checkLightning(env)));
      break;
  }
}
