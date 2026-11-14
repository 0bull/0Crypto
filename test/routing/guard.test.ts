import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_ABI, RAILGUN_SHIELD_ABI } from "../../src/chains/evm/abi";
import { RAILGUN_PROXY, WRAPPED_NATIVE } from "../../src/chains/evm/chains";
import { hotAccount } from "../../src/signing/evmkeys";
import { factoryAddress } from "../../src/chains/evm/predict";
import { solDepositKey, solHotKey } from "../../src/signing/keys";
import { findAta } from "../../src/chains/solana/pda";
import { compileSolSweep, solSweepInstructions, sweepPlan, USDC_MINT } from "../../src/chains/solana/sweeptx";
import { tronAddressFromPubkey, tronBase58ToHex } from "../../src/chains/tron/address";
import { tronDepositKey, tronHotKey } from "../../src/signing/keys";
import { insertInvoice, insertPayment, type PaymentRow } from "../../src/db/repo";
import type { Env } from "../../src/env";
import { allowedDestination, allowedShield, DestinationNotAllowed, isAllowed, type Allowed } from "../../src/routing/guard";
import { railgunShieldKey, signEvmTx } from "../../src/signing/evm";
import { buildShieldRequest, notePublicKey, shieldPrivateKeyFromHot } from "../../src/routing/railgun/note";
import golden from "../fixtures/railgun/golden.json";
import { signSolanaTx } from "../../src/signing/solana";
import { signTronTx } from "../../src/signing/tron";
import { contract, rawBytes, transferData, transferParam, triggerParam } from "../chains/tron/pb";
import { TOPUP_SUN } from "../../src/chains/tron/txcheck";
import { ASSETS } from "../../src/core/assets";

const e = env as unknown as Env;
const HOT_EVM = hotAccount(e).address;
const FACTORY = factoryAddress(HOT_EVM);
const RANDOM_EVM = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRON_HOT = tronHotKey(e.MASTER_SEED!);
const TRON_DEP = tronDepositKey(e.MASTER_SEED!, 4);
const TRON_RANDOM = tronDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 0).address;
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SOL_HOT = solHotKey(e.MASTER_SEED!);
const SOL_RANDOM = solDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 0).address;
const T0 = 1_900_000_000_000;

const HOT_SPEC = { role: "hot" } as const;
const DEP4 = { role: "deposit", index: 4 } as const;
const notAllowed = async (p: Promise<unknown>, reason?: RegExp) => {
  await expect(p).rejects.toBeInstanceOf(DestinationNotAllowed);
  if (reason) await expect(p).rejects.toThrow(reason);
};
const NOT_EXACT = /does not pay exactly/;
const USED = /already used/;
const NOT_COVERED = /not covered/;

