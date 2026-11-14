import { base58 } from "@scure/base";
import { ASSOCIATED_TOKEN_PROGRAM, findAta, TOKEN_PROGRAM } from "./pda";

/*
 * The Solana sweep transaction: build (Kit) and check (decoded, before any signature). src/signing/solana.ts signs (noble).
 *
 * Kit and @solana-program/* are loaded with dynamic import() only (test/node/startup-imports.test.ts). Kit's key and
 * signer functions are never called: they assert a secure context, which workerd lacks. Kit builds instructions,
 * compiles and encodes; @noble/curves signs and verifies; nothing patches globals.
 *
 * One tx sweeps up to MAX_DEPOSITS_PER_TX deposits, hot wallet as fee payer. Its instructions, in order:
 *   SetComputeUnitLimit, SetComputeUnitPrice
 *   createAssociatedTokenIdempotent(hot's USDC ATA, payer hot)        only if any USDC moves
 *   per deposit, per live USDC token account (largest first):
 *     transferChecked(account -> hot's ATA, its exact balance, 6 decimals, authority the deposit)
 *     closeAccount(account, destination hot)                           the account's rent goes to hot, not the deposit
 *   per deposit with SOL: transfer(deposit -> hot, its entire balance) hot pays the fees, so the deposit can reach 0
 */

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** Solana's packet limit for a serialized transaction (signatures included). */
export const MAX_TX_BYTES = 1232;
/** Deposits (each one more signature) per tx, whatever the size. */
export const MAX_DEPOSITS_PER_TX = 8;
export const LAMPORTS_PER_SIGNATURE = 5000n;
/**
 * Priority fee: 10,000 micro-lamports (0.01 lamport) per compute unit, a modest price that lands outside congestion
 * spikes. A drop costs nothing (the blockhash expires, the sweep is retried), so there is no need to bid high.
 */
export const CU_PRICE_MICROLAMPORTS = 10_000n;
/** Most a sweep tx pays in priority fees (lamports): the price is lowered so limit x price stays under it, boosted or not. */
export const MAX_PRIORITY_FEE_LAMPORTS = 20_000n;
/** Compute units per instruction: conservative estimates of typical usage (not measured here); the limit adds CU_MARGIN_PERCENT. */
export const CU_COST = { budget: 150, ataCreate: 30_000, transferChecked: 6_500, closeAccount: 3_000, solTransfer: 450 } as const;
export const CU_MARGIN_PERCENT = 20;
const MAX_CU = 1_400_000;
const U64_MAX = (1n << 64n) - 1n;
/** A lifetime for sizing only (the size does not depend on the blockhash's value). Never signed or sent. */
export const SIZING_LIFETIME = { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: 0n };

export interface SolSweepToken {
  account: string;
  amount: bigint;
}
export interface SolSweepDeposit {
  address: string;
  /** Lamports moved to hot: the deposit's entire balance (0: no SOL transfer). */
  lamports: bigint;
  /** Live USDC token accounts owned by the deposit, each emptied and closed. */
  tokens: SolSweepToken[];
}
export interface SolSweepPlan {
  hot: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  deposits: SolSweepDeposit[];
  /** Priority fee doublings (the sweeper raises it after repeated drops); the cap still applies. */
  boost: number;
  cuLimit: number;
  cuPrice: bigint;
}
const MAX_BOOST = 32;

/** Compute unit limit (estimate + margin) and price (the constant x 2^boost, lowered under the priority fee cap). */
export function computeBudget(deposits: SolSweepDeposit[], boost = 0): { cuLimit: number; cuPrice: bigint } {
  let cu = 2 * CU_COST.budget;
  if (deposits.some((d) => d.tokens.length > 0)) cu += CU_COST.ataCreate;
  for (const d of deposits) {
    cu += d.tokens.length * (CU_COST.transferChecked + CU_COST.closeAccount);
    if (d.lamports > 0n) cu += CU_COST.solTransfer;
  }
  const cuLimit = Math.min(MAX_CU, Math.ceil((cu * (100 + CU_MARGIN_PERCENT)) / 100));
  const cap = (MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) / BigInt(cuLimit);
  const want = CU_PRICE_MICROLAMPORTS << BigInt(Math.min(Math.max(0, Math.trunc(boost)), MAX_BOOST));
  return { cuLimit, cuPrice: want < cap ? want : cap };
}

