// The Developers page (Plan 7 Task 9): API keys (passkey-confirmed create and revoke), the webhook URL and test event,
// and the webhook secret (passkey-confirmed reveal and rotate).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/api/auth";
import { NEEDS_JS } from "../../src/admin/confirm";
import { admin } from "../../src/admin/routes";
import type { Env } from "../../src/env";
import { clearSettingsCache, effectiveEnv } from "../../src/settings";
import { sendTestEvent } from "../../src/webhooks/consumer";
import { verifyWebhook } from "../../src/webhooks/sign";
import { signedIn, type AdminTestSession } from "../admin-session";
import { confirmFields } from "./helpers";

const e = env as unknown as Env;
const BASE = "https://pay.test";
const HOOK = "https://merchant.test/hook";
const network = setupNetwork();
let S: AdminTestSession;

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
beforeEach(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await e.DB.batch([
    e.DB.prepare("DELETE FROM settings"),
    e.DB.prepare("DELETE FROM api_keys"),
    e.DB.prepare("DELETE FROM passkeys"),
    e.DB.prepare("DELETE FROM webauthn_challenges"),
  ]);
  clearSettingsCache();
  S = await signedIn(e);
});

const post = (path: string, form: Record<string, string>, cookie = S.cookie) =>
  exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
const get = (path: string, cookie = S.cookie) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });

/** Posts a passkey-confirmed form: the assertion is bound to `fields` on `path`. */
async function confirmed(action: Parameters<AdminTestSession["confirm"]>[0], path: string, fields: Record<string, string> = {}) {
  const assertion = await S.confirm(action, path, fields);
  return post(path, { csrf: S.csrf, ...fields, assertion });
}
const SECRET = /whsec_[A-Za-z0-9_-]{43}/;
async function reveal(): Promise<string> {
  const r = await confirmed("webhook.rotate", "/admin/developers/webhook/reveal");
  expect(r.status).toBe(200);
  return SECRET.exec(await r.text())![0];
}

describe("developers page", () => {
  it("/admin/keys answers 301 to /admin/developers", async () => {
    const r = await get("/admin/keys");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/admin/developers");
  });

  it("shows the key forms, the webhook URL form and the secret's reveal and rotate forms, but never the secret", async () => {
    const r = await get("/admin/developers");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('data-passkey-confirm="key.create"');
    expect(html).toContain('action="/admin/developers/webhook"');
    expect(html).toContain('action="/admin/developers/webhook/test"');
    expect(html).toMatch(/action="\/admin\/developers\/webhook\/reveal"[^>]*data-passkey-confirm="webhook.rotate"/);
    expect(html).toMatch(/action="\/admin\/developers\/webhook\/rotate"[^>]*data-passkey-confirm="webhook.rotate"/);
    expect(html).toContain("up to 30 s");
    expect(html).not.toContain("whsec_");
  });

  it("marks Developers as the current page and offers + New API key", async () => {
    const html = await (await get("/admin/developers")).text();
    expect(html).toMatch(/<a\b[^>]*aria-current="page"[^>]*href="\/admin\/developers"|<a\b[^>]*href="\/admin\/developers"[^>]*aria-current="page"/);
    // The "+" is decoration (aria-hidden), here and on the empty state's action.
    expect(html.match(/href="#new-key"[^>]*>\s*<span aria-hidden="true">\+<\/span> New API key/g)).toHaveLength(2);
    expect(html).toContain('src="/admin.js"');
  });

  it("the hidden secret says so in words, not only an aria-label", async () => {
    const html = await (await get("/admin/developers")).text();
    expect(html).toContain("Hidden until you reveal it.");
    expect(html).not.toContain('aria-label="Secret hidden"');
  });

  it("after creating a key, its panel is 'Your new API key' and the form keeps 'New API key'", async () => {
    const html = await (await confirmed("key.create", "/admin/developers/keys", { label: "k" })).text();
    expect(html.match(/<h2>Your new API key<\/h2>/g)).toHaveLength(1);
    expect(html.match(/<h2>New API key<\/h2>/g)).toHaveLength(1);
  });

  it("pins the fields every confirm form binds", async () => {
    await confirmed("key.create", "/admin/developers/keys", { label: "k" });
    const html = await (await get("/admin/developers")).text();
    expect(confirmFields(html, "/admin/developers/keys")).toEqual(["label"]);
    expect(confirmFields(html, "/admin/developers/keys/revoke")).toEqual(["id"]);
    expect(confirmFields(html, "/admin/developers/webhook/reveal")).toEqual([]);
    expect(confirmFields(html, "/admin/developers/webhook/rotate")).toEqual([]);
  });
});

