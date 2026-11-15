import { wordlist } from "@scure/bip39/wordlists/english.js";
import { sha256Hex } from "../api/auth";
import { rateKeyIp } from "../core/ip";
import { recordAlert } from "../db/alerts";
import type { Env } from "../env";
import { hmacHex, safeEqual } from "./session";

/*
 * One-time setup codes and recovery secrets.
 *
 * Setup (purpose "setup", only while no passkey exists): the gateway prints a 6-word code (BIP39 English words, 66 bits)
 * to the Worker logs and the owner types it to claim the admin. Only sha256Hex of the normalised phrase is stored. A code
 * lives 60 minutes; at most 3 live codes (printing a 4th deletes the oldest); a new one can be printed at most once per
 * 120 s. The phrase appears in exactly one place: the log line printed by printCode.
 *
 * Recovery (purpose "recover") never prints anything: reading logs is not proof of owning the account (read-only
 * members and log destinations can read them). The owner sets a Worker secret, ADMIN_RECOVERY_CODE (32+ characters),
 * which only someone allowed to change the Worker can do, and types the same value. Each value works once: the recovery
 * batch stores recoveryHash(value) as a used row (purpose "recover") and refuses a value already stored.
 *
 * Every check first reserves an attempt slot for the client (setup_attempts, the same atomic upsert as POS PINs), BEFORE
 * the code is looked at: 5 per 10 minutes per client (an IPv6 /64 is one client; the key is an HMAC, never the IP).
 * Over it: 429 and the code is not checked. A correct code clears the client's counter. The global counter only
 * counts wrong codes for the setup.abuse alert and NEVER blocks: a flood from many addresses must not lock the owner
 * out, and with 66 bits per code the per-client limit is enough.
 */

export type CodePurpose = "setup" | "recover";

export const CODE_TTL_MS = 3_600_000;
export const PRINT_INTERVAL_MS = 120_000;
export const MAX_LIVE_CODES = 3;
export const CLIENT_MAX_WRONG = 5;
const CLIENT_WINDOW_MS = 600_000;
export const GLOBAL_ABUSE_THRESHOLD = 100;
const GLOBAL_WINDOW_MS = 3_600_000;
const GLOBAL_KEY = "global";
/** Longer input is never a valid phrase; refusing it early bounds the work an attacker can ask for. */
const MAX_INPUT = 1024;
/** ADMIN_SETUP_CODE is ignored unless it is at least this long (a weak deploy-time code must not open the admin). */
const MIN_ENV_CODE = 32;

export const BAD_CODE = "That code is not valid or has expired. Check the latest code in your Worker logs.";
export const BAD_RECOVERY = "That is not the value of the ADMIN_RECOVERY_CODE secret, or it was already used. Set a new value and try again.";
export const NO_RECOVERY_SECRET = "The ADMIN_RECOVERY_CODE secret is not set, or is shorter than 32 characters. Add it first (step 2), then try again.";
/** How long a used recovery value stays refused: for good. */
export const USED_FOREVER = 8_640_000_000_000_000;
export const TOO_MANY = "Too many wrong codes. Wait 10 minutes and try again.";
const ABUSE_LINE = "0crypto: setup.abuse more than 100 wrong setup or recovery codes within an hour";

const WORDS: ReadonlySet<string> = new Set(wordlist);

/** A fresh code: 6 words, each `random u16 & 2047` into the BIP39 English list. */
export function newSetupCode(): string {
  return Array.from(crypto.getRandomValues(new Uint16Array(6)), (r) => wordlist[r & 2047]!).join(" ");
}

/** A suggested recovery value: 8 words joined by hyphens (88 bits, over 32 characters). Shown on the page, never stored. */
export function newRecoveryValue(): string {
  for (;;) {
    const v = Array.from(crypto.getRandomValues(new Uint16Array(8)), (r) => wordlist[r & 2047]!).join("-");
    if (v.length >= MIN_ENV_CODE) return v;
  }
}

/** What a used recovery value is stored as (its own namespace, so it can never match a setup code's hash). */
export const recoveryHash = async (value: string): Promise<string> => `recover:${await sha256Hex(value)}`;

/** The canonical phrase (NFKD, lowercase, single spaces), or null unless it is exactly 6 words all on the list. */
export function normalizeCode(input: string): string | null {
  if (input.length > MAX_INPUT) return null;
  const words = input.normalize("NFKD").toLowerCase().trim().split(/\s+/);
  if (words.length !== 6 || !words.every((w) => WORDS.has(w))) return null;
  return words.join(" ");
}

/**
 * Prints a new setup code to the logs unless one was printed in the last 120 s. The insert is conditional on
 * that in the same statement, so concurrent callers print at most one. The same batch deletes this purpose's codes
 * beyond the newest 3 live ones (and its expired ones).
 */
