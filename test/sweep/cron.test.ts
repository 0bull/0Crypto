import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { runSweeps } from "../../src/sweep/cron";
import { runEvmSweep } from "../../src/sweep/evm";
import { runSolanaSweep } from "../../src/sweep/solana";
import { runTronSweep } from "../../src/sweep/tron";

// The chain sweepers are replaced: these tests are about runSweeps' scheduling and isolation only.
vi.mock("../../src/sweep/evm", async (orig) => ({ ...(await orig<typeof import("../../src/sweep/evm")>()), runEvmSweep: vi.fn() }));
vi.mock("../../src/sweep/tron", async (orig) => ({ ...(await orig<typeof import("../../src/sweep/tron")>()), runTronSweep: vi.fn() }));
vi.mock("../../src/sweep/solana", async (orig) => ({ ...(await orig<typeof import("../../src/sweep/solana")>()), runSolanaSweep: vi.fn() }));

const e = env as unknown as Env;
const T0 = 1_900_000_000_000;
const CONFIG = { EVM_RPC_BASE: "https://rpc.test/base", EVM_RPC_ARB: "https://rpc.test/arb", TRONGRID_API_KEY: "test-trongrid-key", SOLANA_RPC_URL: "https://sol.test/rpc" };
const saved = Object.fromEntries(Object.keys(CONFIG).map((k) => [k, e[k as keyof Env]]));
const evm = vi.mocked(runEvmSweep);
const tron = vi.mocked(runTronSweep);
const sol = vi.mocked(runSolanaSweep);
const idle = { status: "idle" as const, paymentIds: [] };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  Object.assign(e, CONFIG);
});
afterAll(() => Object.assign(e, saved));
beforeEach(() => {
  vi.restoreAllMocks();
  for (const m of [evm, tron, sol]) m.mockReset();
});

describe("runSweeps with EVM, Tron and Solana configured", () => {
  it("runs the EVM chains in parallel first, then Tron and Solana once every EVM sweep is done", async () => {
    const log: string[] = [];
    evm.mockImplementation(async (_env, chain) => {
      log.push(`start ${chain}`);
      await tick(chain === "base" ? 30 : 10);
      log.push(`end ${chain}`);
      return idle;
    });
    tron.mockImplementation(async () => (log.push("tron"), idle));
    sol.mockImplementation(async () => (log.push("sol"), idle));
    const out = await runSweeps(e, T0);
    expect(Object.keys(out).sort()).toEqual(["arb", "base", "sol", "tron"]);
    // Both EVM chains started before either ended (parallel), and both ended before Tron or Solana started.
    expect(log.slice(0, 2).sort()).toEqual(["start arb", "start base"]);
    const lastEvm = Math.max(log.indexOf("end arb"), log.indexOf("end base"));
    expect(log.indexOf("tron")).toBeGreaterThan(lastEvm);
    expect(log.indexOf("sol")).toBeGreaterThan(lastEvm);
  });

  it("Tron and Solana measure their 20 s deadline from the start of the cron run, EVM time included", async () => {
    let evmStart = 0;
    evm.mockImplementation(async () => {
      evmStart ||= Date.now();
      await tick(20);
      return idle;
    });
    tron.mockResolvedValue(idle);
    sol.mockResolvedValue(idle);
    const before = Date.now();
    await runSweeps(e, T0);
    for (const m of [tron, sol]) {
      const startedAt = m.mock.calls[0]![2]?.startedAt;
      expect(startedAt).toBeGreaterThanOrEqual(before);
      expect(startedAt).toBeLessThanOrEqual(evmStart);
    }
  });

  for (const broken of ["base", "tron", "sol"] as const) {
    it(`a throwing ${broken} sweeper is reported as failed; every other chain still runs`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const boom = () => {
        throw new TypeError("boom");
      };
      evm.mockImplementation(async (_env, chain) => (chain === broken ? boom() : { status: "sent", tx: `0x${chain}`, paymentIds: [`pay_${chain}`] }));
      tron.mockImplementation(async () => (broken === "tron" ? boom() : { status: "sent", tx: "tx_tron", paymentIds: ["pay_tron"] }));
      sol.mockImplementation(async () => (broken === "sol" ? boom() : { status: "sent", tx: "tx_sol", paymentIds: ["pay_sol"] }));
      const out = await runSweeps(e, T0);
      expect(out[broken]).toEqual({ status: "failed", reason: "TypeError", paymentIds: [] });
      for (const chain of ["base", "arb", "tron", "sol"] as const) if (chain !== broken) expect(out[chain]?.status).toBe("sent");
      expect(warn).toHaveBeenCalledWith(`0crypto: sweep ${broken} failed: TypeError`);
    });
  }
});
