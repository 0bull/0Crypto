import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This file lives in test/node/, so two levels up is the repo root. Git pathspecs are relative to cwd, so pin it.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Search the whole repo and list only exclusions, so new files and directories are covered by default.
const EXCLUDES = [
  // Pre-rename planning docs and specs; historical record.
  ":!docs/superpowers",
  // Test files are not product files; they deliberately use the old names to prove the app refuses them.
  ":!test/**/*.ts",
  // The docs site's own tests assert that its pages and build never mention the old name.
  ":!site/test/*.ts",
  ":!plugins/woocommerce/tests/WebhookTest.php",
  // Third-party vendor code.
  ":!plugins/woocommerce/vendor",
  // Frozen golden-vector seed label; changing it would change the pinned vectors.
  ":!tools/railgun-golden/gen.mjs",
];

describe("old product name", () => {
  it("no product file mentions the old name", () => {
    expect(existsSync(join(root, "wrangler.jsonc"))).toBe(true);
    const r = spawnSync("git", ["grep", "-n", "-i", "-I", "--untracked", "-e", "paygate", "-e", "pg_live_", "-e", "pg_session", "-e", "pg_csrf", "-e", "pg_setup", "-e", "pg_pos", "--", ".", ...EXCLUDES], { encoding: "utf8", cwd: root });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1); // git grep: 1 = no match, 128 = error
  });
});
