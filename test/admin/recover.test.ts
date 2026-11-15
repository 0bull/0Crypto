// "Lost your passkey or moved to a new domain?": the ADMIN_RECOVERY_CODE secret (set by whoever can change the Worker)
// registers a new passkey on the host the request came in on and signs every device out. Nothing is printed to the logs.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { newRecoveryValue, recoveryHash } from "../../src/admin/setup-codes";
import { sessionGen } from "../../src/admin/session";
import type { Env } from "../../src/env";
import { clearSettingsCache } from "../../src/settings";
import { preAuth, signedIn, type AdminTestSession } from "../admin-session";
import { call, cookiePair, e, liveCode, logSpy, options, preAuthPage, setCookieOf, type CallOpts } from "../auth-flow";
import { SoftAuthenticator } from "../passkey";

const BASE = "https://pay.test";
const ALERT = "A new passkey was added with the ADMIN_RECOVERY_CODE secret. Every device was signed out. Delete that secret now.";
/** A fresh recovery value and the env that sets it as the Worker secret. */
const secret = () => { const v = newRecoveryValue(); return { v, env: { ADMIN_RECOVERY_CODE: v } as Partial<Env> }; };
let owner: AdminTestSession;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  owner = await signedIn(e);
});

let log: ReturnType<typeof logSpy>;
beforeEach(async () => {
  await e.DB.batch(["settings", "setup_codes", "setup_attempts", "alerts"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)));
  clearSettingsCache();
  log = logSpy();
});
afterEach(() => vi.restoreAllMocks());

const passkeyIds = async () => (await e.DB.prepare("SELECT id FROM passkeys ORDER BY created_at, id").all<{ id: string }>()).results.map((r) => r.id);
const storedPublicUrl = async () => (await e.DB.prepare("SELECT value FROM settings WHERE key='PUBLIC_URL'").first<{ value: string }>())?.value;

/** GET /admin/recover, options for `code` and a soft-authenticator registration on `base`: everything up to the final POST. */
async function prepareRecovery(base: string, code: string, o: { env?: Partial<Env>; move?: boolean } = {}) {
  const page = await preAuthPage(`${base}/admin/recover`, { env: o.env });
  const fields: Record<string, string> = { csrf: page.csrf, code, ...(o.move ? { move: "1" } : {}) };
  const opts = await options<PublicKeyCredentialCreationOptionsJSON>(`${base}/admin/recover/options`, { env: o.env, cookie: page.cookie, form: fields });
  expect(opts.status, JSON.stringify(opts.body)).toBe(200);
  const auth = new SoftAuthenticator();
  const credential = JSON.stringify(await auth.register(opts.body.options!, new URL(base).origin));
  const post: CallOpts = { env: o.env, cookie: page.cookie, form: { ...fields, credential } };
  return { page, options: opts.body.options!, auth, post };
}

