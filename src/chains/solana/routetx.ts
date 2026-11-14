import { base58 } from "@scure/base";
import { ASSOCIATED_TOKEN_PROGRAM, findAta, TOKEN_PROGRAM } from "./pda";
import { COMPUTE_BUDGET_PROGRAM, CU_COST, CU_MARGIN_PERCENT, CU_PRICE_MICROLAMPORTS, LAMPORTS_PER_SIGNATURE, MAX_PRIORITY_FEE_LAMPORTS, SolTxMismatch, SYSTEM_PROGRAM, USDC_DECIMALS, USDC_MINT, type CompiledSweep } from "./sweeptx";

/*
 * The Solana routing transaction: the hot wallet pays one trade deposit (src/routing/swap.ts). Build (Kit) and check
 * (decoded, before any signature); src/signing/solana.ts signs. Kit and @solana-program/* load with import() only.
 *   sol:sol    SetComputeUnitLimit, SetComputeUnitPrice, System transfer(hot -> deposit, amount)
 *   sol:usdc   SetComputeUnitLimit, SetComputeUnitPrice,
 *              createAssociatedTokenIdempotent(payer hot, ata = ATA(deposit, USDC), owner deposit, USDC),
 *              transferChecked(hot's USDC ATA -> ATA(deposit, USDC), amount, 6 decimals, authority hot)
 * The hot wallet is the only signer and the fee payer. The compute budget is fixed per asset (estimate + margin) and
 * the priority fee stays under MAX_PRIORITY_FEE_LAMPORTS.
 */

export type SolRouteAsset = "sol:sol" | "sol:usdc";
export interface SolRoutePlan {
  hot: string;
  /** The trade deposit (a wallet: for USDC its ATA is derived here). */
  to: string;
  asset: SolRouteAsset;
  amount: bigint;
  blockhash: string;
  lastValidBlockHeight: bigint;
  cuLimit: number;
  cuPrice: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

/** The fixed compute budget of a route tx: the unit limit (estimate + margin) and the capped price. */
export function routeBudget(asset: SolRouteAsset): { cuLimit: number; cuPrice: bigint } {
  const cu = 2 * CU_COST.budget + (asset === "sol:usdc" ? CU_COST.ataCreate + CU_COST.transferChecked : CU_COST.solTransfer);
  const cuLimit = Math.ceil((cu * (100 + CU_MARGIN_PERCENT)) / 100);
  const cap = (MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) / BigInt(cuLimit);
  return { cuLimit, cuPrice: CU_PRICE_MICROLAMPORTS < cap ? CU_PRICE_MICROLAMPORTS : cap };
}

export function routePlan(hot: string, to: string, asset: SolRouteAsset, amount: bigint, life: { blockhash: string; lastValidBlockHeight: bigint }): SolRoutePlan {
  return { hot, to, asset, amount, blockhash: life.blockhash, lastValidBlockHeight: life.lastValidBlockHeight, ...routeBudget(asset) };
}

/** Lamports the hot wallet pays in fees (one signature plus the priority fee, rounded up), rent not included. */
export const routeFee = (p: SolRoutePlan): bigint => LAMPORTS_PER_SIGNATURE + (BigInt(p.cuLimit) * p.cuPrice + 999_999n) / 1_000_000n;

const is32 = (a: string): boolean => {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
};
const mismatch = (reason: string): never => {
  throw new SolTxMismatch(reason);
};

function checkPlan(p: SolRoutePlan): void {
  if (!is32(p.hot) || !is32(p.to) || !is32(p.blockhash)) mismatch("hot wallet, deposit or blockhash is not a 32-byte value");
  if (p.asset !== "sol:sol" && p.asset !== "sol:usdc") mismatch(`asset ${String(p.asset)} is not routed on Solana`);
  const reserved = new Set([p.hot, findAta(p.hot, USDC_MINT)[0], USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
  if (reserved.has(p.to)) mismatch("the deposit is the hot wallet, its ATA or a program");
  if (p.amount <= 0n || p.amount > U64_MAX) mismatch("amount out of range");
  const b = routeBudget(p.asset);
  if (p.cuLimit !== b.cuLimit || p.cuPrice !== b.cuPrice) mismatch("compute budget is not the fixed one");
}

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
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((x) => Array.from(x)));
const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);

/** The plan's instructions, built with Kit and @solana-program/* (the hot wallet as a no-op signer: noble signs later). */
async function instructions(p: SolRoutePlan): Promise<unknown[]> {
  const [k, token, system] = await Promise.all([import("@solana/kit"), import("@solana-program/token"), import("@solana-program/system")]);
  const hot = k.createNoopSigner(k.address(p.hot));
  const out: unknown[] = [
    { programAddress: k.address(COMPUTE_BUDGET_PROGRAM), data: cat([2], u32(p.cuLimit)) },
    { programAddress: k.address(COMPUTE_BUDGET_PROGRAM), data: cat([3], u64(p.cuPrice)) },
  ];
  if (p.asset === "sol:sol") {
    out.push(system.getTransferSolInstruction({ source: hot, destination: k.address(p.to), amount: p.amount }));
    return out;
  }
  const mint = k.address(USDC_MINT);
  const toAta = k.address(findAta(p.to, USDC_MINT)[0]);
  out.push(
    token.getCreateAssociatedTokenIdempotentInstruction({ payer: hot, ata: toAta, owner: k.address(p.to), mint }),
    token.getTransferCheckedInstruction({ source: k.address(findAta(p.hot, USDC_MINT)[0]), mint, destination: toAta, authority: hot, amount: p.amount, decimals: USDC_DECIMALS }),
  );
  return out;
}

/** Compiles the plan's v0 message, the hot wallet paying. */
export async function compileSolRoute(p: SolRoutePlan): Promise<CompiledSweep> {
  checkPlan(p);
  const k = await import("@solana/kit");
  const ixs = await instructions(p);
  const base = k.pipe(
    k.createTransactionMessage({ version: 0 }),
    (m) => k.setTransactionMessageFeePayer(k.address(p.hot), m),
    (m) => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash as never, lastValidBlockHeight: p.lastValidBlockHeight }, m),
  );
  const full = k.appendTransactionMessageInstructions(ixs as never, base) as unknown as Parameters<typeof k.compileTransaction>[0];
  const tx = k.compileTransaction(full) as unknown as Parameters<typeof k.getTransactionSize>[0];
  return { feePayer: p.hot, messageBytes: tx.messageBytes as unknown as Uint8Array, signers: Object.keys(tx.signatures), size: k.getTransactionSize(tx), tx };
}

