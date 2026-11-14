import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { randomBytes } from "node:crypto";

export const SECRET_NAMES = ["MASTER_SEED", "SESSION_SECRET", "WEBHOOK_SECRET"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** What a plain `npm run setup` sets. The Worker generates its own session and webhook keys, so only the routed-mode seed is left. */
export const DEFAULT_SECRETS: readonly SecretName[] = ["MASTER_SEED"];

/** 24 words = 256 bits of entropy. */
export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 256);

/** 32 random bytes, base64url without padding (43 characters). */
export const randomSecret = (): string => randomBytes(32).toString("base64url");

export function generateSecrets(): Record<SecretName, string> {
  return {
    MASTER_SEED: generateSeedPhrase(),
    SESSION_SECRET: randomSecret(),
    WEBHOOK_SECRET: `whsec_${randomSecret()}`,
  };
}

export type SetupArgs = { dryRun: boolean; force: boolean; env?: string; only?: SecretName };

export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { dryRun: false, force: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--env") out.env = value(++i, "--env");
    else if (a === "--only") {
      const v = value(++i, "--only");
      if (!(SECRET_NAMES as readonly string[]).includes(v)) throw new Error(`--only must be one of ${SECRET_NAMES.join(", ")}`);
      out.only = v as SecretName;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Secret names from `wrangler secret list --format json` output (an array of { name, type }). */
export function parseSecretList(stdout: string): string[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("could not parse `wrangler secret list` output");
  const list = JSON.parse(stdout.slice(start, end + 1)) as unknown;
  if (!Array.isArray(list)) throw new Error("could not parse `wrangler secret list` output");
  return list.map((x) => (x as { name?: unknown }).name).filter((n): n is string => typeof n === "string");
}

export type SetupPlan = { action: "set"; names: SecretName[]; overwrites: SecretName[] } | { action: "abort"; message: string };

/** Decides what to set given the secrets already on the Worker. Never overwrites without --force. */
export function planSetup(existing: string[], args: Pick<SetupArgs, "force" | "only">): SetupPlan {
  const names: SecretName[] = args.only ? [args.only] : [...DEFAULT_SECRETS];
  const overwrites = names.filter((n) => existing.includes(n));
  if (overwrites.length > 0 && !args.force) {
    return {
      action: "abort",
      message:
        `Already set on this Worker: ${overwrites.join(", ")}. Nothing was changed.\n` +
        "Re-running would replace them. Replacing MASTER_SEED orphans any funds at addresses derived from the old seed.\n" +
        "Use --only <NAME> to set a single missing secret, or --force if you really mean to overwrite.",
    };
  }
  return { action: "set", names, overwrites };
}

export const summarize = (done: SecretName[], failed: SecretName[]): string =>
  `Set: ${done.join(", ") || "none"}. Failed: ${failed.join(", ")}. Fix the error, then re-run with --only ${failed[0]}` +
  (failed.length > 1 ? ` (once per failed secret: ${failed.join(", ")})` : "") +
  (failed.includes("MASTER_SEED")
    ? ".\nThe seed phrase printed above was NOT stored — discard it. Re-running with --only MASTER_SEED generates a new one; back up that one instead."
    : "");

/** True only when `wrangler secret list` failed because the Worker does not exist yet (not on auth or other errors). */
export const isWorkerMissing = (output: string): boolean => /\[code: 10007\]|This Worker does not exist/i.test(output);

/** The wrangler arguments (never a shell string) for setting one secret. */
export const wranglerArgs = (name: SecretName, env?: string): string[] => [
  "wrangler",
  "secret",
  "put",
  name,
  ...(env ? ["--env", env] : []),
];

/** What a dry run reports: secret names only, with a placeholder instead of any value. */
export const planSecrets = (): { name: SecretName; value: string }[] =>
  DEFAULT_SECRETS.map((name) => ({ name, value: "<generated at run time>" }));
