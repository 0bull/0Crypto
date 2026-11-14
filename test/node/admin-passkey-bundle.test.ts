import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("admin passkey bundle", () => {
  it("is reproducible, self-hosted and eval-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "passkey-"));
    try {
      const out = join(dir, "admin-passkey.js");
      const r = spawnSync("node", ["scripts/build-passkey.mjs", "--out", out], { cwd: root, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const built = readFileSync(out);
      const committed = readFileSync(join(root, "public", "admin-passkey.js"));
      expect(built.equals(committed)).toBe(true);
      const text = committed.toString("utf8");
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).toContain("/admin/webauthn/challenge");
      expect(text).not.toMatch(/\beval\s*\(/);
      expect(text).not.toMatch(/new Function\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
