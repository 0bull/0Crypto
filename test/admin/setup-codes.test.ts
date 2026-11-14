import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { checkCode, consumeCodeStmt, ensureCode, newSetupCode, normalizeCode, printCode, type CodePurpose } from "../../src/admin/setup-codes";

const e = env as unknown as Env;
const T = 1_900_000_000_000;
const BAD = { ok: false, status: 400, error: "That code is not valid or has expired. Check the latest code in your Worker logs." };
const LIMITED = { ok: false, status: 429, error: "Too many wrong codes. Wait 10 minutes and try again." };
const LINE = /^0crypto (setup|recovery) code: ((?:[a-z]+ ){5}[a-z]+) \(valid 60 min\)$/;
const ABUSE = "0crypto: setup.abuse more than 100 wrong setup or recovery codes within an hour";

let log: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => log.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
/** The phrases printed so far, in order. */
const printed = (): string[] => lines().flatMap((l) => LINE.exec(l)?.[2] ?? []);

/** Prints a code and returns its phrase (read back from the log line, the only place it appears). */
async function print(purpose: CodePurpose, now: number): Promise<string> {
  const before = printed().length;
  expect(await printCode(e.DB, purpose, now)).toBe("printed");
  const after = printed();
  expect(after.length).toBe(before + 1);
  return after[after.length - 1]!;
}

/** A wrong but well-formed phrase (six list words, never a printed one in practice). */
const WRONG = "abandon abandon abandon abandon abandon zoo";

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
beforeEach(async () => {
  await e.DB.batch([e.DB.prepare("DELETE FROM setup_codes"), e.DB.prepare("DELETE FROM setup_attempts"), e.DB.prepare("DELETE FROM alerts WHERE kind='setup.abuse'")]);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

describe("newSetupCode / normalizeCode", () => {
  it("is 6 words from the BIP39 English list", () => {
    const words = new Set(wordlist);
    for (let i = 0; i < 20; i++) {
      const w = newSetupCode().split(" ");
      expect(w).toHaveLength(6);
      for (const x of w) expect(words.has(x)).toBe(true);
    }
  });
  it("accepts loose typing: capitals, double spaces, tabs, newlines and words split across lines", () => {
    for (const w of ["maple", "orbit", "zebra", "absorb", "kitten", "velvet"]) expect(wordlist).toContain(w);
    expect(normalizeCode("  Maple  ORBIT\nzebra\tAbsorb\r\n kitten   velvet\n")).toBe("maple orbit zebra absorb kitten velvet");
    expect(normalizeCode("ＭＡＰＬＥ orbit zebra absorb kitten velvet")).toBe("maple orbit zebra absorb kitten velvet"); // NFKD
  });
  it("rejects five words, seven words, a word not on the list and empty input", () => {
    expect(normalizeCode("maple orbit zebra absorb kitten")).toBeNull();
    expect(normalizeCode("maple orbit zebra absorb kitten velvet maple")).toBeNull();
    expect(normalizeCode("maple orbit zebra absorb kitten velvett")).toBeNull();
    expect(normalizeCode("maple orbit zebra absorb kitten 0crypto")).toBeNull();
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode("   \n ")).toBeNull();
  });
});

describe("printCode / ensureCode", () => {
  it("logs exactly the setup line, and the recovery line for recover", async () => {
    await print("setup", T);
    await print("recover", T);
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toMatch(/^0crypto setup code: ([a-z]+ ){5}[a-z]+ \(valid 60 min\)$/);
    expect(lines()[1]).toMatch(/^0crypto recovery code: ([a-z]+ ){5}[a-z]+ \(valid 60 min\)$/);
  });
  it("stores only the hash, never the phrase", async () => {
    const code = await print("setup", T);
    const rows = (await e.DB.prepare("SELECT * FROM setup_codes").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code.split(" ")[0]!);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.expires_at).toBe(T + 3_600_000);
  });
  it("a second print within 120 s is too_soon (per purpose); after 120 s it prints", async () => {
    await print("setup", T);
    expect(await printCode(e.DB, "setup", T + 119_999)).toBe("too_soon");
    expect(printed()).toHaveLength(1);
    await print("recover", T + 1); // the other purpose has its own throttle
    await print("setup", T + 120_001);
  });
  it("ensureCode prints only when no live code of that purpose exists", async () => {
    await ensureCode(e.DB, "setup", T);
    expect(printed()).toHaveLength(1);
    await ensureCode(e.DB, "setup", T + 200_000);
    expect(printed()).toHaveLength(1);
    await ensureCode(e.DB, "recover", T + 200_000);
    expect(printed()).toHaveLength(2);
    await ensureCode(e.DB, "setup", T + 3_600_001); // the first one expired
    expect(printed()).toHaveLength(3);
  });
});