type Role = "writable signer" | "writable" | "readonly";
interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
}
/** Exactly the plan's instructions and account roles, encoded by hand (independently of the Kit builders). */
function intended(p: SolRoutePlan): { ixs: Ix[]; roles: Map<string, Role> } {
  const ixs: Ix[] = [
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([2], u32(p.cuLimit)) },
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cat([3], u64(p.cuPrice)) },
  ];
  const roles = new Map<string, Role>([[p.hot, "writable signer"], [COMPUTE_BUDGET_PROGRAM, "readonly"]]);
  if (p.asset === "sol:sol") {
    ixs.push({ program: SYSTEM_PROGRAM, accounts: [p.hot, p.to], data: cat(u32(2), u64(p.amount)) });
    roles.set(p.to, "writable").set(SYSTEM_PROGRAM, "readonly");
    return { ixs, roles };
  }
  const hotAta = findAta(p.hot, USDC_MINT)[0];
  const toAta = findAta(p.to, USDC_MINT)[0];
  ixs.push(
    { program: ASSOCIATED_TOKEN_PROGRAM, accounts: [p.hot, toAta, p.to, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: Uint8Array.of(1) },
    { program: TOKEN_PROGRAM, accounts: [hotAta, USDC_MINT, toAta, p.hot], data: cat([12], u64(p.amount), [USDC_DECIMALS]) },
  );
  roles.set(toAta, "writable").set(hotAta, "writable");
  for (const a of [p.to, USDC_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]) roles.set(a, "readonly");
  return { ixs, roles };
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
 * exactly the plan: a v0 message with no lookup tables and the plan's blockhash; the hot wallet as the fee payer and
 * only signer; exactly the intended instructions (programs, accounts, amounts, 6 decimals, the fixed compute budget);
 * every account in its intended role; nothing else.
 */
export async function assertSolRouteMessage(messageBytes: Uint8Array, p: SolRoutePlan): Promise<void> {
  checkPlan(p);
  const k = await import("@solana/kit");
  let m: Decoded;
  try {
    m = k.getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Decoded;
  } catch {
    return mismatch("the message does not decode");
  }
  if (m.version !== 0) mismatch(`message version ${String(m.version)}, not 0`);
  if ((m.addressTableLookups?.length ?? 0) > 0) mismatch("address table lookups");
  if (m.lifetimeToken !== p.blockhash) mismatch("blockhash differs");
  const keys = m.staticAccounts;
  const { ixs: want, roles } = intended(p);
  if (keys[0] !== p.hot) mismatch("fee payer is not the hot wallet");
  const h = m.header;
  if (h.numSignerAccounts !== 1 || h.numReadonlySignerAccounts !== 0) mismatch("the hot wallet is not the only signer");
  if (keys.length !== roles.size || new Set(keys).size !== keys.length) mismatch("accounts differ from the intended ones");
  const role = (i: number): Role => (i < h.numSignerAccounts ? "writable signer" : i < keys.length - h.numReadonlyNonSignerAccounts ? "writable" : "readonly");
  keys.forEach((a, i) => {
    if (roles.get(a) !== role(i)) mismatch(`account ${a} is ${role(i)}, intended ${roles.get(a) ?? "absent"}`);
  });
  if (m.instructions.length !== want.length) mismatch(`${m.instructions.length} instructions, ${want.length} intended`);
  m.instructions.forEach((ix, i) => {
    const program = keys[ix.programAddressIndex];
    const accounts = (ix.accountIndices ?? []).map((j) => keys[j]);
    const w = want[i]!;
    if (program !== w.program || accounts.join() !== w.accounts.join() || !same(ix.data ?? new Uint8Array(), w.data)) mismatch(`instruction ${i} is not the intended one`);
  });
}
