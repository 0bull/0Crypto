// Plan 9 Task 1: assets.run_worker_first is a list, so static files are served without waking the Worker while every
// Worker route (and any path with no matching asset) still reaches it.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { clearSettingsCache } from "../../src/settings";

const BASE = "https://pay.test";
beforeEach(async () => {
  await applyD1Migrations((env as unknown as Env).DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  clearSettingsCache();
});

const get = (path: string) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual" });

describe("Worker routes with assets served separately", () => {
  it("GET /healthz reaches the Worker", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("answers a path that is neither a route nor an asset with 404", async () => {
    expect((await get("/nope")).status).toBe(404);
  });

  it("reaches the Worker for checkout, API, POS and admin paths", async () => {
    // Unknown ids: the Worker's own 404/401/redirect answers, never an asset response.
    for (const path of ["/i/inv_x", "/api/v1/invoices/inv_x", "/pos", "/admin", "/admin/x"]) {
      const res = await get(path);
      expect(res.headers.get("content-type") ?? "", path).not.toMatch(/text\/css|javascript/);
    }
  });

  it("still serves static files through the assets binding", async () => {
    for (const path of ["/admin.css", "/checkout.css"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/text\/css/);
    }
  });
});
