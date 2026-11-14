import { recordAlert } from "../db/alerts";
import type { Env, WebhookJob } from "../env";

/** The dead-letter queue of the webhook queue (wrangler `dead_letter_queue`). Without a consumer its messages vanish after 4 days. */
export const DLQ_NAME = "0crypto-webhooks-dlq";

/**
 * Consumes the dead-letter queue: events that failed every delivery attempt. Records one webhook.dead alert per batch
 * (deduped for 6 h by recordAlert), then acks the messages; the events stay in D1 and Developers shows each attempt.
 * If the alert cannot be recorded, the batch is retried instead of lost.
 */
export async function handleDeadLetters(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
  const n = batch.messages.length;
  const last = batch.messages[n - 1]?.body.eventId ?? "unknown";
  try {
    await recordAlert(
      env.DB,
      "webhook.dead",
      null,
      `${n} webhook event(s) failed every delivery attempt (last: ${last}). Check the webhook URL and your server; Developers shows each attempt.`,
    );
  } catch (e) {
    console.error("webhook.dead alert failed:", e instanceof Error ? e.name : "Error");
    batch.retryAll();
    return;
  }
  batch.ackAll();
}