beforeAll(async () => {
  await applyD1Migrations(e.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await insertInvoice(e.DB, {
    id: "inv_g", created_at: T0, expires_at: T0 + 3_600_000, price_minor: 2500n, currency: "USD", order_id: null,
    metadata: null, success_url: null, allowed_assets: null, status: "paid", late: false, overpaid: false, paid_minor: 2500n,
  });
  for (const [id, chain, asset, address] of [
    ["pay_g_tron", "tron", "tron:usdt", TRON_DEP.address],
    ["pay_g_base", "base", "base:usdc", RANDOM_EVM],
  ] as const) {
    const p: PaymentRow = {
      id, invoice_id: "inv_g", asset, chain, address, derivation_index: 4, reference: null, expected: 1n, price_e8: 10n ** 8n, rate_locked_until: 0,
      received: 1n, final: 1n, txids: [], status: "confirmed", created_at: T0, detected_at: T0, confirmed_at: T0, credited_minor: 2500n,
      credit_price_e8: 10n ** 8n, unexpected: null, swept_at: null, sweep_tx: null, sweep_error: null, sweep_retry_at: null,
    };
    await insertPayment(e.DB, p);
  }
});

describe("allowedDestination: static destinations", () => {
  it("mints proofs for the EVM hot wallet, factory, wrapper and Railgun proxy, checksum-insensitively", async () => {
    for (const [to, kind] of [[HOT_EVM, "hot"], [FACTORY.toLowerCase(), "factory"], [WRAPPED_NATIVE.base.toUpperCase().replace("0X", "0x"), "weth"], [RAILGUN_PROXY.base, "railgun"]] as const) {
      const p = await allowedDestination(e, "base", to, {});
      expect(isAllowed(p)).toBe(true);
      expect(p).toMatchObject({ kind, chain: "base", address: to.toLowerCase() });
    }
  });
  it("pins the official wrappers and the spec's Railgun proxies", () => {
    expect(WRAPPED_NATIVE).toEqual({
      eth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      base: "0x4200000000000000000000000000000000000006",
      arb: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    });
    expect(RAILGUN_PROXY).toEqual({
      eth: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
      arb: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
      bsc: "0x590162bf4b50f6576a459b75309ee21d92178a10",
      polygon: "0x19b620929f97b7b990801496c3b361ca5def8c71",
      base: "0x0047d1F97674614189E80566575FB615788AcF25",
    });
  });
  it("mints the Tron and Solana hot wallets (base58, as-is)", async () => {
    expect(await allowedDestination(e, "tron", TRON_HOT.address, {})).toMatchObject({ kind: "hot", chain: "tron", address: TRON_HOT.address });
    expect(await allowedDestination(e, "sol", SOL_HOT.address, {})).toMatchObject({ kind: "hot", chain: "sol", address: SOL_HOT.address });
  });
  it("sending to a random address throws DestinationNotAllowed, on every chain", async () => {
    await notAllowed(allowedDestination(e, "eth", RANDOM_EVM, {}));
    await notAllowed(allowedDestination(e, "base", BASE_USDC, {}));
    await notAllowed(allowedDestination(e, "tron", TRON_RANDOM, {}));
    await notAllowed(allowedDestination(e, "sol", SOL_RANDOM, {}));
    await notAllowed(allowedDestination(e, "btc", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", {}));
    await notAllowed(allowedDestination(e, "ln", "anything", {}));
  });
  it("one chain's hot wallet is not allowed on another chain", async () => {
    await notAllowed(allowedDestination(e, "tron", SOL_HOT.address, {}));
    await notAllowed(allowedDestination(e, "sol", TRON_HOT.address, {}));
  });
  it("refuses malformed addresses", async () => {
    await notAllowed(allowedDestination(e, "base", "0x1234", {}));
    await notAllowed(allowedDestination(e, "base", `${HOT_EVM} `, {}));
    await notAllowed(allowedDestination(e, "tron", `${TRON_HOT.address.slice(0, -1)}x`, {}));
    await notAllowed(allowedDestination(e, "sol", "0OIl", {}));
  });
  it("a Tron deposit is allowed (kind energy) only as the top-up of its own derivation index", async () => {
    expect(await allowedDestination(e, "tron", TRON_DEP.address, { depositIndex: 4 })).toMatchObject({ kind: "energy", chain: "tron", address: TRON_DEP.address, ref: "4" });
    await notAllowed(allowedDestination(e, "tron", TRON_DEP.address, { depositIndex: 5 }));
    await notAllowed(allowedDestination(e, "tron", TRON_DEP.address, {}));
    await notAllowed(allowedDestination(e, "tron", TRON_RANDOM, { depositIndex: 4 }));
    // Derives correctly, but no Tron payment row has that index and address.
    await notAllowed(allowedDestination(e, "tron", tronDepositKey(e.MASTER_SEED!, 6).address, { depositIndex: 6 }));
  });
});

describe("proofs", () => {
  it("are frozen; a forged or copied proof is not allowed", async () => {
    const p = await allowedDestination(e, "base", HOT_EVM, {});
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      (p as { address: string }).address = RANDOM_EVM;
    }).toThrow();
    expect(isAllowed({ ...p })).toBe(false);
    expect(isAllowed({ kind: "hot", chain: "base", address: HOT_EVM.toLowerCase() })).toBe(false);
    expect(isAllowed(null)).toBe(false);
  });
});

describe("allowedDestination: batch legs", () => {
  const LEG_B = TRON_RANDOM;
  const LEG_C = tronDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 1).address;
  beforeAll(async () => {
    const ins = (id: string, asset: string, legs: unknown, status = "executing") =>
      e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(id, asset, "100", "[]", "xmr", T0, status, T0, T0, JSON.stringify(legs))
        .run();
    await ins("bat_B", "tron:usdt", [{ step: "sending", tradeId: "t1", depositAddress: LEG_B, amount: "100" }]);
    await ins("bat_C", "tron:usdt", [{ step: "sending", tradeId: "t2", depositAddress: LEG_C, amount: "100" }]);
    await ins("bat_M", "tron:usdt", [{ step: "sending", tradeId: "t3", depositAddress: TRON_RANDOM, depositMemo: "123", amount: "100" }]);
    await ins("bat_S", "sol:usdc", [{ step: "sending", tradeId: "t4", depositAddress: SOL_RANDOM, amount: "100" }]);
    await ins("bat_X", "tron:usdt", "not an array");
    await ins("bat_T", "tron:usdt", [{ step: "sending", tradeId: "t5", depositAddress: LEG_C, amount: "100", tx: "ab".repeat(32) }]);
    await ins("bat_N", "tron:usdt", [{ step: "sending", tradeId: "t6", depositAddress: LEG_C, amount: "1.5" }]);
    await ins("bat_D", "tron:usdt", [{ step: "sending", tradeId: "t7", depositAddress: LEG_C, amount: "100" }, { step: "sending", tradeId: "t8", depositAddress: LEG_C, amount: "200" }]);
    await ins("bat_W", "tron:usdt", [{ step: "sending", tradeId: "t9", depositAddress: LEG_C, amount: "100" }], "scheduled");
    await ins("bat_SOL", "sol:sol", [{ step: "sending", tradeId: "t10", depositAddress: SOL_RANDOM, amount: "100" }]);
  });
  it("binds the leg's asset and amount", async () => {
    expect(await allowedDestination(e, "tron", LEG_B, { batchId: "bat_B" })).toMatchObject({ asset: "tron:usdt", amount: 100n });
  });
  it("refuses a leg that already has a tx, a batch that is not executing, a non-integer amount and an ambiguous address", async () => {
    await notAllowed(allowedDestination(e, "tron", LEG_C, { batchId: "bat_T" }));
    await notAllowed(allowedDestination(e, "tron", LEG_C, { batchId: "bat_W" }));
    await notAllowed(allowedDestination(e, "tron", LEG_C, { batchId: "bat_N" }));
    await notAllowed(allowedDestination(e, "tron", LEG_C, { batchId: "bat_D" }));
  });
  it("a leg proof covers only its exact asset and amount (Tron USDT)", async () => {
    const p = await allowedDestination(e, "tron", LEG_B, { batchId: "bat_B" });
    const hotTrig = (to: string, amount: bigint) =>
      bytesToHex(rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(TRON_HOT.address), contract: H(USDT), data: transferData(H(to), amount) }))], expiration: EXP, timestamp: T0, feeLimit: 5_000_000n }));
    const hotXfer = (to: string, amount: bigint) => bytesToHex(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(TRON_HOT.address), to: H(to), amount }))], expiration: EXP, timestamp: T0 }));
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, hotTrig(LEG_B, 99n), [p])).toThrow(NOT_EXACT);
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, hotXfer(LEG_B, 100n), [p])).toThrow(NOT_EXACT);
    // A refused tx does not use the proof up; the exact one does, once.
    signTronTx(e.MASTER_SEED!, HOT_SPEC, hotTrig(LEG_B, 100n), [p]);
    const second = bytesToHex(
      rawBytes({ contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(TRON_HOT.address), contract: H(USDT), data: transferData(H(LEG_B), 100n) }))], expiration: EXP + 1_000, timestamp: T0 + 1, feeLimit: 5_000_000n }),
    );
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, second, [p])).toThrow(USED);
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, hotTrig(LEG_B, 100n), [p])).toThrow(USED);
  });
  it("a leg proof covers one SOL payment of its amount, nothing more (Solana)", async () => {
    const [k, system] = await Promise.all([import("@solana/kit"), import("@solana-program/system")]);
    const p = await allowedDestination(e, "sol", SOL_RANDOM, { batchId: "bat_SOL" });
    const hot = k.createNoopSigner(k.address(SOL_HOT.address));
    const pay = (amount: bigint) => system.getTransferSolInstruction({ source: hot, destination: k.address(SOL_RANDOM), amount });
    const plan = sweepPlan(SOL_HOT.address, [{ address: sdep(1).address, lamports: 1n, tokens: [] }], LIFE);
    const cb = (await solSweepInstructions(plan)).slice(0, 2);
    const sign = async (ixs: unknown[]) => signSolanaTx(e.MASTER_SEED!, await compileSolSweep(plan, [...cb, ...ixs]), [HOT_SPEC], [p]);
    await notAllowed(sign([pay(101n)]), NOT_EXACT);
    await notAllowed(sign([pay(50n), pay(50n)]), NOT_EXACT);
    await sign([pay(100n)]);
    // A second tx paying the same exact amount (another blockhash): the proof is spent.
    const plan2 = sweepPlan(SOL_HOT.address, [{ address: sdep(1).address, lamports: 1n, tokens: [] }], { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 2000n });
    const cb2 = (await solSweepInstructions(plan2)).slice(0, 2);
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await compileSolSweep(plan2, [...cb2, pay(100n)]), [HOT_SPEC], [p]), USED);
  });
  it("a trade deposit address from batch B is allowed with { batchId: B } and rejected with { batchId: C }", async () => {
    expect(await allowedDestination(e, "tron", LEG_B, { batchId: "bat_B" })).toMatchObject({ kind: "swap", chain: "tron", address: LEG_B, ref: "bat_B" });
    await notAllowed(allowedDestination(e, "tron", LEG_B, { batchId: "bat_C" }));
    await notAllowed(allowedDestination(e, "tron", LEG_B, { batchId: "bat_nope" }));
  });
  it("refuses a leg on another chain than the batch's asset, a leg with a memo, and malformed legs", async () => {
    await notAllowed(allowedDestination(e, "sol", SOL_RANDOM, { batchId: "bat_B" }));
    await notAllowed(allowedDestination(e, "tron", SOL_RANDOM, { batchId: "bat_S" }));
    expect(await allowedDestination(e, "sol", SOL_RANDOM, { batchId: "bat_S" })).toMatchObject({ kind: "swap", chain: "sol" });
    await notAllowed(allowedDestination(e, "tron", TRON_RANDOM, { batchId: "bat_M" }));
    await notAllowed(allowedDestination(e, "tron", TRON_RANDOM, { batchId: "bat_X" }));
  });
});

