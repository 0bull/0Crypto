import { base64urlnopad } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256Hex } from "../api/auth";
import { hmacHex, safeEqual } from "./session";
import type { ChallengeCheck } from "./webauthn";

/*
 * Single-use WebAuthn challenges in D1 (webauthn_challenges). A challenge is issued for one ceremony `kind` and one
 * `payloadHash` (bindingHash of what it authorises: for "action", the action and its parameters; "" when there is
 * nothing to bind). It is spent by one DELETE whose WHERE also matches kind and payload_hash and requires it to be
 * live, so it passes at most once, and a challenge issued for one purpose or action can never pass a check for
 * another (sign-in and action confirmation are both webauthn.get, so the library cannot tell them apart). A check with
 * the wrong kind or hash deletes nothing.
 *
 * The kinds anyone can start before signing in ("setup", "recover", "login") are not stored when issued: the challenge
 * is a signed token (random bytes, expiry, HMAC under SESSION_SECRET over them, the kind and the payload hash). Nothing
 * a flood of starts does can evict or refuse the owner's challenge. It is stored only when spent (signedChallengeCheck
 * inserts it; a second use conflicts), so it still passes at most once.
 */

export type ChallengeKind = "setup" | "recover" | "login" | "add" | "action";

export const MAX_LIVE_CHALLENGES = 500;
export const CHALLENGE_TTL_MS = 300_000;

/**
 * MAX_LIVE_CHALLENGES of a session-gated kind ("action", "add") are live: refuse to issue. The cap is per kind, so a
 * flood of pre-auth starts can never block a signed-in admin's "action" or "add".
 */
export class ChallengeLimit extends Error {
  constructor() {
    super("too many live webauthn challenges");
    this.name = "ChallengeLimit";
  }
}

/** The kinds anyone can start before signing in: signed, never stored at issue (newSignedChallenge). */
export type PreAuthKind = "setup" | "recover" | "login";

const RAND = 16;
const MAC = 16;
const macOf = async (secret: string, kind: PreAuthKind, payloadHash: string, rand: Uint8Array, exp: number): Promise<string> =>
  (await hmacHex(secret, `webauthn-challenge|${kind}|${payloadHash}|${bytesToHex(rand)}|${exp}`)).slice(0, MAC * 2);

/** A pre-sign-in challenge: 16 random bytes, the expiry (8 bytes, ms) and a 16-byte HMAC, as unpadded base64url. */
export async function newSignedChallenge(secret: string, kind: PreAuthKind, payloadHash: string, now: number): Promise<string> {
  const rand = crypto.getRandomValues(new Uint8Array(RAND));
  const exp = now + CHALLENGE_TTL_MS;
  const out = new Uint8Array(RAND + 8 + MAC);
  out.set(rand, 0);
  new DataView(out.buffer).setBigUint64(RAND, BigInt(exp));
  out.set(hexToBytes(await macOf(secret, kind, payloadHash, rand, exp)), RAND + 8);
  return base64urlnopad.encode(out);
}

/**
 * The webauthn.ts check for a pre-sign-in ceremony: the token must carry a valid HMAC for this kind and payload and be
 * unexpired; then it is stored as spent (a second use hits the primary key and fails). Expired spent rows are dropped.
 */
export function signedChallengeCheck(db: D1Database, secret: string, kind: PreAuthKind, payloadHash: string, now: number): ChallengeCheck {
  return async (challenge: string) => {
    let raw: Uint8Array;
    try {
      raw = base64urlnopad.decode(challenge);
    } catch {
      return false;
    }
    if (raw.length !== RAND + 8 + MAC) return false;
    const rand = raw.slice(0, RAND);
    const exp = Number(new DataView(raw.buffer, raw.byteOffset).getBigUint64(RAND));
    if (!(exp > now) || exp > now + CHALLENGE_TTL_MS) return false;
    if (!safeEqual(bytesToHex(raw.slice(RAND + 8)), await macOf(secret, kind, payloadHash, rand, exp))) return false;
    const [, ins] = await db.batch([
      db.prepare("DELETE FROM webauthn_challenges WHERE expires_at<=?").bind(now),
      db.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(challenge, kind, payloadHash, exp),
    ]);
    return (ins!.meta.changes ?? 0) === 1;
  };
}

/**
 * Issues a challenge for a signed-in ceremony ("add", "action"): 32 random bytes, canonical unpadded base64url, live
 * for 300 s. The same batch deletes expired rows and inserts only while fewer than MAX_LIVE_CHALLENGES of that kind are
 * live; otherwise it throws ChallengeLimit.
 */
export async function newChallenge(db: D1Database, kind: "add" | "action", payloadHash: string, now: number): Promise<string> {
  const id = base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));
  const expired = db.prepare("DELETE FROM webauthn_challenges WHERE expires_at<=?").bind(now);
  const [, ins] = await db.batch([
    expired,
    db
      .prepare(
        `INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at)
         SELECT ?1,?2,?3,?4 WHERE (SELECT count(*) FROM webauthn_challenges WHERE kind=?2 AND expires_at>?5) < ?6`,
      )
      .bind(id, kind, payloadHash, now + CHALLENGE_TTL_MS, now, MAX_LIVE_CHALLENGES),
  ]);
  if ((ins!.meta.changes ?? 0) !== 1) throw new ChallengeLimit();
  return id;
}

/** The webauthn.ts check for one ceremony: consumes `challenge` iff it is live and was issued for this kind and payload. */
export function challengeCheck(db: D1Database, kind: ChallengeKind, payloadHash: string, now: number): ChallengeCheck {
  return async (challenge: string) => {
    const { results } = await db
      .prepare("DELETE FROM webauthn_challenges WHERE id=? AND kind=? AND payload_hash=? AND expires_at>? RETURNING id")
      .bind(challenge, kind, payloadHash, now)
      .all<{ id: string }>();
    return results.length === 1;
  };
}

/** sha256Hex of the parts joined with "|". Callers pass parts that cannot contain "|" (or encode them first). */
export const bindingHash = (...parts: string[]): Promise<string> => sha256Hex(parts.join("|"));