export async function printCode(db: D1Database, purpose: "setup", now: number): Promise<"printed" | "too_soon"> {
  const code = newSetupCode();
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO setup_codes(hash,purpose,created_at,expires_at)
         SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (SELECT 1 FROM setup_codes WHERE purpose=?2 AND created_at>?5)`,
      )
      .bind(await sha256Hex(code), purpose, now, now + CODE_TTL_MS, now - PRINT_INTERVAL_MS),
    db
      .prepare(
        `DELETE FROM setup_codes WHERE purpose=?1 AND hash NOT IN
           (SELECT hash FROM setup_codes WHERE purpose=?1 AND expires_at>?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3)`,
      )
      .bind(purpose, now, MAX_LIVE_CODES),
  ]);
  if ((ins!.meta.changes ?? 0) !== 1) return "too_soon";
  // The only place a code is ever written out.
  console.log(`0crypto setup code: ${code} (valid 60 min)`);
  return "printed";
}

/** Prints a setup code only when none is live. */
export async function ensureCode(db: D1Database, purpose: "setup", now: number): Promise<void> {
  const live = await db.prepare("SELECT 1 AS x FROM setup_codes WHERE purpose=? AND expires_at>? LIMIT 1").bind(purpose, now).first();
  if (!live) await printCode(db, purpose, now);
}

/** The pos_attempts upsert (src/pos/store.ts reserve) on setup_attempts: counts one on `key`; a stale window restarts at 1. */
async function reserve(db: D1Database, key: string, windowMs: number, now: number): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO setup_attempts(key,n,window_start) VALUES(?1,1,?2)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start < ?3 THEN 1 ELSE n + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING n, window_start`,
    )
    .bind(key, now, now - windowMs)
    .first<{ n: number; window_start: number }>();
  if (!r) throw new Error("setup_attempts: no row returned");
  return r.n;
}

/** Counts a wrong code globally and raises setup.abuse once per window. Best effort: it never blocks and never throws. */
async function countWrong(db: D1Database, now: number): Promise<void> {
  try {
    if ((await reserve(db, GLOBAL_KEY, GLOBAL_WINDOW_MS, now)) !== GLOBAL_ABUSE_THRESHOLD + 1) return;
    console.log(ABUSE_LINE);
    await recordAlert(
      db,
      "setup.abuse",
      null,
      `More than ${GLOBAL_ABUSE_THRESHOLD} wrong setup or recovery codes within an hour across all addresses. Sign-in is not blocked; each address is limited to ${CLIENT_MAX_WRONG} tries per 10 minutes. Check access logs.`,
      now,
      { dedupe: true },
    );
  } catch {
    // The alert is advisory; a failure here must not turn a wrong code into an error or a block.
  }
}

export type CodeCheck = { ok: true; hash: string } | { ok: false; status: 400 | 429; error: string };

/**
 * Checks a typed code. `ip` is the client address or its clientIpKey (rateKeyIp is idempotent). The attempt slot is
 * reserved first; over the limit the code is not looked at. Does not consume the code: the claim batch spends it (and
 * the recovery batch stores it as used). "setup": a live logged code, or a deploy-time ADMIN_SETUP_CODE of at least 32
 * chars (hash "env"). "recover": only the ADMIN_RECOVERY_CODE secret (32+ chars) not used before (hash recoveryHash).
 * A D1 error on the client slot throws (the caller answers an error; nothing is checked).
 */
export async function checkCode(env: Env, ip: string, purpose: CodePurpose, input: string, now: number): Promise<CodeCheck> {
  const key = `ip:${await hmacHex(env.SESSION_SECRET, rateKeyIp(ip))}`;
  if ((await reserve(env.DB, key, CLIENT_WINDOW_MS, now)) > CLIENT_MAX_WRONG) return { ok: false, status: 429, error: TOO_MANY };

  let hash: string | null = null;
  if (purpose === "recover") {
    const secret = (env.ADMIN_RECOVERY_CODE ?? "").trim();
    if (secret.length < MIN_ENV_CODE) return { ok: false, status: 400, error: NO_RECOVERY_SECRET };
    if (input.length <= MAX_INPUT && safeEqual(input.trim(), secret)) {
      const h = await recoveryHash(secret);
      const used = await env.DB.prepare("SELECT 1 AS x FROM setup_codes WHERE hash=? AND purpose='recover'").bind(h).first();
      if (!used) hash = h;
    }
    if (hash === null) {
      await countWrong(env.DB, now);
      return { ok: false, status: 400, error: BAD_RECOVERY };
    }
    await env.DB.prepare("DELETE FROM setup_attempts WHERE key=?").bind(key).run();
    return { ok: true, hash };
  }
  const envCode = (env.ADMIN_SETUP_CODE ?? "").trim();
  if (envCode.length >= MIN_ENV_CODE && input.length <= MAX_INPUT && safeEqual(input.trim(), envCode)) {
    hash = "env";
  } else {
    const phrase = normalizeCode(input);
    if (phrase !== null) {
      const h = await sha256Hex(phrase);
      const row = await env.DB.prepare("SELECT 1 AS x FROM setup_codes WHERE hash=? AND purpose='setup' AND expires_at>?").bind(h, now).first();
      if (row) hash = h;
    }
  }

  if (hash === null) {
    await countWrong(env.DB, now);
    return { ok: false, status: 400, error: BAD_CODE };
  }
  await env.DB.prepare("DELETE FROM setup_attempts WHERE key=?").bind(key).run();
  return { ok: true, hash };
}

/** Deletes the live code with this hash; run it in the claim's batch and require meta.changes === 1 (single use). */
export function consumeCodeStmt(db: D1Database, hash: string, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM setup_codes WHERE hash=? AND expires_at>?").bind(hash, now);
}
