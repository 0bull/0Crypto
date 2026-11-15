import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { bindingHash, ChallengeLimit, challengeCheck, MAX_LIVE_CHALLENGES, newChallenge, newTokenChallenge, tokenChallengeCheck } from "../../src/admin/challenges";
import { sha256Hex } from "../../src/api/auth";

const e = env as unknown as Env;
const T = 1_900_000_000_000;
const S = "test-session-secret";
const count = async () => (await e.DB.prepare("SELECT count(*) AS n FROM webauthn_challenges").first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
beforeEach(async () => {
  await e.DB.prepare("DELETE FROM webauthn_challenges").run();
});

describe("webauthn challenges", () => {
  it("are 32 random bytes as canonical unpadded base64url, expiring after 300000 ms", async () => {
    const c = await newChallenge(e.DB, "add", "", T);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await newChallenge(e.DB, "add", "", T)).not.toBe(c);
    const row = await e.DB.prepare("SELECT * FROM webauthn_challenges WHERE id=?").bind(c).first<{ kind: string; payload_hash: string; expires_at: number }>();
    expect(row).toEqual({ id: c, kind: "add", payload_hash: "", expires_at: T + 300_000 });
  });
  it("a check passes once, then fails", async () => {
    const c = await newChallenge(e.DB, "add", "", T);
    const check = challengeCheck(e.DB, "add", "", T + 1);
    expect(await check(c)).toBe(true);
    expect(await check(c)).toBe(false);
    expect(await count()).toBe(0);
  });
  it("concurrent checks of one challenge: exactly one passes", async () => {
    const c = await newChallenge(e.DB, "add", "", T);
    const check = challengeCheck(e.DB, "add", "", T + 1);
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
  it("the cap is per kind: a full action kind does not block add challenges, and pre-sign-in ones are never stored", async () => {
    await e.DB.batch(
      Array.from({ length: 500 }, (_, i) =>
        e.DB.prepare("INSERT INTO webauthn_challenges(id,kind,payload_hash,expires_at) VALUES(?,?,?,?)").bind(`a${i}`, "action", "", T + 300_000),
      ),
    );
    expect(await newChallenge(e.DB, "add", "", T)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await newTokenChallenge(S, "login", "", T);
    expect(await count()).toBe(501);
  });
  it("bindingHash is sha256Hex of the parts joined with |", async () => {
    expect(await bindingHash("a", "b", "c")).toBe(await sha256Hex("a|b|c"));
    expect(await bindingHash("a", "b")).not.toBe(await bindingHash("b", "a"));
  });
});

describe("pre-sign-in challenges (setup, recover, login): signed, stored only when spent", () => {
  it("are 40 bytes of unpadded base64url, never written at issue", async () => {
    const c = await newTokenChallenge(S, "login", "", T);
    expect(c).toMatch(/^[A-Za-z0-9_-]{54}$/);
    expect(await newTokenChallenge(S, "login", "", T)).not.toBe(c);
    expect(await count()).toBe(0);
  });
  it("pass once: the first check stores it, a second use fails", async () => {
    const h = await bindingHash("binder", "code");
    const c = await newTokenChallenge(S, "setup", h, T);
    const check = tokenChallengeCheck(e.DB, S, "setup", h, T + 1);
    expect(await check(c)).toBe(true);
    expect(await check(c)).toBe(false);
    expect(await count()).toBe(1);
  });
  it("concurrent checks of one challenge: exactly one passes", async () => {
    const c = await newTokenChallenge(S, "login", "", T);
    const check = tokenChallengeCheck(e.DB, S, "login", "", T + 1);
    const r = await Promise.all(Array.from({ length: 8 }, () => check(c)));
    expect(r.filter(Boolean)).toHaveLength(1);
  });
  it("a wrong kind, payload, secret, a tampered or expired token fails and stores nothing", async () => {
    const h = await bindingHash("binder");
    const c = await newTokenChallenge(S, "login", h, T);
    expect(await tokenChallengeCheck(e.DB, S, "recover", h, T + 1)(c)).toBe(false);
    expect(await tokenChallengeCheck(e.DB, S, "login", await bindingHash("other"), T + 1)(c)).toBe(false);
    expect(await tokenChallengeCheck(e.DB, "another-secret", "login", h, T + 1)(c)).toBe(false);
    const flipped = (c[0] === "A" ? "B" : "A") + c.slice(1);
    expect(await tokenChallengeCheck(e.DB, S, "login", h, T + 1)(flipped)).toBe(false);
    expect(await tokenChallengeCheck(e.DB, S, "login", h, T + 1)("not base64!")).toBe(false);
    expect(await tokenChallengeCheck(e.DB, S, "login", h, T + 300_000)(c)).toBe(false); // the expiry is exclusive
    expect(await count()).toBe(0);
    expect(await tokenChallengeCheck(e.DB, S, "login", h, T + 299_999)(c)).toBe(true);
  });
  it("a flood of starts cannot evict the owner's challenge", async () => {
    const owner = await newTokenChallenge(S, "login", "owner", T);
    for (let i = 0; i < 2000; i++) await newTokenChallenge(S, "login", `flood${i}`, T + 1);
    expect(await count()).toBe(0);
    expect(await tokenChallengeCheck(e.DB, S, "login", "owner", T + 2)(owner)).toBe(true);
  });
  it("spent rows past their expiry are dropped by the next check", async () => {
    const a = await newTokenChallenge(S, "login", "", T);
    expect(await tokenChallengeCheck(e.DB, S, "login", "", T + 1)(a)).toBe(true);
    const b = await newTokenChallenge(S, "login", "", T + 300_001);
    expect(await tokenChallengeCheck(e.DB, S, "login", "", T + 300_002)(b)).toBe(true);
    expect(await count()).toBe(1);
  });
});
