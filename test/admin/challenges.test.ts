import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { bindingHash, ChallengeLimit, challengeCheck, MAX_LIVE_CHALLENGES, newChallenge } from "../../src/admin/challenges";
import { sha256Hex } from "../../src/api/auth";

const e = env as unknown as Env;
const T = 1_900_000_000_000;
const count = async () => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges").first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
beforeEach(async () => {
  await e.DB.prepare("DELETE FROM webauthn_challenges").run();
});

describe("webauthn challenges", () => {
  it("are 32 random bytes as canonical unpadded base64url, expiring after 300000 ms", async () => {
    const c = await newChallenge(e.DB, "login", "", T);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await newChallenge(e.DB, "login", "", T)).not.toBe(c);
    const row = await e.DB.prepare("SELECT * FROM webauthn_challenges WHERE id=?").bind(c).first<{ kind: string; payload_hash: string; expires_at: number }>();
    expect(row).toEqual({ id: c, kind: "login", payload_hash: "", expires_at: T + 300_000 });
  });
  it("a check passes once, then fails", async () => {
    const c = await newChallenge(e.DB, "login", "", T);
    const check = challengeCheck(e.DB, "login", "", T + 1);
    expect(await check(c)).toBe(true);
    expect(await check(c)).toBe(false);
    expect(await count()).toBe(0);
  });
  it("concurrent checks of one challenge: exactly one passes", async () => {
    const c = await newChallenge(e.DB, "login", "", T);
    const check = challengeCheck(e.DB, "login", "", T + 1);
    const r = await Promise.all(Array.from({ length: 8 }, () => check(c)));
    expect(r.filter(Boolean)).toHaveLength(1);
  });
  it("a wrong kind, a wrong payload hash, an unknown id or an expired challenge fails (and a wrong one is not consumed)", async () => {
    const h = await bindingHash("refund", "inv_1", "1.00");
    const c = await newChallenge(e.DB, "action", h, T);
    expect(await challengeCheck(e.DB, "login", h, T + 1)(c)).toBe(false); // sign-in cannot spend an action challenge
    expect(await challengeCheck(e.DB, "action", await bindingHash("refund", "inv_1", "100.00"), T + 1)(c)).toBe(false);
    expect(await challengeCheck(e.DB, "action", h, T + 1)("A".repeat(43))).toBe(false);
    expect(await challengeCheck(e.DB, "action", h, T + 300_001)(c)).toBe(false);
    expect(await challengeCheck(e.DB, "action", h, T + 300_000)(c)).toBe(false); // expires_at is exclusive
    expect(await count()).toBe(1); // none of the wrong checks deleted it
    expect(await challengeCheck(e.DB, "action", h, T + 299_999)(c)).toBe(true);
  });
  it("the 501st live challenge of a session-gated kind throws ChallengeLimit; expired rows are cleared by the next issue", async () => {
    expect(MAX_LIVE_CHALLENGES).toBe(500);
    for (const kind of ["action", "add"] as const) {
      await e.DB.prepare("DELETE FROM webauthn_challenges").run();
      const stmts = Array.from({ length: 500 }, (_, i) =>
        e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`c${i}`, kind, "", T + 300_000),
      );
      await e.DB.batch(stmts.slice(0, 499));
      await newChallenge(e.DB, kind, "", T); // the 500th
      await expect(newChallenge(e.DB, kind, "", T + 1)).rejects.toBeInstanceOf(ChallengeLimit);
      expect(await count()).toBe(500);
      // once they expire, issuing deletes them in the same batch and succeeds
      await newChallenge(e.DB, kind, "", T + 300_001);
      expect(await count()).toBe(1);
    }
  });
  it("an unauthenticated kind (login, setup, recover) at the cap is never refused: the oldest live rows of that kind are evicted", async () => {
    for (const kind of ["login", "setup", "recover"] as const) {
      await e.DB.prepare("DELETE FROM webauthn_challenges").run();
      // 600 live rows (more than the cap, as if inserted around it), oldest first, plus one live row of another kind.
      await e.DB.batch(
        Array.from({ length: 600 }, (_, i) =>
          e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`f${String(i).padStart(3, "0")}`, kind, "", T + 1_000 + i),
        ),
      );
      const h = await bindingHash("refund", "inv_1", "1.00");
      await e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES('other','action',?,?)").bind(h, T + 300_000).run();
      const c = await newChallenge(e.DB, kind, "fresh", T);
      const n = async (k: string) => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges WHERE kind=?").bind(k).first<{ n: number }>())!.n;
      expect(await n(kind)).toBe(MAX_LIVE_CHALLENGES);
      expect(await n("action")).toBe(1); // other kinds are untouched
      // The newest 499 flood rows and the fresh one remain; the oldest went.
      expect(await e.DB.prepare("SELECT 1 AS x FROM webauthn_challenges WHERE id='f000'").first()).toBeNull();
      expect(await e.DB.prepare("SELECT 1 AS x FROM webauthn_challenges WHERE id='f599'").first()).not.toBeNull();
      expect(await challengeCheck(e.DB, kind, "fresh", T + 1)(c)).toBe(true);
    }
  });
  it("the cap is per kind: a full login kind does not block action or add challenges", async () => {
    await e.DB.batch(
      Array.from({ length: 500 }, (_, i) =>
        e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`l${i}`, "login", "", T + 300_000),
      ),
    );
    const h = await bindingHash("refund", "inv_1", "1.00");
    const a = await newChallenge(e.DB, "action", h, T);
    expect(await newChallenge(e.DB, "add", "", T)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await count()).toBe(502);
    expect(await challengeCheck(e.DB, "action", h, T + 1)(a)).toBe(true);
  });
  it("bindingHash is sha256Hex of the parts joined with |", async () => {
    expect(await bindingHash("a", "b", "c")).toBe(await sha256Hex("a|b|c"));
    expect(await bindingHash("a", "b")).not.toBe(await bindingHash("b", "a"));
  });
});
