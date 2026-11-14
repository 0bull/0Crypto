import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLightning, lightningRefused } from "../../../src/chains/lightning/adapter";
import type { Env } from "../../../src/env";
import worker from "../../../src/index";
import { offline } from "../../offline";
import { CLIENT_PK, defaultWallet, nwcUri, relayFactory, WALLET_PK, WalletState } from "./fake-relay";

const e = env as unknown as Env;
const saved = { NWC_URI: e.NWC_URI, ENABLED_ASSETS: e.ENABLED_ASSETS, NWC_TEST_SOCKET_FACTORY: e.NWC_TEST_SOCKET_FACTORY };
const network = setupNetwork();
beforeAll(async () => {
  network.enable();
  network.use(...offline());
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
afterAll(() => {
  Object.assign(e, saved);
  network.disable();
});
beforeEach(async () => {
  for (const k of [`nwc:enc:${WALLET_PK}`, `nwc:caps:${WALLET_PK}:${CLIENT_PK}`]) await e.KV.delete(k);
});

/** The minute-30 cron run (the Lightning capability check), with everything it waits on awaited. */
async function cronAt30(envOverride: Partial<Env>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2030, 0, 1, 12, 30), cron: "30 * * * *" }), { ...e, ...envOverride } as Env, ctx);
    await waitOnExecutionContext(ctx);
  } finally {
    warn.mockRestore();
  }
}

describe("Lightning capability check in the cron", () => {
  it("runs only when ln:btc is in ENABLED_ASSETS", async () => {
    const off = relayFactory({ handler: defaultWallet(new WalletState()), infoEncryption: "nip44_v2" });
    await cronAt30({ NWC_URI: nwcUri(), ENABLED_ASSETS: "btc:btc", NWC_TEST_SOCKET_FACTORY: off.factory });
    expect(off.sockets.length).toBe(0);
    const on = relayFactory({ handler: defaultWallet(new WalletState()), infoEncryption: "nip44_v2" });
    await cronAt30({ NWC_URI: nwcUri(), ENABLED_ASSETS: "btc:btc,ln:btc", NWC_TEST_SOCKET_FACTORY: on.factory });
    expect(on.sockets.length).toBeGreaterThan(0);
  });
  it("has one overall deadline across every relay: a silent wallet cannot hold the cron for relays x 10 s", async () => {
    // Three relays that never answer: without an overall deadline this is 3 x 10 s.
    const silent = relayFactory({ handler: () => null, infoEncryption: "nip44_v2" });
    const env2 = { ...e, NWC_URI: nwcUri(["wss://a.test/v1", "wss://b.test/v1", "wss://c.test/v1"]), ENABLED_ASSETS: "btc:btc,ln:btc", NWC_TEST_SOCKET_FACTORY: silent.factory } as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    await checkLightning(env2, 300);
    const took = Date.now() - t0;
    warn.mockRestore();
    expect(took).toBeLessThan(3_000);
    expect(await lightningRefused(env2)).toBe(false); // no answer is not a refusal
  });
});