describe("allowedDestination: route legs are paid only while claimed for sending (Task 6)", () => {
  const LEG = tronDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 7).address;
  it("refuses a leg that is quoted, traded, waiting for energy, sent, abandoned or has no step", async () => {
    for (const [i, step] of [["q", "quote"], ["t", "traded"], ["e", "energy_wait"], ["s", "sent"], ["a", "abandoned"], ["n", undefined]] as const) {
      await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(`bat_step_${i}`, "tron:usdt", "100", "[]", "xmr", T0, "executing", T0, T0, JSON.stringify([{ ...(step ? { step } : {}), tradeId: "t", depositAddress: LEG, amount: "100" }]))
        .run();
      await notAllowed(allowedDestination(e, "tron", LEG, { batchId: `bat_step_${i}` }));
    }
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind("bat_step_ok", "tron:usdt", "100", "[]", "xmr", T0, "executing", T0, T0, JSON.stringify([{ step: "abandoned", depositAddress: LEG, amount: "100" }, { step: "sending", depositAddress: LEG, amount: "100" }]))
      .run();
    expect(await allowedDestination(e, "tron", LEG, { batchId: "bat_step_ok" })).toMatchObject({ kind: "swap", amount: 100n });
  });
});

describe("allowedDestination: UTXO change (Task 6)", () => {
  const MN = e.MASTER_SEED!;
  it("mints a change proof only for our own address at an allocated index that no payment uses, never in watch mode", async () => {
    const { accountFromSeed, deriveUtxoAddress } = await import("../../src/chains/utxo/derive");
    const { allocateIndex } = await import("../../src/db/repo");
    const { allocateOwnAddress } = await import("../../src/routing/own");
    const addr = (i: number) => deriveUtxoAddress(accountFromSeed(MN, "btc"), "btc", i);
    await e.DB.prepare("DELETE FROM derivation_counters WHERE chain='btc'").run();
    await e.DB.prepare("DELETE FROM own_addresses").run();
    // Not allocated yet.
    await notAllowed(allowedDestination(e, "btc", addr(0), { changeIndex: 0 }));
    const i = (await allocateOwnAddress(e, "btc", "change", T0)).index;
    const j = (await allocateOwnAddress(e, "btc", "change", T0)).index;
    // Allocated but not recorded as our change (an invoice's index; a refund address): never.
    const k = await allocateIndex(e.DB, "btc");
    await notAllowed(allowedDestination(e, "btc", addr(k), { changeIndex: k }));
    const r = (await allocateOwnAddress(e, "btc", "refund", T0)).index;
    await notAllowed(allowedDestination(e, "btc", addr(r), { changeIndex: r }));
    expect(await allowedDestination(e, "btc", addr(i), { changeIndex: i })).toMatchObject({ kind: "change", chain: "btc", address: addr(i) });
    // Upper-case bech32 is the same address.
    expect(await allowedDestination(e, "btc", addr(i).toUpperCase(), { changeIndex: i })).toMatchObject({ kind: "change", address: addr(i) });
    // Another index's address, a foreign address, a payment's index, an index past the counter.
    await notAllowed(allowedDestination(e, "btc", addr(j), { changeIndex: i }));
    await notAllowed(allowedDestination(e, "btc", deriveUtxoAddress(accountFromSeed("legal winner thank year wave sausage worth useful legal winner thank yellow", "btc"), "btc", i), { changeIndex: i }));
    await notAllowed(allowedDestination(e, "btc", addr(j + 5), { changeIndex: j + 5 }));
    await insertPayment(e.DB, {
      id: "pay_g_btc", invoice_id: "inv_g", asset: "btc:btc", chain: "btc", address: addr(j), derivation_index: j, reference: null, expected: 1n, price_e8: 10n ** 8n, rate_locked_until: 0,
      received: 1n, final: 1n, txids: [], status: "confirmed", created_at: T0, detected_at: T0, confirmed_at: T0, credited_minor: 1n, credit_price_e8: 10n ** 8n, unexpected: null,
    });
    await notAllowed(allowedDestination(e, "btc", addr(j), { changeIndex: j }));
    // Watch mode: never.
    await notAllowed(allowedDestination({ ...e, BTC_XPUB: "xpub-set" } as Env, "btc", addr(i), { changeIndex: i }));
    // Not on Tron or Solana.
    await notAllowed(allowedDestination(e, "tron", TRON_RANDOM, { changeIndex: 0 }));
  });
});

