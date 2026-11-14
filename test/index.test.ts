import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

// Every request reads the D1 settings first (src/settings.ts effectiveEnv).
beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

it("serves /healthz", async () => {
  const res = await exports.default.fetch("https://example.com/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
