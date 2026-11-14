// First claim of a fresh gateway: the 6-word code from the Worker logs, then a passkey (Plan 7 Task 7).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { sha256Hex } from "../../src/api/auth";
import type { Env } from "../../src/env";
import { clearSettingsCache } from "../../src/settings";
import { call, cookiePair, e, freshIp, liveCode, logSpy, options, preAuthPage, setCookieOf, type CallOpts } from "../auth-flow";
import { preAuth } from "../admin-session";
import { SoftAuthenticator } from "../passkey";

const BASE = "https://pay.test";
const CLAIMED = "This gateway was just claimed by another browser.";

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

/** Back to a fresh, unclaimed gateway (each claim is one-shot, so every test starts from here). */
async function unclaim(): Promise<void> {
  await e.DB.batch(
    ["passkeys", "settings", "setup_codes", "setup_attempts", "webauthn_challenges", "alerts"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
  );
  await e.DB.prepare("UPDATE admin_state SET created_at=0 WHERE id=1").run();
  clearSettingsCache();
}

let log: ReturnType<typeof logSpy>;
beforeEach(async () => {
  await unclaim();
  log = logSpy();
});
afterEach(() => vi.restoreAllMocks());

const count = async (sql: string) => (await e.DB.prepare(sql).first<{ n: number }>())!.n;
const passkeys = () => count("SELECT count(*) AS n FROM passkeys");

/** GET /admin/setup, then options for `code` and a soft-authenticator registration: everything up to the final POST. */
async function prepareClaim(base: string, code: string, env: Partial<Env> = {}) {
  const page = await preAuthPage(`${base}/admin/setup`, { env });
  const o = await options<PublicKeyCredentialCreationOptionsJSON>(`${base}/admin/setup/options`, { env, cookie: page.cookie, form: { csrf: page.csrf, code } });
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  const auth = new SoftAuthenticator();
  const credential = JSON.stringify(await auth.register(o.body.options!, new URL(base).origin));
  const post: CallOpts = { env, cookie: page.cookie, form: { csrf: page.csrf, code, credential } };
  return { page, options: o.body.options!, auth, post };
}

describe("claim", () => {
  it("while no passkey exists, every admin path redirects to /admin/setup", async () => {
    for (const p of ["/admin", "/admin/invoices/new", "/admin/login", "/admin/recover", "/admin/keys"]) {
      const r = await call(BASE + p);
      expect(r.status, p).toBe(302);
      expect(r.headers.get("location"), p).toBe("/admin/setup");
    }
    const r = await call(`${BASE}/admin/webauthn/challenge`, { form: { csrf: "x" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/setup");
  });

  it("the setup page prints a code to the logs once and says where to find it", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/setup`);
    expect(r.status).toBe(200);
    expect(log.codes("setup")).toHaveLength(1);
    expect(html).toContain('data-passkey-register="/admin/setup/options"');
    expect(html).toMatch(/<textarea[^>]*name="code"[^>]*autocomplete="off"|<textarea[^>]*autocomplete="off"[^>]*name="code"/);
    expect(html).toContain('name="credential"');
    expect(html).toContain("data-passkey-error");
    expect(html).toContain('action="/admin/setup/code"');
    expect(html).toContain("Cloudflare dashboard → Workers &amp; Pages → 0crypto → Logs");
    expect(html).toContain("npx wrangler tail");
    expect(html).toMatch(/<noscript>[^]*JavaScript[^]*<\/noscript>/);
    expect(html).not.toContain(log.codes("setup")[0]!);
    // A second visit does not print another while that one is live.
    await call(`${BASE}/admin/setup`);
    expect(log.codes("setup")).toHaveLength(1);
  });

  it("Print a new code is limited to once per 2 minutes", async () => {
    const page = await preAuthPage(`${BASE}/admin/setup`);
    const again = await call(`${BASE}/admin/setup/code`, { cookie: page.cookie, form: { csrf: page.csrf } });
    expect(again.status).toBe(429);
    expect(await again.text()).toContain("A code was printed less than 2 minutes ago. Check your logs.");
    expect(log.codes("setup")).toHaveLength(1);
    await e.DB.prepare("UPDATE setup_codes SET created_at=created_at-130000").run();
    const ok = await call(`${BASE}/admin/setup/code`, { cookie: page.cookie, form: { csrf: page.csrf } });
    expect(ok.status).toBe(200);
    expect(log.codes("setup")).toHaveLength(2);
  });

  it("a wrong code at options is a 400 JSON error and issues no challenge", async () => {
    const page = await preAuthPage(`${BASE}/admin/setup`);
    const o = await options(`${BASE}/admin/setup/options`, { cookie: page.cookie, form: { csrf: page.csrf, code: "abandon abandon abandon abandon abandon zoo" } });
    expect(o.status).toBe(400);
    expect(o.body.error).toMatch(/not valid/);
    expect(o.body.options).toBeUndefined();
    expect(await count("SELECT count(*) AS n FROM webauthn_challenges")).toBe(0);
    // Options need the CSRF token of the page's cookie.
    expect((await call(`${BASE}/admin/setup/options`, { cookie: page.cookie, form: { code: log.codes("setup")[0]! } })).status).toBe(403);
  });

  it("the right code and a passkey claim the gateway: session, one passkey, code consumed, PUBLIC_URL stored", async () => {
    await call(`${BASE}/admin/setup`);
    const code = log.codes("setup")[0]!;
    const other = await liveCode("setup"); // a second live setup code: deleted by the claim too
    const c = await prepareClaim(BASE, code.toUpperCase().replaceAll(" ", "  \n"));
    expect(c.options.rp.id).toBe("pay.test");
    expect(c.options.authenticatorSelection?.userVerification).toBe("required");
    const userId = (await e.DB.prepare("SELECT user_id FROM admin_state WHERE id=1").first<{ user_id: string }>())!.user_id;
    expect(bytesToHex(base64urlnopad.decode(c.options.user.id))).toBe(userId);

    const r = await call(`${BASE}/admin/setup`, c.post);
    expect(r.status, await r.clone().text()).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/welcome");
    const session = cookiePair(setCookieOf(r, "__Host-0c_session"))!;
    expect(setCookieOf(r, "__Host-0c_session")).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(await passkeys()).toBe(1);
    const row = (await e.DB.prepare("SELECT id,name,counter,rp_id FROM passkeys").first<{ id: string; name: string; counter: number; rp_id: string }>())!;
    expect(row).toEqual({ id: c.auth.credentialId, name: "Passkey 1", counter: 0, rp_id: "pay.test" });
    expect(await count("SELECT count(*) AS n FROM setup_codes WHERE purpose='setup'")).toBe(0);
    void other;
    expect((await e.DB.prepare("SELECT value FROM settings WHERE key='PUBLIC_URL'").first<{ value: string }>())?.value).toBe("https://pay.test");
    expect((await e.DB.prepare("SELECT created_at FROM admin_state WHERE id=1").first<{ created_at: number }>())!.created_at).toBeGreaterThan(0);

    // The new session opens the admin; setup is gone.
    expect((await call(`${BASE}/admin`, { cookie: session })).status).toBe(200);
    for (const p of ["/admin/setup", "/admin/setup/options", "/admin/setup/code"]) expect((await call(BASE + p)).status, p).toBe(404);
    expect((await call(`${BASE}/admin/setup`, c.post)).status).toBe(404);
    // Signed out, admin paths now go to the sign-in page.
    expect((await call(`${BASE}/admin`)).headers.get("location")).toBe("/admin/login");
  });

  it("the final POST re-checks the code: a code that expired after options is refused", async () => {
    await call(`${BASE}/admin/setup`);
    const c = await prepareClaim(BASE, log.codes("setup")[0]!);
    await e.DB.prepare("DELETE FROM setup_codes").run();
    const r = await call(`${BASE}/admin/setup`, c.post);
    expect(r.status).toBe(400);
    expect(await passkeys()).toBe(0);
  });

  it("a registration made for one code does not pass with another code", async () => {
    await call(`${BASE}/admin/setup`);
    const c = await prepareClaim(BASE, log.codes("setup")[0]!);
    const other = await liveCode("setup");
    const r = await call(`${BASE}/admin/setup`, { ...c.post, form: { ...c.post.form!, code: other } });
    expect(r.status).toBe(400);
    expect(await passkeys()).toBe(0);
  });

  it("a recovery code cannot claim", async () => {
    const code = await liveCode("recover");
    const page = await preAuthPage(`${BASE}/admin/setup`);
    const o = await options(`${BASE}/admin/setup/options`, { cookie: page.cookie, form: { csrf: page.csrf, code } });
    expect(o.status).toBe(400);
  });

  it("race: two browsers with two valid codes post at once; exactly one wins", async () => {
    await call(`${BASE}/admin/setup`);
    const a = await prepareClaim(BASE, log.codes("setup")[0]!);
    const b = await prepareClaim(BASE, await liveCode("setup"));
    const [ra, rb] = await Promise.all([call(`${BASE}/admin/setup`, a.post), call(`${BASE}/admin/setup`, b.post)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([303, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(await loser.text()).toContain(CLAIMED);
    expect(setCookieOf(loser, "__Host-0c_session")).toBeUndefined();
    expect([ra, rb].filter((r) => setCookieOf(r, "__Host-0c_session") !== undefined)).toHaveLength(1);
    expect(await passkeys()).toBe(1);
    const winner = ra.status === 303 ? a : b;
    expect((await e.DB.prepare("SELECT id FROM passkeys").first<{ id: string }>())!.id).toBe(winner.auth.credentialId);
  });

  it("race: the same code from two browsers; exactly one wins", async () => {
    await call(`${BASE}/admin/setup`);
    const code = log.codes("setup")[0]!;
    const a = await prepareClaim(BASE, code);
    const b = await prepareClaim(BASE, code);
    const [ra, rb] = await Promise.all([call(`${BASE}/admin/setup`, a.post), call(`${BASE}/admin/setup`, b.post)]);
    expect([ra.status, rb.status].sort()).toEqual([303, 409]);
    expect(await passkeys()).toBe(1);
  });

  it("with an empty PUBLIC_URL var, the claim stores the origin it came in on", async () => {
    const env = { PUBLIC_URL: "" };
    await call("https://shop.test/admin/setup", { env });
    const c = await prepareClaim("https://shop.test", log.codes("setup")[0]!, env);
    expect(c.options.rp.id).toBe("shop.test");
    const r = await call("https://shop.test/admin/setup", c.post);
    expect(r.status).toBe(303);
    expect((await e.DB.prepare("SELECT value FROM settings WHERE key='PUBLIC_URL'").first<{ value: string }>())?.value).toBe("https://shop.test");
  });

  it("works with a blank SESSION_SECRET (the instance key signs cookies and checks codes)", async () => {
    const env = { SESSION_SECRET: "" };
    await call(`${BASE}/admin/setup`, { env });
    const c = await prepareClaim(BASE, log.codes("setup")[0]!, env);
    const r = await call(`${BASE}/admin/setup`, c.post);
    expect(r.status).toBe(303);
    const session = cookiePair(setCookieOf(r, "__Host-0c_session"))!;
    expect((await call(`${BASE}/admin`, { env, cookie: session })).status).toBe(200);
    // Signed with the instance key, so the test SESSION_SECRET does not accept it.
    expect((await call(`${BASE}/admin`, { cookie: session })).status).toBe(302);
  });

  it("ADMIN_SETUP_CODE (40 chars) claims a fresh gateway once", async () => {
    const env = { ADMIN_SETUP_CODE: "ci-chosen-setup-code-0123456789abcdefghi" };
    expect(env.ADMIN_SETUP_CODE).toHaveLength(40);
    const c = await prepareClaim(BASE, env.ADMIN_SETUP_CODE, env);
    const r = await call(`${BASE}/admin/setup`, c.post);
    expect(r.status).toBe(303);
    expect(await passkeys()).toBe(1);
    // One-shot: once a passkey exists the code opens nothing.
    const page = await preAuthPage(`${BASE}/admin/login`, { env });
    expect((await call(`${BASE}/admin/setup/options`, { env, cookie: page.cookie, form: { csrf: page.csrf, code: env.ADMIN_SETUP_CODE } })).status).toBe(404);
  });

  it("an ADMIN_SETUP_CODE shorter than 32 chars is ignored", async () => {
    const env = { ADMIN_SETUP_CODE: "short-code-0123456789" };
    const page = await preAuthPage(`${BASE}/admin/setup`, { env });
    const o = await options(`${BASE}/admin/setup/options`, { env, cookie: page.cookie, form: { csrf: page.csrf, code: env.ADMIN_SETUP_CODE } });
    expect(o.status).toBe(400);
  });

  it("http on a public host is sent to https (308) before anything else", async () => {
    const env = { PUBLIC_URL: "" };
    const r = await call("http://shop.test/admin/setup", { env });
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://shop.test/admin/setup");
    expect(log.codes("setup")).toHaveLength(0);
    const o = await call("http://shop.test/admin/setup/options", { env, form: { csrf: "x", code: "x" } });
    expect(o.status).toBe(308);
    expect(await passkeys()).toBe(0);
  });

  it("on an IP-literal host, refuses with “Open http://localhost:<port>/admin/setup” and starts no ceremony", async () => {
    const env = { PUBLIC_URL: "" };
    for (const base of ["http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const html = await (await call(`${base}/admin/setup`, { env })).text();
      expect(html).toContain("Open http://localhost:8787/admin/setup instead.");
      const { cookie, csrf } = await preAuth(e, base);
      expect(html).not.toContain("data-passkey-register");
      const code = await liveCode("setup");
      const o = await options(`${base}/admin/setup/options`, { env, cookie, form: { csrf, code } });
      expect(o.status).toBe(400);
      expect(o.body.error).toContain("Open http://localhost:8787/admin/setup");
    }
    expect(await count("SELECT count(*) AS n FROM webauthn_challenges")).toBe(0);
    expect(await passkeys()).toBe(0);
  });

  it("on http://localhost the claim works and stores that origin", async () => {
    const env = { PUBLIC_URL: "" };
    const c = await prepareClaim("http://localhost:8787", await liveCode("setup"), env);
    expect(c.options.rp.id).toBe("localhost");
    const r = await call("http://localhost:8787/admin/setup", c.post);
    expect(r.status).toBe(303);
    expect((await e.DB.prepare("SELECT value FROM settings WHERE key='PUBLIC_URL'").first<{ value: string }>())?.value).toBe("http://localhost:8787");
  });

  it("with a PUBLIC_URL var, a claim on another origin is refused with the var's address", async () => {
    const msg = "PUBLIC_URL is set by a Wrangler var to https://pay.test: open https://pay.test/admin/setup, or change the var.";
    const html = await (await call("https://shop.test/admin/setup")).text();
    expect(html).toContain(msg);
    expect(log.codes("setup")).toHaveLength(0); // no code is printed for a claim that cannot run here
    const { cookie, csrf } = await preAuth(e, "https://shop.test");
    expect(html).not.toContain("data-passkey-register");
    const o = await options("https://shop.test/admin/setup/options", { cookie, form: { csrf, code: await liveCode("setup") } });
    expect(o.status).toBe(400);
    expect(o.body.error).toBe(msg);
    expect(await count("SELECT count(*) AS n FROM webauthn_challenges")).toBe(0);
  });

  it("five wrong codes from one client give 429 without checking the sixth; another client is unaffected", async () => {
    await call(`${BASE}/admin/setup`);
    const code = log.codes("setup")[0]!;
    const ip = freshIp();
    const page = await preAuthPage(`${BASE}/admin/setup`, { ip });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await call(`${BASE}/admin/setup/options`, { ip, cookie: page.cookie, form: { csrf: page.csrf, code: "abandon abandon abandon abandon abandon zoo" } })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect((await call(`${BASE}/admin/setup/options`, { ip, cookie: page.cookie, form: { csrf: page.csrf, code } })).status).toBe(429);
    expect((await call(`${BASE}/admin/setup/options`, { cookie: page.cookie, form: { csrf: page.csrf, code } })).status).toBe(200);
  });

  it("never logs a code anywhere but the code line", async () => {
    await call(`${BASE}/admin/setup`);
    const code = log.codes("setup")[0]!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await prepareClaim(BASE, code);
    await call(`${BASE}/admin/setup`, c.post);
    const all = [...log.lines(), ...warn.mock.calls.flat().map(String), ...error.mock.calls.flat().map(String)];
    expect(all.filter((l) => l.includes(code))).toEqual([`0crypto setup code: ${code} (valid 60 min)`]);
    const hash = await sha256Hex(code);
    expect(all.some((l) => l.includes(hash))).toBe(false);
  });
});
