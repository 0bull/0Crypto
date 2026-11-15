import { base58 } from "@scure/base";
import { solBalance, tokenAccounts } from "../chains/solana/adapter";
import { findAta } from "../chains/solana/pda";
import { RpcRejected, solRpc, solRpcUrls, type RpcMeter } from "../chains/solana/rpc";
import {
  assertSolSweepMessage, compileSolSweep, instructionOwners, MAX_DEPOSITS_PER_TX, MAX_TX_BYTES, SIZING_LIFETIME, SolTxMismatch, sweepFee, sweepPlan, USDC_MINT,
  type SolSweepDeposit, type SolSweepPlan,
} from "../chains/solana/sweeptx";
import { recordAlert, type AlertKind } from "../db/alerts";
import { listSweepCandidates, type PaymentRow } from "../db/repo";
import { checkFailing, clearSweepLock } from "../db/sweeps";
import type { Env } from "../env";
import { allowedDestination, type Allowed } from "../routing/guard";
import { solDepositAddress, solHotAddress, type KeySpec } from "../signing/addresses";
import { signSolanaTx } from "../signing/solana";
import type { SweepResult } from "./cron";
import { errText } from "./evm";
import { DEADLINE_REACHED, deadline, NEEDS_ADMIN, summarize, type RunOptions } from "./tron";

export { NEEDS_ADMIN };

/*
 * Solana sweeper: moves every due deposit's SOL and USDC (the payment's asset and any unexpected one, like EVM's "all")
 * to the hot wallet (m/44'/501'/2147483646'/0'), up to MAX_DEPOSITS_PER_TX deposits per tx (and never over 1232 bytes),
 * the hot wallet paying every fee. One sweep is pending per chain (sweeps_one_pending, migration 0008 keeps Solana in it).
 *
 *   start      due payments (listSweepCandidates), grouped by deposit; each deposit's SOL and live USDC token accounts are
 *              read at `confirmed`; deposits are added while the compiled tx fits. Hot must hold the fees, hot's ATA rent
 *              if it does not exist yet, and HOT_RESERVE_LAMPORTS, or sweep.insufficient_gas. The compiled message is
 *              decoded and checked (assertSolSweepMessage) before anything is signed: a mismatch is sweep.tx_mismatch.
 *   signed     the row and the payments' lock (sweep_tx = the fee payer's signature, computed locally) are written in one
 *              batch BEFORE sendTransaction. A JSON-RPC refusal fails the sweep and releases the lock; an unclear answer
 *              (timeout, non-2xx, network) leaves it pending for reconcile
 *   sent       the node accepted it
 *   reconcile  (later runs) finalized with err null: confirmed, every payment swept. finalized with an error: failed,
 *              released, backoff. Unknown and the finalized block height past lastValidBlockHeight: the blockhash expired,
 *              so it can never land: dropped, released, retried at once. Otherwise: wait.
 *
 * Every state change is a compare-and-set on (id, status='pending', step), so overlapping runs never send twice and a
 * stale run never undoes a newer outcome. Keys are derived per use and never logged or stored.
 *
 * Failures. A definite failure is a preflight refusal (JSON-RPC -32002, unless its message is "Blockhash not found": the
 * node is behind), an error on chain, or a self-check mismatch.
 *   - In a single-deposit tx it is counted against that deposit's payments in payments.sweep_paid_attempts (the Tron
 *     "paid attempts" column, reused: on Solana it counts failed attempts): backoff 1h, then 6h; at MAX_SOL_FAILURES the
 *     payment waits for an admin ("Retry sweep" resets the count) and sweep.needs_admin is recorded (never deduped).
 *   - In a batch it is counted against nobody (any one deposit may have caused it): every payment in it is marked
 *     sweep_solo (migration 0010) and from then on swept one deposit per tx, solo payments first, until it is swept.
 *     The alert names the deposit when the error's instruction index (InstructionError, or "Instruction N" in the
 *     preflight message) maps to one.
 *   - Any other JSON-RPC refusal (rate limit, node behind, -32002 "Blockhash not found", ...) is no verdict on the tx:
 *     released, retried next run, counted against nobody, with a deduped sweep.failing.
 *   - A drop costs nothing and is not counted. After DROPS_PER_BOOST consecutive drops of the same payment set the
 *     priority fee price doubles (again after each further DROPS_PER_BOOST), never above MAX_PRIORITY_FEE_LAMPORTS.
 *     consecutiveDrops looks back over the chain's last DROP_LOOKBACK settled sweeps, so the boost stops at
 *     DROP_LOOKBACK / DROPS_PER_BOOST = 4 doublings: at most x16 the base price (before the cap).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const CHAIN = "sol";
/** HTTP requests (Workers subrequests) per run, fallback probes and genesis checks included (measured, not estimated). */
export const SOL_SUBREQUEST_BUDGET = 40;
/** Calls reserved per deposit read (balance, token accounts, an earlier-sweep status) and for the send (hot balance, hot
 * ATA, blockhash, sendTransaction). Each may try every RPC URL. */
