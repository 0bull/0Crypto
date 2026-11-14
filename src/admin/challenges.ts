import { base64urlnopad } from "@scure/base";
import { sha256Hex } from "../api/auth";
import type { ChallengeCheck } from "./webauthn";

/*
 * Single-use WebAuthn challenges in D1 (webauthn_challenges). A challenge is issued for one ceremony `kind` and one
 * `payloadHash` (bindingHash of what it authorises: for "action", the action and its parameters; "" when there is
 * nothing to bind). It is spent by one DELETE whose WHERE also matches kind and payload_hash and requires it to be
 * live, so it passes at most once, and a challenge issued for one purpose or action can never pass a check for
 * another (sign-in and action confirmation are both webauthn.get, so the library cannot tell them apart). A check with
 * the wrong kind or hash deletes nothing.
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

/**
 * Kinds anyone can start before signing in. They are never refused for being over the cap (a flood must not lock the
 * owner out): issuing one evicts the oldest live rows of its kind instead, so the table stays bounded and the owner's
 * fresh challenge is always the newest.
 */
const UNAUTHENTICATED: ReadonlySet<ChallengeKind> = new Set<ChallengeKind>(["setup", "recover", "login"]);

/**
 * Issues a challenge: 32 random bytes, canonical unpadded base64url, live for 300 s. The same batch deletes expired
 * rows and then, for "setup", "recover" and "login", evicts the oldest live rows of that kind so that at most
 * MAX_LIVE_CHALLENGES remain with the new one; for "action" and "add" it inserts only while fewer than
 * MAX_LIVE_CHALLENGES of that kind are live and throws ChallengeLimit otherwise.
 */
export async function newChallenge(db: D1Database, kind: ChallengeKind, payloadHash: string, now: number): Promise<string> {
  const id = base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));
  const expired = db.prepare("DELETE FROM webauthn_challenges WHERE expires_at<=?").bind(now);
  if (UNAUTHENTICATED.has(kind)) {
    await db.batch([
      expired,
      // Every challenge lives CHALLENGE_TTL_MS, so the oldest are the ones that expire first.
      db
        .prepare(
          `DELETE FROM webauthn_challenges WHERE id IN
             (SELECT id FROM webauthn_challenges WHERE kind=?1 AND expires_at>?2 ORDER BY expires_at DESC, id DESC LIMIT -1 OFFSET ?3)`,
        )
        .bind(kind, now, MAX_LIVE_CHALLENGES - 1),
      db.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(id, kind, payloadHash, now + CHALLENGE_TTL_MS),
    ]);
    return id;
  }
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
