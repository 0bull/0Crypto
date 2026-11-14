import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { instanceKey, rotateWebhookKey } from "../../src/keys";

const e = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

const count = async (name: string) =>
  (await e.DB.prepare("SELECT count(*) AS n FROM instance_keys WHERE name=?").bind(name).first<{ n: number }>())!.n;

describe("instanceKey", () => {
  it("is created once: 10 concurrent callers all get the same key and one row exists", async () => {
    const keys = await Promise.all(Array.from({ length: 10 }, () => instanceKey(e.DB, "session")));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await count("session")).toBe(1);
    expect(await instanceKey(e.DB, "session")).toBe(keys[0]);
  });
  it("keeps session and webhook keys apart", async () => {
    expect(await instanceKey(e.DB, "webhook")).not.toBe(await instanceKey(e.DB, "session"));
  });
});

describe("rotateWebhookKey", () => {
  it("returns a new key that instanceKey then returns", async () => {
    const before = await instanceKey(e.DB, "webhook");
    const fresh = await rotateWebhookKey(e.DB);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(before);
    expect(await instanceKey(e.DB, "webhook")).toBe(fresh);
    expect(await count("webhook")).toBe(1);
  });
  it("creates the webhook key when none exists yet", async () => {
    await e.DB.prepare("DELETE FROM instance_keys WHERE name='webhook'").run();
    const fresh = await rotateWebhookKey(e.DB);
    expect(await instanceKey(e.DB, "webhook")).toBe(fresh);
  });
});