const DEPOSIT_CALLS = 3;
const TAIL_CALLS = 4;
const MAX_CANDIDATES = 40;
/**
 * Token accounts swept per deposit (largest first). More stay at the address and the payment is marked unexpected_left.
 * A deviation from "every account": anyone can create USDC accounts owned by a deposit, so the list is attacker-sized;
 * 12 bounds the work per run (one compile per size probe) and is the most one deposit can carry in one tx anyway (12
 * accounts plus a SOL transfer is 1131 bytes; 14 would exceed 1232). Normally a deposit has one, its ATA.
 */
export const MAX_TOKEN_ACCOUNTS_PER_DEPOSIT = 12;
/** Rent of a token account (165 bytes): what hot pays to create its ATA, and what each closeAccount returns to hot. */
export const ATA_RENT_LAMPORTS = 2_039_280n;
/** Kept in the hot wallet beyond the fees: its own rent-exempt minimum (890,880 lamports) plus a margin. */
export const HOT_RESERVE_LAMPORTS = 1_000_000n;
export const MAX_SOL_FAILURES = 3;
/** Wait before retrying after the 1st and 2nd counted failure (the 3rd needs an admin). */
const BACKOFF_MS = [HOUR, 6 * HOUR];
/** A deposit with nothing to sweep is looked at again after this long. */
const EMPTY_RETRY_MS = 24 * HOUR;
/** sweep_retry_at of a payment that waits for an admin (the largest JS date: never due by itself). */
const NEEDS_ADMIN_RETRY_AT = 8_640_000_000_000_000;
/** JSON-RPC code of a preflight (simulation) failure: the only refusal that is a verdict on the tx itself... */
const PREFLIGHT_FAILURE = -32002;
/** ...except this one: the node does not know the blockhash yet (it is behind), which says nothing about the tx. */
const NOT_A_VERDICT = /Blockhash not found/i;
/** Consecutive drops of the same payments per doubling of the priority fee price. */
export const DROPS_PER_BOOST = 3;
/** Settled sweeps consecutiveDrops looks back over: caps the boost at 12 / 3 = 4 doublings (x16). */
const DROP_LOOKBACK = 12;

