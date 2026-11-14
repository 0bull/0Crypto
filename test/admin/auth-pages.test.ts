import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { assetField, OFFERABLE } from "../../src/admin/settings";
import type { Env } from "../../src/env";
import { signedIn, type AdminTestSession } from "../admin-session";
import { call, preAuthPage } from "../auth-flow";
import { confirmFields } from "./helpers";

/*
 * The pages on AuthShell (Plan 8 Task 10): setup, sign-in, recovery, the welcome wizard and the Not configured,
 * Forbidden and Not found pages. This file is new on purpose: its D1 starts without passkeys (the "unclaimed" state), and
 * the claimed tests below add one.
 *
 * Restyling must not touch what public/admin-passkey.js reads from the markup, so the field set of every form is pinned.
 */

const e = env as unknown as Env;
const BASE = "https://pay.test";
let S: AdminTestSession;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The form posting to `action`: its opening tag and the sorted names of its inputs, selects and textareas. */
function form(html: string, action: string): { open: string; names: string[] } {
  const f = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find((x) => attr(/^<form\b[^>]*>/.exec(x)![0], "action") === action);
  if (!f) throw new Error(`no form posts to ${action}`);
  const names = [...f.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((m) => attr(m[0], "name")).filter((n): n is string => n !== undefined);
  return { open: /^<form\b[^>]*>/.exec(f)![0], names: names.sort() };
}

/** What every AuthShell page shares: the strict CSP, one h1, one main landmark and none of the admin navigation. */
function expectAuthChrome(html: string): void {
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).not.toContain("<nav");
  expect(html).not.toContain('aria-label="Main"');
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain("0Crypto");
}

