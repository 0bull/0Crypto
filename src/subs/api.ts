import { Hono } from "hono";
import { requireApiKey } from "../api/auth";
import { apiError } from "../api/errors";
import { parsePage } from "../api/page";
import type { Env } from "../env";
import { createSubscription, deactivateSubscription, getSubscription, listSubscriptionsPage, parseSubscriptionInput, serializeSubscription } from "./store";

export const subsApi = new Hono<{ Bindings: Env }>();
subsApi.onError((e, c) => {
  console.error("api error:", e instanceof Error ? e.name : "Error");
  return apiError(c, "internal_error", "internal error");
});

subsApi.post("/", requireApiKey, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_request", "body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return apiError(c, "invalid_request", "body must be a JSON object");
  const b = body as Record<string, unknown>;
  const now = Date.now();
  const p = parseSubscriptionInput({ label: b.label, price_amount: b.price_amount, price_currency: b.price_currency, interval: b.interval, start_at: b.start_at, metadata: b.metadata }, now);
  if (!p.ok) return apiError(c, "invalid_request", p.message);
  return c.json(serializeSubscription(await createSubscription(c.env.DB, p.value, now)), 201);
});

subsApi.get("/", requireApiKey, async (c) => {
  const p = parsePage((k) => c.req.query(k));
  if (!p.ok) return apiError(c, "invalid_request", p.message);
  const { subscriptions, next } = await listSubscriptionsPage(c.env.DB, p.page);
  return c.json({ subscriptions: subscriptions.map(serializeSubscription), next_cursor: next });
});

subsApi.delete("/:id", requireApiKey, async (c) => {
  if (!(await deactivateSubscription(c.env.DB, c.req.param("id")))) return apiError(c, "not_found", "subscription not found");
  return c.json(serializeSubscription((await getSubscription(c.env.DB, c.req.param("id")))!));
});
