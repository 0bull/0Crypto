import { serializeInvoice } from "../api/serialize";
import { getEvent, getInvoice, listPayments, recordDelivery } from "../db/repo";
import type { Env, WebhookJob } from "../env";
import { NON_INVOICE_EVENTS, nonInvoiceEventData } from "./routing";
import { signWebhook } from "./sign";

const retryDelay = (attempts: number): number => Math.min(30 * 2 ** attempts, 21600);

/**
 * POSTs `body` to `url` with the `0crypto-signature` header (HMAC with WEBHOOK_SECRET). The only place a webhook is
 * signed. Never throws: `status` is 0 when no response came back, and `error` is null only for a 2xx answer.
 */
export async function postSigned(env: Env, url: string, body: string): Promise<{ status: number; error: string | null }> {
  const t = Math.floor(Date.now() / 1000);
  const signature = await signWebhook(env.WEBHOOK_SECRET, body, t);
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "0crypto-signature": signature,
        "user-agent": "0crypto-webhooks/1",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!(res.status >= 200 && res.status < 300)) error = `HTTP ${res.status}`;
    await res.body?.cancel();
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    error = `${name}: ${name === "TimeoutError" ? "timeout" : "network error"}`;
  }
  return { status, error };
}

/** Sends a `webhook.test` event (not stored, not retried) so the merchant can check their endpoint and signature check. */
export async function sendTestEvent(env: Env, url: string, now: number): Promise<{ status: number; error: string | null }> {
  const id = "evt_test_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const body = JSON.stringify({ id, type: "webhook.test", created_at: new Date(now).toISOString(), data: {} });
  return postSigned(env, url, body);
}

async function deliver(msg: Message<WebhookJob>, env: Env, url: string): Promise<void> {
  const { eventId } = msg.body;
  const event = await getEvent(env.DB, eventId);
  if (!event) {
    console.warn(`webhook: event ${eventId} not found, dropping`);
    msg.ack();
    return;
  }
  let data: unknown;
  if (NON_INVOICE_EVENTS.has(event.type)) {
    // Routing events carry the route batch id (sweep.insufficient_gas and refund.approved the alert id) where invoice events carry the invoice.
    const b = event.type.startsWith("routing.") ? await env.DB.prepare("SELECT chunks FROM route_batches WHERE id=?").bind(event.invoice_id).first<{ chunks: string }>() : null;
    let chunkCount: number | null = null;
    try {
      chunkCount = b ? (JSON.parse(b.chunks) as unknown[]).length : null;
    } catch {
      chunkCount = null;
    }
    data = nonInvoiceEventData(event.type, event.invoice_id, event.payload, chunkCount);
  } else {
    const inv = await getInvoice(env.DB, event.invoice_id);
    if (!inv) {
      console.warn(`webhook: invoice ${event.invoice_id} for event ${eventId} not found, dropping`);
      msg.ack();
      return;
    }
    data = serializeInvoice(inv, await listPayments(env.DB, inv.id), env.PUBLIC_URL);
    if (event.type === "subscription.invoice_created") {
      // The invoice payload plus the subscription it was billed for; the merchant mails `checkout_url` (the gateway never emails).
      let sid: unknown = null;
      try {
        sid = (JSON.parse(event.payload) as { subscription_id?: unknown }).subscription_id;
      } catch {
        sid = null;
      }
      data = { ...(data as object), subscription_id: typeof sid === "string" ? sid : null, checkout_url: (data as { checkout_url: string }).checkout_url };
    }
  }
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: new Date(event.created_at).toISOString(),
    data,
  });
  const { status, error } = await postSigned(env, url, body);

  try {
    await recordDelivery(env.DB, { event_id: eventId, attempt: msg.attempts, at: Date.now(), status, error });
  } catch (e) {
    console.warn(`webhook: failed to record delivery for ${eventId} (${e instanceof Error ? e.name : "Error"})`);
  }

  if (error === null) msg.ack();
  else msg.retry({ delaySeconds: retryDelay(msg.attempts) });
}

export async function handleWebhookBatch(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
  const url = env.WEBHOOK_URL;
  for (const msg of batch.messages) {
    if (!url) {
      msg.ack();
      continue;
    }
    try {
      await deliver(msg, env, url);
    } catch (e) {
      console.warn(`webhook: unexpected error for ${msg.body.eventId} (${e instanceof Error ? e.name : "Error"})`);
      msg.retry({ delaySeconds: retryDelay(msg.attempts) });
    }
  }
}
