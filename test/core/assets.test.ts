import { describe, expect, it, vi } from "vitest";
import { getAsset } from "../../src/core/assets";
import { enabledAssets } from "../../src/config";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("assets", () => {
  it("btc:btc", () => {
    expect(getAsset("btc:btc")).toMatchObject({ decimals: 8, confirmations: 2, priceSymbol: "BTC" });
  });
  it("ltc:ltc has 6 confirmations", () => {
    expect(getAsset("ltc:ltc").confirmations).toBe(6);
  });
  it("doge:doge", () => {
    expect(getAsset("doge:doge")).toMatchObject({ decimals: 8, confirmations: 20 });
  });
  it("throws on unknown asset", () => {
    expect(() => getAsset("btc:xyz")).toThrow("unknown asset");
  });
});

describe("enabledAssets", () => {
  const custody = { ALLOW_SEED_CUSTODY: "true", DOGE_BLOCKBOOK_URL: "https://bb.test", MASTER_SEED: SEED };
  it("returns enabled assets in order", () => {
    expect(enabledAssets({ ENABLED_ASSETS: "btc:btc,doge:doge", ...custody }).map((a) => a.id)).toEqual(["btc:btc", "doge:doge"]);
  });
  it("trims whitespace and handles empty", () => {
    expect(enabledAssets({ ENABLED_ASSETS: " btc:btc , ltc:ltc ", ...custody }).map((a) => a.id)).toEqual(["btc:btc", "ltc:ltc"]);
    expect(enabledAssets({ ENABLED_ASSETS: "" })).toEqual([]);
  });
  it("throws on unknown id", () => {
    expect(() => enabledAssets({ ENABLED_ASSETS: "btc:btc,nope:nope", ...custody })).toThrow("unknown asset");
  });
  it("drops unusable assets (no xpub and no custody opt-in; doge without Blockbook), warning once per asset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const all = "btc:btc,ltc:ltc,doge:doge";
    // Watch mode needs only the xpub.
    expect(enabledAssets({ ENABLED_ASSETS: all, BTC_XPUB: "xpub-btc", DOGE_XPUB: "xpub-doge" }).map((a) => a.id)).toEqual(["btc:btc"]);
    expect(enabledAssets({ ENABLED_ASSETS: all, LTC_XPUB: "", ALLOW_SEED_CUSTODY: "1" })).toEqual([]);
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((m) => m.includes("ltc:ltc"))).toHaveLength(1);
    expect(logged.filter((m) => m.includes("doge:doge"))).toHaveLength(1);
    expect(logged.find((m) => m.includes("ltc:ltc"))).toContain("LTC_XPUB");
    expect(logged.find((m) => m.includes("doge:doge"))).toContain("DOGE_BLOCKBOOK_URL");
    warn.mockRestore();
  });
  it("drops routed-mode assets when MASTER_SEED is not a valid mnemonic, warning why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(enabledAssets({ ENABLED_ASSETS: "arb:eth", EVM_RPC_ARB: "https://a.test", ALLOW_SEED_CUSTODY: "true", MASTER_SEED: "abandon ".repeat(12).trim() })).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("arb:eth") && m.includes("MASTER_SEED is not a valid BIP39 mnemonic"))).toBe(true);
    warn.mockRestore();
  });
});

describe("enabledAssets (EVM)", () => {
  const rpc = { EVM_RPC_ETH: "https://rpc.test", MASTER_SEED: SEED };
  it("needs both custody opt-in and the chain's RPC var", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ENABLED_ASSETS = "eth:eth,eth:usdc";
    expect(enabledAssets({ ENABLED_ASSETS, MASTER_SEED: SEED, ALLOW_SEED_CUSTODY: "true" })).toEqual([]);
    expect(enabledAssets({ ENABLED_ASSETS, ALLOW_SEED_CUSTODY: "true", EVM_RPC_ETH: "  ", MASTER_SEED: SEED })).toEqual([]);
    expect(enabledAssets({ ENABLED_ASSETS, ...rpc })).toEqual([]);
    expect(enabledAssets({ ENABLED_ASSETS, ...rpc, ALLOW_SEED_CUSTODY: "true" }).map((a) => a.id)).toEqual(["eth:eth", "eth:usdc"]);
    // a different chain's RPC var does not help
    expect(enabledAssets({ ENABLED_ASSETS: "base:usdc", ...rpc, ALLOW_SEED_CUSTODY: "true" })).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("eth:eth") && m.includes("EVM_RPC_ETH"))).toBe(true);
    warn.mockRestore();
  });
});
