import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vitest";
import {
  generateSecrets,
  isWorkerMissing,
  parseArgs,
  parseSecretList,
  planSecrets,
  planSetup,
  randomSecret,
  summarize,
  wranglerArgs,
} from "../../scripts/setup-lib";

describe("setup helpers", () => {
  it("generates a valid 24-word mnemonic", () => {
    const { MASTER_SEED } = generateSecrets();
    expect(MASTER_SEED.split(" ")).toHaveLength(24);
    expect(validateMnemonic(MASTER_SEED, wordlist)).toBe(true);
  });

  it("generates 43-char base64url secrets, webhook one prefixed whsec_", () => {
    const s = generateSecrets();
    expect(s.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.WEBHOOK_SECRET.startsWith("whsec_")).toBe(true);
    expect(s.WEBHOOK_SECRET.slice(6)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret()).not.toBe(randomSecret());
  });

  it("dry-run plan lists exactly the secret names and no real values", () => {
    const plan = planSecrets();
    expect(plan.map((p) => p.name)).toEqual(["MASTER_SEED"]);
    expect(plan.every((p) => p.value === "<generated at run time>")).toBe(true);
  });

  it("passes --env through to wrangler and rejects unknown flags", () => {
    expect(parseArgs(["--dry-run", "--env", "staging"])).toEqual({ dryRun: true, force: false, env: "staging" });
    expect(wranglerArgs("SESSION_SECRET", "staging")).toEqual(["wrangler", "secret", "put", "SESSION_SECRET", "--env", "staging"]);
    expect(wranglerArgs("SESSION_SECRET")).toEqual(["wrangler", "secret", "put", "SESSION_SECRET"]);
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["--env"])).toThrow();
  });

  it("parses --force and --only, rejecting unknown secret names", () => {
    expect(parseArgs(["--force", "--only", "WEBHOOK_SECRET"])).toEqual({ dryRun: false, force: true, only: "WEBHOOK_SECRET" });
    expect(() => parseArgs(["--only", "FOO"])).toThrow();
  });

  it("parses wrangler secret list output", () => {
    expect(parseSecretList('[{"name":"MASTER_SEED","type":"secret_text"},{"name":"X","type":"secret_text"}]')).toEqual(["MASTER_SEED", "X"]);
    expect(parseSecretList("noise\n[]\n")).toEqual([]);
    expect(() => parseSecretList("oops")).toThrow();
  });

  it("plans: sets everything when none exist, aborts on any existing unless forced", () => {
    expect(planSetup([], { force: false })).toEqual({
      action: "set",
      names: ["MASTER_SEED"],
      overwrites: [],
    });
    expect(planSetup(["OTHER"], { force: false }).action).toBe("set");
    const abort = planSetup(["MASTER_SEED"], { force: false });
    expect(abort.action).toBe("abort");
    expect(abort.action === "abort" && abort.message).toContain("MASTER_SEED");
    expect(planSetup(["MASTER_SEED"], { force: true })).toMatchObject({ action: "set", overwrites: ["MASTER_SEED"] });
  });

  it("--only sets just that secret and ignores other existing ones", () => {
    expect(planSetup(["MASTER_SEED", "SESSION_SECRET"], { force: false, only: "WEBHOOK_SECRET" })).toEqual({
      action: "set",
      names: ["WEBHOOK_SECRET"],
      overwrites: [],
    });
    expect(planSetup(["WEBHOOK_SECRET"], { force: false, only: "WEBHOOK_SECRET" }).action).toBe("abort");
  });

  it("summarizes partial failure", () => {
    expect(summarize(["MASTER_SEED", "SESSION_SECRET"], ["WEBHOOK_SECRET"])).toBe(
      "Set: MASTER_SEED, SESSION_SECRET. Failed: WEBHOOK_SECRET. Fix the error, then re-run with --only WEBHOOK_SECRET",
    );
  });

  it("tells the operator to discard the printed seed when MASTER_SEED failed to set", () => {
    const msg = summarize(["SESSION_SECRET"], ["MASTER_SEED", "WEBHOOK_SECRET"]);
    expect(msg).toContain(
      "The seed phrase printed above was NOT stored — discard it. Re-running with --only MASTER_SEED generates a new one; back up that one instead.",
    );
    expect(summarize(["MASTER_SEED"], ["WEBHOOK_SECRET"])).not.toContain("NOT stored");
  });

  it("detects a missing Worker only from wrangler's 10007 code or exact message", () => {
    expect(isWorkerMissing("✘ [ERROR] A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]")).toBe(true);
    expect(isWorkerMissing("[code: 10007]")).toBe(true);
    expect(isWorkerMissing("this worker does not exist")).toBe(true);
    expect(isWorkerMissing("Authentication error [code: 10000]: route not found")).toBe(false);
    expect(isWorkerMissing("Error: account not found")).toBe(false);
    expect(isWorkerMissing("[code: 100070]")).toBe(false);
  });
});