type Step = "signed" | "sent";
interface MetaDeposit {
  address: string;
  payments: string[];
  lamports: string;
  tokens: { account: string; amount: string }[];
  /** Funds stay at the address after this sweep (frozen accounts, or more token accounts than fit). */
  left?: boolean;
}
/** sweeps.meta of a Solana row. Amounts are strings (bigint). No keys or signatures other than the tx id. */
interface Meta {
  blockhash: string;
  lastValidBlockHeight: string;
  fee: string;
  boost?: number;
  deposits: MetaDeposit[];
}
interface Row {
  id: string;
  tx: string | null;
  step: Step;
  meta: string;
  payment_ids: string;
}
interface Ctx {
  env: Env;
  rpc: ReturnType<typeof solRpc>;
  meter: RpcMeter;
  urls: number;
  /** The hot wallet (address only: its key never leaves src/signing). */
  hot: { address: string };
  /** Guard proof for the hot wallet: the only destination of a sweep tx (and owner of its USDC ATA). */
  hotProof: Allowed;
  hotAta: string;
  now: number;
  /** True once the run's wall-time deadline (RUN_DEADLINE_MS) has passed: no new step or send starts. */
  late: () => boolean;
}
type Advance = { done: boolean; result: SweepResult };
interface Picked {
  deposit: SolSweepDeposit;
  /** Which of our keys signs for the deposit (derived by the signer). */
  key: KeySpec;
  payments: string[];
  left: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const idsOf = (row: Pick<Row, "payment_ids">) => JSON.parse(row.payment_ids) as string[];
const progress = (now: number) => JSON.stringify({ at: now });
const pending = (reason = "a sweep is pending"): Advance => ({ done: false, result: { status: "skipped", reason, paymentIds: [] } });
const timedOut = (): SweepResult => ({ status: "skipped", reason: DEADLINE_REACHED, paymentIds: [] });
const failed = (ids: string[], reason: string): SweepResult => ({ status: "failed", reason, paymentIds: ids });
const errored = (e: unknown): SweepResult => {
  const name = e instanceof Error ? e.name : "Error";
  console.warn(`0crypto: sweep sol step failed: ${name}`);
  return { status: "failed", reason: name, paymentIds: [] };
};
/**
 * Can the run still afford `calls` RPC calls plus a genesis check? Each is reserved at up to 2 URLs (the first, and one
 * fallback): a fallback costs a request only when it is used, a failing URL cools down after its first failure, and the
 * meter counts real requests, so reserving every URL would stall a run with many fallbacks for nothing.
 */
const affordable = (c: Ctx, calls: number) => c.meter.used + (calls + 1) * Math.min(c.urls, 2) <= SOL_SUBREQUEST_BUDGET;
const is32 = (a: string): boolean => {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
};

// ---- RPC reads ----

async function finalizedHeight(c: Ctx): Promise<bigint> {
  const h = await c.rpc.call("getBlockHeight", [{ commitment: "finalized" }]);
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("solana: malformed block height");
  return BigInt(h);
}

type Status = { confirmationStatus: string | null; err: unknown } | null;
async function statuses(c: Ctx, sigs: string[]): Promise<Status[]> {
  const r = await c.rpc.call("getSignatureStatuses", [sigs, { searchTransactionHistory: true }]);
  const v = isObj(r) ? r.value : undefined;
  if (!Array.isArray(v) || v.length !== sigs.length) throw new Error("solana: malformed getSignatureStatuses");
  return v.map((x: unknown) => {
    if (x === null) return null;
    if (!isObj(x) || !("err" in x)) throw new Error("solana: malformed signature status");
    return { confirmationStatus: typeof x.confirmationStatus === "string" ? x.confirmationStatus : null, err: x.err ?? null };
  });
}

async function latestBlockhash(c: Ctx): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const r = await c.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const v = isObj(r) && isObj(r.value) ? r.value : undefined;
  const h = v?.lastValidBlockHeight;
  if (!v || typeof v.blockhash !== "string" || !is32(v.blockhash) || typeof h !== "number" || !Number.isSafeInteger(h) || h < 0)
    throw new Error("solana: malformed getLatestBlockhash");
  return { blockhash: v.blockhash, lastValidBlockHeight: BigInt(h) };
}

/** A deposit's SOL and live USDC token accounts at `confirmed` (largest first, deduplicated), and its frozen USDC. */
async function readDeposit(c: Ctx, address: string): Promise<{ lamports: bigint; tokens: { account: string; amount: bigint }[]; frozen: bigint }> {
  const [lamports, toks] = await Promise.all([solBalance(c.rpc, address, "confirmed"), tokenAccounts(c.rpc, address, USDC_MINT, "confirmed")]);
  const seen = new Set<string>();
  const tokens: { account: string; amount: bigint }[] = [];
  for (const t of toks.live) {
    if (!is32(t.pubkey)) throw new Error("solana: malformed token account address");
    if (seen.has(t.pubkey)) continue;
    seen.add(t.pubkey);
    tokens.push({ account: t.pubkey, amount: t.amount });
  }
  tokens.sort((a, b) => (a.amount === b.amount ? (a.account < b.account ? -1 : 1) : a.amount > b.amount ? -1 : 1));
  return { lamports, tokens, frozen: toks.frozen };
}

// ---- Payment bookkeeping ----

async function backoff(c: Ctx, ids: string[], error: string, ms: number): Promise<void> {
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=?").bind(error.slice(0, 120), c.now + ms, id)));
}

/**
 * A definite failure of a tx holding these payments. A batch (`single` false) blames nobody: its payments go solo. A
 * single-deposit tx counts it against its payments: backoff after the 1st and 2nd, "needs admin" at MAX_SOL_FAILURES,
 * with a sweep.needs_admin alert recorded for every occurrence (dedupe: false).
 */
