import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MAX_SPIKE_USDC, SPEND_FLAG, parseShieldOnceArgs } from "../../scripts/railgun-shield-once-args";
import golden from "../fixtures/railgun/golden.json";

const TO = golden.addresses[0]!.address;
const ok = ["--chain", "arb", "--amount", "1", "--rpc", "https://rpc.example/x", "--to", TO, SPEND_FLAG];

describe("parseShieldOnceArgs", () => {
  it("refuses without the spend flag, whatever else is passed", () => {
    expect(() => parseShieldOnceArgs(ok.filter((a) => a !== SPEND_FLAG))).toThrow(/refusing to run/);
    expect(() => parseShieldOnceArgs([])).toThrow(/refusing to run/);
    expect(() => parseShieldOnceArgs(["--i-understand"])).toThrow(/refusing to run/);
  });
  it("parses the spike arguments with the flag", () => {
    expect(parseShieldOnceArgs(ok)).toEqual({ chain: "arb", amount: 1_000_000n, rpc: "https://rpc.example/x", to: TO });
    expect(parseShieldOnceArgs([SPEND_FLAG, ...ok.slice(0, -1).map((a) => (a === "1" ? "0.5" : a))]).amount).toBe(500_000n);
  });
  it("rejects other chains, bad amounts and stray arguments", () => {
    const w = (i: number, v: string) => ok.map((a, j) => (j === i ? v : a));
    expect(() => parseShieldOnceArgs(w(1, "eth"))).toThrow(/--chain must be arb/);
    expect(() => parseShieldOnceArgs(w(3, "0"))).toThrow(/> 0/);
    expect(() => parseShieldOnceArgs(w(3, "1.0000001"))).toThrow(/at most 6 decimals/);
    expect(() => parseShieldOnceArgs(w(3, String(Number(MAX_SPIKE_USDC) / 1e6 + 1)))).toThrow(/at most 5 USDC/);
    expect(() => parseShieldOnceArgs(w(5, "http://rpc.example"))).toThrow(/https/);
    expect(() => parseShieldOnceArgs([...ok, "abandon"])).toThrow("unknown argument: (positional)");
  });
});

it("the script exits non-zero without the flag, before reading the seed or touching the network", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/railgun-shield-once.ts", ...ok.filter((a) => a !== SPEND_FLAG)], {
    input: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n",
    encoding: "utf8",
    timeout: 60_000,
    // No inherited env: nothing (RPC URLs, seeds) can leak in. Cast: worker-configuration.d.ts widens ProcessEnv.
    env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/refusing to run/);
  expect(r.stdout).toBe("");
});
