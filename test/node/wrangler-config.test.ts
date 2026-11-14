import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Parses the repo's JSONC configs: full-line `//` comments only, no trailing commas. */
const readJsonc = (path: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  ) as Record<string, unknown>;

/**
 * Optional secrets (`wrangler secret put`): never vars in wrangler.jsonc, since the URLs carry API keys. The test config
 * binds them to "" so a developer's environment cannot leak into tests; tests set them per file.
 */
const OPTIONAL_SECRETS = ["EVM_RPC_ETH", "EVM_RPC_BASE", "EVM_RPC_ARB", "EVM_RPC_POLYGON", "EVM_RPC_BSC", "TRONGRID_API_KEY", "TRON_API_URL", "TRONSAVE_API_KEY", "SOLANA_RPC_URL", "TROCADOR_API_KEY", "NWC_URI"];

/** Drops what legitimately differs: paths (relative to each file), var values, and the secrets list (bound by vitest.config.ts). */
function shape(cfg: Record<string, unknown>) {
  const c = structuredClone(cfg) as Record<string, any>;
  delete c.$schema;
  delete c.secrets;
  delete c.main;
  delete c.assets.directory;
  for (const db of c.d1_databases) {
    delete db.migrations_dir;
    delete db.database_id;
  }
  for (const kv of c.kv_namespaces) delete kv.id;
  c.vars = Object.keys(c.vars).filter((k) => !OPTIONAL_SECRETS.includes(k)).sort();
  return c;
}

/** Cloudflare run_worker_first glob: `*` matches any run of characters, including `/`. */
const globMatch = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(path);

describe("test wrangler config", () => {
  it("matches wrangler.jsonc apart from paths, var values and the test-only bindings of optional secrets", () => {
    const prod = readJsonc("wrangler.jsonc");
    const test = readJsonc("test/wrangler.test.jsonc");
    expect(shape(test)).toEqual(shape(prod));
    expect(test.main).toBe("../src/index.ts");
  });

  it("keeps the deployed config deploy-button friendly: no secrets list, no resource ids, empty PUBLIC_URL, logs on", () => {
    const prod = readJsonc("wrangler.jsonc") as Record<string, any>;
    expect(prod).not.toHaveProperty("secrets");
    for (const db of prod.d1_databases) expect(db).not.toHaveProperty("database_id");
    for (const kv of prod.kv_namespaces) expect(kv).not.toHaveProperty("id");
    expect(prod.vars.PUBLIC_URL).toBe("");
    expect(prod.observability.enabled).toBe(true);
  });

  it("declares the Railgun routing vars in both configs (values are the operator's)", () => {
    const prod = readJsonc("wrangler.jsonc") as { vars: Record<string, string> };
    const test = readJsonc("test/wrangler.test.jsonc") as { vars: Record<string, string> };
    for (const k of ["RAILGUN_0ZK_ADDRESS", "RAILGUN_GOLDEN_OK", "RAILGUN_GOLDEN_OK_CHAINS", "XMR_ADDRESS", "TROCADOR_LIVE_OK", "TROCADOR_MIN_KYC", "ROUTE_MIN_BATCH_USD", "ROUTE_DELAY_MIN_H", "ROUTE_DELAY_MAX_H", "HOT_CAP_USD"]) {
      expect(Object.keys(prod.vars), k).toContain(k);
      expect(Object.keys(test.vars), k).toContain(k);
    }
  });

  it("keeps the EVM RPC URLs out of the deployed vars (they are secrets) and binds them empty in tests", () => {
    const prod = readJsonc("wrangler.jsonc") as { vars: Record<string, string> };
    const test = readJsonc("test/wrangler.test.jsonc") as { vars: Record<string, string> };
    for (const k of OPTIONAL_SECRETS) {
      expect(Object.keys(prod.vars), k).not.toContain(k);
      expect(test.vars[k], k).toBe("");
    }
  });

  it("uses the 0crypto resource names in both configs", () => {
    for (const path of ["wrangler.jsonc", "test/wrangler.test.jsonc"]) {
      const c = readJsonc(path) as Record<string, any>;
      expect(c.name, path).toBe("0crypto");
      expect(c.d1_databases[0].database_name, path).toBe("0crypto");
      if (path.startsWith("test/")) {
        expect(c.d1_databases[0].database_id, path).toBe("local-0crypto-db");
        expect(c.kv_namespaces[0].id, path).toBe("local-0crypto-kv");
      }
      expect(c.queues.producers[0].queue, path).toBe("0crypto-webhooks");
      expect(c.queues.consumers[0].queue, path).toBe("0crypto-webhooks");
      expect(c.queues.consumers[0].dead_letter_queue, path).toBe("0crypto-webhooks-dlq");
    }
    expect(JSON.parse(readFileSync("package.json", "utf8")).name).toBe("0crypto");
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    expect(lock.name).toBe("0crypto");
    expect(lock.packages[""].name).toBe("0crypto");
  });

  it("enables observability, minify and source maps; routes only Worker paths first", () => {
    for (const path of ["wrangler.jsonc", "test/wrangler.test.jsonc"]) {
      const c = readJsonc(path) as Record<string, any>;
      expect(c.observability, path).toEqual({ enabled: true, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 } });
      expect(c.upload_source_maps, path).toBe(true);
      expect(c.minify, path).toBe(true);
      expect(c.assets.run_worker_first, path).toEqual(["/", "/healthz", "/admin", "/admin/*", "/api/*", "/pos", "/pos/*", "/i/*", "/l/*"]);
      expect(c.ratelimits[0].namespace_id, path).toBe("8317");
      const patterns: string[] = c.assets.run_worker_first;
      for (const p of patterns) expect(p.startsWith("/"), p).toBe(true);
      const worker = ["/", "/healthz", "/api/v1/invoices", "/admin", "/admin/settings", "/pos", "/pos/x", "/i/inv_x", "/i/inv_x/p/pay_y/ws", "/l/lnk_x"];
      for (const path of worker) expect(patterns.some((p) => globMatch(p, path)), path).toBe(true);
      const assets = ["/admin.css", "/admin.js", "/admin-passkey.js", "/pos.js", "/pos.css", "/checkout.css", "/checkout.js", "/theme.css", "/fonts/x.woff2"];
      for (const path of assets) expect(patterns.some((p) => globMatch(p, path)), path).toBe(false);
    }
  });

  it("lists exactly the CRONS expressions from src/cron.ts, one per job, in both configs", () => {
    const src = readFileSync("src/cron.ts", "utf8");
    const block = /export const CRONS = \{([\s\S]*?)\} as const/.exec(src)![1]!;
    const crons = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual(["* * * * *", "*/15 * * * *", "5-59/15 * * * *", "0 * * * *", "30 * * * *"]);
    for (const path of ["wrangler.jsonc", "test/wrangler.test.jsonc"]) {
      const c = readJsonc(path) as Record<string, any>;
      expect(c.triggers.crons, path).toEqual(crons);
    }
  });

  it("has no static asset under a Worker-first prefix (it would be hidden behind the Worker)", () => {
    for (const d of ["admin", "api", "pos", "i", "l"]) expect(existsSync(`public/${d}`), d).toBe(false);
    expect(existsSync("public/index.html")).toBe(false);
  });
});
