import { hashPassword, verifyPassword } from "../admin/password";
import { hmacHex, safeEqual } from "../admin/session";
import { formatFiat } from "../core/money";
import { recordAlert } from "../db/alerts";
import type { Env } from "../env";

/*
 * Session notes. Cookies are stateless HMACs: there is no per-session revoke, only "change or disable the PIN", which bumps
 * the version and ends every POS session at once. An admin-opened ("a") cookie survives an admin logout until it expires (2h)
 * or the PIN version changes. The admin session cookie (`__Host-0c_session`, bare `0c_session` on http loopback) has
 * Path=/, so a signed-in admin's browser sends it to /pos too and /pos accepts it as a session: it ends with the admin
 * session (logout, expiry, or a session_gen bump). A `0c_pos` cookie means nothing on /admin.
 *
 * POS state: the PIN settings row (D1), the POS session cookie, the CSRF token bound to a session, the login lockout
 * counters (KV) and the recent-invoices read. Nothing here creates invoices or touches money.
 */

export const POS_COOKIE = "0c_pos";
/** PIN sessions last 12h. Admin-opened sessions last 2h (they outlive an admin logout, so keep them short). */
export const POS_MAX_AGE = 12 * 3600;
export const POS_ADMIN_MAX_AGE = 2 * 3600;
export const maxAgeOf = (kind: "p" | "a"): number => (kind === "a" ? POS_ADMIN_MAX_AGE : POS_MAX_AGE);
/** 8 digits: with the global limit below, a full sweep of 10^8 PINs at 200 guesses an hour takes about 57 years. */
export const MIN_PIN_DIGITS = 8;
export const MAX_PIN_DIGITS = 32;
export const validPin = (s: string): boolean => new RegExp(`^\\d{${MIN_PIN_DIGITS},${MAX_PIN_DIGITS}}$`).test(s);

// ---------- PIN settings ----------

export interface PosConfig {
  pin_hash: string | null;
  pin_salt: string | null;
  version: number;
}

export async function getPosConfig(db: D1Database): Promise<PosConfig> {
  const r = await db.prepare("SELECT pin_hash,pin_salt,version FROM pos_config WHERE id=1").first<PosConfig>();
  return r ?? { pin_hash: null, pin_salt: null, version: 0 };
}

/** Sets (or changes) the PIN. The version bump invalidates every POS cookie issued before. The caller validated the format. */
export async function setPin(db: D1Database, pin: string, now = Date.now()): Promise<void> {
  const { hash, salt } = await hashPassword(pin);
  await db.prepare("UPDATE pos_config SET pin_hash=?, pin_salt=?, version=version+1, updated_at=? WHERE id=1").bind(hash, salt, now).run();
}

/** Disables PIN login: clears the hash and bumps the version, so every POS cookie stops working. */
/** Ends every POS cookie (PIN sessions and admin-opened ones) without touching the PIN: used by sign out everywhere and passkey removal. */
export async function bumpPosVersion(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE pos_config SET version=version+1, updated_at=? WHERE id=1").bind(now).run();
}

export async function disablePin(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE pos_config SET pin_hash=NULL, pin_salt=NULL, version=version+1, updated_at=? WHERE id=1").bind(now).run();
}

/** PBKDF2 hash comparison in constant time (verifyPassword). False when no PIN is set. */
export async function checkPin(cfg: PosConfig, pin: string): Promise<boolean> {
  if (!cfg.pin_hash || !cfg.pin_salt) return false;
  return verifyPassword(pin, cfg.pin_hash, cfg.pin_salt);
}

// ---------- session cookie ----------

/** `p` = issued after a PIN login (only valid while a PIN is set); `a` = issued from the admin panel (needs no PIN). */
export type PosKind = "p" | "a";

/** `<kind>.<pin version>.<exp unix ms>.<hex hmac-sha256(SESSION_SECRET, "pos:<kind>:<version>:<exp>")>` */
export async function mintPosCookie(secret: string, kind: PosKind, version: number, exp: number): Promise<string> {
  return `${kind}.${version}.${exp}.${await hmacHex(secret, `pos:${kind}:${version}:${exp}`)}`;
}

/** The cookie's kind if the signature, expiry and PIN version are all current, else null. */
export async function verifyPosCookie(secret: string, value: string | undefined, cfg: PosConfig, now: number): Promise<PosKind | null> {
  const m = /^([pa])\.(\d{1,9})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(value ?? "");
  if (!m) return null;
  const kind = m[1] as PosKind;
  const [version, exp] = [Number(m[2]), Number(m[3])];
  if (!safeEqual(await hmacHex(secret, `pos:${kind}:${version}:${exp}`), m[4]!)) return null;
  if (exp <= now || exp > now + maxAgeOf(kind) * 1000 + 60_000) return null;
  if (version !== cfg.version) return null;
  if (kind === "p" && !cfg.pin_hash) return null; // a PIN session means nothing once the PIN is gone
  return kind;
}