async function blame(c: Ctx, ids: string[], single: boolean, error: string): Promise<void> {
  if (!single) {
    await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE payments SET sweep_solo=1 WHERE id=? AND swept_at IS NULL").bind(id)));
    return;
  }
  const stop: string[] = [];
  for (const id of ids) {
    const r = await c.env.DB.prepare("UPDATE payments SET sweep_paid_attempts=sweep_paid_attempts+1 WHERE id=? RETURNING sweep_paid_attempts AS n").bind(id).first<{ n: number }>();
    const n = r?.n ?? 1;
    if (n >= MAX_SOL_FAILURES) stop.push(id);
    else await backoff(c, [id], error, BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1]!);
  }
  if (stop.length === 0) return;
  await c.env.DB.batch(
    stop.map((id) =>
      c.env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=?").bind(`${NEEDS_ADMIN}: ${MAX_SOL_FAILURES} Solana sweep attempts failed (last: ${error})`.slice(0, 120), NEEDS_ADMIN_RETRY_AT, id),
    ),
  );
  await recordAlert(
    c.env.DB,
    "sweep.needs_admin",
    CHAIN,
    `${stop.join(", ")}: ${MAX_SOL_FAILURES} Solana sweep attempts in a row failed (last: ${error}). It is no longer retried automatically: check the deposit address and the hot wallet, then click "Retry sweep" on its invoice page.`,
    c.now,
    { dedupe: false },
  );
}

/** " (instruction N, deposit X)" for an instruction index of a tx built from `deposits`, or "" when unknown. */
function where(deposits: MetaDeposit[], index: number | undefined): string {
  if (index === undefined || !Number.isInteger(index)) return "";
  const owner = instructionOwners(deposits)[index];
  return ` (instruction ${index}${owner ? `, deposit ${owner}` : ""})`;
}
/** The instruction index of an on-chain error ({InstructionError: [index, ...]}). */
const errIndex = (err: unknown): number | undefined => {
  const ie = isObj(err) ? err.InstructionError : undefined;
  return Array.isArray(ie) && typeof ie[0] === "number" ? ie[0] : undefined;
};

/**
 * Fails a pending sweep still at `step` (a run that read an older step changes nothing), then optionally releases the
 * payments' lock (the tx never moved funds), alerts and counts the failure.
 */
async function fail(
  c: Ctx,
  row: Pick<Row, "id" | "tx" | "payment_ids">,
  step: Step,
  error: string,
  o: { release?: boolean; blame?: { single: boolean }; alert?: [AlertKind, string] } = {},
): Promise<boolean> {
  const r = await c.env.DB.prepare("UPDATE sweeps SET status='failed', error=?, req=? WHERE id=? AND status='pending' AND step=?").bind(error.slice(0, 120), progress(c.now), row.id, step).run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  const ids = idsOf(row);
  if (o.release && row.tx) await clearSweepLock(c.env.DB, ids, [row.tx]);
  if (o.alert) await recordAlert(c.env.DB, o.alert[0], CHAIN, o.alert[1], c.now);
  if (o.blame) await blame(c, ids, o.blame.single, error);
  await checkFailing(c.env, CHAIN, c.now);
  return true;
}

// ---- Reconcile ----

async function reconcile(c: Ctx, row: Row): Promise<Advance> {
  if (!row.tx) throw new Error(`sol sweep ${row.id}: no tx`);
  const meta = JSON.parse(row.meta) as Meta;
  const ids = idsOf(row);
  // Height first: if the finalized chain is already past lastValidBlockHeight now, every block that could hold the tx
  // is final, so a status read after this one sees it if it landed.
  const height = await finalizedHeight(c);
  const [st] = await statuses(c, [row.tx]);
  const settled = (done: boolean, result: SweepResult): Advance => ({ done, result });
  if (st && st.confirmationStatus === "finalized") {
    if (st.err === null) return confirm(c, row, meta);
    const why = `failed on chain: ${JSON.stringify(st.err)}`.slice(0, 100);
    const single = meta.deposits.length === 1;
    const ok = await fail(c, row, row.step, why, {
      release: true,
      blame: { single },
      alert: [
        "sweep.payment_failed",
        `the Solana sweep tx ${row.tx} of ${ids.join(", ")} failed on chain${where(meta.deposits, errIndex(st.err))} (${JSON.stringify(st.err).slice(0, 80)}); ${single ? "retried after a backoff" : "every payment in it is retried alone"}`,
      ],
    });
    return ok ? settled(true, failed(ids, why)) : pending();
  }
  if (st) return pending();
  if (height > BigInt(meta.lastValidBlockHeight)) {
    const ok = await fail(c, row, row.step, "dropped", {
      release: true,
      alert: ["sweep.failing", `a Solana sweep tx of ${ids.join(", ")} expired without landing (its blockhash is past its last valid block height); it is retried`],
    });
    return ok ? settled(true, failed(ids, "dropped")) : pending();
  }
  return pending();
}

