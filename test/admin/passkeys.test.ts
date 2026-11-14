// The Passkeys page (Plan 7 Task 8): add a backup passkey, rename, remove (never the last) and sign out everywhere.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { BAD_ASSERTION, NEEDS_JS } from "../../src/admin/confirm";
import type { Env } from "../../src/env";
import { disablePin, getPosConfig, mintPosCookie, setPin } from "../../src/pos/store";
import { effectiveEnv } from "../../src/settings";
import { signedIn, type AdminTestSession } from "../admin-session";
import { SoftAuthenticator } from "../passkey";
import { confirmFields } from "./helpers";

const e = env as unknown as Env;
const BASE = "https://pay.test";
let S: AdminTestSession;

beforeEach(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await e.DB.batch([e.DB.prepare("DELETE FROM passkeys"), e.DB.prepare("DELETE FROM webauthn_challenges")]);
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
const rows = async () => (await e.DB.prepare("SELECT id,name FROM passkeys ORDER BY created_at, id").all<{ id: string; name: string }>()).results;

/** Registration options for a new passkey (the options endpoint), then the credential a second authenticator makes. */
async function newCredential(name: string, auth = new SoftAuthenticator()) {
  const r = await post("/admin/passkeys/options", { csrf: S.csrf, name });
  expect(r.status).toBe(200);
  const { options } = (await r.json()) as { options: PublicKeyCredentialCreationOptionsJSON };
  return { auth, options, credential: JSON.stringify(await auth.register(options, BASE)) };
}

async function add(name: string, auth = new SoftAuthenticator()) {
  const c = await newCredential(name, auth);
  const assertion = await S.confirm("passkey.add", "/admin/passkeys", { name });
  return { ...c, res: await post("/admin/passkeys", { csrf: S.csrf, name, assertion, credential: c.credential }) };
}

describe("passkeys page", () => {
  it("lists the passkey with rename, remove, add and sign-out-everywhere forms", async () => {
    const r = await get("/admin/passkeys");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Test passkey");
    expect(html).toContain('data-passkey-confirm="passkey.add"');
    expect(html).toContain('data-passkey-register="/admin/passkeys/options"');
    expect(html).toContain('data-passkey-confirm="passkey.remove"');
    expect(html).toContain("/rename");
    expect(html).toContain('action="/admin/logout-all"');
    expect(html).toContain("Sign out everywhere");
    expect(html).toMatch(/name="name"[^>]*maxlength="64"[^>]*value="Passkey 2"|value="Passkey 2"[^>]*maxlength="64"/);
  });
  it("with one passkey, Remove is disabled and says why; with two it is enabled", async () => {
    const html = await (await get("/admin/passkeys")).text();
    expect(html).toMatch(/You can(&#39;|')t remove your only passkey/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Remove/);
    await signedIn(e);
    const two = await (await get("/admin/passkeys")).text();
    expect(two).not.toMatch(/only passkey/);
  });
  it("pins the fields every confirm form binds, and mentions cashier PIN sessions", async () => {
    const html = await (await get("/admin/passkeys")).text();
    expect(confirmFields(html, "/admin/passkeys")).toEqual(["name"]);
    expect(confirmFields(html, `/admin/passkeys/${encodeURIComponent(S.authenticator.credentialId)}/remove`)).toEqual([]);
    expect(html).toContain("cashier PIN sessions");
    expect(html).toMatch(/href="#add-passkey"[^>]*>\s*\+ Add a passkey/);
  });
  it("needs a session", async () => {
    const r = await exports.default.fetch(`${BASE}/admin/passkeys`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/login");
  });
  it("the navigation names Passkeys, Settings and Developers, not API keys", async () => {
    const html = await (await get("/admin/passkeys")).text();
    expect(html).toContain('href="/admin/passkeys"');
    expect(html).toContain('href="/admin/settings"');
    expect(html).toContain('href="/admin/developers"');
    expect(html).not.toContain(">API keys<");
  });
});

describe("add", () => {
  it("adding a second passkey (assertion plus registration) lists 2 rows", async () => {
    const { res, options } = await add("Backup");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/passkeys");
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([S.authenticator.credentialId]);
    expect((await rows()).map((r) => r.name).sort()).toEqual(["Backup", "Test passkey"]);
    expect(await e.DB.prepare("SELECT rp_id FROM passkeys WHERE name='Backup'").first()).toEqual({ rp_id: "pay.test" });
    const html = await (await get("/admin/passkeys")).text();
    expect(html).toContain("Backup");
  });
  it("without an assertion gives 403", async () => {
    const { credential } = await newCredential("Backup");
    const r = await post("/admin/passkeys", { csrf: S.csrf, name: "Backup", assertion: "", credential });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(NEEDS_JS);
    expect(await rows()).toHaveLength(1);
  });
  it("an assertion approved for another name is refused", async () => {
    const { credential } = await newCredential("Backup");
    const assertion = await S.confirm("passkey.add", "/admin/passkeys", { name: "Other" });
    const r = await post("/admin/passkeys", { csrf: S.csrf, name: "Backup", assertion, credential });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain(BAD_ASSERTION);
    expect(await rows()).toHaveLength(1);
  });
  it("on an origin other than PUBLIC_URL, options and finish say to open PUBLIC_URL and start no ceremony", async () => {
    const other = await signedIn(e, "https://other.test");
    const at = (path: string, form: Record<string, string>) =>
      exports.default.fetch(`https://other.test${path}`, { method: "POST", redirect: "manual", headers: { cookie: other.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    const o = await at("/admin/passkeys/options", { csrf: other.csrf, name: "Backup" });
    expect(o.status).toBe(400);
    expect(await o.json()).toEqual({ error: "Open https://pay.test/admin/passkeys" });
    const f = await at("/admin/passkeys", { csrf: other.csrf, name: "Backup", assertion: "{}", credential: "{}" });
    expect(f.status).toBe(400);
    expect(await f.text()).toContain("Open https://pay.test/admin/passkeys");
    expect((await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges").first<{ n: number }>())!.n).toBe(0);
  });
  it("a registration made for another name is refused", async () => {
    const { credential } = await newCredential("Other");
    const assertion = await S.confirm("passkey.add", "/admin/passkeys", { name: "Backup" });
    const r = await post("/admin/passkeys", { csrf: S.csrf, name: "Backup", assertion, credential });
    expect(r.status).toBe(400);
    expect(await rows()).toHaveLength(1);
  });
});

describe("rename", () => {
  it("a rename to Laptop shows up in the list", async () => {
    const id = (await rows())[0]!.id;
    const r = await post(`/admin/passkeys/${id}/rename`, { csrf: S.csrf, name: "Laptop" });
    expect(r.status).toBe(303);
    expect(await (await get("/admin/passkeys")).text()).toContain("Laptop");
    expect((await rows())[0]!.name).toBe("Laptop");
  });
  it("needs the CSRF token", async () => {
    const id = (await rows())[0]!.id;
    expect((await post(`/admin/passkeys/${id}/rename`, { name: "Laptop" })).status).toBe(403);
  });
});

describe("remove", () => {
  it("the only passkey gives 409", async () => {
    const id = (await rows())[0]!.id;
    const assertion = await S.confirm("passkey.remove", `/admin/passkeys/${id}/remove`, {});
    const r = await post(`/admin/passkeys/${id}/remove`, { csrf: S.csrf, assertion });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("You cannot remove your only passkey.");
    expect(await rows()).toHaveLength(1);
  });
  it("one of two gives 303; the acting session stays signed in and an earlier session is signed out", async () => {
    const other = await signedIn(e); // a second session signed earlier than the removal (its own passkey makes 2 rows)
    expect(await rows()).toHaveLength(2);
    const id = other.authenticator.credentialId;
    const assertion = await S.confirm("passkey.remove", `/admin/passkeys/${id}/remove`, {});
    const r = await post(`/admin/passkeys/${id}/remove`, { csrf: S.csrf, assertion });
    expect(r.status).toBe(303);
    expect(await rows()).toHaveLength(1);
    const fresh = r.headers.getSetCookie().find((c) => c.startsWith("__Host-0c_session=") && !c.startsWith("__Host-0c_session=;"))!.split(";")[0]!;
    expect((await get("/admin", fresh)).status).toBe(200);
    expect((await get("/admin", other.cookie)).status).toBe(302);
    expect((await get("/admin", S.cookie)).status).toBe(302); // the old cookie of the acting browser is replaced
  });
  it("without an assertion gives 403 and removes nothing", async () => {
    const other = await signedIn(e);
    const r = await post(`/admin/passkeys/${other.authenticator.credentialId}/remove`, { csrf: S.csrf, assertion: "" });
    expect(r.status).toBe(403);
    expect(await rows()).toHaveLength(2);
  });
  it("an assertion for one passkey does not remove another", async () => {
    const other = await signedIn(e);
    const mine = S.authenticator.credentialId;
    const assertion = await S.confirm("passkey.remove", `/admin/passkeys/${mine}/remove`, {});
    const r = await post(`/admin/passkeys/${other.authenticator.credentialId}/remove`, { csrf: S.csrf, assertion });
    expect(r.status).toBe(403);
    expect(await rows()).toHaveLength(2);
  });
  it("an unknown passkey gives 404", async () => {
    await signedIn(e);
    const assertion = await S.confirm("passkey.remove", "/admin/passkeys/nope/remove", {});
    expect((await post("/admin/passkeys/nope/remove", { csrf: S.csrf, assertion })).status).toBe(404);
  });
  it("also ends an admin-opened POS session", async () => {
    const other = await signedIn(e);
    const open = await post("/admin/pos/open", { csrf: S.csrf });
    const pos = `0c_pos=${/0c_pos=([^;]+)/.exec(open.headers.get("set-cookie") ?? "")![1]}`;
    expect((await get("/pos/recent", pos)).status).toBe(200);
    const id = other.authenticator.credentialId;
    const assertion = await S.confirm("passkey.remove", `/admin/passkeys/${id}/remove`, {});
    expect((await post(`/admin/passkeys/${id}/remove`, { csrf: S.csrf, assertion })).status).toBe(303);
    expect((await get("/pos/recent", pos)).status).toBe(401);
  });
});

describe("passkeys for another RP ID", () => {
  /** A passkey made for an old domain (before a move): it can no longer sign in here. */
  const foreign = async (id = "old-domain-passkey") => {
    await e.DB.prepare("INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id) VALUES(?,x'00',0,'[\"usb\"]','Old laptop',?,'old.test')").bind(id, Date.now()).run();
    return id;
  };
  it("each row says where it works", async () => {
    await foreign();
    const html = await (await get("/admin/passkeys")).text();
    expect(html).toContain("works on pay.test");
    expect(html).toContain("works on old.test");
  });
  it("do not count for the remove-last guard: the only pay.test passkey stays (409), the old.test one can always go", async () => {
    const old = await foreign();
    const mine = S.authenticator.credentialId;
    const a1 = await S.confirm("passkey.remove", `/admin/passkeys/${mine}/remove`, {});
    const r1 = await post(`/admin/passkeys/${mine}/remove`, { csrf: S.csrf, assertion: a1 });
    expect(r1.status).toBe(409);
    expect(await r1.text()).toContain("You cannot remove your only passkey.");
    const a2 = await S.confirm("passkey.remove", `/admin/passkeys/${old}/remove`, {});
    const r2 = await post(`/admin/passkeys/${old}/remove`, { csrf: S.csrf, assertion: a2 });
    expect(r2.status).toBe(303);
    expect((await rows()).map((r) => r.id)).toEqual([mine]);
  });
  it("the remove button is disabled only for the last passkey of this RP ID", async () => {
    const old = await foreign();
    const html = await (await get("/admin/passkeys")).text();
    const form = (id: string) => new RegExp(`action="/admin/passkeys/${id}/remove"[^]*?</form>`).exec(html)![0];
    expect(form(S.authenticator.credentialId)).toMatch(/<button[^>]*disabled/);
    expect(form(old)).not.toMatch(/<button[^>]*disabled/);
  });
  it("are left out of excludeCredentials and allowCredentials", async () => {
    const old = await foreign();
    const { options } = await newCredential("Backup");
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([S.authenticator.credentialId]);
    const r = await post("/admin/webauthn/challenge", { csrf: S.csrf, action: "pos.pin", params: JSON.stringify({ _path: "/admin/pos/pin" }) });
    const allow = ((await r.json()) as { options: { allowCredentials: { id: string }[] } }).options.allowCredentials.map((c) => c.id);
    expect(allow).toEqual([S.authenticator.credentialId]);
    expect(allow).not.toContain(old);
  });
});

describe("sign out everywhere", () => {
  it("logout-all makes the current cookie get 302 and answers 303 to the sign-in page", async () => {
    expect((await get("/admin")).status).toBe(200);
    const r = await post("/admin/logout-all", { csrf: S.csrf });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/login");
    expect(r.headers.getSetCookie().join("\n")).toMatch(/0c_session=;|0c_session=; /);
    expect((await get("/admin")).status).toBe(302);
  });
  it("says it ends cashier PIN sessions too, and does", async () => {
    expect(await (await get("/admin/passkeys")).text()).toContain("Ends every admin session on every device and every POS session, including cashier PIN sessions.");
    await setPin(e.DB, "12345678");
    const cfg = await getPosConfig(e.DB);
    const secret = (await effectiveEnv(e)).SESSION_SECRET;
    const pin = `0c_pos=${await mintPosCookie(secret, "p", cfg.version, Date.now() + 60_000)}`; // a cashier's PIN sign-in
    expect((await get("/pos/recent", pin)).status).toBe(200);
    await post("/admin/logout-all", { csrf: S.csrf });
    expect((await get("/pos/recent", pin)).status).toBe(401);
    await disablePin(e.DB);
  });
  it("ends every other session and an admin-opened POS cookie", async () => {
    const other = await signedIn(e);
    const open = await post("/admin/pos/open", { csrf: S.csrf });
    const pos = `0c_pos=${/0c_pos=([^;]+)/.exec(open.headers.get("set-cookie") ?? "")![1]}`;
    expect((await get("/pos/recent", pos)).status).toBe(200);
    await post("/admin/logout-all", { csrf: S.csrf });
    expect((await get("/admin", other.cookie)).status).toBe(302);
    expect((await get("/pos/recent", pos)).status).toBe(401);
  });
  it("needs the CSRF token", async () => {
    expect((await post("/admin/logout-all", {})).status).toBe(403);
    expect((await get("/admin")).status).toBe(200);
  });
});