describe("signSolanaTx: route legs (Task 6)", () => {
  const OWNER = solDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 3).address;
  const OTHER = solDepositKey("legal winner thank year wave sausage worth useful legal winner thank yellow", 4).address;
  const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
  beforeAll(async () => {
    await e.DB.prepare("INSERT INTO route_batches(id,asset,total,chunks,destination,due_at,status,created_at,updated_at,legs) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind("bat_usdc", "sol:usdc", "100", "[]", "xmr", T0, "executing", T0, T0, JSON.stringify([{ step: "sending", depositAddress: OWNER, amount: "100" }]))
      .run();
  });
  const build = async (to: string, ataOwner: string, mint: string) => {
    const [k, token] = await Promise.all([import("@solana/kit"), import("@solana-program/token")]);
    const { compileSolRoute, routePlan } = await import("../../src/chains/solana/routetx");
    const plan = routePlan(SOL_HOT.address, to, "sol:usdc", 100n, { blockhash: BH, lastValidBlockHeight: 1000n });
    const base = await compileSolRoute(plan);
    if (ataOwner === to && mint === USDC_MINT) return base;
    const hot = k.createNoopSigner(k.address(SOL_HOT.address));
    const ixs = [
      { programAddress: k.address("ComputeBudget111111111111111111111111111111"), data: Uint8Array.of(2, 0, 0, 0, 0) },
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: hot, ata: k.address(findAta(ataOwner, mint)[0]), owner: k.address(ataOwner), mint: k.address(mint) }),
      token.getTransferCheckedInstruction({ source: k.address(findAta(SOL_HOT.address, USDC_MINT)[0]), mint: k.address(USDC_MINT), destination: k.address(findAta(to, USDC_MINT)[0]), authority: hot, amount: 100n, decimals: 6 }),
    ];
    return compileSolSweep(sweepPlan(SOL_HOT.address, [{ address: sdep(1).address, lamports: 1n, tokens: [] }], { blockhash: BH, lastValidBlockHeight: 1000n }), ixs);
  };
  it("allows the ATA create and transferChecked to ATA(leg owner, USDC) under the leg proof, once", async () => {
    const p = await allowedDestination(e, "sol", OWNER, { batchId: "bat_usdc" });
    await signSolanaTx(e.MASTER_SEED!, await build(OWNER, OWNER, USDC_MINT), [HOT_SPEC], [p]);
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await build(OWNER, OWNER, USDC_MINT), [HOT_SPEC], [p]), USED);
  });
  it("refuses an ATA create for a non-leg owner, and the leg owner's ATA of another mint", async () => {
    const p = await allowedDestination(e, "sol", OWNER, { batchId: "bat_usdc" });
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await build(OWNER, OTHER, USDC_MINT), [HOT_SPEC], [p]), NOT_COVERED);
    const OTHER_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT on Solana
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await build(OWNER, OWNER, OTHER_MINT), [HOT_SPEC], [p]), /not for the asset/);
    // The proof was not used up by the refused txs.
    await signSolanaTx(e.MASTER_SEED!, await build(OWNER, OWNER, USDC_MINT), [HOT_SPEC], [p]);
  });
});