async function confirm(c: Ctx, row: Row, meta: Meta): Promise<Advance> {
  const ids = idsOf(row);
  const left = new Map<string, number>();
  for (const d of meta.deposits) for (const p of d.payments) left.set(p, d.left ? 1 : 0);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sweeps SET status='confirmed', req=? WHERE id=? AND status='pending' AND step=?").bind(progress(c.now), row.id, row.step),
    ...ids.map((pid) =>
      c.env.DB.prepare(
        "UPDATE payments SET swept_at=?, swept_base=received, sweep_tx=?, sweep_error=NULL, sweep_retry_at=NULL, sweep_paid_attempts=0, sweep_solo=0, unexpected_left=? WHERE id=? AND swept_at IS NULL AND EXISTS (SELECT 1 FROM sweeps WHERE id=? AND status='confirmed' AND tx=?)",
      ).bind(c.now, row.tx, left.get(pid) ?? 0, pid, row.id, row.tx),
    ),
  ]);
  return { done: true, result: { status: "idle", reason: "swept", tx: row.tx!, paymentIds: ids } };
}

// ---- Start ----

/** The deposit key of a group of payments at one address, or null (backed off, alerted) if it does not match. */
async function keyFor(c: Ctx, address: string, ps: PaymentRow[]): Promise<KeySpec | null> {
  let key: KeySpec | null = null;
  for (const p of ps) {
    let derived: string | null = null;
    try {
      derived = solDepositAddress(c.env.MASTER_SEED ?? "", p.derivation_index);
    } catch {
      derived = null;
    }
    if (derived !== address) {
      const ids = ps.map((x) => x.id);
      await backoff(c, ids, "deposit key does not match the address", EMPTY_RETRY_MS);
      await recordAlert(c.env.DB, "sweep.payment_failed", CHAIN, `the derived key of ${p.id} does not match its Solana address (was MASTER_SEED changed?); not sweeping ${ids.join(", ")}`, c.now);
      return null;
    }
    key = { role: "deposit", index: p.derivation_index };
  }
  return key;
}

/**
 * A deposit that reads empty may have been swept by an earlier attempt that was written off (an admin "mark failed", a
 * crash) after its tx landed. If one of these payments' earlier sweep txs is finalized without error, mark them swept.
 */
async function sweptEarlier(c: Ctx, ps: PaymentRow[]): Promise<boolean> {
  const ids = ps.map((p) => p.id);
  const { results } = await c.env.DB.prepare(
    `SELECT s.tx AS tx, s.meta AS meta, MAX(s.created_at) AS at FROM sweeps s, json_each(s.payment_ids) j
     WHERE s.chain=? AND s.status<>'pending' AND s.tx IS NOT NULL AND s.id LIKE 'swp\\_%' ESCAPE '\\' AND j.value IN (${ids.map(() => "?").join(",")})
     GROUP BY s.tx ORDER BY at DESC LIMIT 5`,
  )
    .bind(CHAIN, ...ids)
    .all<{ tx: string; meta: string | null }>();
  if (results.length === 0) return false;
  const txs = results.map((r) => r.tx);
  const sts = await statuses(c, txs);
  const i = sts.findIndex((s) => s?.confirmationStatus === "finalized" && s.err === null);
  if (i < 0) return false;
  // What that sweep left at the address (meta.deposits[].left) still stands.
  let deposits: MetaDeposit[] = [];
  try {
    const m = JSON.parse(results[i]!.meta ?? "{}") as Partial<Meta>;
    deposits = Array.isArray(m.deposits) ? m.deposits : [];
  } catch {
    deposits = [];
  }
  const left = (id: string) => (deposits.some((d) => Array.isArray(d.payments) && d.payments.includes(id) && d.left) ? 1 : 0);
  await c.env.DB.batch(
    ids.map((id) =>
      c.env.DB.prepare(
        "UPDATE payments SET swept_at=?, swept_base=received, sweep_tx=?, sweep_error=NULL, sweep_retry_at=NULL, sweep_paid_attempts=0, sweep_solo=0, unexpected_left=? WHERE id=? AND swept_at IS NULL",
      ).bind(c.now, txs[i], left(id), id),
    ),
  );
  return true;
}

async function empty(c: Ctx, ps: PaymentRow[], frozen: bigint): Promise<SweepResult | null> {
  const ids = ps.map((p) => p.id);
  if (await sweptEarlier(c, ps)) return { status: "idle", reason: "swept by an earlier attempt", paymentIds: ids };
  const address = ps[0]!.address;
  await backoff(c, ids, frozen > 0n ? "only frozen USDC at the deposit" : "nothing to sweep at the deposit", EMPTY_RETRY_MS);
  await recordAlert(
    c.env.DB,
    "sweep.payment_failed",
    CHAIN,
    frozen > 0n
      ? `the Solana deposit ${address} of ${ids.join(", ")} holds ${frozen} USDC (atomic units) only in frozen token accounts, which cannot be moved: nothing to sweep`
      : `no SOL or USDC at the Solana deposit ${address} of ${ids.join(", ")}: nothing to sweep`,
    c.now,
  );
  return null;
}

