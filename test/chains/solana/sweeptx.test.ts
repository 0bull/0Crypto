import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { solDepositKey, solHotKey } from "../../../src/signing/keys";
import { findAta } from "../../../src/chains/solana/pda";
import {
  assertSolSweepMessage, checkRules, compileSolSweep, CU_PRICE_MICROLAMPORTS, MAX_PRIORITY_FEE_LAMPORTS, MAX_TX_BYTES, SolTxMismatch, solSweepInstructions,
  sweepFee, sweepPlan, type SolSweepDeposit, type SolSweepPlan,
} from "../../../src/chains/solana/sweeptx";
import { allowedDestination } from "../../../src/routing/guard";
import { signSolanaTx } from "../../../src/signing/solana";

// The signer (src/signing/solana.ts) needs the guard's hot proof: every destination of a sweep is hot or its ATA.
const signSolSweep = async (c: Parameters<typeof signSolanaTx>[1], keys: { address: string }[]) =>
  signSolanaTx(
    SEED,
    c,
    keys.map((k) => (k.address === solHotKey(SEED).address ? ({ role: "hot" } as const) : ({ role: "deposit", index: [1, 2, 3, 4].find((i) => solDepositKey(SEED, i).address === k.address)! } as const))),
    [await allowedDestination({ MASTER_SEED: SEED }, "sol", solHotKey(SEED).address)],
  );

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CB = "ComputeBudget111111111111111111111111111111";
const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const hot = solHotKey(SEED);
const dep = (i: number) => solDepositKey(SEED, i);
const HOT_ATA = findAta(hot.address, USDC)[0];
const ATTACKER = dep(900).address;
const ATTACKER_ATA = findAta(ATTACKER, USDC)[0];
const extra = dep(901).address; // a second, non-ATA token account of deposit 3
const LIFE = { blockhash: BH, lastValidBlockHeight: 1000n };

const D1: SolSweepDeposit = { address: dep(1).address, lamports: 1_500_000_000n, tokens: [] };
const D2: SolSweepDeposit = { address: dep(2).address, lamports: 0n, tokens: [{ account: findAta(dep(2).address, USDC)[0], amount: 25_000_000n }] };
const D3: SolSweepDeposit = { address: dep(3).address, lamports: 7_000n, tokens: [{ account: findAta(dep(3).address, USDC)[0], amount: 5n }, { account: extra, amount: 0n }] };
const PLAN = sweepPlan(hot.address, [D1, D2, D3], LIFE);

