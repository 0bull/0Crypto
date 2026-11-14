// The gateway's own `/` (Plan 7 Task 10): the admin until a passkey exists, then a neutral page with the shop name only.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { clearSettingsCache, saveSettings } from "../../src/settings";
import { CSP } from "../../src/web/layout";
import { signedIn } from "../admin-session";

const e = env as unknown as Env;
const BASE = "https://pay.test";

beforeEach(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await e.DB.batch(["settings", "passkeys"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)));
  clearSettingsCache();
});

const home = () => exports.default.fetch(`${BASE}/`, { redirect: "manual" });

describe("gateway home", () => {
  it("on a fresh gateway (no passkey yet), / answers 302 to /admin", async () => {
    const r = await home();
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin");
  });

  it("once a passkey exists, / is the shop name only, with the strict CSP and same-origin assets", async () => {
    await signedIn(e);
    await saveSettings(e, { MERCHANT_NAME: "Bean Bar" });
    const r = await home();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await r.text();
    expect(html).toContain("<title>Bean Bar</title>");
    expect(html).toContain("<h1>Bean Bar</h1>");
    expect(html).not.toContain("Deploy");
    expect(html).not.toContain("0Crypto");
    const loaded = [...html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
    expect(loaded.length).toBeGreaterThan(0);
    for (const url of loaded) expect(url.startsWith("/") && !url.startsWith("//")).toBe(true);
  });

  it("without a shop name it shows the neutral default", async () => {
    await signedIn(e);
    const html = await (await home()).text();
    expect(html).toContain("<h1>Store</h1>");
    expect(html).not.toContain("0Crypto");
  });
});