/** Chooses the deposits of the next tx (reading each), or returns the results of the ones that went nowhere. */
async function pick(c: Ctx, results: SweepResult[]): Promise<Picked[]> {
  const due = (await listSweepCandidates(c.env.DB, CHAIN, c.now, MAX_CANDIDATES)).filter((p) => p.asset === "sol:sol" || p.asset === "sol:usdc");
  const groups = new Map<string, PaymentRow[]>();
  for (const p of due) {
    const g = groups.get(p.address);
    if (g) g.push(p);
    else groups.set(p.address, [p]);
  }
  // Payments of a failed batch go alone, before any batch (they are retried one deposit per tx until swept).
  const ids = due.map((p) => p.id);
  const solo = new Set(
    ids.length === 0
      ? []
      : (await c.env.DB.prepare(`SELECT id FROM payments WHERE sweep_solo=1 AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string }>()).results.map((r) => r.id),
  );
  const isSolo = (ps: PaymentRow[]) => ps.some((p) => solo.has(p.id));
  const all = [...groups];
  const ordered = [...all.filter(([, ps]) => isSolo(ps)), ...all.filter(([, ps]) => !isSolo(ps))];
  const picked: Picked[] = [];
  const fits = async (list: SolSweepDeposit[]) => (await compileSolSweep(sweepPlan(c.hot.address, list, SIZING_LIFETIME))).size <= MAX_TX_BYTES;
  for (const [address, ps] of ordered) {
    if (picked.length >= MAX_DEPOSITS_PER_TX) break;
    const alone = isSolo(ps);
    if (alone && picked.length > 0) break;
    if (!affordable(c, DEPOSIT_CALLS + TAIL_CALLS)) {
      results.push({ status: "skipped", reason: "subrequest budget reached; continued next run", paymentIds: [] });
      break;
    }
    if (c.late()) {
      results.push(timedOut());
      break;
    }
    const key = await keyFor(c, address, ps);
    if (!key) continue;
    let read: Awaited<ReturnType<typeof readDeposit>>;
    // An RPC error on one deposit (its reads, or the earlier-sweep lookup of an empty one) skips that deposit only.
    try {
      read = await readDeposit(c, address);
      if (read.lamports === 0n && read.tokens.length === 0) {
        const r = await empty(c, ps, read.frozen);
        if (r) results.push(r);
        continue;
      }
    } catch (e) {
      results.push(errored(e));
      continue;
    }
    let d: SolSweepDeposit = { address, lamports: read.lamports, tokens: read.tokens.slice(0, MAX_TOKEN_ACCOUNTS_PER_DEPOSIT) };
    let left = read.frozen > 0n || d.tokens.length < read.tokens.length;
    const pids = ps.map((p) => p.id);
    if (await fits([...picked.map((x) => x.deposit), d])) {
      picked.push({ deposit: d, key, payments: pids, left });
      if (alone) break;
      continue;
    }
    if (picked.length > 0) break; // it goes in the next tx
    // Alone and still too big (many token accounts): the largest that fit go now; the rest stay at the address.
    while (d.tokens.length > 0 && !(await fits([d]))) {
      d = { ...d, tokens: d.tokens.slice(0, -1) };
      left = true;
    }
    if (d.tokens.length > 0 || d.lamports > 0n) picked.push({ deposit: d, key, payments: pids, left });
    break;
  }
  return picked;
}

/** Writes the pending row and the payments' lock in one batch, only if no Solana sweep is pending. */
async function lock(c: Ctx, id: string, ids: string[], sig: string, meta: Meta): Promise<boolean> {
  try {
    const [ins] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,txs,step,meta,req)
         SELECT ?1,?2,?3,?4,'pending',?5,?6,'signed',?7,?8 WHERE NOT EXISTS (SELECT 1 FROM sweeps WHERE chain=?2 AND status='pending')`,
      ).bind(id, CHAIN, sig, c.now, JSON.stringify(ids), JSON.stringify([sig]), JSON.stringify(meta), progress(c.now)),
      ...ids.map((pid) =>
        c.env.DB.prepare("UPDATE payments SET sweep_tx=? WHERE id=? AND swept_at IS NULL AND EXISTS (SELECT 1 FROM sweeps WHERE id=? AND status='pending' AND tx=?)").bind(sig, pid, id, sig),
      ),
    ]);
    return (ins!.meta.changes ?? 0) === 1;
  } catch (e) {
    if (/unique/i.test(errText(e))) return false;
    throw e;
  }
}

