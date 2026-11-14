import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { startSession } from "../../src/admin/auth";
import { admin, type AdminEnv } from "../../src/admin/routes";
import {
  SESSION_MAX_AGE,
  bumpSessionGen,
  csrfFor,
  hmacHex,
  sessionGen,
  signSession,
  verifySession,
} from "../../src/admin/session";
import type { Env } from "../../src/env";
import { signedIn } from "../admin-session";

const e = env as unknown as Env;
const BASE = "https://pay.test";
const SECRET = e.SESSION_SECRET;
const HOUR = 3_600_000;
let ipSeq = 0;
const freshIp = () => `10.55.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await signedIn(e); // a passkey exists, so the gateway is claimed and the sign-in page is public
});

const get = (url: string, cookie?: string) =>
  exports.default.fetch(url.startsWith("http") ? url : BASE + url, { headers: { "cf-connecting-ip": freshIp(), ...(cookie ? { cookie } : {}) }, redirect: "manual" });
const post = (path: string, form: Record<string, string>, cookie?: string) =>
  exports.default.fetch(BASE + path, {
    method: "POST",
    headers: { "cf-connecting-ip": freshIp(), "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
const setCookie = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + "="));
const valueOf = (raw: string | undefined) => raw?.split(";")[0]!.split("=").slice(1).join("=");
const csrfIn = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
// A pre-auth page with a form.
const LOGIN_PAGE = "/admin/login";

describe("session cookie value", () => {
  it("is <gen>.<exp>.<hmac(session:<gen>:<exp>)>", async () => {
    const exp = Date.now() + HOUR;
    expect(await signSession(SECRET, 3, exp)).toBe(`3.${exp}.${await hmacHex(SECRET, `session:3:${exp}`)}`);
  });

  it("a cookie signed with gen 0 passes with gen 0 and fails after bumpSessionGen", async () => {
    expect(await sessionGen(e.DB)).toBe(0);
    const v = await signSession(SECRET, 0, Date.now() + HOUR);
    expect(await verifySession(SECRET, v, Date.now(), 0)).toBe(true);
    const cookie = `__Host-0c_session=${v}`;
    expect((await get("/admin", cookie)).status).toBe(200);
    await bumpSessionGen(e.DB);
    expect(await sessionGen(e.DB)).toBe(1);
    expect(await verifySession(SECRET, v, Date.now(), 1)).toBe(false);
    const r = await get("/admin", cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
    // A fresh sign-in after the bump works again.
    expect((await get("/admin", (await signedIn(e)).cookie)).status).toBe(200);
  });

  it("rejects far-future, expired, tampered, malformed and extra-part values", async () => {
    const gen = await sessionGen(e.DB);
    const now = Date.now();
    const good = await signSession(SECRET, gen, now + HOUR);
    const [g, exp, sig] = good.split(".") as [string, string, string];
    expect(await verifySession(SECRET, good, now, gen)).toBe(true);
    const bad = [
      await signSession(SECRET, gen, now + 13 * HOUR), // far future: never minted with more than 12 h
      await signSession(SECRET, gen, now - 1000), // expired
      await signSession(SECRET, gen + 1, now + HOUR), // a future generation
      `${g}.${Number(exp) + 1}.${sig}`,
      `${g}.${exp}.${"0".repeat(64)}`,
      `${g}.${exp}.${sig.toUpperCase()}`,
      `0${g}.${exp}.${sig}`, // non-canonical gen
      `${g}.0${exp}.${sig}`, // non-canonical exp
      `${exp}.${sig}`, // the old two-part format
      `${good}.x`,
      `${good}.`,
      `x.${good}`,
      "",
      "junk",
    ];
    for (const v of bad) expect(await verifySession(SECRET, v, now, gen), v).toBe(false);
    expect(await verifySession(SECRET, undefined, now, gen)).toBe(false);
    expect((await get("/admin", `__Host-0c_session=${await signSession(SECRET, gen, now + 13 * HOUR)}`)).status).toBe(302);
  });

  it("keeps the 12 h lifetime", () => {
    expect(SESSION_MAX_AGE).toBe(12 * 3600);
  });
});

describe("cookie names (cookieName itself: secure-cookie.test.ts)", () => {
  it("only the name for the current scheme is read", async () => {
    const { cookie } = await signedIn(e);
    const v = valueOf(cookie)!;
    expect((await get("/admin", `0c_session=${v}`)).status).toBe(302); // bare name on https
    expect((await get("/admin", `__Host-0c_session=${v}`)).status).toBe(200);
    expect((await get("http://localhost/admin", `__Host-0c_session=${v}`)).status).toBe(302);
    expect((await get("http://localhost/admin", `0c_session=${v}`)).status).toBe(200);
  });

  const app = new Hono<AdminEnv>().get("/t", async (c) => {
    await startSession(c);
    return c.text("ok");
  });

  it("https: the session cookie is __Host-0c_session; Path=/; HttpOnly; Secure; SameSite=Strict, no Domain", async () => {
    const r = await app.request("https://pay.test/t", {}, e);
    const sc = setCookie(r, "__Host-0c_session")!;
    expect(sc).toMatch(/^__Host-0c_session=\d+\.\d+\.[0-9a-f]{64}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(sc).not.toMatch(/Domain/i);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("0c_session=") && !/Max-Age=0/.test(c))).toBe(false);
    expect(await verifySession(SECRET, valueOf(sc), Date.now(), await sessionGen(e.DB))).toBe(true);
  });

  it("http loopback: the session cookie is 0c_session; Path=/ without Secure", async () => {
    const r = await app.request("http://localhost/t", {}, e);
    const sc = r.headers.getSetCookie().find((c) => c.startsWith("0c_session=") && c.includes("Path=/;"))!;
    expect(sc).toMatch(/^0c_session=\d+\.\d+\.[0-9a-f]{64}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(sc).not.toMatch(/Secure/);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-"))).toBe(false);
  });
});

describe("CSRF", () => {
  it("pre-auth pages bind the token to a fresh __Host-0c_setup cookie and never set 0c_csrf", async () => {
    const r = await get(LOGIN_PAGE);
    expect(r.status).toBe(200);
    const sc = setCookie(r, "__Host-0c_setup")!;
    expect(sc).toMatch(/^__Host-0c_setup=[A-Za-z0-9_-]{43}; Max-Age=3600; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(r.headers.getSetCookie().some((c) => c.includes("0c_csrf"))).toBe(false);
    const binder = valueOf(sc)!;
    expect(csrfIn(await r.text())).toBe(await csrfFor(SECRET, binder));
    // The same cookie is reused, not re-minted.
    const again = await get(LOGIN_PAGE, `__Host-0c_setup=${binder}`);
    expect(setCookie(again, "__Host-0c_setup")).toBeUndefined();
    expect(csrfIn(await again.text())).toBe(await csrfFor(SECRET, binder));
    // A malformed one is replaced.
    expect(setCookie(await get("/admin/login", "__Host-0c_setup=short"), "__Host-0c_setup")).toBeDefined();
  });

  it("a signed-in page carries the token bound to the session cookie", async () => {
    const s = await signedIn(e);
    expect(s.csrf).toBe(await csrfFor(SECRET, valueOf(s.cookie)!));
    const r = await get("/admin/developers", s.cookie);
    expect(r.status).toBe(200);
    expect(csrfIn(await r.text())).toBe(s.csrf);
    expect(setCookie(r, "__Host-0c_setup")).toBeUndefined();
  });

  it("a token for session A is rejected with session B's cookie", async () => {
    const a = await signedIn(e);
    const gen = await sessionGen(e.DB);
    const b = `__Host-0c_session=${await signSession(SECRET, gen, Date.now() + HOUR - 12_345)}`;
    expect(b).not.toBe(a.cookie);
    expect((await post("/admin/alerts/none/resolve", { csrf: a.csrf }, b)).status).toBe(403);
    expect((await post("/admin/alerts/none/resolve", { csrf: a.csrf }, a.cookie)).status).toBe(303);
  });

  it("a pre-auth token posted after login is rejected", async () => {
    const g = await get(LOGIN_PAGE);
    const setup = valueOf(setCookie(g, "__Host-0c_setup"))!;
    const pre = csrfIn(await g.text())!;
    // Accepted pre-auth on a public path (a refused passkey, not a 403).
    expect((await post("/admin/login", { csrf: pre, assertion: "{}" }, `__Host-0c_setup=${setup}`)).status).toBe(401);
    const s = await signedIn(e);
    const both = `${s.cookie}; __Host-0c_setup=${setup}`;
    expect((await post("/admin/alerts/none/resolve", { csrf: pre }, both)).status).toBe(403);
    expect((await post("/admin/alerts/none/resolve", { csrf: s.csrf }, both)).status).toBe(303);
  });

  it("a missing or empty token gives 403", async () => {
    const s = await signedIn(e);
    expect((await post("/admin/alerts/none/resolve", {}, s.cookie)).status).toBe(403);
    expect((await post("/admin/alerts/none/resolve", { csrf: "" }, s.cookie)).status).toBe(403);
    expect((await post("/admin/login", { assertion: "{}" })).status).toBe(403);
  });

  it("a token minted under a stale generation is rejected", async () => {
    const s = await signedIn(e);
    await bumpSessionGen(e.DB);
    expect((await post("/admin/alerts/none/resolve", { csrf: s.csrf }, s.cookie)).status).toBe(403);
  });
});

describe("POS", () => {
  it("an admin __Host-0c_session cookie opens /pos; after bumpSessionGen it does not", async () => {
    const s = await signedIn(e);
    expect(await (await get("/pos", s.cookie)).text()).toContain('name="amount"');
    await bumpSessionGen(e.DB);
    expect(await (await get("/pos", s.cookie)).text()).not.toContain('name="amount"');
  });

  it("a bare 0c_session cookie on https does not open /pos", async () => {
    const s = await signedIn(e);
    expect(await (await get("/pos", `0c_session=${valueOf(s.cookie)}`)).text()).not.toContain('name="amount"');
  });
});

describe("routes", () => {
  it("the admin app still 503s without a usable secret", async () => {
    const app = new Hono().route("/admin", admin);
    expect((await app.request("/admin/login", {}, { ...e, SESSION_SECRET: "" })).status).toBe(503);
  });
});
