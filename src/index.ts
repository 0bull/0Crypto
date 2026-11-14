import { Hono } from "hono";
import type { Env, WebhookJob } from "./env";
import { admin } from "./admin/routes";
import { api } from "./api/invoices";
import { links, linksApi } from "./links/routes";
import { pos } from "./pos/routes";
import { checkout } from "./web/checkout";
import { home } from "./web/home";
import { handleWebhookBatch } from "./webhooks/consumer";
import { DLQ_NAME, handleDeadLetters } from "./webhooks/dead";
import { subsApi } from "./subs/api";
import { errorPage } from "./web/layout";
import { effectiveEnv } from "./settings";
import { runScheduled } from "./cron";

export { PaymentWatcher } from "./watcher/PaymentWatcher";

const app = new Hono<{ Bindings: Env }>();

// Anything a route did not handle (the JSON API routers have their own JSON onError): a minimal styled 500 page. Only the
// error's name is logged; its message can carry request or upstream details.
app.onError((e, c) => {
  console.error("unhandled error:", e instanceof Error ? e.name : "Error");
  return errorPage(c);
});

app.get("/healthz", (c) => c.text("ok"));
app.route("/api/v1/links", linksApi);
app.route("/api/v1/subscriptions", subsApi);
app.route("/api/v1", api);
app.route("/admin", admin);
app.route("/pos", pos);
app.route("/", home);
app.route("/", links);
app.route("/", checkout);
// Static files are served by the assets binding without the Worker (assets.run_worker_first lists only Worker paths);
// anything that reaches here and matched no route is a 404 via the assets fallback.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Every entry point resolves the effective env first (D1 settings over Wrangler vars, instance keys for blank secrets,
// src/settings.ts), so everything downstream reads env.PUBLIC_URL, env.SESSION_SECRET, ... as before.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let eff: Env;
    try {
      eff = await effectiveEnv(env);
    } catch (e) {
      // D1 unreachable (or not migrated): never fall back to the vars alone, they may name an older wallet.
      console.error("effectiveEnv failed:", e instanceof Error ? e.name : "Error");
      return new Response("Service temporarily unavailable", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" } });
    }
    return app.fetch(req, eff, ctx);
  },
  async scheduled(controller: ScheduledController, rawEnv: Env, ctx: ExecutionContext) {
    await runScheduled(controller, await effectiveEnv(rawEnv), ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    const eff = await effectiveEnv(env);
    if (batch.queue === DLQ_NAME) await handleDeadLetters(batch as MessageBatch<WebhookJob>, eff);
    else await handleWebhookBatch(batch as MessageBatch<WebhookJob>, eff);
  },
} satisfies ExportedHandler<Env>;