describe("unclaimed gateway", () => {
  it("/admin/setup is 'Claim your gateway', with the code field and the steps to find the code", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/setup`);
    expect(r.status).toBe(200);
    expectAuthChrome(html);
    expect(html).toContain("Claim your gateway");
    expect(html).toContain("Where to find the code");
    expect(html).toContain("Workers &amp; Pages");
    expect(html).toContain("npx wrangler tail");
    expect(html).toMatch(/<ol\b/);
    expect(html).toContain("Print a new code");
    expect(html).toMatch(/<textarea[^>]*name="code"[^>]*autocomplete="off"|<textarea[^>]*autocomplete="off"[^>]*name="code"/);
  });

  it("pins the setup code form and the print-a-new-code form", async () => {
    const { html } = await preAuthPage(`${BASE}/admin/setup`);
    const code = form(html, "/admin/setup");
    expect(code.names).toEqual(["code", "credential", "csrf"]);
    expect(code.open).toContain('data-passkey-register="/admin/setup/options"');
    expect(html).toContain("data-passkey-error");
    expect(html).toContain("Create passkey");
    expect(form(html, "/admin/setup/code").names).toEqual(["csrf"]);
  });

  it("Not configured: a missing SESSION_SECRET gets the 503 page on AuthShell", async () => {
    const r = await call(`${BASE}/admin/setup`, { env: { SESSION_SECRET: "too-short" } });
    expect(r.status).toBe(503);
    const html = await r.text();
    expectAuthChrome(html);
    expect(html).toContain("Admin unavailable");
    expect(html).toContain("SESSION_SECRET");
  });
});

describe("claimed gateway", () => {
  beforeAll(async () => {
    S = await signedIn(e); // inserts the passkey row, the way Plan 7's tests claim
  });
  const get = (path: string, cookie?: string) => exports.default.fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

  it("sign-in has one 'Sign in with passkey' button and the recovery link", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/login`);
    expect(r.status).toBe(200);
    expectAuthChrome(html);
    expect(html).toContain("Sign in with passkey");
    expect(html).toContain('href="/admin/recover"');
    expect(html.match(/<button\b[^>]*type="submit"/g)).toHaveLength(1);
  });

  it("pins the sign-in form: username (autofill), assertion, csrf and the error target", async () => {
    const { html } = await preAuthPage(`${BASE}/admin/login`);
    const f = form(html, "/admin/login");
    expect(f.names).toEqual(["assertion", "csrf", "username"]);
    expect(f.open).toContain('data-passkey-login="/admin/login/options"');
    expect(html).toMatch(/<input[^>]*autocomplete="username webauthn"/);
    expect(html).toContain("data-passkey-error");
  });

  it("recovery has the same layout as setup and pins its forms", async () => {
    const { r, html } = await preAuthPage(`${BASE}/admin/recover`);
    expect(r.status).toBe(200);
    expectAuthChrome(html);
    expect(html).toContain("Where to find the code");
    expect(html).toContain("Workers &amp; Pages");
    expect(html).toContain('href="/admin/login"');
    const f = form(html, "/admin/recover");
    expect(f.names).toEqual(["code", "credential", "csrf"]);
    expect(f.open).toContain('data-passkey-register="/admin/recover/options"');
    expect(form(html, "/admin/recover/code").names).toEqual(["csrf"]);
  });

  it("recovery on another origin than PUBLIC_URL asks for the move in a warning panel, with the move checkbox", async () => {
    const { html } = await preAuthPage("https://other.test/admin/recover", { env: { PUBLIC_URL: "" } });
    expect(html).toContain("This will move your gateway to https://other.test");
    expect(form(html, "/admin/recover").names).toEqual(["code", "credential", "csrf", "move"]);
    expectAuthChrome(html);
  });

  it("sign-in on another host keeps the refusal copy and has no passkey form", async () => {
    const html = await (await call("https://other.test/admin/login")).text();
    expectAuthChrome(html);
    expect(html).toContain("Sign in at https://pay.test");
    expect(html).toContain('href="/admin/recover"');
    expect(html).not.toContain("data-passkey-login");
  });

  it("Forbidden: a POST without the CSRF token gets the 403 page on AuthShell", async () => {
    const r = await exports.default.fetch(`${BASE}/admin/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: S.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expect(r.status).toBe(403);
    const html = await r.text();
    expectAuthChrome(html);
    expect(html).toContain("Request rejected");
  });

  it("Not found while signed in is the auth-shell 404 page", async () => {
    const r = await get("/admin/invoices/no-such-invoice", S.cookie);
    expect(r.status).toBe(404);
    const html = await r.text();
    expectAuthChrome(html);
    expect(html).toContain("Not found");
  });

  describe("welcome wizard", () => {
    it("step 1 is 'Step 1 of 3 · Your shop' with a three-item progress list and one current step", async () => {
      const html = await (await get("/admin/welcome", S.cookie)).text();
      expectAuthChrome(html);
      expect(html).toContain("Step 1 of 3");
      expect(html).toContain("Your shop");
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(html.match(/<li\b/g)).toHaveLength(3);
    });

    it("step 2 reads 'Step 2 of 3' and marks the current step", async () => {
      const html = await (await get("/admin/welcome?step=2", S.cookie)).text();
      expect(html).toContain("Step 2 of 3");
      expect(html).toContain('aria-current="step"');
    });

    it("the Coins step is step 2 of 3 by name, and the Done step is step 3 of 3", async () => {
      const coins = await (await get("/admin/welcome?step=coins", S.cookie)).text();
      expectAuthChrome(coins);
      expect(coins).toContain("Step 2 of 3");
      expect(coins).toContain("Advanced: see docs");
      const done = await (await get("/admin/welcome?step=done", S.cookie)).text();
      expectAuthChrome(done);
      expect(done).toContain("Step 3 of 3");
      expect(done).toContain("Create a $1 test invoice");
      expect(done).toContain("Send test event");
    });

    it("pins the shop form", async () => {
      const html = await (await get("/admin/welcome?step=shop", S.cookie)).text();
      expect(form(html, "/admin/welcome/shop").names).toEqual(["MERCHANT_NAME", "csrf"]);
    });

    it("pins the coins confirm form: the same xpub, Blockbook and coin fields, bound to settings.wallets", async () => {
      const html = await (await get("/admin/welcome?step=coins", S.cookie)).text();
      const expected = ["BTC_XPUB", "DOGE_BLOCKBOOK_URL", "DOGE_XPUB", "LTC_XPUB", ...OFFERABLE.map((a) => assetField(a.id))].sort();
      expect(confirmFields(html, "/admin/welcome/coins")).toEqual(expected);
      expect(form(html, "/admin/welcome/coins").open).toContain('data-passkey-confirm="settings.wallets"');
      expect(html).toContain("data-passkey-error");
    });

    it("pins the done step's forms", async () => {
      const html = await (await get("/admin/welcome?step=done", S.cookie)).text();
      expect(confirmFields(html, "/admin/developers/webhook/reveal")).toEqual(["from"]);
      expect(form(html, "/admin/developers/webhook/reveal").open).toContain('data-passkey-confirm="webhook.rotate"');
      expect(form(html, "/admin/developers/webhook").names).toEqual(["csrf", "from", "url"]);
      expect(form(html, "/admin/developers/webhook/test").names).toEqual(["csrf", "from"]);
      expect(form(html, "/admin/welcome/test-invoice").names).toEqual(["csrf"]);
      expect(form(html, "/admin/welcome/test-invoice").open).toContain('target="_blank"');
    });
  });
});