/** A built tx that failed the self-check: recorded as a failed sweep (nothing signed), alerted (every occurrence) and blamed. */
async function refused(c: Ctx, ids: string[], plan: SolSweepPlan, reason: string): Promise<SweepResult> {
  const id = `swp_${crypto.randomUUID().replaceAll("-", "")}`;
  const meta = { blockhash: plan.blockhash, deposits: plan.deposits.map((d) => d.address) };
  await c.env.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,error,step,meta,req) VALUES(?,?,NULL,?,'failed',?,'tx_mismatch',NULL,?,?)")
    .bind(id, CHAIN, c.now, JSON.stringify(ids), JSON.stringify(meta), progress(c.now))
    .run();
  await recordAlert(c.env.DB, "sweep.tx_mismatch", CHAIN, `the Solana sweep tx built for ${ids.join(", ")} is not the intended one (${reason}); nothing was signed`, c.now, { dedupe: false });
  await blame(c, ids, plan.deposits.length === 1, "tx_mismatch");
  await checkFailing(c.env, CHAIN, c.now);
  return failed(ids, "tx_mismatch");
}

/** "Error processing Instruction N" in a preflight message. */
const instructionIn = (detail: string): number | undefined => {
  const m = /Instruction (\d+)/.exec(detail);
  return m ? Number(m[1]) : undefined;
};

/** How many of the chain's latest DROP_LOOKBACK settled sweeps, newest first, were drops of exactly these payments. */
async function consecutiveDrops(c: Ctx, ids: string[]): Promise<number> {
  const key = JSON.stringify([...ids].sort());
  const { results } = await c.env.DB.prepare("SELECT payment_ids, error FROM sweeps WHERE chain=? AND status<>'pending' ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(CHAIN, DROP_LOOKBACK)
    .all<{ payment_ids: string; error: string | null }>();
  let n = 0;
  for (const r of results) {
    if (r.error !== "dropped" || JSON.stringify((JSON.parse(r.payment_ids) as string[]).sort()) !== key) break;
    n++;
  }
  return n;
}

async function send(c: Ctx, picked: Picked[]): Promise<SweepResult> {
  const deposits = picked.map((p) => p.deposit);
  const ids = picked.flatMap((p) => p.payments);
  const usdc = deposits.some((d) => d.tokens.length > 0);
  const boost = Math.floor((await consecutiveDrops(c, ids)) / DROPS_PER_BOOST);
  const fee = sweepFee(sweepPlan(c.hot.address, deposits, SIZING_LIFETIME, boost));
  const [hotLamports, ataLamports] = await Promise.all([solBalance(c.rpc, c.hot.address, "confirmed"), usdc ? solBalance(c.rpc, c.hotAta, "confirmed") : Promise.resolve(1n)]);
  const ataRent = usdc && ataLamports === 0n ? ATA_RENT_LAMPORTS : 0n;
  const need = fee + ataRent + HOT_RESERVE_LAMPORTS;
  if (hotLamports < need) {
    await recordAlert(
      c.env.DB,
      "sweep.insufficient_gas",
      CHAIN,
      `the Solana hot wallet ${c.hot.address} holds ${hotLamports} lamports; the next sweep needs ${need} (fees ${fee}${ataRent ? `, ${ataRent} rent for its USDC account` : ""} and a ${HOT_RESERVE_LAMPORTS} reserve)`,
      c.now,
    );
    return { status: "skipped", reason: "insufficient SOL in the hot wallet", paymentIds: [] };
  }

  const plan = sweepPlan(c.hot.address, deposits, await latestBlockhash(c), boost);
  const compiled = await compileSolSweep(plan);
  try {
    if (compiled.size > MAX_TX_BYTES) throw new SolTxMismatch(`the tx is ${compiled.size} bytes`);
    await assertSolSweepMessage(compiled.messageBytes, plan);
  } catch (e) {
    if (!(e instanceof SolTxMismatch)) throw e;
    return refused(c, ids, plan, e.reason);
  }
  const { signature, wire } = await signSolanaTx(c.env.MASTER_SEED ?? "", compiled, [{ role: "hot" }, ...picked.map((p) => p.key)], [c.hotProof]);

  const id = `swp_${crypto.randomUUID().replaceAll("-", "")}`;
  const meta: Meta = {
    blockhash: plan.blockhash,
    lastValidBlockHeight: plan.lastValidBlockHeight.toString(),
    fee: fee.toString(),
    ...(boost > 0 ? { boost } : {}),
    deposits: picked.map((p) => ({
      address: p.deposit.address,
      payments: p.payments,
      lamports: p.deposit.lamports.toString(),
      tokens: p.deposit.tokens.map((t) => ({ account: t.account, amount: t.amount.toString() })),
      ...(p.left ? { left: true } : {}),
    })),
  };
  // Row and lock before the send: a crash after it can never lose the tx, and the payments keep their credit while
  // the addresses empty. Only the run whose row went in sends.
  if (!(await lock(c, id, ids, signature, meta))) return { status: "skipped", reason: "a sweep is pending", paymentIds: [] };
  const row = { id, tx: signature, payment_ids: JSON.stringify(ids) };
  let accepted = false;
  try {
    const r = await c.rpc.send("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed" }]);
    accepted = true;
    if (r !== signature) console.warn("0crypto: sweep sol: the node answered another signature than ours; ours is tracked");
  } catch (e) {
    if (e instanceof RpcRejected) {
      const why = `send refused${e.code === undefined ? "" : ` (${e.code})`}`;
      const single = picked.length === 1;
      const ok =
        e.code === PREFLIGHT_FAILURE && !NOT_A_VERDICT.test(e.detail)
          ? await fail(c, row, "signed", why, {
              release: true,
              blame: { single },
              alert: [
                "sweep.failing",
                `the Solana RPC refused a sweep tx for ${ids.join(", ")} at preflight${where(meta.deposits, instructionIn(e.detail))}: ${e.detail || why}${single ? "" : "; every payment in it is retried alone"}`,
              ],
            })
          : // Not a verdict on the tx (rate limit, node behind, ...): released and retried next run, blaming nobody.
            await fail(c, row, "signed", why, {
              release: true,
              alert: ["sweep.failing", `the Solana RPC refused a sweep tx for ${ids.join(", ")} without judging it (${e.code ?? "no code"}: ${e.detail}); retried next run`],
            });
      return ok ? failed(ids, why) : { status: "skipped", reason: "a sweep is pending", paymentIds: [] };
    }
    // No usable answer: it may have been accepted. Reconcile settles it (landed, or dropped once the blockhash expires).
    console.warn(`0crypto: sweep sol send answer lost: ${e instanceof Error ? e.name : "Error"}`);
  }
  if (accepted) await c.env.DB.prepare("UPDATE sweeps SET step='sent', req=? WHERE id=? AND status='pending' AND step='signed'").bind(progress(c.now), id).run();
  return { status: "sent", tx: signature, paymentIds: ids };
}

