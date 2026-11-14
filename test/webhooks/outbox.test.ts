import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EventRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { enqueueEvents, requeuePendingEvents } from "../../src/webhooks/outbox";

const e = env as unknown as Env;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function insertEvent(id: string, createdAt: number, enqueuedAt: number | null = null): Promise<EventRow> {
  const row: EventRow = { id, created_at: createdAt, type: "invoice.paid", invoice_id: "inv_ob", payload: "{}" };
  await env.DB.prepare("INSERT INTO events(id,created_at,type,invoice_id,payload,enqueued_at) VALUES(?,?,?,?,?,?)")
    .bind(row.id, row.created_at, row.type, row.invoice_id, row.payload, enqueuedAt)
    .run();
  return row;
}

const enqueuedAt = async (id: string) =>
  (await env.DB.prepare("SELECT enqueued_at FROM events WHERE id=?").bind(id).first<{ enqueued_at: number | null }>())
    ?.enqueued_at;

const HOOK = "https://merchant.test/hook";
const fakeQueue = (sendBatch: (msgs: { body: { eventId: string } }[]) => Promise<void>, url = HOOK) =>
  ({ ...e, WEBHOOK_URL: url, WEBHOOKS: { sendBatch } }) as unknown as Env;

describe("enqueueEvents", () => {
  it("marks rows enqueued after sendBatch succeeds", async () => {
    const ev = await insertEvent("evt_mark", NOW);
    const sendBatch = vi.fn(async () => {});
    await enqueueEvents(fakeQueue(sendBatch), [ev], NOW + 5);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { eventId: "evt_mark" } }]);
    expect(await enqueuedAt("evt_mark")).toBe(NOW + 5);
  });

  it("leaves enqueued_at NULL when sendBatch fails", async () => {
    const ev = await insertEvent("evt_fail", NOW);
    const sendBatch = vi.fn(async () => {
      throw new Error("queue down");
    });
    await expect(enqueueEvents(fakeQueue(sendBatch), [ev], NOW)).rejects.toThrow("queue down");
    expect(await enqueuedAt("evt_fail")).toBeNull();
  });
});

describe("enqueueEvents without a webhook URL", () => {
  it("sends nothing but marks the rows handled", async () => {
    const a = await insertEvent("evt_nourl_a", NOW);
    const b = await insertEvent("evt_nourl_b", NOW);
    const sendBatch = vi.fn(async () => {});
    await enqueueEvents(fakeQueue(sendBatch, ""), [a, b], NOW + 7);
    expect(sendBatch).toHaveBeenCalledTimes(0);
    expect(await enqueuedAt("evt_nourl_a")).toBe(NOW + 7);
    expect(await enqueuedAt("evt_nourl_b")).toBe(NOW + 7);
  });

  it("sends once with a URL", async () => {
    const a = await insertEvent("evt_url_a", NOW);
    const b = await insertEvent("evt_url_b", NOW);
    const sendBatch = vi.fn(async () => {});
    await enqueueEvents(fakeQueue(sendBatch, HOOK), [a, b], NOW);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("requeuePendingEvents with no URL leaves no unmarked row", async () => {
    await env.DB.prepare("DELETE FROM events").run();
    await insertEvent("evt_nu_1", NOW - 120_000);
    await requeuePendingEvents(fakeQueue(async () => {}, ""), NOW);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE enqueued_at IS NULL").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("requeuePendingEvents", () => {
  it("re-enqueues unmarked events older than 60s, oldest first, and skips young or marked ones", async () => {
    await insertEvent("evt_old2", NOW - 90_000);
    await insertEvent("evt_old1", NOW - 120_000);
    await insertEvent("evt_young", NOW - 30_000);
    await insertEvent("evt_done", NOW - 120_000, NOW - 119_000);
    const sent: string[] = [];
    const sendBatch = vi.fn(async (msgs: { body: { eventId: string } }[]) => {
      sent.push(...msgs.map((m) => m.body.eventId));
    });
    await requeuePendingEvents(fakeQueue(sendBatch), NOW);
    expect(sent.filter((id) => id.startsWith("evt_old") || id === "evt_young" || id === "evt_done")).toEqual([
      "evt_old1",
      "evt_old2",
    ]);
    expect(await enqueuedAt("evt_old1")).toBe(NOW);
    expect(await enqueuedAt("evt_old2")).toBe(NOW);
    expect(await enqueuedAt("evt_young")).toBeNull();
    expect(await enqueuedAt("evt_done")).toBe(NOW - 119_000);
  });

  it("caps one run at 500 events", async () => {
    const stmts = Array.from({ length: 501 }, (_, i) =>
      env.DB.prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) VALUES(?,?,?,?,?)").bind(
        `evt_cap_${String(i).padStart(3, "0")}`,
        NOW - 10 * 86_400_000 + i,
        "invoice.paid",
        "inv_cap",
        "{}",
      ),
    );
    await env.DB.batch(stmts);
    const sent: string[] = [];
    await requeuePendingEvents(
      fakeQueue(async (msgs) => {
        sent.push(...msgs.map((m) => m.body.eventId));
      }),
      NOW,
    );
    expect(sent).toHaveLength(500);
    expect(sent[0]).toBe("evt_cap_000");
    expect(await enqueuedAt("evt_cap_500")).toBeNull();
  });
});
