import { describe, expect, it } from "vitest";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import pins from "../../../contracts/factory-initcode.json";
import { counterKey } from "../../../src/chains/registry";
import { EVM_CHAINS, evmClient } from "../../../src/chains/evm/chains";
import { hotAccount } from "../../../src/signing/evmkeys";
import { factoryAddress, predictLegacyDeposit as predictDeposit } from "../../../src/chains/evm/predict";
import { evmDepositSalt } from "../../../src/signing/addresses";
import { getAsset } from "../../../src/core/assets";
import { allocateIndex } from "../../../src/db/repo";
import type { Env } from "../../../src/env";

const SINK = "0x000000000000000000000000000000000000dEaD" as const;
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Worked out apart from the code (Python hashlib: BIP39 PBKDF2, BIP32 hardened m/7703'/60'/0', HMAC-SHA256 of the
// tag "0crypto/evm-deposit-salt/v1" + uint32be(index)).
const PIN0 = "0x1381d18b7ccb5ea1ee7a7052b0d1bf799fc727743bf49dd73688077d88f157c1";
const PIN7 = "0x43d10b25e8cd85b4b16135c9d3615b6d5bf1b5226594e18f514573ae96298ca3";

describe("deposit address prediction", () => {
  it("factoryAddress and predictDeposit match the forge-pinned values", () => {
    const factory = factoryAddress(SINK);
    expect(factory).toBe(pins.pins.sinkDead.factory);
    expect(predictDeposit(factory, 7)).toBe(pins.pins.sinkDead.predict7);
  });
  it("matches the pinned addresses as literals (a regenerated pins file cannot silently move them)", () => {
    const factory = factoryAddress(SINK);
    expect(factory).toBe("0xEcc5136c8a869A73eeecb4907bE0429c2a8431c6");
    expect(predictDeposit(factory, 7)).toBe("0xc20804abAC91F0f1aa086f1A5077FC18c2afe892");
  });
  it("indices give distinct addresses; bad indices throw", () => {
    const f = factoryAddress(SINK);
    expect(predictDeposit(f, 0)).not.toBe(predictDeposit(f, 1));
    expect(predictDeposit(f, 2 ** 31 - 1)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (const bad of [-1, 1.5, 2 ** 31, Number.NaN]) expect(() => predictDeposit(f, bad)).toThrow();
  });
});

describe("secret deposit salt", () => {
  it("is pinned for the test seed (changing the tag or path would move every new deposit address)", () => {
    expect(evmDepositSalt(SEED, 0)).toBe(PIN0);
    expect(evmDepositSalt(SEED, 7)).toBe(PIN7);
  });
  it("is the same for a normalised seed, different per seed and index, and refuses bad indices", () => {
    expect(evmDepositSalt(`  ${SEED.toUpperCase()} `, 7)).toBe(evmDepositSalt(SEED, 7));
    expect(evmDepositSalt("legal winner thank year wave sausage worth useful legal winner thank yellow", 7)).not.toBe(evmDepositSalt(SEED, 7));
    expect(evmDepositSalt(SEED, 7)).not.toBe(evmDepositSalt(SEED, 8));
    for (const bad of [-1, 1.5, 2 ** 31, Number.NaN]) expect(() => evmDepositSalt(SEED, bad)).toThrow();
  });
});

describe("hot wallet", () => {
  it("is m/44'/60'/0'/0/0 of MASTER_SEED", () => {
    expect(hotAccount({ MASTER_SEED: SEED }).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });
  it("is derived once per normalised seed per isolate (PBKDF2 is not rerun)", () => {
    const a = hotAccount({ MASTER_SEED: SEED });
    expect(hotAccount({ MASTER_SEED: SEED })).toBe(a);
    expect(hotAccount({ MASTER_SEED: `  ${SEED.toUpperCase().replaceAll(" ", "   ")} ` })).toBe(a);
    expect(hotAccount({ MASTER_SEED: "legal winner thank year wave sausage worth useful legal winner thank yellow" })).not.toBe(a);
  });
});

describe("chains", () => {
  it("registry", () => {
    expect(Object.values(EVM_CHAINS).map((c) => c.chainId)).toEqual([1, 8453, 42161, 137, 56]);
    expect(EVM_CHAINS.polygon.minDepth).toBe(64);
    expect(EVM_CHAINS.eth.minDepth).toBe(0);
    expect(EVM_CHAINS.polygon.nativeSymbol).toBe("POL");
    expect(EVM_CHAINS.bsc.rpcVar).toBe("EVM_RPC_BSC");
  });
  it("evmClient needs at least one RPC URL (chain id checks and fallbacks: adapter.test.ts)", async () => {
    await expect(evmClient({ EVM_RPC_ETH: " , " }, "eth")).rejects.toThrow("EVM_RPC_ETH");
    await expect(evmClient({}, "base")).rejects.toThrow("EVM_RPC_BASE");
  });
});

describe("evm assets", () => {
  it("bsc stablecoins are 18 decimals", () => {
    expect(getAsset("bsc:usdt").decimals).toBe(18);
    expect(getAsset("bsc:usdc").decimals).toBe(18);
    expect(getAsset("eth:usdc").decimals).toBe(6);
    expect(getAsset("eth:dai").decimals).toBe(18);
  });
  it("no USDT on base", () => {
    expect(() => getAsset("base:usdt")).toThrow("unknown asset");
  });
  it("natives and price symbols", () => {
    expect(getAsset("eth:eth")).toMatchObject({ decimals: 18, priceSymbol: "ETH", confirmations: 0 });
    expect(getAsset("base:eth").priceSymbol).toBe("ETH");
    expect(getAsset("arb:eth").priceSymbol).toBe("ETH");
    expect(getAsset("polygon:pol").priceSymbol).toBe("POL");
    expect(getAsset("bsc:bnb").priceSymbol).toBe("BNB");
    expect(getAsset("polygon:usdt").priceSymbol).toBe("USDT");
    expect(getAsset("arb:dai").priceSymbol).toBe("DAI");
  });
  it("token contracts per the spec table", () => {
    expect(getAsset("eth:usdc").contract).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(getAsset("base:usdc").contract).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(getAsset("arb:usdt").contract).toBe("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9");
    expect(getAsset("bsc:dai").contract).toBe("0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3");
    expect(getAsset("eth:eth").contract).toBeUndefined();
  });
  it("lists all 19", () => {
    const ids = ["eth", "base", "arb", "polygon", "bsc"].flatMap((c) =>
      ["eth", "pol", "bnb", "usdc", "usdt", "dai"].flatMap((s) => {
        try { return [getAsset(`${c}:${s}`).id]; } catch { return []; }
      }),
    );
    expect(ids).toHaveLength(19);
  });
});

describe("shared evm derivation counter", () => {
  it("maps all EVM chains to evm and leaves others alone", () => {
    for (const c of ["eth", "base", "arb", "polygon", "bsc"] as const) expect(counterKey(c)).toBe("evm");
    expect(counterKey("btc")).toBe("btc");
    expect(counterKey("doge")).toBe("doge");
  });
  it("payments on different EVM chains get different indices and addresses", async () => {
    await applyD1Migrations((env as unknown as Env).DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
    const db = (env as unknown as Env).DB;
    const a = await allocateIndex(db, counterKey("eth"));
    const b = await allocateIndex(db, counterKey("base"));
    expect(b).not.toBe(a);
    const f = factoryAddress(SINK);
    expect(predictDeposit(f, a)).not.toBe(predictDeposit(f, b));
  });
});