export function sweepPlan(hot: string, deposits: SolSweepDeposit[], life: { blockhash: string; lastValidBlockHeight: bigint }, boost = 0): SolSweepPlan {
  return { hot, blockhash: life.blockhash, lastValidBlockHeight: life.lastValidBlockHeight, deposits, boost, ...computeBudget(deposits, boost) };
}

/**
 * The deposit each instruction of a sweep tx belongs to (null for ComputeBudget and the ATA creation), in the order
 * solSweepInstructions builds them: maps an InstructionError index back to the deposit that failed.
 */
export function instructionOwners(deposits: { address: string; lamports: bigint | string; tokens: unknown[] }[]): (string | null)[] {
  const out: (string | null)[] = [null, null];
  if (deposits.some((d) => d.tokens.length > 0)) out.push(null);
  for (const d of deposits) {
    for (let i = 0; i < d.tokens.length; i++) out.push(d.address, d.address);
    if (BigInt(d.lamports) > 0n) out.push(d.address);
  }
  return out;
}

/** Lamports the hot wallet pays: a signature fee for hot and each deposit, plus the priority fee (rounded up). */
export function sweepFee(plan: SolSweepPlan): bigint {
  return LAMPORTS_PER_SIGNATURE * BigInt(1 + plan.deposits.length) + (BigInt(plan.cuLimit) * plan.cuPrice + 999_999n) / 1_000_000n;
}

const hasTokens = (plan: SolSweepPlan) => plan.deposits.some((d) => d.tokens.length > 0);

/** The plan's instructions, built with Kit and @solana-program/* (every signer a no-op signer: noble signs later). */
export async function solSweepInstructions(plan: SolSweepPlan): Promise<unknown[]> {
  const [k, token, system] = await Promise.all([import("@solana/kit"), import("@solana-program/token"), import("@solana-program/system")]);
  const a = (s: string) => k.address(s);
  const hot = a(plan.hot);
  const hotAta = a(findAta(plan.hot, USDC_MINT)[0]);
  const mint = a(USDC_MINT);
  const out: unknown[] = [
    { programAddress: a(COMPUTE_BUDGET_PROGRAM), data: cuLimitData(plan.cuLimit) },
    { programAddress: a(COMPUTE_BUDGET_PROGRAM), data: cuPriceData(plan.cuPrice) },
  ];
  if (hasTokens(plan)) out.push(token.getCreateAssociatedTokenIdempotentInstruction({ payer: k.createNoopSigner(hot), ata: hotAta, owner: hot, mint }));
  for (const d of plan.deposits) {
    const owner = k.createNoopSigner(a(d.address));
    for (const t of d.tokens) {
      out.push(
        token.getTransferCheckedInstruction({ source: a(t.account), mint, destination: hotAta, authority: owner, amount: t.amount, decimals: USDC_DECIMALS }),
        token.getCloseAccountInstruction({ account: a(t.account), destination: hot, owner }),
      );
    }
    if (d.lamports > 0n) out.push(system.getTransferSolInstruction({ source: owner, destination: hot, amount: d.lamports }));
  }
  return out;
}

export interface CompiledSweep {
  feePayer: string;
  messageBytes: Uint8Array;
  /** Addresses that must sign, in the message's order (the fee payer first). */
  signers: string[];
  /** Serialized size with every signature, in bytes. */
  size: number;
  /** Kit's compiled transaction (signatures empty). */
  tx: unknown;
}

