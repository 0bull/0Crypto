// Where passkey ceremonies may run (src/admin/rp.ts) and the admin's http → https redirect.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { httpsUpgrade, isIpLiteral, publicRp, requestRp } from "../../src/admin/rp";
import type { Env } from "../../src/env";
import { signedIn } from "../admin-session";

const e = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await signedIn(e); // claimed, so /admin/login is a public page
});

describe("http → https", () => {
  it("answers 308 to https for http on any non-loopback host, GET and POST, keeping path and query", async () => {
    const g = await exports.default.fetch("http://shop.test/admin/login?x=1", { redirect: "manual" });
    expect(g.status).toBe(308);
    expect(g.headers.get("location")).toBe("https://shop.test/admin/login?x=1");
    const p = await exports.default.fetch("http://pay.test:8080/admin/login/options", { method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: "x" }) });
    expect(p.status).toBe(308);
    expect(p.headers.get("location")).toBe("https://pay.test:8080/admin/login/options");
    for (const ip of ["http://203.0.113.5/admin/login", "http://localhost.evil.test/admin/login"])
      expect((await exports.default.fetch(ip, { redirect: "manual" })).status, ip).toBe(308);
  });
  it("leaves http on localhost, 127.0.0.1 and [::1] alone", async () => {
    for (const u of ["http://localhost:8787/admin/login", "http://127.0.0.1:8787/admin/login", "http://[::1]:8787/admin/login"])
      expect((await exports.default.fetch(u, { redirect: "manual" })).status, u).toBe(200);
    expect(httpsUpgrade("https://shop.test/admin")).toBeNull();
  });
});

describe("rp rules", () => {
  it("isIpLiteral: IPv4 and IPv6 literals, not names", () => {
    for (const h of ["127.0.0.1", "203.0.113.5", "[::1]", "[2001:db8::1]"]) expect(isIpLiteral(h), h).toBe(true);
    for (const h of ["localhost", "pay.test", "1.2.3.example"]) expect(isIpLiteral(h), h).toBe(false);
    expect(isIpLiteral(new URL("http://0x7f.1/").hostname)).toBe(true); // URL canonicalises IPv4
  });
  it("publicRp: only PUBLIC_URL's exact origin (scheme, host and port), never an IP literal", () => {
    const env = { PUBLIC_URL: "https://pay.test" };
    expect(publicRp(env, "https://pay.test/admin/login", "/admin/login")).toEqual({ ok: true, rp: { rpId: "pay.test", origin: "https://pay.test" } });
    expect(publicRp(env, "https://pay.test:8443/admin/login", "/admin/login")).toMatchObject({ ok: false, error: "Open https://pay.test/admin/login", reason: "elsewhere" });
    expect(publicRp({ PUBLIC_URL: "https://localhost:8787" }, "http://localhost:8787/admin/login", "/admin/login")).toMatchObject({
      ok: false,
      error: "Open https://localhost:8787/admin/login",
    });
    expect(publicRp({ PUBLIC_URL: "http://127.0.0.1:8787" }, "http://127.0.0.1:8787/admin/login", "/admin/login")).toMatchObject({
      ok: false,
      error: "Passkeys cannot use an IP address. Open http://localhost:8787/admin/login instead.",
    });
    expect(publicRp({ PUBLIC_URL: "" }, "https://pay.test/admin/login", "/admin/login").ok).toBe(false);
  });
  it("requestRp: the request's origin; with a pinning var, only that origin", () => {
    const unpinned = { ...e, PUBLIC_URL: "" } as Env;
    expect(requestRp(unpinned, "https://shop.test/admin/setup", "/admin/setup")).toEqual({ ok: true, rp: { rpId: "shop.test", origin: "https://shop.test" } });
    expect(requestRp(unpinned, "http://localhost:8787/admin/setup", "/admin/setup")).toEqual({ ok: true, rp: { rpId: "localhost", origin: "http://localhost:8787" } });
    expect(requestRp(unpinned, "http://[::1]:8787/admin/setup", "/admin/setup")).toMatchObject({
      ok: false,
      error: "Passkeys cannot use an IP address. Open http://localhost:8787/admin/setup instead.",
    });
    expect(requestRp(unpinned, "https://203.0.113.5/admin/setup", "/admin/setup")).toMatchObject({
      ok: false,
      error: "Passkeys cannot use an IP address. Open the gateway on its domain name instead.",
    });
    const pinned = { ...e, PUBLIC_URL: "https://pay.test" } as Env;
    expect(requestRp(pinned, "https://pay.test/admin/recover", "/admin/recover").ok).toBe(true);
    expect(requestRp(pinned, "https://new.test/admin/recover", "/admin/recover")).toMatchObject({
      ok: false,
      error: "PUBLIC_URL is set by a Wrangler var to https://pay.test: open https://pay.test/admin/recover, or change the var.",
    });
  });
});