describe("recovery page", () => {
  it("is public once a passkey exists, prints nothing, explains the secret and has the register form", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/recover`);
    expect(r.status).toBe(200);
    expect(log.lines()).toHaveLength(0);
    expect(html).toContain('data-passkey-register="/admin/recover/options"');
    expect(html).toContain('name="code"');
    expect(html).toContain("Settings → Variables and Secrets");
    expect(html).toContain("ADMIN_RECOVERY_CODE");
    expect(html).toMatch(/Copy this recovery code: <code class="mono">([a-z]+-){7}[a-z]+<\/code>/);
    expect(html).not.toContain("/admin/recover/code");
    expect((await call(`${BASE}/admin/recover/code`, { method: "POST" } as CallOpts)).status).not.toBe(200);
    expect(html).not.toContain('name="move"'); // same host as PUBLIC_URL: nothing moves
    expect(html).toMatch(/<noscript>[^]*JavaScript[^]*<\/noscript>/);
  });

  it("on another host with an empty PUBLIC_URL var, asks to confirm the move", async () => {
    const { html } = await preAuthPage("https://new.test/admin/recover", { env: { PUBLIC_URL: "" } });
    expect(html).toContain("This will move your gateway to https://new.test");
    expect(html).toMatch(/<input[^>]*name="move"[^>]*required|<input[^>]*required[^>]*name="move"/);
  });

  it("on another host with a PUBLIC_URL var, refuses: open the var's address or change the var", async () => {
    const html = await (await call("https://new.test/admin/recover")).text();
    expect(html).toContain("PUBLIC_URL is set by a Wrangler var to https://pay.test: open https://pay.test/admin/recover, or change the var.");
    expect(html).not.toContain('name="move"');
    expect(html).not.toContain("data-passkey-register");
  });

  it("on an IP-literal host, refuses with “Open http://localhost:<port>/admin/recover”", async () => {
    const env = { PUBLIC_URL: "" };
    const html = await (await call("http://127.0.0.1:8787/admin/recover", { env })).text();
    expect(html).toContain("Open http://localhost:8787/admin/recover instead.");
    expect(html).not.toContain("data-passkey-register");
    const page = await preAuth(e, "http://127.0.0.1:8787");
    const o = await options("http://127.0.0.1:8787/admin/recover/options", { env, cookie: page.cookie, form: { csrf: page.csrf, code: newRecoveryValue(), move: "1" } });
    expect(o.status).toBe(400);
    expect(o.body.error).toContain("Open http://localhost:8787/admin/recover");
  });
});

describe("recovery", () => {
  it("adds a second passkey, signs every device out, raises admin.recovered and keeps the first passkey", async () => {
    const { v: code, env: rec } = secret();
    const before = await passkeyIds();
    const gen = await sessionGen(e.DB);
    expect((await call(`${BASE}/admin`, { cookie: owner.cookie })).status).toBe(200);

    const r0 = await prepareRecovery(BASE, code, { env: rec });
    expect(r0.options.rp.id).toBe("pay.test");
    expect((r0.options.excludeCredentials ?? []).map((c) => c.id)).toEqual(expect.arrayContaining(before));
    const r = await call(`${BASE}/admin/recover`, r0.post);
    expect(r.status, await r.clone().text()).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/passkeys");

    const after = await passkeyIds();
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(expect.arrayContaining([...before, r0.auth.credentialId]));
    const added = (await e.DB.prepare("SELECT name,rp_id FROM passkeys WHERE id=?").bind(r0.auth.credentialId).first<{ name: string; rp_id: string }>())!;
    expect(added.name).toMatch(/^Recovered \d{4}-\d{2}-\d{2}/);
    expect(added.rp_id).toBe("pay.test");
    expect(await sessionGen(e.DB)).toBe(gen + 1);
    // The old session is signed out; the new one works.
    const old = await call(`${BASE}/admin`, { cookie: owner.cookie });
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/admin/login");
    expect((await call(`${BASE}/admin`, { cookie: cookiePair(setCookieOf(r, "__Host-0c_session")) })).status).toBe(200);
    const alert = await e.DB.prepare("SELECT detail FROM alerts WHERE kind='admin.recovered' AND resolved_at IS NULL").first<{ detail: string }>();
    expect(alert?.detail).toBe(ALERT);
    // The value is stored as used (only its hash).
    expect((await e.DB.prepare("SELECT hash FROM setup_codes WHERE purpose='recover'").all<{ hash: string }>()).results).toEqual([{ hash: await recoveryHash(code) }]);
    // Not moving: PUBLIC_URL is untouched.
    expect(await storedPublicUrl()).toBeUndefined();
    // The same code again is refused.
    const again = await preAuthPage(`${BASE}/admin/recover`, { env: rec });
    expect((await options(`${BASE}/admin/recover/options`, { env: rec, cookie: again.cookie, form: { csrf: again.csrf, code } })).status).toBe(400);
  });

  it("also ends every POS session (the POS version is bumped in the recovery batch) and records the alert there", async () => {
    const s = await signedIn(e);
    const open = await call(`${BASE}/admin/pos/open`, { cookie: s.cookie, form: { csrf: s.csrf } });
    const pos = `0c_pos=${/0c_pos=([^;]+)/.exec(open.headers.get("set-cookie") ?? "")![1]}`;
    expect((await call(`${BASE}/pos/recent`, { cookie: pos })).status).toBe(200);
    const version = async () => (await e.DB.prepare("SELECT version FROM pos_config WHERE id=1").first<{ version: number }>())!.version;
    const v = await version();
    const { v: value, env: rec } = secret();
    const r0 = await prepareRecovery(BASE, value, { env: rec });
    // The batch writes the alert itself: recordAlert (a separate write after it) is no longer called.
    const alerts = await import("../../src/db/alerts");
    const spy = vi.spyOn(alerts, "recordAlert");
    expect((await call(`${BASE}/admin/recover`, r0.post)).status).toBe(303);
    expect(spy).not.toHaveBeenCalled();
    expect(await version()).toBe(v + 1);
    expect((await call(`${BASE}/pos/recent`, { cookie: pos })).status).toBe(401);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM alerts WHERE kind='admin.recovered'").first<{ n: number }>())!.n).toBe(1);
  });

  it("two recoveries with one code at once: exactly one wins", async () => {
    const { v: code, env: rec } = secret();
    const a = await prepareRecovery(BASE, code, { env: rec });
    const b = await prepareRecovery(BASE, code, { env: rec });
    const before = (await passkeyIds()).length;
    const [ra, rb] = await Promise.all([call(`${BASE}/admin/recover`, a.post), call(`${BASE}/admin/recover`, b.post)]);
    expect([ra.status, rb.status].sort()).toEqual([303, 400]);
    expect(await passkeyIds()).toHaveLength(before + 1);
  });

  it("ADMIN_SETUP_CODE is refused for recovery (400)", async () => {
    const envCode = { ADMIN_SETUP_CODE: "ci-chosen-setup-code-0123456789abcdefghij" };
    const page = await preAuthPage(`${BASE}/admin/recover`, { env: envCode });
    const o = await options(`${BASE}/admin/recover/options`, { env: envCode, cookie: page.cookie, form: { csrf: page.csrf, code: envCode.ADMIN_SETUP_CODE } });
    expect(o.status).toBe(400);
    expect(o.body.options).toBeUndefined();
  });

  it("a logged setup code is refused for recovery, even with the secret set", async () => {
    const code = await liveCode("setup");
    const { env: rec } = secret();
    const page = await preAuthPage(`${BASE}/admin/recover`, { env: rec });
    expect((await options(`${BASE}/admin/recover/options`, { env: rec, cookie: page.cookie, form: { csrf: page.csrf, code } })).status).toBe(400);
  });

  it("the final POST re-checks the secret (changed meanwhile: refused)", async () => {
    const { v, env: rec } = secret();
    const r0 = await prepareRecovery(BASE, v, { env: rec });
    r0.post.env = { ADMIN_RECOVERY_CODE: newRecoveryValue() };
    const before = (await passkeyIds()).length;
    expect((await call(`${BASE}/admin/recover`, r0.post)).status).toBe(400);
    expect(await passkeyIds()).toHaveLength(before);
  });

  it("re-registering a credential that is already listed is refused and changes nothing", async () => {
    const { v: code, env: rec } = secret();
    const page = await preAuthPage(`${BASE}/admin/recover`, { env: rec });
    const opts = await options<PublicKeyCredentialCreationOptionsJSON>(`${BASE}/admin/recover/options`, { env: rec, cookie: page.cookie, form: { csrf: page.csrf, code } });
    const credential = JSON.stringify(await owner.authenticator.register(opts.body.options!, BASE));
    const gen = await sessionGen(e.DB);
    const before = await passkeyIds();
    const r = await call(`${BASE}/admin/recover`, { env: rec, cookie: page.cookie, form: { csrf: page.csrf, code, credential } });
    expect(r.status).toBe(400);
    expect(await sessionGen(e.DB)).toBe(gen);
    expect(await e.DB.prepare("SELECT 1 AS x FROM setup_codes WHERE hash=?").bind(await recoveryHash(code)).first()).toBeNull(); // not spent
    expect(await passkeyIds()).toEqual(before);
  });

  it("moves: from https://new.test with move=1 and an empty PUBLIC_URL var, PUBLIC_URL becomes https://new.test", async () => {
    const { v: code, env: rec } = secret();
    const envNoVar = { PUBLIC_URL: "", ...rec };
    await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('PUBLIC_URL','https://pay.test',?)").bind(Date.now()).run();
    clearSettingsCache();
    // Without the move box: refused at options and at the final POST.
    const page = await preAuthPage("https://new.test/admin/recover", { env: envNoVar });
    const refused = await options("https://new.test/admin/recover/options", { env: envNoVar, cookie: page.cookie, form: { csrf: page.csrf, code } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("https://new.test");
    const r0 = await prepareRecovery("https://new.test", code, { env: envNoVar, move: true });
    expect(r0.options.rp.id).toBe("new.test");
    const noMove = await call("https://new.test/admin/recover", { ...r0.post, form: { ...r0.post.form!, move: "" } });
    expect(noMove.status).toBe(400);
    expect(await storedPublicUrl()).toBe("https://pay.test");

    const r = await call("https://new.test/admin/recover", r0.post);
    expect(r.status, await r.clone().text()).toBe(303);
    expect(await storedPublicUrl()).toBe("https://new.test");
    expect(await e.DB.prepare("SELECT rp_id FROM passkeys WHERE id=?").bind(r0.auth.credentialId).first()).toEqual({ rp_id: "new.test" });
    // Sign-in now lives on the new host.
    clearSettingsCache();
    expect(await (await call("https://new.test/admin/login", { env: envNoVar })).text()).toContain('data-passkey-login="/admin/login/options"');
    expect(await (await call(`${BASE}/admin/login`, { env: envNoVar })).text()).toContain("Sign in at https://new.test");
  });

  it("with a PUBLIC_URL var, a recovery on another origin is refused at options and at the final POST", async () => {
    const msg = "PUBLIC_URL is set by a Wrangler var to https://pay.test: open https://pay.test/admin/recover, or change the var.";
    const { v: code, env: rec } = secret();
    const page = await preAuth(e, "https://new.test");
    const o = await options("https://new.test/admin/recover/options", { env: rec, cookie: page.cookie, form: { csrf: page.csrf, code } });
    expect(o.status).toBe(400);
    expect(o.body.error).toBe(msg);
    // A registration made through an unpinned options call cannot be finished once the var pins another origin.
    const r0 = await prepareRecovery("https://new.test", code, { env: { PUBLIC_URL: "", ...rec }, move: true });
    const before = await passkeyIds();
    const gen = await sessionGen(e.DB);
    const r = await call("https://new.test/admin/recover", { ...r0.post, env: rec });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain(msg);
    expect(await passkeyIds()).toEqual(before);
    expect(await sessionGen(e.DB)).toBe(gen);
    expect(await storedPublicUrl()).toBeUndefined();
  });
});