/** Form token bound to one session: HMAC of the session cookie value, so another session's token never verifies. */
export const posCsrf = (secret: string, binder: string): Promise<string> => hmacHex(secret, `pos-csrf:${binder}`);
export async function validPosCsrf(secret: string, binder: string, sent: string): Promise<boolean> {
  return /^[0-9a-f]{64}$/.test(sent) && safeEqual(await posCsrf(secret, binder), sent);
}

// ---------- login lockout (D1) ----------
// Every PIN attempt first reserves a slot, per address (an HMAC of the IP, never the raw IP) and globally, in one atomic
// upsert each (pos_attempts), BEFORE any PBKDF2 runs. Over a limit: 429 and no PIN check. Per address: 5 attempts per 15
// minutes (the 5th wrong PIN already answers 429). Globally: 200 attempts per hour across all addresses; passing it locks
// POS PIN login for everyone until that window ends and raises the pos.lockout alert. A correct PIN clears the address and
// gives its global slot back, so the merchant's own sign-ins never use up the budget. Windows are fixed from the first
// attempt (never extended). Any D1 error is an error to the caller, which answers 429 (fail closed).

export const IP_MAX_ATTEMPTS = 5;
const IP_WINDOW_MS = 15 * 60_000;
export const GLOBAL_MAX_ATTEMPTS = 200;
const GLOBAL_WINDOW_MS = 3_600_000;
export const GLOBAL_KEY = "global";
const ipKey = async (secret: string, ip: string) => `ip:${await hmacHex(secret, ip)}`;

/** Atomically counts one attempt on `key`: a window older than `windowMs` restarts at 1. Returns the new count and window start. */
export async function reserve(db: D1Database, key: string, windowMs: number, now: number): Promise<{ n: number; start: number }> {
  const r = await db
    .prepare(
      `INSERT INTO pos_attempts(key,n,window_start) VALUES(?1,1,?2)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start < ?3 THEN 1 ELSE n + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING n, window_start`,
    )
    .bind(key, now, now - windowMs)
    .first<{ n: number; window_start: number }>();
  if (!r) throw new Error("pos_attempts: no row returned");
  return { n: r.n, start: r.window_start };
}

export interface Reservation {
  ok: boolean;
  ipKey: string;
  ipN: number;
  globalStart: number;
}

/** Reserves one attempt for this address and globally. Throws on a D1 error. ok=false means: refuse, do not check the PIN. */
export async function reservePosAttempt(env: Pick<Env, "DB" | "SESSION_SECRET">, ip: string, now = Date.now()): Promise<Reservation> {
  const key = await ipKey(env.SESSION_SECRET, ip);
  const i = await reserve(env.DB, key, IP_WINDOW_MS, now);
  if (i.n > IP_MAX_ATTEMPTS) return { ok: false, ipKey: key, ipN: i.n, globalStart: 0 };
  const g = await reserve(env.DB, GLOBAL_KEY, GLOBAL_WINDOW_MS, now);
  if (g.n === GLOBAL_MAX_ATTEMPTS + 1) {
    await recordAlert(env.DB, "pos.lockout", null, `More than ${GLOBAL_MAX_ATTEMPTS} POS PIN attempts within an hour: POS PIN login is locked for everyone until the hour ends. Check access logs; change the PIN if it may have been guessed.`, now).catch(() => false);
  }
  return { ok: g.n <= GLOBAL_MAX_ATTEMPTS, ipKey: key, ipN: i.n, globalStart: g.start };
}

/** After a correct PIN: forget this address and return the global slot (same window only). */
export async function releasePosAttempt(env: Pick<Env, "DB">, r: Reservation): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pos_attempts WHERE key=?").bind(r.ipKey),
    env.DB.prepare("UPDATE pos_attempts SET n = MAX(n-1,0) WHERE key=? AND window_start=?").bind(GLOBAL_KEY, r.globalStart),
  ]);
}

// ---------- recent invoices ----------

export interface RecentInvoice {
  amount: string;
  currency: string;
  status: string;
  created_at: string;
}

/** The last 20 POS invoices. Amount, currency, status and time only: no ids, customer data or addresses. */
export async function recentPos(db: D1Database, now = Date.now()): Promise<RecentInvoice[]> {
  const { results } = await db
    .prepare("SELECT price_minor,currency,status,created_at,expires_at FROM invoices WHERE json_extract(metadata, '$.pos') = 1 ORDER BY created_at DESC, id DESC LIMIT 20")
    .all<{ price_minor: string; currency: string; status: string; created_at: number; expires_at: number }>();
  return results.map((r) => ({
    amount: formatFiat(BigInt(r.price_minor)),
    currency: r.currency,
    // An unpaid invoice past its expiry is shown as expired even before the cron flips the stored status.
    status: r.status === "open" && now > r.expires_at ? "expired" : r.status,
    created_at: new Date(r.created_at).toISOString(),
  }));
}