const kit = () => import("@solana/kit");
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return Array.from(b);
};
async function decode(bytes: Uint8Array) {
  const k = await kit();
  const m = k.getCompiledTransactionMessageDecoder().decode(bytes) as unknown as {
    version: number | string;
    header: { numSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  };
  const ixs = m.instructions.map((ix) => ({ program: m.staticAccounts[ix.programAddressIndex]!, accounts: (ix.accountIndices ?? []).map((i) => m.staticAccounts[i]!), data: Array.from(ix.data ?? []) }));
  return { m, ixs, signers: m.staticAccounts.slice(0, m.header.numSignerAccounts) };
}

describe("buildSolSweepTx: instructions", () => {
  it("USDC: ComputeBudget, then createAssociatedTokenIdempotent (hot ATA, payer hot), transferChecked (exact, 6 decimals) and closeAccount (destination hot); fee payer hot", async () => {
    const plan = sweepPlan(hot.address, [D2], LIFE);
    const c = await compileSolSweep(plan);
    const { m, ixs, signers } = await decode(c.messageBytes);
    expect(m.staticAccounts[0]).toBe(hot.address);
    expect(signers.sort()).toEqual([hot.address, D2.address].sort());
    expect(ixs.map((i) => i.program)).toEqual([CB, CB, ATA_PROGRAM, TOKEN, TOKEN]);
    expect(ixs[2]).toEqual({ program: ATA_PROGRAM, accounts: [hot.address, HOT_ATA, hot.address, USDC, SYSTEM, TOKEN], data: [1] });
    expect(ixs[3]).toEqual({ program: TOKEN, accounts: [D2.tokens[0]!.account, USDC, HOT_ATA, D2.address], data: [12, ...u64(25_000_000n), 6] });
    expect(ixs[4]).toEqual({ program: TOKEN, accounts: [D2.tokens[0]!.account, hot.address, D2.address], data: [9] });
    await assertSolSweepMessage(c.messageBytes, plan);
  });

  it("SOL: a single transfer of exactly the deposit's balance to hot, hot paying the fee", async () => {
    const plan = sweepPlan(hot.address, [D1], LIFE);
    const c = await compileSolSweep(plan);
    const { m, ixs } = await decode(c.messageBytes);
    expect(m.staticAccounts[0]).toBe(hot.address);
    expect(ixs.map((i) => i.program)).toEqual([CB, CB, SYSTEM]);
    expect(ixs[2]).toEqual({ program: SYSTEM, accounts: [D1.address, hot.address], data: [2, 0, 0, 0, ...u64(1_500_000_000n)] });
  });

  it("several USDC accounts on one deposit are each transferred and closed, then its SOL goes; one ATA creation for the batch", async () => {
    const c = await compileSolSweep(PLAN);
    const { ixs, signers } = await decode(c.messageBytes);
    expect(ixs.filter((i) => i.program === ATA_PROGRAM)).toHaveLength(1);
    const d3 = ixs.filter((i) => i.accounts.at(-1) === D3.address || i.accounts[0] === D3.address);
    expect(d3.map((i) => i.data[0])).toEqual([12, 9, 12, 9, 2]);
    expect(d3[2]!.accounts[0]).toBe(extra);
    expect(signers.sort()).toEqual([hot.address, D1.address, D2.address, D3.address].sort());
    expect(c.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    await assertSolSweepMessage(c.messageBytes, PLAN);
  });

  it("compute budget: a limit with margin and a price capped so the priority fee stays under MAX_PRIORITY_FEE_LAMPORTS", async () => {
    const { ixs } = await decode((await compileSolSweep(PLAN)).messageBytes);
    const limit = new DataView(Uint8Array.from(ixs[0]!.data).buffer).getUint32(1, true);
    const price = new DataView(Uint8Array.from(ixs[1]!.data).buffer).getBigUint64(1, true);
    expect([ixs[0]!.data[0], ixs[1]!.data[0]]).toEqual([2, 3]);
    expect(limit).toBe(PLAN.cuLimit);
    expect(price).toBe(PLAN.cuPrice);
    expect(price).toBeLessThanOrEqual(CU_PRICE_MICROLAMPORTS);
    expect(BigInt(limit) * price).toBeLessThanOrEqual(MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n);
    // 4 signatures at 5000 lamports, plus the priority fee rounded up.
    expect(sweepFee(PLAN)).toBe(20_000n + (BigInt(limit) * price + 999_999n) / 1_000_000n);
  });
});

type Ix = { programAddress: string; accounts?: { address: string; role: number }[]; data?: Uint8Array };
const at = (ixs: Ix[], program: string, disc: number, nth = 0) => ixs.filter((i) => i.programAddress === program && i.data?.[0] === disc)[nth]!;
const withData = (ix: Ix, f: (d: Uint8Array) => void): Ix => {
  const d = Uint8Array.from(ix.data!);
  f(d);
  return { ...ix, data: d };
};
const setAccount = (ix: Ix, i: number, address: string): Ix => ({ ...ix, accounts: ix.accounts!.map((a, j) => (j === i ? { ...a, address } : a)) });
const setRole = (ix: Ix, i: number, role: number): Ix => ({ ...ix, accounts: ix.accounts!.map((a, j) => (j === i ? { ...a, role } : a)) });
const replace = (ixs: Ix[], from: Ix, to: Ix) => ixs.map((i) => (i === from ? to : i));

describe("assertSolSweepMessage: every mutation is caught before signing, for its own reason", () => {
  // One case per distinct check. AccountRole: 0 readonly, 1 writable, 2 readonly signer, 3 writable signer.
  const mutations: [string, RegExp, (ixs: Ix[]) => Ix[]][] = [
    ["transferChecked destination is not hot's ATA", /transferChecked destination is not hot's ATA/, (x) => replace(x, at(x, TOKEN, 12), setAccount(at(x, TOKEN, 12), 2, ATTACKER_ATA))],
    ["transferChecked decimals 9", /transferChecked decimals are not 6/, (x) => replace(x, at(x, TOKEN, 12), withData(at(x, TOKEN, 12), (d) => (d[9] = 9)))],
    ["transferChecked of another mint", /transferChecked of another mint/, (x) => replace(x, at(x, TOKEN, 12), setAccount(at(x, TOKEN, 12), 1, WSOL))],
    ["transferChecked under Token-2022", /program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb is not allowed/, (x) => replace(x, at(x, TOKEN, 12), { ...at(x, TOKEN, 12), programAddress: TOKEN_2022 })],
    ["closeAccount destination is not hot", /closeAccount destination is not hot/, (x) => replace(x, at(x, TOKEN, 9), setAccount(at(x, TOKEN, 9), 1, ATTACKER))],
    ["SOL transfer destination is not hot", /SOL transfer destination is not hot/, (x) => replace(x, at(x, SYSTEM, 2), setAccount(at(x, SYSTEM, 2), 1, ATTACKER))],
    ["ATA creation paid by a deposit", /associated token instruction is not hot's idempotent USDC ATA paid by hot/, (x) => replace(x, at(x, ATA_PROGRAM, 1), setRole(setAccount(at(x, ATA_PROGRAM, 1), 0, D1.address), 0, 3))],
    ["transferChecked amount off by one (exact amounts)", /instruction 4 is not the intended one/, (x) => replace(x, at(x, TOKEN, 12), withData(at(x, TOKEN, 12), (d) => new DataView(d.buffer).setBigUint64(1, 25_000_001n, true)))],
    ["an extra instruction that passes every rule (a second close to hot)", /12 instructions, 11 intended/, (x) => [...x, at(x, TOKEN, 9)]],
    ["priority fee above the cap", /priority fee above the cap/, (x) => replace(x, at(x, CB, 3), withData(at(x, CB, 3), (d) => new DataView(d.buffer).setBigUint64(1, 10n ** 12n, true)))],
    ["an extra signer (the mint marked as signer)", /signer set is not hot plus the deposits/, (x) => replace(x, at(x, TOKEN, 12), setRole(at(x, TOKEN, 12), 1, 2))],
    ["the mint marked writable (same signers)", /account roles differ/, (x) => replace(x, at(x, TOKEN, 12), setRole(at(x, TOKEN, 12), 1, 1))],
    ["a SOL-less deposit made a writable signer", /account roles differ/, (x) => replace(x, at(x, TOKEN, 9), setRole(at(x, TOKEN, 9), 2, 3))],
  ];
  it.each(mutations)("%s", async (_, reason, mutate) => {
    const ixs = (await solSweepInstructions(PLAN)) as Ix[];
    const bad = await compileSolSweep(PLAN, mutate(ixs));
    await expect(assertSolSweepMessage(bad.messageBytes, PLAN)).rejects.toThrow(reason);
    await expect(assertSolSweepMessage(bad.messageBytes, PLAN)).rejects.toBeInstanceOf(SolTxMismatch);
  });

  async function message(feePayer: string, blockhash: string, version: 0 | "legacy" = 0) {
    const k = await kit();
    const m0 = k.pipe(
      k.createTransactionMessage({ version: version as 0 }),
      (m) => k.setTransactionMessageFeePayer(feePayer as never, m),
      (m) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as never, lastValidBlockHeight: 1000n }, m),
    );
    const m = k.appendTransactionMessageInstructions((await solSweepInstructions(PLAN)) as never, m0);
    return (k.compileTransaction(m as never) as unknown as { messageBytes: Uint8Array }).messageBytes;
  }
  it("the fee payer is a deposit", async () => {
    await expect(assertSolSweepMessage(await message(D1.address, BH), PLAN)).rejects.toThrow(/fee payer is not the hot wallet/);
  });
  it("another blockhash", async () => {
    await expect(assertSolSweepMessage(await message(hot.address, "11111111111111111111111111111111"), PLAN)).rejects.toThrow(/blockhash differs/);
  });
  it("a legacy message", async () => {
    await expect(assertSolSweepMessage(await message(hot.address, BH, "legacy"), PLAN)).rejects.toThrow(/message version legacy, not 0/);
  });
  it("the unmutated message passes (control)", async () => {
    await assertSolSweepMessage(await message(hot.address, BH), PLAN);
  });

  const badPlans: [string, RegExp, (p: SolSweepPlan) => SolSweepPlan][] = [
    ["a token source that is hot's ATA", /is the hot wallet, its ATA or a program/, (p) => ({ ...p, deposits: [D1, { ...D2, tokens: [{ account: HOT_ATA, amount: 1n }] }] })],
    ["a token source that is another deposit", /is a deposit/, (p) => ({ ...p, deposits: [D1, { ...D2, tokens: [{ account: D1.address, amount: 1n }] }] })],
    ["the same token account twice", /appears twice/, (p) => ({ ...p, deposits: [D2, { ...D3, tokens: [D2.tokens[0]!] }] })],
    ["a deposit that is the hot wallet", /is not a plain account/, (p) => ({ ...p, deposits: [{ ...D1, address: hot.address }] })],
    ["a deposit with nothing to move", /has nothing to move/, (p) => ({ ...p, deposits: [D1, { address: dep(4).address, lamports: 0n, tokens: [] }] })],
    ["a compute budget other than the computed one", /compute budget is not the computed one/, (p) => ({ ...p, cuPrice: p.cuPrice + 1n })],
  ];
  it.each(badPlans)("plan sanity: %s", async (_, reason, f) => {
    const plan = f(PLAN);
    const c = await compileSolSweep(plan);
    await expect(assertSolSweepMessage(c.messageBytes, plan)).rejects.toThrow(reason);
  });
});

describe("checkRules: per-instruction rules, whatever the plan says", () => {
  const ok = (program: string, accounts: string[], data: number[]) => ({ program, accounts, data: Uint8Array.from(data) });
  const tc = (dest: string, mint = USDC, decimals = 6) => ok(TOKEN, [extra, mint, dest, D3.address], [12, ...u64(5n), decimals]);
  const valid = [
    ok(CB, [], [2, 0, 1, 0, 0]),
    ok(CB, [], [3, ...u64(10n)]),
    ok(ATA_PROGRAM, [hot.address, HOT_ATA, hot.address, USDC, SYSTEM, TOKEN], [1]),
    tc(HOT_ATA),
    ok(TOKEN, [extra, hot.address, D3.address], [9]),
    ok(SYSTEM, [D1.address, hot.address], [2, 0, 0, 0, ...u64(7n)]),
  ];
  it.each(valid.map((v) => [v.program, v.data[0], v] as const))("accepts %s %i", (_, __, ix) => {
    expect(() => checkRules(ix, hot.address, HOT_ATA)).not.toThrow();
  });
  const bad: [string, RegExp, ReturnType<typeof ok>][] = [
    ["ComputeBudget with accounts", /ComputeBudget instruction with accounts/, ok(CB, [hot.address], [2, 0, 1, 0, 0])],
    ["ComputeBudget heap frame request", /ComputeBudget instruction other than the unit limit and price/, ok(CB, [], [1, 0, 0, 1, 0])],
    ["non-idempotent ATA create", /associated token instruction/, ok(ATA_PROGRAM, [hot.address, HOT_ATA, hot.address, USDC, SYSTEM, TOKEN], [0])],
    ["ATA for someone else", /associated token instruction/, ok(ATA_PROGRAM, [hot.address, ATTACKER_ATA, ATTACKER, USDC, SYSTEM, TOKEN], [1])],
    ["transferChecked to an attacker", /transferChecked destination is not hot's ATA/, tc(ATTACKER_ATA)],
    ["transferChecked of wSOL", /transferChecked of another mint/, tc(HOT_ATA, WSOL)],
    ["transferChecked with 9 decimals", /transferChecked decimals are not 6/, tc(HOT_ATA, USDC, 9)],
    ["closeAccount to an attacker", /closeAccount destination is not hot/, ok(TOKEN, [extra, ATTACKER, D3.address], [9])],
    ["token approve", /token instruction other than transferChecked and closeAccount/, ok(TOKEN, [extra, ATTACKER, D3.address], [4, ...u64(1n)])],
    ["SOL transfer to an attacker", /SOL transfer destination is not hot/, ok(SYSTEM, [D1.address, ATTACKER], [2, 0, 0, 0, ...u64(7n)])],
    ["SOL transfer from hot", /SOL transfer from hot/, ok(SYSTEM, [hot.address, hot.address], [2, 0, 0, 0, ...u64(7n)])],
    ["system assign", /system instruction other than a transfer/, ok(SYSTEM, [D1.address], [1, 0, 0, 0, ...new Array(32).fill(0)])],
    ["memo program", /program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr is not allowed/, ok("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", [], [104, 105])],
  ];
  it.each(bad)("rejects %s", (_, reason, ix) => {
    expect(() => checkRules(ix, hot.address, HOT_ATA)).toThrow(reason);
  });
});

describe("priority fee boost", () => {
  it("each boost step doubles the price, never above the priority fee cap", () => {
    const base = sweepPlan(hot.address, [D1], LIFE);
    expect(sweepPlan(hot.address, [D1], LIFE, 1).cuPrice).toBe(base.cuPrice * 2n);
    const max = sweepPlan(hot.address, [D1], LIFE, 30);
    expect(BigInt(max.cuLimit) * max.cuPrice).toBeLessThanOrEqual(MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n);
    expect(max.cuPrice).toBeGreaterThan(base.cuPrice * 4n);
  });
  it("a boosted plan passes the self-check", async () => {
    const plan = sweepPlan(hot.address, [D1, D2], LIFE, 2);
    await assertSolSweepMessage((await compileSolSweep(plan)).messageBytes, plan);
  });
});

describe("signSolSweep", () => {
  it("signs with noble for hot and every deposit; each signature verifies; the id is the fee payer's signature in base58", async () => {
    const c = await compileSolSweep(PLAN);
    const { signature, wire } = await signSolSweep(c, [hot, dep(1), dep(2), dep(3)]);
    const k = await kit();
    const tx = k.getTransactionDecoder().decode(Uint8Array.from(atob(wire), (ch) => ch.charCodeAt(0))) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array> };
    expect(Array.from(tx.messageBytes)).toEqual(Array.from(c.messageBytes));
    expect(Object.keys(tx.signatures).sort()).toEqual([hot.address, D1.address, D2.address, D3.address].sort());
    for (const [addr, sig] of Object.entries(tx.signatures)) expect(ed25519.verify(sig, tx.messageBytes, base58.decode(addr))).toBe(true);
    expect(signature).toBe(base58.encode(tx.signatures[hot.address]!));
  });
  it("refuses a key set that is not exactly the message's signers", async () => {
    const c = await compileSolSweep(PLAN);
    await expect(signSolSweep(c, [hot, dep(1), dep(2)])).rejects.toThrow(/signer/);
    await expect(signSolSweep(c, [hot, dep(1), dep(2), dep(3), dep(4)])).rejects.toThrow(/signer/);
  });
  it("never puts key material in an error", async () => {
    const c = await compileSolSweep(PLAN);
    const err = await signSolSweep(c, [hot]).catch((x: Error) => x);
    const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
    for (const key of [hot, dep(1)]) expect(text).not.toContain(base58.encode(key.priv));
  });
});

describe("sizes", () => {
  it("8 small SOL deposits fit one tx; 8 USDC deposits with 2 accounts each do not", async () => {
    const sol = Array.from({ length: 8 }, (_, i) => ({ address: dep(10 + i).address, lamports: 1_000_000n, tokens: [] }));
    expect((await compileSolSweep(sweepPlan(hot.address, sol, LIFE))).size).toBeLessThanOrEqual(MAX_TX_BYTES);
    const usdc = Array.from({ length: 8 }, (_, i) => ({
      address: dep(30 + i).address, lamports: 0n,
      tokens: [{ account: findAta(dep(30 + i).address, USDC)[0], amount: 1n }, { account: dep(60 + i).address, amount: 2n }],
    }));
    expect((await compileSolSweep(sweepPlan(hot.address, usdc, LIFE))).size).toBeGreaterThan(MAX_TX_BYTES);
  });
});
