import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SPEND_FLAG, parseTradeOnceArgs } from "../../scripts/trocador-trade-once-args";

const XMR = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const ok = ["--asset", "btc:btc", "--amount", "0.0005", "--xmr", XMR, SPEND_FLAG];

describe("parseTradeOnceArgs", () => {
  it("refuses without the spend flag", () => {
    expect(() => parseTradeOnceArgs(ok.filter((a) => a !== SPEND_FLAG))).toThrow(/refusing to run/);
    expect(() => parseTradeOnceArgs([])).toThrow(/refusing to run/);
  });
  it("parses; --send is off by default", () => {
    expect(parseTradeOnceArgs(ok)).toEqual({ asset: "btc:btc", amount: 50_000n, decimals: 8, xmr: XMR, send: false });
    expect(parseTradeOnceArgs([...ok, "--send"]).send).toBe(true);
  });
  it("rejects bad assets, amounts, addresses and stray arguments", () => {
    const w = (i: number, v: string) => ok.map((a, j) => (j === i ? v : a));
    expect(() => parseTradeOnceArgs(w(1, "eth:eth"))).toThrow(/--asset/);
    expect(() => parseTradeOnceArgs(w(3, "0.000000001"))).toThrow(/at most 8 decimals/);
    expect(() => parseTradeOnceArgs(w(3, "0"))).toThrow(/> 0/);
    expect(() => parseTradeOnceArgs(w(5, XMR.slice(0, 94) + "B"))).toThrow();
    expect(() => parseTradeOnceArgs([...ok, "key"])).toThrow("unknown argument: (positional)");
  });
});

it("the script exits non-zero without the flag, before touching the network", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/trocador-trade-once.ts", ...ok.filter((a) => a !== SPEND_FLAG)], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/refusing to run/);
  expect(r.stdout).toBe("");
});
