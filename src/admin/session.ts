import { bytesToHex } from "@noble/hashes/utils.js";
import { timingSafeEqual } from "./password";

/*
 * Admin sessions. The session cookie is a stateless HMAC over the admin's session generation and an expiry; bumping the
 * generation in admin_state (sign out everywhere, recovery) ends every session at once. CSRF tokens are not stored: a
 * token is an HMAC of the cookie it is bound to (the session cookie, or before sign-in the random `0c_setup` cookie), so
 * a token only works next to that one cookie.
 */

export const SESSION_COOKIE = "0c_session";
/** Pre-auth CSRF binder: 32 random bytes (base64url), HttpOnly, 1 h. */
export const SETUP_COOKIE = "0c_setup";
export const SETUP_MAX_AGE = 3600;
export const SESSION_MAX_AGE = 12 * 3600;

/** Hosts where plain http is allowed (local development), as URL.hostname spells them. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a cookie set in reply to this request gets the Secure flag. Always, except for plain http to a loopback host:
 * Safari drops Secure cookies sent over http even on localhost, which broke every admin form under `wrangler dev`.
 * A deployed Worker is reached over https on its own hostname, so it always sets Secure.
 */
export function secureCookie(url: string): boolean {
  const u = new URL(url);
  return !(u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
}

/**
 * The name a cookie has for this request: `__Host-<name>` whenever it is Secure (the browser then insists on Secure,
 * Path=/ and no Domain), else the bare name (http loopback only). Only this name is read back, so a bare cookie
 * planted over http (or by a sibling subdomain) is never accepted on https.
 */
export function cookieName(name: string, url: string): string {
  return secureCookie(url) ? `__Host-${name}` : name;
}

/** Attributes shared by every admin cookie: Path=/ (the session also reaches /pos), SameSite=Strict, never a Domain. */
export const cookieAttrs = (url: string) => ({ secure: secureCookie(url), sameSite: "Strict", path: "/" }) as const;

const enc = new TextEncoder();

/** Hex HMAC-SHA256. The only HMAC helper outside src/signing/: session cookies and public form tokens share it. */
export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg))));
}

export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(enc.encode(a), enc.encode(b));

/** The current session generation (admin_state.session_gen). */
export async function sessionGen(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT session_gen FROM admin_state WHERE id=1").first<{ session_gen: number }>())?.session_gen ?? 0;
}

/** Ends every admin session (and every CSRF token bound to one) at once. */
export async function bumpSessionGen(db: D1Database): Promise<void> {
  await db.prepare("UPDATE admin_state SET session_gen=session_gen+1 WHERE id=1").run();
}

// Named apart from signSession so verifySession computes the value without a call the signing perimeter counts.
const sessionValue = async (secret: string, gen: number, exp: number): Promise<string> =>
  `${gen}.${exp}.${await hmacHex(secret, `session:${gen}:${exp}`)}`;

/** `<gen>.<exp unix ms>.<hex hmac-sha256(secret, "session:<gen>:<exp>")>` */
export const signSession: (secret: string, gen: number, exp: number) => Promise<string> = sessionValue;

/**
 * True only for a value this code minted under the current generation that has not expired. The value is compared, in
 * constant time, with the one signSession mints for (gen, exp), so non-canonical numbers, other generations, extra
 * or missing parts and upper-case hex all fail.
 */
export async function verifySession(secret: string, value: string | undefined, now: number, gen: number): Promise<boolean> {
  const m = /^(\d{1,15})\.(\d{1,16})\.[0-9a-f]{64}$/.exec(value ?? "");
  if (!m || m[1] !== String(gen)) return false;
  const exp = Number(m[2]);
  // Reject far-future expiries too: a valid signature never carries more than the 12h lifetime (plus 60s skew).
  if (!(exp > now && exp <= now + SESSION_MAX_AGE * 1000 + 60_000)) return false;
  return safeEqual(m[0], await sessionValue(secret, gen, exp));
}

/** The CSRF token for forms next to this binder (a session cookie value or a pre-auth `0c_setup` value). */
export const csrfFor = (secret: string, binder: string): Promise<string> => hmacHex(secret, "csrf:" + binder);

/** A fresh pre-auth binder for the `0c_setup` cookie: 32 random bytes, base64url without padding (43 chars). */
export const newSetupBinder = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export const validSetupBinder = (v: string | undefined): v is string => v !== undefined && /^[A-Za-z0-9_-]{43}$/.test(v);