describe("API keys", () => {
  it("create with an assertion shows a 0c_live_ key once; the list has no key and no hash", async () => {
    const r = await confirmed("key.create", "/admin/developers/keys", { label: "shop-prod" });
    expect(r.status).toBe(200);
    const body = await r.text();
    const key = /0c_live_[A-Za-z0-9_-]{43}/.exec(body)![0];
    expect(body).toMatch(/Copy it now.*be shown again/);
    const hash = await sha256Hex(key);
    expect(body).not.toContain(hash);
    const list = await (await get("/admin/developers")).text();
    expect(list).toContain("shop-prod");
    expect(list).not.toContain(key);
    expect(list).not.toContain(hash);
    expect(list).toContain('data-passkey-confirm="key.revoke"');
  });

  it("create without an assertion is 403 and makes no key", async () => {
    const r = await post("/admin/developers/keys", { csrf: S.csrf, label: "shop-prod" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM api_keys").first<{ n: number }>())!.n).toBe(0);
  });

  it("an empty label is 400", async () => {
    const r = await confirmed("key.create", "/admin/developers/keys", { label: "   " });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Enter a label");
  });

  it("revoke needs an assertion bound to the key id", async () => {
    const body = await (await confirmed("key.create", "/admin/developers/keys", { label: "k1" })).text();
    const hash = await sha256Hex(/0c_live_[A-Za-z0-9_-]{43}/.exec(body)![0]);
    const id = hash.slice(0, 16);
    expect((await post("/admin/developers/keys/revoke", { csrf: S.csrf, id })).status).toBe(403);
    // An assertion for another id does not revoke this one.
    const other = await S.confirm("key.revoke", "/admin/developers/keys/revoke", { id: "f".repeat(16) });
    expect((await post("/admin/developers/keys/revoke", { csrf: S.csrf, id, assertion: other })).status).toBe(403);
    const revoked = async () => (await e.DB.prepare("SELECT revoked_at FROM api_keys WHERE hash=?").bind(hash).first<{ revoked_at: number | null }>())!.revoked_at;
    expect(await revoked()).toBeNull();
    const r = await confirmed("key.revoke", "/admin/developers/keys/revoke", { id });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/developers");
    expect(await revoked()).toBeGreaterThan(0);
  });

  it("revoking an id that matches nothing changes nothing", async () => {
    const r = await confirmed("key.revoke", "/admin/developers/keys/revoke", { id: "f".repeat(16) });
    expect(r.status).toBe(303);
  });
});

describe("webhook URL", () => {
  it("saves with session and CSRF only; from=welcome goes back to the wizard", async () => {
    const r = await post("/admin/developers/webhook", { csrf: S.csrf, url: HOOK });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/developers");
    expect((await effectiveEnv(e)).WEBHOOK_URL).toBe(HOOK);
    const w = await post("/admin/developers/webhook", { csrf: S.csrf, url: "", from: "welcome" });
    expect(w.headers.get("location")).toBe("/admin/welcome?step=done");
    expect((await effectiveEnv(e)).WEBHOOK_URL).toBe("");
    expect((await post("/admin/developers/webhook", { url: HOOK })).status).toBe(403);
  });

  it("refuses a non-https URL with 400", async () => {
    const r = await post("/admin/developers/webhook", { csrf: S.csrf, url: "http://merchant.test/hook" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("must be an https:// URL");
  });
});

describe("webhook secret", () => {
  it("reveal with an assertion shows whsec_ with a copy button; without one the body has no whsec_", async () => {
    const no = await post("/admin/developers/webhook/reveal", { csrf: S.csrf });
    expect(no.status).toBe(403);
    expect(await no.text()).not.toContain("whsec_");
    const r = await confirmed("webhook.rotate", "/admin/developers/webhook/reveal");
    const html = await r.text();
    const secret = SECRET.exec(html)![0];
    expect(secret).toBe((await effectiveEnv(e)).WEBHOOK_SECRET);
    expect(html).toMatch(/class="well mono[^"]*"[^>]*>whsec_/);
    expect(html).toContain(`data-copy="${secret}"`);
    expect(html).toContain("Copy");
  });

  it("an assertion for reveal does not rotate (the path is bound)", async () => {
    const before = await reveal();
    const assertion = await S.confirm("webhook.rotate", "/admin/developers/webhook/reveal", {});
    expect((await post("/admin/developers/webhook/rotate", { csrf: S.csrf, assertion })).status).toBe(403);
    expect(await reveal()).toBe(before);
  });

  it("rotate changes the value the next reveal shows", async () => {
    const before = await reveal();
    expect((await post("/admin/developers/webhook/rotate", { csrf: S.csrf })).status).toBe(403);
    const r = await confirmed("webhook.rotate", "/admin/developers/webhook/rotate");
    expect(r.status).toBe(200);
    const after = await reveal();
    expect(after).not.toBe(before);
    expect(SECRET.exec(await r.text())![0]).toBe(after);
  });

  it("with a WEBHOOK_SECRET Worker secret, rotate is disabled with the wrangler note and refused", async () => {
    const app = new Hono().route("/admin", admin);
    const worker = { ...(await effectiveEnv(e)), WEBHOOK_SECRET: "whsec_from_worker_secret" } as Env;
    // A hand-built env counts as a Worker secret whenever WEBHOOK_SECRET is set (see webhookSecretFromWorker).
    const page = await app.request(`${BASE}/admin/developers`, { headers: { cookie: S.cookie } }, worker);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Set as a Worker secret. Change it with npx wrangler secret put WEBHOOK_SECRET.");
    expect(html).toMatch(/action="\/admin\/developers\/webhook\/rotate"[\s\S]*?<button[^>]*disabled/);
    const assertion = await S.confirm("webhook.rotate", "/admin/developers/webhook/rotate", {});
    const r = await app.request(
      `${BASE}/admin/developers/webhook/rotate`,
      { method: "POST", headers: { cookie: S.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: S.csrf, assertion }) },
      worker,
    );
    expect(r.status).toBe(409);
  });
});

describe("test event", () => {
  it("POSTs a webhook.test event signed with the revealed secret, and the page shows the status", async () => {
    let seen: { header: string | null; body: string } | null = null;
    network.use(
      http.post(HOOK, async ({ request }) => {
        seen = { header: request.headers.get("0crypto-signature"), body: await request.text() };
        return HttpResponse.json({ ok: true });
      }),
    );
    expect((await post("/admin/developers/webhook", { csrf: S.csrf, url: HOOK })).status).toBe(303);
    const secret = await reveal();
    const r = await post("/admin/developers/webhook/test", { csrf: S.csrf });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("HTTP 200");
    expect(seen).not.toBeNull();
    const { header, body } = seen!;
    expect(await verifyWebhook(secret, header, body, Math.floor(Date.now() / 1000))).toBe(true);
    const ev = JSON.parse(body) as Record<string, unknown>;
    expect(ev.id).toMatch(/^evt_test_[0-9a-f]{16}$/);
    expect(ev).toMatchObject({ type: "webhook.test", data: {} });
    expect(new Date(ev.created_at as string).toISOString()).toBe(ev.created_at);
  });

  it("a 2xx answer is a status; any other answer is an alert that says what to check", async () => {
    expect((await post("/admin/developers/webhook", { csrf: S.csrf, url: HOOK })).status).toBe(303);
    network.use(http.post(HOOK, () => new HttpResponse(null, { status: 204 })));
    const ok = await (await post("/admin/developers/webhook/test", { csrf: S.csrf })).text();
    expect(ok).toMatch(/role="status"[^>]*>Test event: HTTP 204\. Your endpoint accepted it\./);
    network.use(http.post(HOOK, () => new HttpResponse("nope", { status: 500 })));
    const bad = await (await post("/admin/developers/webhook/test", { csrf: S.csrf })).text();
    expect(bad).toMatch(/role="alert"[^>]*>Test event: HTTP 500\. Your endpoint did not accept it: check its logs/);
    expect(bad).not.toMatch(/role="status"[^>]*>Test event/);
    network.use(http.post(HOOK, () => new HttpResponse(null, { status: 302, headers: { location: "https://elsewhere.test/" } })));
    const moved = await (await post("/admin/developers/webhook/test", { csrf: S.csrf })).text();
    expect(moved).toMatch(/role="alert"[^>]*>Test event: HTTP 302\./);
    network.use(http.post(HOOK, () => HttpResponse.error()));
    const none = await (await post("/admin/developers/webhook/test", { csrf: S.csrf })).text();
    expect(none).toMatch(/role="alert"[^>]*>Test event: no response \([^)]*network error\)\. Check the URL/);
  });

  it("without a webhook URL the test is refused with 400", async () => {
    const r = await post("/admin/developers/webhook/test", { csrf: S.csrf });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Save a webhook URL first");
  });

  it("sendTestEvent reports a failing endpoint", async () => {
    network.use(http.post(HOOK, () => new HttpResponse("nope", { status: 500 })));
    const out = await sendTestEvent(await effectiveEnv(e), HOOK, Date.UTC(2026, 10, 14));
    expect(out).toEqual({ status: 500, error: "HTTP 500" });
  });
});