/** Compiles a v0 message for the plan (or for `instructions`, which tests use to build mutated messages). */
export async function compileSolSweep(plan: SolSweepPlan, instructions?: unknown[]): Promise<CompiledSweep> {
  const k = await import("@solana/kit");
  const ixs = instructions ?? (await solSweepInstructions(plan));
  const base = k.pipe(
    k.createTransactionMessage({ version: 0 }),
    (m) => k.setTransactionMessageFeePayer(k.address(plan.hot), m),
    (m) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: plan.blockhash as never, lastValidBlockHeight: plan.lastValidBlockHeight }, m),
  );
  const full = k.appendTransactionMessageInstructions(ixs as never, base) as unknown as Parameters<typeof k.compileTransaction>[0];
  const tx = k.compileTransaction(full) as unknown as Parameters<typeof k.getTransactionSize>[0];
  return { feePayer: plan.hot, messageBytes: tx.messageBytes as unknown as Uint8Array, signers: Object.keys(tx.signatures), size: k.getTransactionSize(tx), tx };
}

/** The compiled message is not exactly the intended sweep. Nothing may be signed. */
export class SolTxMismatch extends Error {
  override name = "SolTxMismatch";
  constructor(readonly reason: string) {
    super(`solana sweep tx mismatch: ${reason}`);
  }
}
const mismatch = (reason: string): never => {
  throw new SolTxMismatch(reason);
};

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
function cuLimitData(n: number): Uint8Array {
  return cat([2], u32(n));
}
function cuPriceData(n: bigint): Uint8Array {
  return cat([3], u64(n));
}
const is32 = (a: string): boolean => {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
};
const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

export interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