describe("allowedDestination: refunds", () => {
  const TO = "0x2222222222222222222222222222222222222222";
  const refund = (id: string, o: { approved?: boolean; tx?: string | null; payment?: string; to?: string } = {}) =>
    e.DB.prepare("INSERT INTO refunds(id,payment_id,to_address,amount,approved_at,tx) VALUES(?,?,?,?,?,?)")
      .bind(id, o.payment ?? "pay_g_base", o.to ?? TO, "5", o.approved === false ? null : T0, o.tx ?? null)
      .run();
  beforeEach(async () => {
    await e.DB.prepare("DELETE FROM refunds").run();
  });
  it("an approved refund is allowed once; a second use throws", async () => {
    await refund("ref_1");
    expect(await allowedDestination(e, "base", TO.toUpperCase().replace("0X", "0x"), { refundId: "ref_1" })).toMatchObject({ kind: "refund", chain: "base", address: TO, ref: "ref_1" });
    expect((await e.DB.prepare("SELECT consumed_at FROM refunds WHERE id='ref_1'").first<{ consumed_at: number | null }>())?.consumed_at).not.toBeNull();
    await notAllowed(allowedDestination(e, "base", TO, { refundId: "ref_1" }));
  });
  it("a refund proof binds the payment's asset and the refund's amount, and covers only that exact transfer", async () => {
    await refund("ref_b");
    const p = await allowedDestination(e, "base", TO, { refundId: "ref_b" });
    expect(p).toMatchObject({ asset: "base:usdc", amount: 5n });
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(TO, 6n) }, [p]), NOT_EXACT);
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: TO, value: 5n }, [p]), NOT_EXACT);
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: RANDOM_EVM, data: transferCall(TO, 5n) }, [p]), NOT_EXACT);
    await signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(TO, 5n) }, [p]);
  });
  it("an EVM bound proof is bound to its first (chain, from, nonce): a fee-bump replacement passes, another nonce is refused", async () => {
    await refund("ref_n");
    const p = await allowedDestination(e, "base", TO, { refundId: "ref_n" });
    const tx = { ...fee, chainId: 8453, to: BASE_USDC as `0x${string}`, data: transferCall(TO, 5n) };
    await signEvmTx(e, tx, [p]);
    await signEvmTx(e, { ...tx, maxFeePerGas: 3n, maxPriorityFeePerGas: 2n }, [p]);
    await notAllowed(signEvmTx(e, { ...tx, nonce: fee.nonce + 1 }, [p]), USED);
    await notAllowed(signEvmTx(e, { ...tx, chainId: 1 }, [p]));
  });
  it("concurrent double use yields exactly one success", async () => {
    await refund("ref_2");
    const r = await Promise.allSettled([1, 2, 3].map(() => allowedDestination(e, "base", TO, { refundId: "ref_2" })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r.filter((x) => x.status === "rejected")) expect((x as PromiseRejectedResult).reason).toBeInstanceOf(DestinationNotAllowed);
  });
  it("refuses unapproved, already sent, other-address and other-chain refunds without consuming them", async () => {
    await refund("ref_u", { approved: false });
    await refund("ref_s", { tx: "0xabc" });
    await refund("ref_a");
    await refund("ref_c");
    await notAllowed(allowedDestination(e, "base", TO, { refundId: "ref_u" }));
    await notAllowed(allowedDestination(e, "base", TO, { refundId: "ref_s" }));
    await notAllowed(allowedDestination(e, "base", RANDOM_EVM, { refundId: "ref_a" }));
    await notAllowed(allowedDestination(e, "eth", TO, { refundId: "ref_c" }));
    await notAllowed(allowedDestination(e, "base", TO, { refundId: "ref_missing" }));
    const left = await e.DB.prepare("SELECT COUNT(*) AS n FROM refunds WHERE consumed_at IS NOT NULL").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

// ---- Signers ----

const all = async (chain: "base" | "eth"): Promise<Allowed[]> =>
  Promise.all([HOT_EVM, FACTORY, WRAPPED_NATIVE[chain], RAILGUN_PROXY[chain]].map((a) => allowedDestination(e, chain, a, {})));
const fee = { type: "eip1559" as const, nonce: 3, gas: 200_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const transferCall = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${word(amount.toString(16))}` as `0x${string}`;
const approveCall = (to: string, amount: bigint) => `0x095ea7b3${word(to)}${word(amount.toString(16))}` as `0x${string}`;

/** Spies on the hot account's signTransaction (the signer derives the account itself; the cache returns this one). */
function spyAccount() {
  const signTransaction = vi.spyOn(hotAccount(e), "signTransaction");
  return { account: e, signTransaction };
}
afterEach(() => vi.restoreAllMocks());

describe("railgunShieldKey", () => {
  it("is the note's shield key of the hot account, derived inside src/signing", async () => {
    expect(Array.from(await railgunShieldKey(e))).toEqual(Array.from(await shieldPrivateKeyFromHot(hotAccount(e))));
  });
});

describe("signEvmTx", () => {
  it("signs a deployAndFlush to the factory with the factory proof, and the signed tx is exactly it", async () => {
    const { encodeFunctionData, parseTransaction } = await import("viem");
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[`0x${"11".repeat(32)}`], [BASE_USDC]] });
    const raw = await signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data }, [await allowedDestination(e, "base", FACTORY, {})]);
    const p = parseTransaction(raw);
    expect(p.to?.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(p.data).toBe(data);
    expect(p.chainId).toBe(8453);
  });
  it("rejects a forged proof object and signs nothing", async () => {
    const { account, signTransaction } = spyAccount();
    const forged = { kind: "factory", chain: "base", address: FACTORY.toLowerCase() } as unknown as Allowed;
    const { encodeFunctionData } = await import("viem");
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[`0x${"11".repeat(32)}`], []] });
    await notAllowed(signEvmTx(account, { ...fee, chainId: 8453, to: FACTORY, data }, [forged]));
    const real = await allowedDestination(e, "base", FACTORY, {});
    await notAllowed(signEvmTx(account, { ...fee, chainId: 8453, to: FACTORY, data }, [{ ...real }]));
    expect(signTransaction).not.toHaveBeenCalled();
  });
  it("rejects a proof for chain A used on chain B", async () => {
    const { account, signTransaction } = spyAccount();
    await notAllowed(signEvmTx(account, { ...fee, chainId: 1, to: HOT_EVM, value: 1n }, [await allowedDestination(e, "base", HOT_EVM, {})]));
    expect(signTransaction).not.toHaveBeenCalled();
  });
  it("rejects a hot proof for a tx paying elsewhere", async () => {
    const { account, signTransaction } = spyAccount();
    await notAllowed(signEvmTx(account, { ...fee, chainId: 8453, to: RANDOM_EVM, value: 1n }, await all("base")));
    expect(signTransaction).not.toHaveBeenCalled();
  });
  it("a USDC transfer whose outer to is the USDC contract but whose inner recipient is random throws; to hot it signs", async () => {
    const { account, signTransaction } = spyAccount();
    await notAllowed(signEvmTx(account, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(RANDOM_EVM, 5n) }, await all("base")));
    expect(signTransaction).not.toHaveBeenCalled();
    await signEvmTx(account, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(HOT_EVM, 5n) }, [await allowedDestination(e, "base", HOT_EVM, {})]);
    expect(signTransaction).toHaveBeenCalledOnce();
  });
  it("a token transfer to the factory, wrapper or Railgun proxy (funds lost) is refused", async () => {
    for (const to of [FACTORY, WRAPPED_NATIVE.base, RAILGUN_PROXY.base])
      await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(to, 5n) }, await all("base")));
  });
  it("approve: a random spender is rejected; the Railgun proxy with its proof signs", async () => {
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RANDOM_EVM, 5n) }, await all("base")));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(HOT_EVM, 5n) }, await all("base")));
    await signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RAILGUN_PROXY.base, 5n) }, [await allowedDestination(e, "base", RAILGUN_PROXY.base, {})]);
  });
  it("rejects an unknown selector, and transfer calldata that does not decode exactly", async () => {
    const proofs = await all("base");
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: "0xdeadbeef" }, proofs));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: `${transferCall(HOT_EVM, 5n)}00` }, proofs));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(HOT_EVM, 5n).slice(0, -2) as `0x${string}` }, proofs));
    const dirty = `0xa9059cbb${"ff".repeat(12)}${HOT_EVM.slice(2).toLowerCase()}${word("5")}` as `0x${string}`;
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: dirty }, proofs));
    const { encodeFunctionData } = await import("viem");
    const flushData = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[`0x${"11".repeat(32)}`], [BASE_USDC]] });
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: `${flushData}00` }, proofs));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: `${flushData}${"00".repeat(32)}` }, proofs));
    // flush() is only callable by the factory: the hot wallet never sends it.
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: `0x48897c52${word("20")}${word("0")}` }, proofs));
  });
  it("rejects a value-bearing call to anything but the wrapper's deposit()", async () => {
    const proofs = await all("base");
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: transferCall(HOT_EVM, 5n), value: 1n }, proofs));
    const { encodeFunctionData } = await import("viem");
    const flush = encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployAndFlush", args: [[], []] });
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: flush, value: 1n }, proofs));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: FACTORY, data: "0xd0e30db0", value: 1n }, proofs));
    await signEvmTx(e, { ...fee, chainId: 8453, to: WRAPPED_NATIVE.base, data: "0xd0e30db0", value: 10n }, [await allowedDestination(e, "base", WRAPPED_NATIVE.base, {})]);
  });
  it("rejects a contract creation and an unknown chain id", async () => {
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, data: "0x6000" } as never, await all("base")));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 10, to: HOT_EVM, value: 1n }, await all("base")));
  });
  it("Railgun shield(ShieldRequest[]): selector 044a40c3 (RailgunSmartWallet V2.1 ABI), to the proxy only, exact calldata", async () => {
    const { encodeFunctionData, toFunctionSelector } = await import("viem");
    expect(toFunctionSelector(RAILGUN_SHIELD_ABI[0])).toBe("0x044a40c3");
    const saved = e.RAILGUN_0ZK_ADDRESS;
    e.RAILGUN_0ZK_ADDRESS = golden.addresses[0]!.address;
    try {
    const { proof, request } = await allowedShield(e, "base", "base:usdc", 5n, await railgunShieldKey(e));
    const data = encodeFunctionData({ abi: RAILGUN_SHIELD_ABI, functionName: "shield", args: [[request]] });
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: RANDOM_EVM, data }, [...(await all("base")), proof]));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: HOT_EVM, data }, [...(await all("base")), proof]));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: RAILGUN_PROXY.base, data: `${data}00` }, [proof]));
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: RAILGUN_PROXY.base, data, value: 1n }, [proof]));
    await signEvmTx(e, { ...fee, chainId: 8453, to: RAILGUN_PROXY.base, data }, [proof]);
    } finally {
      e.RAILGUN_0ZK_ADDRESS = saved;
    }
  });
  it("approve: an amount above uint120 (an unlimited approval) is refused; approve(0) to the proxy signs", async () => {
    const proxy = [await allowedDestination(e, "base", RAILGUN_PROXY.base, {})];
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RAILGUN_PROXY.base, (1n << 256n) - 1n) }, proxy), /uint120/);
    await notAllowed(signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RAILGUN_PROXY.base, 1n << 120n) }, proxy), /uint120/);
    await signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RAILGUN_PROXY.base, (1n << 120n) - 1n) }, proxy);
    await signEvmTx(e, { ...fee, chainId: 8453, to: BASE_USDC, data: approveCall(RAILGUN_PROXY.base, 0n) }, proxy);
  });
});

// ---- Railgun shield binding (npk, token, value; single-use) ----

describe("shield proofs: the signer recomputes the bound note", () => {
  // golden.addresses[0] is valid on all chains; [2] is an Ethereum-only (0:1) address.
  const RECEIVER = golden.addresses[0]!.address;
  const OTHER = golden.addresses[3]!.address;
  let saved: string | undefined;
  beforeAll(() => {
    saved = e.RAILGUN_0ZK_ADDRESS;
    e.RAILGUN_0ZK_ADDRESS = RECEIVER;
  });
  afterAll(() => {
    e.RAILGUN_0ZK_ADDRESS = saved;
  });
  type Req = Awaited<ReturnType<typeof allowedShield>>["request"];
  const shieldData = async (requests: Req[]) => (await import("viem")).encodeFunctionData({ abi: RAILGUN_SHIELD_ABI, functionName: "shield", args: [requests] });
  const tx = (data: `0x${string}`, nonce = 3) => ({ ...fee, nonce, chainId: 8453, to: RAILGUN_PROXY.base, data }) as const;
  const mint = async (amount = 5_000_000n, asset = "base:usdc") => allowedShield(e, "base", asset, amount, await railgunShieldKey(e));

  it("binds receiver, random, token and amount into a frozen railgun proof; random and IVs are fresh per shield", async () => {
    const a = await mint();
    const b = await mint();
    expect(isAllowed(a.proof)).toBe(true);
    expect(a.proof.kind).toBe("railgun");
    expect(a.proof.address).toBe(RAILGUN_PROXY.base.toLowerCase());
    expect(a.proof.asset).toBe("base:usdc");
    expect(a.proof.amount).toBe(5_000_000n);
    expect(a.proof.shield?.receiver0zk).toBe(RECEIVER);
    expect(Object.isFrozen(a.proof.shield)).toBe(true);
    expect(a.proof.shield?.random).toMatch(/^0x[0-9a-f]{32}$/);
    expect(a.proof.shield?.random).not.toBe(b.proof.shield?.random);
    expect(a.request.ciphertext.encryptedBundle[0]).not.toBe(b.request.ciphertext.encryptedBundle[0]);
    expect(a.request.preimage.npk).toBe(notePublicKey(RECEIVER, a.proof.shield!.random));
    expect(a.request.preimage.token.tokenAddress).toBe(BASE_USDC.toLowerCase());
    // Native assets shield the wrapper.
    expect((await mint(10n, "base:eth")).request.preimage.token.tokenAddress).toBe(WRAPPED_NATIVE.base.toLowerCase());
  });
  it("refuses a shield to another npk (another receiver, or another random)", async () => {
    const { proof, request } = await mint();
    const other = await buildShieldRequest({ receiver0zk: OTHER, token: BASE_USDC, value: 5_000_000n, shieldPrivateKey: await railgunShieldKey(e), random: new Uint8Array(16).fill(7) });
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...request.preimage, npk: other.preimage.npk } }])), [proof]), /npk/);
    await notAllowed(signEvmTx(e, tx(await shieldData([other])), [proof]), /npk/);
  });
  it("refuses another token, token type or sub id, and another value", async () => {
    const { proof, request } = await mint();
    const p = request.preimage;
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...p, token: { ...p.token, tokenAddress: WRAPPED_NATIVE.base } } }])), [proof]), /token/);
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...p, token: { ...p.token, tokenSubID: 1n as 0n } } }])), [proof]), /token/);
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...p, token: { ...p.token, tokenType: 1 as 0 } } }])), [proof]), /token/);
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...p, value: 5_000_001n } }])), [proof]), /value/);
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...p, value: 4_999_999n } }])), [proof]), /value/);
  });
  it("refuses two ShieldRequests, and none", async () => {
    const { proof, request } = await mint();
    const second = await mint();
    await notAllowed(signEvmTx(e, tx(await shieldData([request, request])), [proof]), /exactly one/);
    await notAllowed(signEvmTx(e, tx(await shieldData([request, second.request])), [proof, second.proof]), /exactly one/);
    await notAllowed(signEvmTx(e, tx(await shieldData([])), [proof]), /exactly one/);
  });
  it("refuses a ciphertext that is not the bound note's (shield key, bundle)", async () => {
    const { proof, request } = await mint();
    const c = request.ciphertext;
    const flip = (h: `0x${string}`) => `${h.slice(0, -2)}${h.endsWith("00") ? "01" : "00"}` as `0x${string}`;
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, ciphertext: { ...c, shieldKey: flip(c.shieldKey) } }])), [proof]), /does not match/);
    for (const i of [0, 1, 2] as const) {
      const bundle = [...c.encryptedBundle] as typeof c.encryptedBundle;
      bundle[i] = flip(bundle[i]);
      await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, ciphertext: { ...c, encryptedBundle: bundle } }])), [proof]), /does not match/);
    }
    // A request built with another shield key (and so another shared key) for the same note is refused too.
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, ciphertext: (await buildShieldRequest({ receiver0zk: RECEIVER, token: BASE_USDC, value: 5_000_000n, shieldPrivateKey: new Uint8Array(32).fill(9), random: hexToBytes(proof.shield!.random.slice(2)) })).ciphertext }])), [proof]), /does not match/);
  });
  it("an unbound railgun proof (the approve spender) never covers a shield", async () => {
    const { request } = await mint();
    await notAllowed(signEvmTx(e, tx(await shieldData([request])), await all("base")), /shield proof/);
  });
  it("is single-use: the same nonce (a fee bump) re-signs, another nonce is refused; a refused tx uses nothing", async () => {
    const { proof, request } = await mint();
    const data = await shieldData([request]);
    await notAllowed(signEvmTx(e, tx(await shieldData([{ ...request, preimage: { ...request.preimage, value: 1n } }]), 9), [proof]), /value/);
    await signEvmTx(e, tx(data, 4), [proof]);
    await signEvmTx(e, { ...tx(data, 4), maxFeePerGas: 3n }, [proof]);
    await notAllowed(signEvmTx(e, tx(data, 5), [proof]), USED);
  });
  it("a shield only ever goes to RAILGUN_0ZK_ADDRESS: the signer compares the note's receiver with env alone", async () => {
    // Neither the minter nor the signer takes a receiver from the caller (typecheck refuses a 4th signEvmTx argument).
    expect(allowedShield.length).toBe(5);
    expect(signEvmTx.length).toBe(3);
    e.RAILGUN_0ZK_ADDRESS = OTHER;
    const { proof, request } = await mint();
    expect(proof.shield?.receiver0zk).toBe(OTHER);
    const data = await shieldData([request]);
    e.RAILGUN_0ZK_ADDRESS = RECEIVER; // the var changed after the mint
    await notAllowed(signEvmTx(e, tx(data, 11), [proof]), /receiver/);
    e.RAILGUN_0ZK_ADDRESS = undefined;
    await notAllowed(signEvmTx(e, tx(data, 11), [proof]), /receiver/);
    e.RAILGUN_0ZK_ADDRESS = OTHER;
    await signEvmTx(e, tx(data, 11), [proof]);
    e.RAILGUN_0ZK_ADDRESS = RECEIVER;
  });
  it("refuses a detection-only asset", async () => {
    ASSETS["base:detonly"] = { id: "base:detonly", chain: "base", symbol: "DET", decimals: 6, contract: BASE_USDC, priceSymbol: "USDC", confirmations: 0, detectionOnly: true };
    try {
      await notAllowed(allowedShield(e, "base", "base:detonly", 5n, await railgunShieldKey(e)), /asset/);
    } finally {
      delete ASSETS["base:detonly"];
    }
  });
  it("a proof minted with another caller-supplied shield key is refused by the signer (it recomputes with its own)", async () => {
    const { proof, request } = await allowedShield(e, "base", "base:usdc", 5n, new Uint8Array(32).fill(3));
    await notAllowed(signEvmTx(e, tx(await shieldData([request])), [proof]), /does not match/);
  });
  it("minting refuses a bad or other-chain RAILGUN_0ZK_ADDRESS, an asset of another chain and a bad amount", async () => {
    const key = await railgunShieldKey(e);
    e.RAILGUN_0ZK_ADDRESS = golden.addresses[1]!.address; // Arbitrum only
    await notAllowed(allowedShield(e, "base", "base:usdc", 5n, key), /RAILGUN_0ZK_ADDRESS/);
    await allowedShield(e, "arb", "arb:usdc", 5n, key);
    e.RAILGUN_0ZK_ADDRESS = "0zk1nope";
    await notAllowed(allowedShield(e, "base", "base:usdc", 5n, key), /RAILGUN_0ZK_ADDRESS/);
    e.RAILGUN_0ZK_ADDRESS = undefined;
    await notAllowed(allowedShield(e, "base", "base:usdc", 5n, key), /RAILGUN_0ZK_ADDRESS/);
    e.RAILGUN_0ZK_ADDRESS = RECEIVER;
    await notAllowed(allowedShield(e, "base", "arb:usdc", 5n, key), /asset/);
    await notAllowed(allowedShield(e, "base", "base:nope", 5n, key), /asset/);
    await notAllowed(allowedShield(e, "base", "base:usdc", 0n, key), /amount/);
    await notAllowed(allowedShield(e, "base", "base:usdc", 1n << 120n, key), /amount/);
  });
});

// ---- Tron ----

const H = (a: string) => tronBase58ToHex(a);
const EXP = T0 + 60_000;
const trig = (o: { owner?: string; contract?: string; to?: string } = {}) =>
  bytesToHex(
    rawBytes({
      contracts: [contract("TriggerSmartContract", triggerParam({ owner: H(o.owner ?? TRON_DEP.address), contract: H(o.contract ?? USDT), data: transferData(H(o.to ?? TRON_HOT.address), 7n) }))],
      expiration: EXP, timestamp: T0, feeLimit: 5_000_000n,
    }),
  );
const xfer = (to: string) =>
  bytesToHex(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(TRON_HOT.address), to: H(to), amount: 500_000n }))], expiration: EXP, timestamp: T0 }));

describe("signTronTx", () => {
  it("signs a USDT transfer to hot with the hot proof: signature over our own sha256(raw), recovering the owner", async () => {
    const raw = trig();
    const { txID, signature } = signTronTx(e.MASTER_SEED!, DEP4, raw, [await allowedDestination(e, "tron", TRON_HOT.address, {})]);
    const { sha256 } = await import("@noble/hashes/sha2.js");
    expect(txID).toBe(bytesToHex(sha256(hexToBytes(raw))));
    const sig = hexToBytes(signature);
    const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(hexToBytes(txID)).toBytes(false);
    expect(tronAddressFromPubkey(pub)).toBe(TRON_DEP.address);
  });
  it("rejects a TriggerSmartContract to a non-USDT contract, and a USDT transfer to a random recipient", async () => {
    const hot = await allowedDestination(e, "tron", TRON_HOT.address, {});
    expect(() => signTronTx(e.MASTER_SEED!, DEP4, trig({ contract: TRON_RANDOM }), [hot])).toThrow(DestinationNotAllowed);
    expect(() => signTronTx(e.MASTER_SEED!, DEP4, trig({ to: TRON_RANDOM }), [hot])).toThrow(DestinationNotAllowed);
  });
  it("a TRX top-up signs only with the deposit's energy proof; to a random address it throws", async () => {
    const hot = await allowedDestination(e, "tron", TRON_HOT.address, {});
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, xfer(TRON_DEP.address), [hot])).toThrow(DestinationNotAllowed);
    signTronTx(e.MASTER_SEED!, HOT_SPEC, xfer(TRON_DEP.address), [await allowedDestination(e, "tron", TRON_DEP.address, { depositIndex: 4 })]);
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, xfer(TRON_RANDOM), [hot])).toThrow(DestinationNotAllowed);
  });
  it("an energy proof covers only a TRX top-up of exactly TOPUP_SUN from hot: not USDT, not another amount", async () => {
    const energy = await allowedDestination(e, "tron", TRON_DEP.address, { depositIndex: 4 });
    const hotXfer = (amount: bigint) => bytesToHex(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(TRON_HOT.address), to: H(TRON_DEP.address), amount }))], expiration: EXP, timestamp: T0 }));
    signTronTx(e.MASTER_SEED!, HOT_SPEC, hotXfer(TOPUP_SUN), [energy]);
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, hotXfer(TOPUP_SUN + 1n), [energy])).toThrow(NOT_EXACT);
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, trig({ owner: TRON_HOT.address, to: TRON_DEP.address }), [energy])).toThrow(NOT_COVERED);
    // From another deposit (not the hot wallet) it is no top-up either.
    const other = tronDepositKey(e.MASTER_SEED!, 7);
    const fromDep = bytesToHex(rawBytes({ contracts: [contract("TransferContract", transferParam({ owner: H(other.address), to: H(TRON_DEP.address), amount: TOPUP_SUN }))], expiration: EXP, timestamp: T0 }));
    expect(() => signTronTx(e.MASTER_SEED!, { role: "deposit", index: 7 }, fromDep, [energy])).toThrow(NOT_EXACT);
  });
  it("rejects forged and other-chain proofs, and a key that does not own the tx", async () => {
    expect(() => signTronTx(e.MASTER_SEED!, DEP4, trig(), [{ kind: "hot", chain: "tron", address: TRON_HOT.address } as unknown as Allowed])).toThrow(DestinationNotAllowed);
    const hot = await allowedDestination(e, "tron", TRON_HOT.address, {});
    expect(() => signTronTx(e.MASTER_SEED!, HOT_SPEC, trig(), [hot])).toThrow(/owner/);
  });
});

// ---- Solana ----

const sdep = (i: number) => solDepositKey(e.MASTER_SEED!, i);
const dspec = (index: number) => ({ role: "deposit", index }) as const;
const LIFE = { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000n };
const PLAN = sweepPlan(
  SOL_HOT.address,
  [
    { address: sdep(1).address, lamports: 1_000n, tokens: [] },
    { address: sdep(2).address, lamports: 0n, tokens: [{ account: findAta(sdep(2).address, USDC_MINT)[0], amount: 25n }] },
  ],
  LIFE,
);

describe("signSolanaTx", () => {
  it("signs a sweep (SOL transfer, ATA create, transferChecked to hot's ATA, closeAccount to hot) with the hot proof", async () => {
    const c = await compileSolSweep(PLAN);
    const { signature, wire } = await signSolanaTx(e.MASTER_SEED!, c, [HOT_SPEC, dspec(1), dspec(2)], [await allowedDestination(e, "sol", SOL_HOT.address, {})]);
    const k = await import("@solana/kit");
    const tx = k.getTransactionDecoder().decode(Uint8Array.from(atob(wire), (ch) => ch.charCodeAt(0))) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array> };
    for (const [addr, sig] of Object.entries(tx.signatures)) expect(ed25519.verify(sig, tx.messageBytes, base58.decode(addr))).toBe(true);
    expect(signature).toBe(base58.encode(tx.signatures[SOL_HOT.address]!));
  });
  it("rejects no proof, a forged proof and another chain's proof", async () => {
    const c = await compileSolSweep(PLAN);
    const keys = [HOT_SPEC, dspec(1), dspec(2)];
    await notAllowed(signSolanaTx(e.MASTER_SEED!, c, keys, []));
    await notAllowed(signSolanaTx(e.MASTER_SEED!, c, keys, [{ kind: "hot", chain: "sol", address: SOL_HOT.address } as unknown as Allowed]));
    await notAllowed(signSolanaTx(e.MASTER_SEED!, c, keys, [await allowedDestination(e, "tron", TRON_HOT.address, {})]));
  });
  it("rejects a SOL transfer to a non-hot account", async () => {
    const [k, system] = await Promise.all([import("@solana/kit"), import("@solana-program/system")]);
    const plan = sweepPlan(SOL_HOT.address, [{ address: sdep(1).address, lamports: 1_000n, tokens: [] }], LIFE);
    const ixs = await solSweepInstructions(plan);
    ixs[ixs.length - 1] = system.getTransferSolInstruction({ source: k.createNoopSigner(k.address(sdep(1).address)), destination: k.address(SOL_RANDOM), amount: 1_000n });
    const c = await compileSolSweep(plan, ixs);
    await notAllowed(signSolanaTx(e.MASTER_SEED!, c, [HOT_SPEC, dspec(1)], [await allowedDestination(e, "sol", SOL_HOT.address, {})]));
  });
  it("rejects a closeAccount whose destination is not hot, and a transferChecked to another owner's ATA", async () => {
    const [k, token] = await Promise.all([import("@solana/kit"), import("@solana-program/token")]);
    const d = sdep(2);
    const acct = findAta(d.address, USDC_MINT)[0];
    const plan = sweepPlan(SOL_HOT.address, [{ address: d.address, lamports: 0n, tokens: [{ account: acct, amount: 25n }] }], LIFE);
    const hot = await allowedDestination(e, "sol", SOL_HOT.address, {});
    const owner = k.createNoopSigner(k.address(d.address));
    const close = await solSweepInstructions(plan);
    close[close.length - 1] = token.getCloseAccountInstruction({ account: k.address(acct), destination: k.address(SOL_RANDOM), owner });
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await compileSolSweep(plan, close), [HOT_SPEC, dspec(2)], [hot]));
    const xfer = await solSweepInstructions(plan);
    xfer[xfer.length - 2] = token.getTransferCheckedInstruction({ source: k.address(acct), mint: k.address(USDC_MINT), destination: k.address(findAta(SOL_RANDOM, USDC_MINT)[0]), authority: owner, amount: 25n, decimals: 6 });
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await compileSolSweep(plan, xfer), [HOT_SPEC, dspec(2)], [hot]));
  });
  it("rejects CreateAccount, Assign and Allocate (System instructions other than transfer)", async () => {
    const [k, system] = await Promise.all([import("@solana/kit"), import("@solana-program/system")]);
    const plan = sweepPlan(SOL_HOT.address, [{ address: sdep(1).address, lamports: 1_000n, tokens: [] }], LIFE);
    const hot = await allowedDestination(e, "sol", SOL_HOT.address, {});
    const dep = k.createNoopSigner(k.address(sdep(1).address));
    const fresh = k.createNoopSigner(k.address(sdep(3).address));
    for (const bad of [
      system.getCreateAccountInstruction({ payer: dep, newAccount: fresh, lamports: 1_000n, space: 0, programAddress: k.address(SOL_HOT.address) }),
      system.getAssignInstruction({ account: dep, programAddress: k.address(SOL_RANDOM) }),
      system.getAllocateInstruction({ newAccount: dep, space: 10 }),
    ]) {
      const ixs = await solSweepInstructions(plan);
      ixs[ixs.length - 1] = bad;
      const c = await compileSolSweep(plan, ixs);
      const signers = Object.keys((c.tx as { signatures: Record<string, unknown> }).signatures);
      const specs = signers.map((a) => (a === SOL_HOT.address ? HOT_SPEC : dspec(a === sdep(1).address ? 1 : 3)));
      await notAllowed(signSolanaTx(e.MASTER_SEED!, c, specs, [hot]));
    }
  });
  it("rejects an ATA creation for an owner no proof covers", async () => {
    const [k, token] = await Promise.all([import("@solana/kit"), import("@solana-program/token")]);
    const d = sdep(2);
    const plan = sweepPlan(SOL_HOT.address, [{ address: d.address, lamports: 0n, tokens: [{ account: findAta(d.address, USDC_MINT)[0], amount: 25n }] }], LIFE);
    const ixs = await solSweepInstructions(plan);
    ixs[2] = token.getCreateAssociatedTokenIdempotentInstruction({
      payer: k.createNoopSigner(k.address(SOL_HOT.address)), ata: k.address(findAta(SOL_RANDOM, USDC_MINT)[0]), owner: k.address(SOL_RANDOM), mint: k.address(USDC_MINT),
    });
    await notAllowed(signSolanaTx(e.MASTER_SEED!, await compileSolSweep(plan, ixs), [HOT_SPEC, dspec(2)], [await allowedDestination(e, "sol", SOL_HOT.address, {})]));
  });
  it("rejects a message with address lookup tables", async () => {
    const k = await import("@solana/kit");
    const c = await compileSolSweep(PLAN);
    const m = k.getCompiledTransactionMessageDecoder().decode(c.messageBytes) as unknown as Record<string, unknown>;
    const withLut = new Uint8Array(
      k.getCompiledTransactionMessageEncoder().encode({ ...m, addressTableLookups: [{ lookupTableAddress: k.address(SOL_RANDOM), writableIndexes: [0], readonlyIndexes: [] }] } as never),
    );
    const lut = { ...c, messageBytes: withLut, tx: { ...(c.tx as object), messageBytes: withLut } };
    await notAllowed(signSolanaTx(e.MASTER_SEED!, lut, [HOT_SPEC, dspec(1), dspec(2)], [await allowedDestination(e, "sol", SOL_HOT.address, {})]));
  });
});
