import { exports } from "cloudflare:workers";
import type { ConfirmAction } from "../src/admin/confirm";
import { SESSION_COOKIE, SESSION_MAX_AGE, SETUP_COOKIE, cookieName, csrfFor, newSetupBinder, sessionGen, signSession } from "../src/admin/session";
import type { Env } from "../src/env";
import { effectiveEnv } from "../src/settings";
import { SoftAuthenticator } from "./passkey";

/** A signed-in admin for Workers-pool tests. */
export type AdminTestSession = {
  /** Its credential is a row in `passkeys`. */
  authenticator: SoftAuthenticator;
  /** `__Host-0c_session=<value>` (the bare name for an http loopback base). */
  cookie: string;
  /** The form token bound to this session cookie. */
  csrf: string;
  /** `{ cookie }`, to spread into request headers. */
  headers: Record<string, string>;
  /**
   * A passkey assertion (JSON) for `action` on `path` with these form fields, the way public/admin-passkey.js gets one:
   * POST /admin/webauthn/challenge with params = { ...fields, _path: path }, then the authenticator signs the options.
   */
  confirm: (action: ConfirmAction, path: string, fields: Record<string, string>) => Promise<string>;
};

let lastExp = 0;

/**
 * Registers a new software passkey and signs a session under the current `session_gen`, the way a passkey sign-in
 * does. Secrets come from the effective env, so this works when SESSION_SECRET is blank and the instance key is used.
 */
export async function signedIn(env: Env, base = "https://pay.test"): Promise<AdminTestSession> {
  const secret = (await effectiveEnv(env)).SESSION_SECRET;
  const authenticator = new SoftAuthenticator();
  await env.DB.prepare("INSERT OR IGNORE INTO passkeys(id,public_key,counter,transports,name,created_at,rp_id) VALUES(?,?,?,?,?,?,?)")
    .bind(authenticator.credentialId, authenticator.cosePublicKey, 0, JSON.stringify(["internal"]), "Test passkey", Date.now(), new URL(base).hostname)
    .run();
  // Strictly increasing expiries, so two sessions are always distinct cookies with distinct CSRF tokens (a clock step
  // between two calls could otherwise cancel a decreasing offset and mint the same cookie twice).
  const exp = Math.max(Date.now() + SESSION_MAX_AGE * 1000 - 60_000, lastExp + 1);
  lastExp = exp;
  const value = await signSession(secret, await sessionGen(env.DB), exp);
  const cookie = `${cookieName(SESSION_COOKIE, base)}=${value}`;
  const csrf = await csrfFor(secret, value);
  const confirm = async (action: ConfirmAction, path: string, fields: Record<string, string>): Promise<string> => {
    const r = await exports.default.fetch(`${base}/admin/webauthn/challenge`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, action, params: JSON.stringify({ ...fields, _path: path }) }),
    });
    if (r.status !== 200) throw new Error(`challenge for ${action} on ${path}: ${r.status} ${await r.text()}`);
    const { options } = (await r.json()) as { options: Parameters<SoftAuthenticator["assert"]>[0] };
    return JSON.stringify(await authenticator.assert(options, new URL(base).origin));
  };
  return { authenticator, cookie, csrf, headers: { cookie }, confirm };
}

/** A signed-out browser: a pre-auth `0c_setup` binder cookie and the CSRF token bound to it (for public forms). */
export async function preAuth(env: Env, base = "https://pay.test"): Promise<{ cookie: string; csrf: string; headers: Record<string, string> }> {
  const secret = (await effectiveEnv(env)).SESSION_SECRET;
  const binder = newSetupBinder();
  const cookie = `${cookieName(SETUP_COOKIE, base)}=${binder}`;
  return { cookie, csrf: await csrfFor(secret, binder), headers: { cookie } };
}