/** Checks the plan itself: what it moves, from where, and that it can only pay the hot wallet. */
function checkPlan(plan: SolSweepPlan, hotAta: string): void {
  const n = plan.deposits.length;
  if (n === 0 || n > MAX_DEPOSITS_PER_TX) mismatch(`${n} deposits`);
  if (!is32(plan.hot) || !is32(plan.blockhash)) mismatch("hot wallet or blockhash is not a 32-byte value");
  const deposits = new Set(plan.deposits.map((d) => d.address));
  if (deposits.size !== n) mismatch("a deposit appears twice");
  const reserved = new Set([plan.hot, hotAta, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
  const accounts = new Set<string>();
  for (const d of plan.deposits) {
    if (!is32(d.address) || reserved.has(d.address)) mismatch(`deposit ${d.address} is not a plain account`);
    if (d.lamports < 0n || d.lamports > U64_MAX) mismatch(`deposit ${d.address}: lamports out of range`);
    if (d.lamports === 0n && d.tokens.length === 0) mismatch(`deposit ${d.address} has nothing to move`);
    for (const t of d.tokens) {
      if (!is32(t.account) || reserved.has(t.account)) mismatch(`token account ${t.account} is the hot wallet, its ATA or a program`);
      if (deposits.has(t.account)) mismatch(`token account ${t.account} is a deposit`);
      if (accounts.has(t.account)) mismatch(`token account ${t.account} appears twice`);
      accounts.add(t.account);
      if (t.amount < 0n || t.amount > U64_MAX) mismatch(`token account ${t.account}: amount out of range`);
    }
  }
  if (!Number.isInteger(plan.boost) || plan.boost < 0 || plan.boost > MAX_BOOST) mismatch("priority fee boost out of range");
  const cb = computeBudget(plan.deposits, plan.boost);
  if (plan.cuLimit !== cb.cuLimit || plan.cuPrice !== cb.cuPrice) mismatch("compute budget is not the computed one");
}

/**
 * Rules every instruction must meet, whatever the plan says: which programs run, who pays, where funds may go, the
 * mint and its decimals. Throws SolTxMismatch. (The priority fee needs both ComputeBudget instructions: checked per
 * message by checkPriorityFee.)
 */
export function checkRules(ix: Ix, hot: string, hotAta: string): void {
  const { program, accounts: acc, data } = ix;
  switch (program) {
    case COMPUTE_BUDGET_PROGRAM:
      if (acc.length !== 0) mismatch("ComputeBudget instruction with accounts");
      if (data[0] === 2 && data.length === 5) return;
      if (data[0] === 3 && data.length === 9) return;
      return mismatch("ComputeBudget instruction other than the unit limit and price");
    case ASSOCIATED_TOKEN_PROGRAM:
      if (same(data, Uint8Array.of(1)) && acc.join() === [hot, hotAta, hot, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM].join()) return;
      return mismatch("associated token instruction is not hot's idempotent USDC ATA paid by hot");
    case TOKEN_PROGRAM:
      if (data[0] === 12 && data.length === 10 && acc.length === 4) {
        if (acc[1] !== USDC_MINT) mismatch("transferChecked of another mint");
        if (acc[2] !== hotAta) mismatch("transferChecked destination is not hot's ATA");
        if (data[9] !== USDC_DECIMALS) mismatch("transferChecked decimals are not 6");
        return;
      }
      if (data[0] === 9 && data.length === 1 && acc.length === 3) {
        if (acc[1] !== hot) mismatch("closeAccount destination is not hot");
        return;
      }
      return mismatch("token instruction other than transferChecked and closeAccount");
    case SYSTEM_PROGRAM:
      if (data.length === 12 && same(data.subarray(0, 4), u32(2)) && acc.length === 2) {
        if (acc[1] !== hot) mismatch("SOL transfer destination is not hot");
        if (acc[0] === hot) mismatch("SOL transfer from hot");
        return;
      }
      return mismatch("system instruction other than a transfer");
    default:
      return mismatch(`program ${program} is not allowed`);
  }
}

/** limit x price of the message's ComputeBudget instructions must stay under MAX_PRIORITY_FEE_LAMPORTS. */
function checkPriorityFee(ixs: Ix[]): void {
  const cb = ixs.filter((i) => i.program === COMPUTE_BUDGET_PROGRAM);
  const limit = cb.find((i) => i.data[0] === 2);
  const price = cb.find((i) => i.data[0] === 3);
  if (cb.length !== 2 || !limit || !price) mismatch("not exactly one compute unit limit and one price");
  const units = BigInt(new DataView(limit!.data.buffer, limit!.data.byteOffset).getUint32(1, true));
  if (units * u64At(price!.data, 1) > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) mismatch("priority fee above the cap");
}

type Role = "writable signer" | "readonly signer" | "writable" | "readonly";
/** The role every account of the plan's message must have. */
function intendedRoles(plan: SolSweepPlan, hotAta: string): Map<string, Role> {
  const roles = new Map<string, Role>([[plan.hot, "writable signer"], [COMPUTE_BUDGET_PROGRAM, "readonly"]]);
  for (const d of plan.deposits) {
    // A deposit is writable only as the source of its SOL transfer; as token authority it only signs.
    roles.set(d.address, d.lamports > 0n ? "writable signer" : "readonly signer");
    for (const t of d.tokens) roles.set(t.account, "writable");
    if (d.lamports > 0n) roles.set(SYSTEM_PROGRAM, "readonly");
  }
  if (hasTokens(plan)) {
    roles.set(hotAta, "writable");
    for (const a of [USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]) roles.set(a, "readonly");
  }
  return roles;
}

/** Every static account has exactly its intended role (from the header's signer and readonly counts). */
function checkRoles(m: Decoded, plan: SolSweepPlan, hotAta: string): void {
  const want = intendedRoles(plan, hotAta);
  const keys = m.staticAccounts;
  const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: rn } = m.header;
  const role = (i: number): Role => (i < s ? (i < s - rs ? "writable signer" : "readonly signer") : i < keys.length - rn ? "writable" : "readonly");
  if (keys.length !== want.size || new Set(keys).size !== keys.length) mismatch(`account roles differ from the intended ones (${keys.length} accounts, ${want.size} intended)`);
  keys.forEach((k, i) => {
    if (want.get(k) !== role(i)) mismatch(`account roles differ from the intended ones (${k} is ${role(i)}, intended ${want.get(k) ?? "absent"})`);
  });
}

/** Exactly what the plan's message must contain, encoded by hand (independently of the Kit builders). */
function intended(plan: SolSweepPlan, hotAta: string): Ix[] {
  const out: Ix[] = [
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cuLimitData(plan.cuLimit) },
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cuPriceData(plan.cuPrice) },
  ];
  if (hasTokens(plan)) out.push({ program: ASSOCIATED_TOKEN_PROGRAM, accounts: [plan.hot, hotAta, plan.hot, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Uint8Array.of(1) });
  for (const d of plan.deposits) {
    for (const t of d.tokens) {
      out.push({ program: TOKEN_PROGRAM, accounts: [t.account, USDC_MINT, hotAta, d.address], data: cat([12], u64(t.amount), [USDC_DECIMALS]) });
      out.push({ program: TOKEN_PROGRAM, accounts: [t.account, plan.hot, d.address], data: Uint8Array.of(9) });
    }
    if (d.lamports > 0n) out.push({ program: SYSTEM_PROGRAM, accounts: [d.address, plan.hot], data: cat(u32(2), u64(d.lamports)) });
  }
  return out;
}