describe("checkCode", () => {
  it("a printed code passes until consumeCodeStmt runs in a batch, then it is wrong", async () => {
    const code = await print("setup", T);
    const r = await checkCode(e, "198.51.100.1", "setup", code, T + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await checkCode(e, "198.51.100.1", "setup", `  ${code.toUpperCase().replace(" ", "\n")}  `, T + 2)).toEqual(r); // loose typing
    const [del] = await e.DB.batch([consumeCodeStmt(e.DB, r.hash, T + 3)]);
    expect(del!.meta.changes).toBe(1);
    expect(await checkCode(e, "198.51.100.1", "setup", code, T + 4)).toEqual(BAD);
    const [again] = await e.DB.batch([consumeCodeStmt(e.DB, r.hash, T + 5)]);
    expect(again!.meta.changes).toBe(0);
  });
  it("a code is only valid for its own purpose", async () => {
    const code = await print("recover", T);
    expect(await checkCode(e, "198.51.100.1", "setup", code, T + 1)).toEqual(BAD);
    expect((await checkCode(e, "198.51.100.1", "recover", code, T + 1)).ok).toBe(true);
  });
  it("an expired code is wrong at now + 3600001", async () => {
    const code = await print("setup", T);
    expect((await checkCode(e, "198.51.100.1", "setup", code, T + 3_599_999)).ok).toBe(true);
    expect(await checkCode(e, "198.51.100.1", "setup", code, T + 3_600_001)).toEqual(BAD);
    const [del] = await e.DB.batch([consumeCodeStmt(e.DB, (await e.DB.prepare("SELECT hash FROM setup_codes").first<{ hash: string }>())!.hash, T + 3_600_001)]);
    expect(del!.meta.changes).toBe(0); // an expired code cannot be consumed either
  });
  it("printing 4 codes 121 s apart leaves the first wrong and codes 2-4 valid", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) codes.push(await print("setup", T + i * 121_000));
    const now = T + 4 * 121_000;
    expect(await checkCode(e, "198.51.100.1", "setup", codes[0]!, now)).toEqual(BAD);
    for (const c of codes.slice(1)) expect((await checkCode(e, "198.51.100.1", "setup", c, now)).ok).toBe(true);
    expect((await e.DB.prepare("SELECT count(*) AS n FROM setup_codes WHERE purpose='setup'").first<{ n: number }>())!.n).toBe(3);
  });
  it("5 wrong codes from one IP, then the right code: the 6th call is 429; another IP passes", async () => {
    const code = await print("setup", T);
    for (let i = 0; i < 5; i++) expect(await checkCode(e, "203.0.113.7", "setup", WRONG, T + i)).toEqual(BAD);
    expect(await checkCode(e, "203.0.113.7", "setup", code, T + 5)).toEqual(LIMITED);
    expect((await checkCode(e, "203.0.113.8", "setup", code, T + 6)).ok).toBe(true);
    // the window is 10 minutes from the first attempt
    expect((await checkCode(e, "203.0.113.7", "setup", code, T + 600_001)).ok).toBe(true);
  });
  it("malformed input (5 words, 7 words, off-list word) is rejected and counted", async () => {
    const code = await print("setup", T);
    const w = code.split(" ");
    const bad = [w.slice(0, 5).join(" "), [...w, w[0]].join(" "), [...w.slice(0, 5), "notaword"].join(" "), "", "x".repeat(5000)];
    for (const [i, b] of bad.entries()) expect(await checkCode(e, "203.0.113.9", "setup", b, T + i)).toEqual(BAD);
    expect(await checkCode(e, "203.0.113.9", "setup", code, T + 10)).toEqual(LIMITED);
  });
  it("a correct code clears the client's counter", async () => {
    const code = await print("setup", T);
    for (let i = 0; i < 4; i++) await checkCode(e, "203.0.113.10", "setup", WRONG, T + i);
    expect((await checkCode(e, "203.0.113.10", "setup", code, T + 4)).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(await checkCode(e, "203.0.113.10", "setup", WRONG, T + 10 + i)).toEqual(BAD);
    expect(await checkCode(e, "203.0.113.10", "setup", WRONG, T + 20)).toEqual(LIMITED);
  });
  it("IPv6 2001:db8::1 and 2001:db8::2 share one budget (one /64)", async () => {
    const code = await print("setup", T);
    for (let i = 0; i < 5; i++) await checkCode(e, i % 2 ? "2001:db8::1" : "2001:db8::2", "setup", WRONG, T + i);
    expect(await checkCode(e, "2001:db8::1", "setup", code, T + 5)).toEqual(LIMITED);
    expect(await checkCode(e, "2001:db8::2", "setup", code, T + 5)).toEqual(LIMITED);
    expect((await checkCode(e, "2001:db8:0:1::1", "setup", code, T + 6)).ok).toBe(true);
  });
  it("never stores the raw IP: the client key is ip:<hmac>", async () => {
    await checkCode(e, "198.51.100.77", "setup", WRONG, T);
    const keys = (await e.DB.prepare("SELECT key FROM setup_attempts").all<{ key: string }>()).results.map((r) => r.key).sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe("global");
    expect(keys[1]).toMatch(/^ip:[0-9a-f]{64}$/);
  });
  it("101 wrong codes across 101 IPs: never 429, a fresh IP still claims, one abuse line and one setup.abuse alert", async () => {
    const code = await print("setup", T);
    for (let i = 0; i < 101; i++) {
      expect(await checkCode(e, `10.0.${i >> 8}.${i & 255}`, i % 2 ? "setup" : "recover", WRONG, T + i)).toEqual(BAD);
    }
    for (let i = 101; i < 130; i++) expect(await checkCode(e, `10.0.${i >> 8}.${i & 255}`, "setup", WRONG, T + i)).toEqual(BAD);
    expect((await checkCode(e, "192.0.2.200", "setup", code, T + 200)).ok).toBe(true);
    expect(lines().filter((l) => l === ABUSE)).toHaveLength(1);
    const alerts = (await e.DB.prepare("SELECT * FROM alerts WHERE kind='setup.abuse'").all<{ chain: string | null; resolved_at: number | null }>()).results;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.chain).toBeNull();
    expect(alerts[0]!.resolved_at).toBeNull();
  });
  it("ADMIN_SETUP_CODE of 32+ chars is accepted for setup only; a 31-char value is ignored", async () => {
    const secret = "S3cret-owner-chosen-code-0123456"; // 32 chars
    expect(secret).toHaveLength(32);
    const withEnv = { ...e, ADMIN_SETUP_CODE: secret } as Env;
    expect(await checkCode(withEnv, "198.51.100.5", "setup", `  ${secret}\n`, T)).toEqual({ ok: true, hash: "env" });
    expect(await checkCode(withEnv, "198.51.100.5", "recover", secret, T + 1)).toEqual(BAD);
    expect(await checkCode(withEnv, "198.51.100.5", "setup", secret.slice(0, 31), T + 2)).toEqual(BAD);
    const short = { ...e, ADMIN_SETUP_CODE: secret.slice(0, 31) } as Env;
    expect(await checkCode(short, "198.51.100.5", "setup", secret.slice(0, 31), T + 3)).toEqual(BAD);
    const blank = { ...e, ADMIN_SETUP_CODE: "" } as Env;
    expect(await checkCode(blank, "198.51.100.5", "setup", "", T + 4)).toEqual(BAD);
  });
  it("over the limit, even the ADMIN_SETUP_CODE is not checked", async () => {
    const secret = "S3cret-owner-chosen-code-0123456";
    const withEnv = { ...e, ADMIN_SETUP_CODE: secret } as Env;
    for (let i = 0; i < 5; i++) await checkCode(withEnv, "198.51.100.6", "setup", WRONG, T + i);
    expect(await checkCode(withEnv, "198.51.100.6", "setup", secret, T + 5)).toEqual(LIMITED);
  });
  it("never logs anything for a check (codes appear only on the print line)", async () => {
    const code = await print("setup", T);
    log.mockClear();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkCode(e, "198.51.100.1", "setup", WRONG, T + 1);
    await checkCode(e, "198.51.100.1", "setup", code, T + 2);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });
});
