import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env, WebhookJob } from "../../src/env";
import { DLQ_NAME } from "../../src/webhooks/dead";

const e = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const msgs = (...ids: string[]) => ids.map((id, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 6, body: { eventId: id } }));
const count = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind='webhook.dead' AND resolved_at IS NULL").first<{ n: number }>())!.n;

describe("dead-letter queue consumer", () => {
  it("records one webhook.dead alert per batch and acks every message", async () => {
    const batch = createMessageBatch<WebhookJob>(DLQ_NAME, msgs("evt_d1", "evt_d2"));
    const ctx = createExecutionContext();
    await worker.queue!(batch as MessageBatch<unknown>, e);
    const r = await getQueueResult(batch, ctx);
    expect(r.ackAll).toBe(true);
    expect(r.retryMessages).toEqual([]);
    expect(await count()).toBe(1);
    const a = await env.DB.prepare("SELECT detail FROM alerts WHERE kind='webhook.dead'").first<{ detail: string }>();
    expect(a?.detail).toContain("2 webhook event(s) failed every delivery attempt (last: evt_d2)");
  });

  it("dedupes a second batch within 6 hours", async () => {
    const batch = createMessageBatch<WebhookJob>(DLQ_NAME, msgs("evt_d3"));
    const ctx = createExecutionContext();
    await worker.queue!(batch as MessageBatch<unknown>, e);
    const r = await getQueueResult(batch, ctx);
    expect(r.ackAll).toBe(true);
    expect(await count()).toBe(1);
  });

  it("leaves the main queue to the webhook consumer", async () => {
    const before = await count();
    const batch = createMessageBatch<WebhookJob>("0crypto-webhooks", msgs("evt_missing"));
    const ctx = createExecutionContext();
    await worker.queue!(batch as MessageBatch<unknown>, e);
    const r = await getQueueResult(batch, ctx);
    expect(r.explicitAcks).toEqual(["m0"]); // no URL in the test env: acked by handleWebhookBatch
    expect(await count()).toBe(before); // the main queue records no webhook.dead alert
  });
});
