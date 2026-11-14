import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { clearSettingsCache } from "../../src/settings";

const e = env as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/**
 * A D1 binding whose queries throw an error carrying a secret-looking message. `settingsToo: false` keeps the settings
 * read of effectiveEnv working, so the error reaches a route.
 */
const broken = (settingsToo: boolean) =>
  new Proxy(e.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          if (!settingsToo && /\b(settings|instance_keys)\b/.test(sql)) return t.prepare(sql);
          throw new TypeError("D1_ERROR: secret-detail-0123 rpc=https://key@rpc.example");
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
const brokenDb = broken(false);

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
beforeEach(() => clearSettingsCache());
afterEach(() => vi.restoreAllMocks());

describe("entry point", () => {
  it("when the settings read fails the answer is a plain 503; only the error name is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await worker.fetch(new Request("https://pay.test/", { headers: { "cf-connecting-ip": "10.99.0.3" } }), { ...e, DB: broken(true) } as Env, ctx);
    expect(r.status).toBe(503);
    const body = await r.text();
    expect(body).not.toContain("secret-detail");
    const logged = log.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret-detail");
  });
});

describe("app-level onError", () => {
  it("an unhandled error on a public page is a minimal styled 500 page; only the error name is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await worker.fetch(new Request("https://pay.test/l/lnk_aaaaaaaaaaaaaaaa", { headers: { "cf-connecting-ip": "10.99.0.1" } }), { ...e, DB: brokenDb } as Env, ctx);
    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain('href="/theme.css"');
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("secret-detail");
    expect(html).not.toContain("D1_ERROR");
    const logged = log.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret-detail");
    expect(logged).not.toContain("rpc.example");
  });
  it("JSON API errors keep their own JSON handler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await worker.fetch(new Request("https://pay.test/api/v1/links", { headers: { authorization: "Bearer 0c_live_" + "a".repeat(30), "cf-connecting-ip": "10.99.0.2" } }), { ...e, DB: brokenDb } as Env, ctx);
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ error: "internal_error" });
  });
});
