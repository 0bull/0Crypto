import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Parses the repo's JSONC configs: full-line `//` comments only, no trailing commas. */
const readJsonc = (path: string): { vars: Record<string, string> } =>
  JSON.parse(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );

/** Bindings and the test-only hook: not configuration an operator sets. */
const NOT_CONFIG = new Set(["DB", "KV", "WATCHER", "WEBHOOKS", "ASSETS", "API_RATE", "NWC_TEST_SOCKET_FACTORY"]);

const envKeys = (): string[] => {
  const src = readFileSync("src/env.ts", "utf8");
  const body = /export interface Env \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  // Strip comments so words inside them are not read as keys; keys are `NAME?: type;` at the start of a line.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]!);
};

/** Names that appear as `NAME=` in the example, commented out or not. */
const exampleNames = (): Set<string> =>
  new Set([...readFileSync(".dev.vars.example", "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

describe(".dev.vars.example", () => {
  it("lists every secret in Env (everything that is neither a binding nor a var in wrangler.jsonc)", () => {
    const vars = Object.keys(readJsonc("wrangler.jsonc").vars);
    const secrets = envKeys().filter((k) => !NOT_CONFIG.has(k) && !vars.includes(k));
    // Sanity: the parser really found the Plans 1-5 secrets.
    for (const k of ["MASTER_SEED", "SESSION_SECRET", "WEBHOOK_SECRET", "EVM_RPC_BASE", "TRONGRID_API_KEY", "SOLANA_RPC_URL", "TROCADOR_API_KEY", "NWC_URI"]) {
      expect(secrets, k).toContain(k);
    }
    const listed = exampleNames();
    expect(secrets.filter((k) => !listed.has(k))).toEqual([]);
  });

  it("gives every entry a one-line comment", () => {
    const lines = readFileSync(".dev.vars.example", "utf8").split("\n").filter((l) => /^#?\s*[A-Z][A-Z0-9_]*=/.test(l));
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.filter((l) => !/\s#\s+\S/.test(l))).toEqual([]);
  });

  it("covers the optional-secret list the wrangler drift guard binds empty in tests", () => {
    const test = readJsonc("test/wrangler.test.jsonc");
    const prod = readJsonc("wrangler.jsonc");
    const optional = Object.keys(test.vars).filter((k) => !(k in prod.vars));
    expect(optional.length).toBeGreaterThan(8);
    const listed = exampleNames();
    expect(optional.filter((k) => !listed.has(k))).toEqual([]);
  });

  it("documents every var of wrangler.jsonc with a comment (JSONC)", () => {
    const lines = readFileSync("wrangler.jsonc", "utf8").split("\n");
    const start = lines.findIndex((l) => /^\s*"vars"\s*:\s*\{/.test(l));
    expect(start).toBeGreaterThan(-1);
    const undocumented: string[] = [];
    for (let i = start + 1; lines[i] !== undefined && !/^\s*\}/.test(lines[i]!); i++) {
      const m = /^\s*"([A-Z0-9_]+)"\s*:/.exec(lines[i]!);
      if (m && !/^\s*\/\//.test(lines[i - 1] ?? "") && !/\/\/\s*\S/.test(lines[i]!)) undocumented.push(m[1]!);
    }
    expect(undocumented).toEqual([]);
  });

  it("leaves every entry commented out (the Deploy button makes each uncommented one a required field)", () => {
    const active = readFileSync(".dev.vars.example", "utf8")
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    expect(active).toEqual([]);
  });

  it("describes every Deploy button binding, and each one is a var or an example entry", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { cloudflare?: { bindings?: Record<string, { description?: string }> } };
    const bindings = pkg.cloudflare?.bindings ?? {};
    const vars = Object.keys(readJsonc("wrangler.jsonc").vars);
    const listed = exampleNames();
    expect(Object.keys(bindings).length).toBeGreaterThan(0);
    for (const [name, b] of Object.entries(bindings)) {
      expect(vars.includes(name) || listed.has(name), name).toBe(true);
      expect(typeof b.description === "string" && b.description.trim().length > 0, name).toBe(true);
    }
  });
});