/**
 * One Solana sweep run: settle the pending sweep (if any); with none pending, build, check, sign, lock and send the next
 * batch. No step or send starts once RUN_DEADLINE_MS of wall time have passed since the run began (one already begun
 * finishes). Throws only on D1 failures; RPC failures are reported per step.
 */
export async function runSolanaSweep(env: Env, now: number = Date.now(), o: RunOptions = {}): Promise<SweepResult> {
  const late = deadline(o);
  const meter: RpcMeter = { used: 0 };
  const hot = { address: solHotAddress(env.MASTER_SEED ?? "") };
  const c: Ctx = {
    env, rpc: solRpc(env, undefined, meter), meter, urls: Math.max(1, solRpcUrls(env).length), hot, hotProof: await allowedDestination(env, CHAIN, hot.address), hotAta: findAta(hot.address, USDC_MINT)[0], now, late,
  };
  const rows = (await env.DB.prepare("SELECT id,tx,step,meta,payment_ids FROM sweeps WHERE chain=? AND status='pending' ORDER BY created_at, rowid").bind(CHAIN).all<Row>()).results;
  const results: SweepResult[] = [];
  let open = 0;
  for (const row of rows) {
    if (late()) {
      results.push(timedOut());
      open++;
      continue;
    }
    try {
      const a = await reconcile(c, row);
      results.push(a.result);
      if (!a.done) open++;
    } catch (e) {
      results.push(errored(e));
      open++;
    }
  }
  if (open > 0) return summarize(results);
  const picked = await pick(c, results);
  // Reading deposits may have used up the run's wall time: then nothing is signed or sent (the next run starts over).
  if (picked.length > 0 && late()) results.push(timedOut());
  else if (picked.length > 0) {
    try {
      results.push(await send(c, picked));
    } catch (e) {
      results.push(errored(e));
    }
  }
  return summarize(results);
}
