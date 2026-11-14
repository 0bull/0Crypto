import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const triggers = ci.slice(ci.indexOf("\non:"), ci.indexOf("\npermissions:"));

describe("CI workflow", () => {
  it("runs once per change: push only on main, plus pull requests", () => {
    expect(triggers).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/);
    expect(triggers).toMatch(/\n {2}pull_request:\n/);
  });
  it("cancels a superseded run of the same ref", () => {
    expect(ci).toMatch(/\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/);
  });
  it("pins every action by full commit SHA and reads contents only", () => {
    for (const m of ci.matchAll(/uses: (\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(ci).toMatch(/\npermissions:\n {2}contents: read\n/);
  });
});
