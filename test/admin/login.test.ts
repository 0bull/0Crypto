// Passkey sign-in and sign-out (Plan 7 Task 7). Sign-in uses PUBLIC_URL's host only (Review Focus 1).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { preAuth, signedIn, type AdminTestSession } from "../admin-session";
import { call, cookiePair, e, freshIp, options, preAuthPage, setCookieOf } from "../auth-flow";
import { SoftAuthenticator } from "../passkey";
import { sameMinuteWindow } from "../rate-window";

const BASE = "https://pay.test";
const REFUSED = "That passkey was not accepted. Try again or use “Lost your passkey or moved?”";
let S: AdminTestSession;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  S = await signedIn(e); // the owner's passkey (S.authenticator) is registered
});

/** The sign-in page, options for it and an assertion by `auth` (default: the owner's passkey). */
async function assertion(auth: SoftAuthenticator = S.authenticator, origin = BASE) {
  const page = await preAuthPage(`${BASE}/admin/login`);
  const o = await options<PublicKeyCredentialRequestOptionsJSON>(`${BASE}/admin/login/options`, { cookie: page.cookie, form: { csrf: page.csrf } });
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  return { page, options: o.body.options!, assertion: JSON.stringify(await auth.assert(o.body.options!, origin)) };
}

describe("sign-in page", () => {
  it("offers a passkey button with autofill and the recovery link", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/login`);
    expect(r.status).toBe(200);
    expect(html).toContain('data-passkey-login="/admin/login/options"');
    expect(html).toContain("Sign in with passkey");
    expect(html).toMatch(/<input[^>]*name="username"[^>]*autocomplete="username webauthn"|<input[^>]*autocomplete="username webauthn"[^>]*name="username"/);
    expect(html).toContain('name="assertion"');
    expect(html).toContain('href="/admin/recover"');
    expect(html).toContain("Lost your passkey or moved to a new domain?");
    expect(html).not.toMatch(/type="password"/);
  });

  it("on a host other than PUBLIC_URL names the right host, offers recovery and starts no ceremony", async () => {
    const r = await call("https://other.test/admin/login");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Sign in at https://pay.test");
    expect(html).toContain('href="https://pay.test/admin/login"');
    expect(html).toContain('href="/admin/recover"');
    expect(html).not.toContain("data-passkey-login");
    // No form on that page; a pre-auth cookie and token for other.test, as any page there would hand out.
    const page = await preAuth(e, "https://other.test");
    const o = await options("https://other.test/admin/login/options", { cookie: page.cookie, form: { csrf: page.csrf } });
    expect(o.status).toBe(400);
    expect(o.body.error).toContain("https://pay.test");
  });

  it("compares the origin, not the host: http://localhost:8787 is not PUBLIC_URL https://localhost:8787", async () => {
    const env = { PUBLIC_URL: "https://localhost:8787" };
    const html = await (await call("http://localhost:8787/admin/login", { env })).text();
    expect(html).not.toContain("data-passkey-login");
    expect(html).toContain("Sign in at https://localhost:8787");
    const page = await preAuth(e, "http://localhost:8787");
    const o = await options("http://localhost:8787/admin/login/options", { env, cookie: page.cookie, form: { csrf: page.csrf } });
    expect(o.status).toBe(400);
    expect(o.body.error).toBe("Open https://localhost:8787/admin/login");
    const post = await call("http://localhost:8787/admin/login", { env, cookie: page.cookie, form: { csrf: page.csrf, assertion: "{}" } });
    expect(post.status).toBe(400);
  });

  it("on an IP-literal host, says to open localhost and starts no ceremony", async () => {
    const env = { PUBLIC_URL: "http://127.0.0.1:8787" };
    const html = await (await call("http://127.0.0.1:8787/admin/login", { env })).text();
    expect(html).toContain("Open http://localhost:8787/admin/login instead.");
    expect(html).not.toContain("data-passkey-login");
    const page = await preAuth(e, "http://127.0.0.1:8787");
    const o = await options("http://127.0.0.1:8787/admin/login/options", { env, cookie: page.cookie, form: { csrf: page.csrf } });
    expect(o.status).toBe(400);
    expect(o.body.error).toContain("Open http://localhost:8787/admin/login");
  });

  it("signed in, the sign-in page goes to the dashboard", async () => {
    const r = await call(`${BASE}/admin/login`, { cookie: S.cookie });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin");
  });
});

describe("passkey sign-in", () => {
  it("options are a discoverable-credential request on PUBLIC_URL's rpId", async () => {
    const { options: o } = await assertion();
    expect(o.rpId).toBe("pay.test");
    expect(o.userVerification).toBe("required");
    expect(o.allowCredentials ?? []).toEqual([]);
  });

  it("a valid assertion signs in (303 to /admin) with a session that opens /admin, and stores the counter", async () => {
    const a = await assertion();
    const r = await call(`${BASE}/admin/login`, { cookie: a.page.cookie, form: { csrf: a.page.csrf, assertion: a.assertion } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin");
    const raw = setCookieOf(r, "__Host-0c_session")!;
    expect(raw).toMatch(/^__Host-0c_session=\d+\.\d+\.[0-9a-f]{64}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect((await call(`${BASE}/admin`, { cookie: cookiePair(raw) })).status).toBe(200);
    const row = (await e.DB.prepare("SELECT counter,last_used_at FROM passkeys WHERE id=?").bind(S.authenticator.credentialId).first<{ counter: number; last_used_at: number }>())!;
    expect(row.counter).toBe(S.authenticator.counter);
    expect(row.last_used_at).toBeGreaterThan(Date.now() - 60_000);
    // The challenge is single use: the same assertion again is refused.
    const again = await call(`${BASE}/admin/login`, { cookie: a.page.cookie, form: { csrf: a.page.csrf, assertion: a.assertion } });
    expect(again.status).toBe(401);
  });

  it("an unknown credential is 401 with the recovery hint", async () => {
    const a = await assertion(new SoftAuthenticator());
    const r = await call(`${BASE}/admin/login`, { cookie: a.page.cookie, form: { csrf: a.page.csrf, assertion: a.assertion } });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain(REFUSED);
    expect(setCookieOf(r, "__Host-0c_session")).toBeUndefined();
  });

  it("an empty or malformed assertion is 401", async () => {
    const page = await preAuthPage(`${BASE}/admin/login`);
    for (const assertion of ["", "{", "[]", JSON.stringify({ id: "!!" })])
      expect((await call(`${BASE}/admin/login`, { cookie: page.cookie, form: { csrf: page.csrf, assertion } })).status, assertion).toBe(401);
  });

  it("an assertion for another origin is 401", async () => {
    const a = await assertion(S.authenticator, "https://other.test");
    expect((await call(`${BASE}/admin/login`, { cookie: a.page.cookie, form: { csrf: a.page.csrf, assertion: a.assertion } })).status).toBe(401);
  });

  it("a challenge issued to one browser does not sign in another", async () => {
    const a = await assertion();
    const b = await preAuthPage(`${BASE}/admin/login`);
    expect((await call(`${BASE}/admin/login`, { cookie: b.cookie, form: { csrf: b.csrf, assertion: a.assertion } })).status).toBe(401);
  });

  it("an action-confirmation challenge does not sign in", async () => {
    const actionAssertion = await S.confirm("key.revoke", "/admin/developers/keys/revoke", { id: "f".repeat(16) });
    const page = await preAuthPage(`${BASE}/admin/login`);
    expect((await call(`${BASE}/admin/login`, { cookie: page.cookie, form: { csrf: page.csrf, assertion: actionAssertion } })).status).toBe(401);
  });

  it("one client is limited on options (429) while another still gets them", async () => {
    await sameMinuteWindow();
    const page = await preAuthPage(`${BASE}/admin/login`);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call(`${BASE}/admin/login/options`, { ip, cookie: page.cookie, form: { csrf: page.csrf } })).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await call(`${BASE}/admin/login/options`, { cookie: page.cookie, form: { csrf: page.csrf } })).status).toBe(200);
  });
});

describe("a flood of sign-in starts", () => {
  it("never locks the owner out: starting a sign-in stores nothing, so nothing can be evicted", async () => {
    const exp = Date.now() + 300_000;
    // A flood from two addresses at their per-client limit keeps the login kind full (and past it).
    await e.DB.batch(
      Array.from({ length: 600 }, (_, i) => e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`flood${i}`, "login", "x", exp - 1000 + i)),
    );
    const loginRows = async () => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind='login'").first<{ n: number }>())!.n;
    try {
      const a = await assertion();
      const before = await loginRows();
      // The flood goes on while the owner signs in.
      for (let i = 0; i < 20; i++) {
        const p = await preAuthPage(`${BASE}/admin/login`);
        expect((await call(`${BASE}/admin/login/options`, { cookie: p.cookie, form: { csrf: p.csrf } })).status).toBe(200);
      }
      expect(await loginRows()).toBe(before); // issuing a pre-sign-in challenge writes no row
      const r = await call(`${BASE}/admin/login`, { cookie: a.page.cookie, form: { csrf: a.page.csrf, assertion: a.assertion } });
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/admin");
      await expect(S.confirm("key.revoke", "/admin/developers/keys/revoke", { id: "f".repeat(16) })).resolves.toContain(S.authenticator.credentialId);
    } finally {
      await e.DB.prepare("DELETE FROM webauthn_challenges WHERE kind='login'").run();
    }
  });
});

describe("sign out", () => {
  it("clears the session cookie (Path=/) and goes to the sign-in page", async () => {
    const s = await signedIn(e);
    const r = await call(`${BASE}/admin/logout`, { cookie: s.cookie, form: { csrf: s.csrf } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/login");
    const cleared = setCookieOf(r, "__Host-0c_session")!;
    expect(cleared).toMatch(/^__Host-0c_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/; Path=\/;/);
    expect((await call(`${BASE}/admin`, { cookie: "__Host-0c_session=" })).status).toBe(302);
  });
});