type Decoded = {
  version: number | string;
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: string[];
  lifetimeToken: string;
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  addressTableLookups?: unknown[];
};

/**
 * The pre-sign self-check. Decodes the compiled message with Kit's decoder and throws SolTxMismatch unless it is
 * exactly the plan's sweep: a v0 message with no lookup tables and the plan's blockhash; the hot wallet as fee payer;
 * signers exactly hot plus the plan's deposits; only System, Token, Associated Token and ComputeBudget programs, each
 * only where intended; every transfer to hot or hot's USDC ATA, every closeAccount to hot, the exact amounts, 6
 * decimals for transferChecked; the priority fee under its cap; every account with its intended role (header counts);
 * nothing else.
 */
export async function assertSolSweepMessage(messageBytes: Uint8Array, plan: SolSweepPlan): Promise<void> {
  const hotAta = findAta(plan.hot, USDC_MINT)[0];
  checkPlan(plan, hotAta);
  const k = await import("@solana/kit");
  let m: Decoded;
  try {
    m = k.getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Decoded;
  } catch {
    return mismatch("the message does not decode");
  }
  if (m.version !== 0) mismatch(`message version ${String(m.version)}, not 0`);
  if ((m.addressTableLookups?.length ?? 0) > 0) mismatch("address table lookups");
  if (m.lifetimeToken !== plan.blockhash) mismatch("blockhash differs");
  const keys = m.staticAccounts;
  if (keys[0] !== plan.hot) mismatch("fee payer is not the hot wallet");
  const signers = keys.slice(0, m.header.numSignerAccounts);
  const want = new Set([plan.hot, ...plan.deposits.map((d) => d.address)]);
  if (signers.length !== want.size || signers.some((s) => !want.has(s))) mismatch("signer set is not hot plus the deposits");
  const ixs: Ix[] = m.instructions.map((ix) => {
    const program = keys[ix.programAddressIndex];
    const accounts = (ix.accountIndices ?? []).map((i) => keys[i]);
    if (program === undefined || accounts.some((x) => x === undefined)) mismatch("account index out of range");
    return { program: program!, accounts: accounts as string[], data: ix.data ?? new Uint8Array() };
  });
  for (const ix of ixs) checkRules(ix, plan.hot, hotAta);
  checkPriorityFee(ixs);
  checkRoles(m, plan, hotAta);
  const want2 = intended(plan, hotAta);
  if (ixs.length !== want2.length) mismatch(`${ixs.length} instructions, ${want2.length} intended`);
  ixs.forEach((ix, i) => {
    const w = want2[i]!;
    if (ix.program !== w.program || ix.accounts.join() !== w.accounts.join() || !same(ix.data, w.data)) mismatch(`instruction ${i} is not the intended one`);
  });
}

// Signing lives in src/signing/solana.ts (signSolanaTx), behind the spending guard.
