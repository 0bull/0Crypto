import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { tronGrid } from "../chains/tron/trongrid";
import { rentEnergy, TronSaveError } from "../chains/tron/tronsave";
import { assertTronTx, encodeSignedTx, MAX_FEE_LIMIT_SUN, StaleTx, TOPUP_SUN, TxMismatch } from "../chains/tron/txcheck";
import { getAsset } from "../core/assets";
import { recordAlert, type AlertKind } from "../db/alerts";
import { listSweepCandidates, type PaymentRow } from "../db/repo";
import { checkFailing, clearSweepLock } from "../db/sweeps";
import type { Env } from "../env";
import { allowedDestination, type Allowed } from "../routing/guard";
import { tronDepositAddress, tronHotAddress } from "../signing/addresses";
import { signTronTx } from "../signing/tron";
import type { SweepResult } from "./cron";
import { errText } from "./evm";

/*
 * Tron USDT sweeper: moves each confirmed deposit's USDT to the hot wallet (m/44'/195'/1'/0/0). Each sweep is one row
 * in `sweeps` (chain 'tron', one payment). Up to TRON_MAX_PENDING run side by side (Tron txs have no nonce); a
 * payment never has two (guarded insert + unique index, migration 0008). A sweep walks through `step` over several
 * cron runs (every 15 minutes), each run doing at most what is safe:
 *
 *   topup    the deposit holds < 0.5 TRX (or is not activated): the hot wallet sent exactly 0.5 TRX; wait until solid
 *   energy   rent 65k energy (131k if the hot wallet holds no USDT: a first-time holder slot costs more), plus 2%, via
 *            TronSave unless the deposit already has it; never above ENERGY_PRICE_CAP_SUN_PER_UNIT
 *   rented   wait until the deposit shows the energy (EnergyLimit - EnergyUsed); give up after 45 minutes. Broadcasting
 *            without it would burn the deposit's TRX and fail OUT_OF_ENERGY
 *   transfer the deposit signed transfer(hot, its whole on-chain USDT balance); the lock (payments.sweep_tx) is written
 *            with the step before the broadcast; swept_at is set once the solid tx paid exactly that amount to the hot wallet
 *
 * Every step change and every failure is a compare-and-set on (id, status='pending', step), so overlapping runs never
 * send, rent, sign or fail twice, and a stale run never undoes a newer step. Every node-built tx is decoded and checked
 * by assertTronTx before it is signed; the txID signed and stored is our own sha256 of the checked bytes. Keys are
 * derived per use and never logged or stored. A run spends at most about SUBREQUEST_BUDGET TronGrid/TronSave calls.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHAIN = "tron";
/** The deposit is topped up below this, with exactly this much (sun): bandwidth for the USDT transfer (chains/tron/txcheck). */
export { TOPUP_SUN };
/** Hot-wallet TRX each top-up needs: the top-up, activation (1 TRX) and account creation (0.1 TRX), plus bandwidth margin. */
export const HOT_MIN_SUN = TOPUP_SUN + 1_500_000n;
export const ENERGY_NORMAL = 65_000;
export const ENERGY_NEW_HOLDER = 131_000;
/** Rented on top of the estimate, so a slightly dearer transfer still fits; arrival is judged on the need itself. */
const ENERGY_MARGIN_PERCENT = 2;
export const rentAmount = (need: number): number => Math.ceil((need * (100 + ENERGY_MARGIN_PERCENT)) / 100);
/**
 * Most a rental may cost per unit of energy, in sun (the cap scales with the amount). Burning energy costs 100 sun per
 * unit, so renting above 90 is barely cheaper than letting the deposit burn TRX: refuse and alert instead.
 */
export const ENERGY_PRICE_CAP_SUN_PER_UNIT = 90;
/** fee_limit of the USDT transfer: with the energy rented this is never burned, it only bounds a surprise. */
export const FEE_LIMIT_SUN = MAX_FEE_LIMIT_SUN;
/** Rented energy that has not shown up after this long: the sweep is given up (the rental itself lasts an hour). */
export const ENERGY_WAIT_MS = 45 * MIN;
/** A tx not solid this long after its expiration, and unknown to the full node, can no longer be included: dropped. */
export const DROP_GRACE_MS = 10 * MIN;
/** A payment whose sweep failed for a reason that a retry will not fix soon waits this long. */
const RETRY_AFTER_MS = DAY;
/**
 * Counted failures after which a payment waits for an admin: paid ones (energy rented, then a revert or no energy) and
 * every tx_mismatch (top-up or transfer, paid or not), so tx_mismatch alerts are bounded per payment.
 */
export const MAX_PAID_FAILURES = 2;
export const NEEDS_ADMIN = "needs admin";
/** sweep_retry_at of a payment that waits for an admin (the largest JS date: never due by itself). */
const NEEDS_ADMIN_RETRY_AT = 8_640_000_000_000_000;
/** Pending Tron sweeps at once, over all payments. */
export const TRON_MAX_PENDING = 5;
/** TronGrid + TronSave calls per run (Workers subrequest limits), and what one advance or start may need at most. */
export const SUBREQUEST_BUDGET = 40;
const STEP_RESERVE = 12;
/** Candidates fetched per run. */
const MAX_CANDIDATES = 20;
/**
 * Wall time after the run's start past which no new step or send is begun (one already begun finishes). Cron
 * invocations on sub-hourly schedules get little wall time (Cloudflare: 30 s), and EVM chains run first: 20 s is the
 * safe default. Tron and Solana share it.
 */
export const RUN_DEADLINE_MS = 20_000;
export const DEADLINE_REACHED = "run deadline reached; continued next run";
/**
 * Options of a Tron or Solana run. `clock` is the wall clock for the deadline (tests inject one; `now` stays the logical
 * time written to D1). `startedAt` is when the cron run began (runSweeps passes it, so time spent on EVM chains counts);
 * without it the deadline runs from this sweeper's own start.
 */
export interface RunOptions {
  clock?: () => number;
  startedAt?: number;
}
/** True once RUN_DEADLINE_MS of wall time have passed since `startedAt` (or since this was called). */
export function deadline(o: RunOptions): () => boolean {
  const clock = o.clock ?? Date.now;
  const started = o.startedAt ?? clock();
  return () => clock() - started >= RUN_DEADLINE_MS;
}
export const TRONSAVE_MISSING = "TRONSAVE_API_KEY is not set";
/** sweep_error of a payment that holds only unexpected TRX (the sweeper never moves TRX). */
export const TRX_ONLY = "only TRX at the deposit (TRX recovery not supported yet)";
/**
 * unexpected_left on a swept Tron payment: 1 when its unexpected deposits include TRX, which the sweeper never moves
 * (only USDT is swept), so the dashboard does not show it as swept. Kept at 1 if already set.
 */
const TRX_LEFT = `CASE WHEN unexpected_left=1 OR json_extract(unexpected,'$."tron:trx"') IS NOT NULL THEN 1 ELSE 0 END`;

type Step = "topup" | "energy" | "rented" | "transfer";
interface Meta {
  deposit: string;
  index: number;
  topup?: { txid: string; exp: number };
  energy?: number;
  rentAt?: number;
  orderId?: string;
  /** An energy order may have been paid for in this sweep. */
  paid?: boolean;
  /** USDT atomic units, as a string (bigint). */
  amount?: string;
  /** Expiration of the transfer tx. */
  exp?: number;
}
interface Row {
  id: string;
  tx: string | null;
  txs: string | null;
  step: Step;
  meta: string;
  payment_ids: string;
  /** JSON {at}: last progress (listStuckSweeps). */
  req: string | null;
}
interface Ctx {
  env: Env;
  grid: ReturnType<typeof tronGrid>;
  /** The hot wallet (address only: its key never leaves src/signing). */
  hot: { address: string };
  /** Guard proof for the hot wallet: the only destination of a deposit's USDT transfer. */
  hotProof: Allowed;
  usdt: string;
  now: number;
  budget: { left: number };
  hotUsdtZero?: boolean;
  hotTrxLeft?: bigint;
}
type Advance = { done: boolean; result: SweepResult };

const pending = (reason = "a sweep is pending"): Advance => ({ done: false, result: { status: "skipped", reason, paymentIds: [] } });
const idsOf = (row: Pick<Row, "payment_ids">) => JSON.parse(row.payment_ids) as string[];
const txsOf = (row: Pick<Row, "tx" | "txs">) => (row.txs ? (JSON.parse(row.txs) as string[]) : row.tx ? [row.tx] : []);
/** The txID we sign and store: our own sha256 of the bytes assertTronTx checked (never the node's string). */
const localTxId = (rawHex: string) => bytesToHex(sha256(hexToBytes(rawHex)));
/** sweeps.req for Tron rows: when the sweep last made progress (listStuckSweeps measures from it). */
const progress = (now: number) => JSON.stringify({ at: now });

/** Every TronGrid call costs one unit of the run's budget. */
function budgeted<T extends object>(target: T, budget: { left: number }): T {
  return new Proxy(target, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        budget.left--;
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function hotUsdtZero(c: Ctx): Promise<boolean> {
  c.hotUsdtZero ??= (await c.grid.trc20Balance(c.usdt, c.hot.address, c.hot.address)) === 0n;
  return c.hotUsdtZero;
}

/** Moves a pending sweep from one step to the next; false when another run got there first (or it settled). */
async function cas(c: Ctx, id: string, from: Step, to: Step, meta: Meta): Promise<boolean> {
  const r = await c.env.DB.prepare("UPDATE sweeps SET step=?, meta=?, req=? WHERE id=? AND status='pending' AND step=?").bind(to, JSON.stringify(meta), progress(c.now), id, from).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Stale node answers in a row (payments.sweep_stale) before sweep.failing. */
export const STALE_ALERT_AFTER = 3;
/** Counts a stale (already expired) node answer for these payments; the third in a row raises sweep.failing. */
async function staleSeen(c: Ctx, ids: string[]): Promise<void> {
  for (const id of ids) {
    const r = await c.env.DB.prepare("UPDATE payments SET sweep_stale=sweep_stale+1 WHERE id=? RETURNING sweep_stale AS n").bind(id).first<{ n: number }>();
    if (r && r.n >= STALE_ALERT_AFTER)
      await recordAlert(c.env.DB, "sweep.failing", CHAIN, `TronGrid returned already-expired transactions for ${id} ${r.n} times in a row: is the node (TRON_API_URL) lagging?`, c.now);
  }
}
const staleReset = (c: Ctx, ids: string[]) => c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE payments SET sweep_stale=0 WHERE id=? AND sweep_stale<>0").bind(id)));

/** Short error and a retry time on the payments (they leave the candidate list until then). */
async function backoff(c: Ctx, ids: string[], error: string): Promise<void> {
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=?").bind(error.slice(0, 120), c.now + RETRY_AFTER_MS, id)));
}

/**
 * Counts a failed attempt (payments.sweep_paid_attempts): one that paid for energy, or a tx_mismatch. At
 * MAX_PAID_FAILURES the payments stop auto-retrying; returns the alert that tells the operator what to do. `last`
 * describes this failure for that alert.
 */
async function paidFailure(c: Ctx, ids: string[], last: string): Promise<[AlertKind, string] | null> {
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE payments SET sweep_paid_attempts=sweep_paid_attempts+1 WHERE id=?").bind(id)));
  const stop: string[] = [];
  for (const id of ids) {
    const r = await c.env.DB.prepare("SELECT sweep_paid_attempts AS n FROM payments WHERE id=?").bind(id).first<{ n: number }>();
    if (r && r.n >= MAX_PAID_FAILURES) stop.push(id);
  }
  if (stop.length === 0) return null;
  await c.env.DB.batch(
    stop.map((id) =>
      c.env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=?").bind(`${NEEDS_ADMIN}: ${MAX_PAID_FAILURES} sweep attempts failed (last: ${last})`.slice(0, 120), NEEDS_ADMIN_RETRY_AT, id),
    ),
  );
  return [
    "sweep.needs_admin",
    `${stop.join(", ")}: ${MAX_PAID_FAILURES} Tron sweep attempts failed (last: ${last}). It is no longer retried automatically: check the deposit address, TRON_API_URL and the TronSave orders, then click "Retry sweep" on its invoice page.`,
  ];
}

/**
 * Fails a pending sweep that is still at `step` (a run that read an older step changes nothing), then optionally
 * releases the lock of the given txs (they never moved funds), backs the payments off, alerts, and counts the failure
 * toward MAX_PAID_FAILURES when `count` (its description) is given.
 */
async function fail(
  c: Ctx,
  row: Pick<Row, "id" | "payment_ids">,
  step: Step,
  error: string,
  o: { release?: string[]; backoff?: boolean; count?: string; alert?: [AlertKind, string] } = {},
): Promise<boolean> {
  const r = await c.env.DB.prepare("UPDATE sweeps SET status='failed', error=?, req=? WHERE id=? AND status='pending' AND step=?").bind(error.slice(0, 120), progress(c.now), row.id, step).run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  const ids = idsOf(row);
  if (o.release?.length) await clearSweepLock(c.env.DB, ids, o.release);
  if (o.backoff) await backoff(c, ids, error);
  // Both alerts when the payment now needs an admin: they are different kinds, so neither dedupes the other.
  if (o.alert) await recordAlert(c.env.DB, o.alert[0], CHAIN, o.alert[1], c.now, { dedupe: o.alert[0] !== "sweep.tx_mismatch" });
  const escalation = o.count ? await paidFailure(c, ids, o.count) : null;
  // Every needs-admin escalation is recorded: each names other payments.
  if (escalation) await recordAlert(c.env.DB, escalation[0], CHAIN, escalation[1], c.now, { dedupe: false });
  await checkFailing(c.env, CHAIN, c.now);
  return true;
}
const failed = (row: Pick<Row, "payment_ids">, reason: string): Advance => ({ done: true, result: { status: "failed", reason, paymentIds: idsOf(row) } });
/** fail(), as an Advance: a failure another run pre-empted leaves the row to that run. */
async function failStep(c: Ctx, row: Row, step: Step, error: string, o: Parameters<typeof fail>[4] = {}): Promise<Advance> {
  return (await fail(c, row, step, error, o)) ? failed(row, error) : pending();
}

/**
 * The pending-row guard, one statement: inserts only if this payment has no pending Tron sweep and fewer than
 * TRON_MAX_PENDING are pending in all (the unique index per payment is the backstop).
 */
async function insert(c: Ctx, id: string, paymentId: string, step: Step, meta: Meta, tx: string | null): Promise<boolean> {
  const ids = JSON.stringify([paymentId]);
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,txs,step,meta,req)
       SELECT ?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9
       WHERE NOT EXISTS (SELECT 1 FROM sweeps WHERE chain=?2 AND status='pending' AND payment_ids=?5)
         AND (SELECT COUNT(*) FROM sweeps WHERE chain=?2 AND status='pending') < ?10`,
    )
      .bind(id, CHAIN, tx, c.now, ids, tx ? JSON.stringify([tx]) : null, step, JSON.stringify(meta), progress(c.now), TRON_MAX_PENDING)
      .run();
    return (r.meta.changes ?? 0) === 1;
  } catch (e) {
    if (/unique/i.test(errText(e))) return false;
    throw e;
  }
}
const pendingCount = async (c: Ctx) =>
  (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sweeps WHERE chain=? AND status='pending'").bind(CHAIN).first<{ n: number }>())?.n ?? 0;

/** Broadcasts a verified, signed tx. "unknown": no usable answer (it may have been accepted); expiry settles it. */
async function broadcast(c: Ctx, raw: string, sig: string): Promise<"sent" | "unknown" | { code: string }> {
  try {
    const r = await c.grid.broadcastHex(encodeSignedTx(raw, sig));
    return r.ok ? "sent" : { code: r.code };
  } catch (e) {
    console.warn(`0crypto: sweep tron broadcast answer lost: ${e instanceof Error ? e.name : "Error"}`);
    return "unknown";
  }
}

// ---- Steps ----

async function advance(c: Ctx, row: Row): Promise<Advance> {
  const meta = JSON.parse(row.meta) as Meta;
  switch (row.step) {
    case "topup": {
      const top = meta.topup!;
      const st = await c.grid.solidTxStatus(top.txid);
      if (st === null) {
        if (c.now <= top.exp + DROP_GRACE_MS) return pending();
        // In a block but not solid yet: it will be. Only a tx no node has can be written off.
        if (await c.grid.fullNodeKnows(top.txid)) return pending("waiting for the top-up to solidify");
        return failStep(c, row, "topup", "dropped", { alert: ["sweep.failing", `a TRX top-up for the Tron deposit ${meta.deposit} was dropped; the sweep starts over`] });
      }
      if (!st.success) return failStep(c, row, "topup", "top-up failed", { backoff: true, alert: ["sweep.failing", `a TRX top-up for the Tron deposit ${meta.deposit} failed on chain`] });
      if (!(await cas(c, row.id, "topup", "energy", meta))) return pending();
      return rent(c, { ...row, step: "energy", req: progress(c.now) }, meta);
    }
    case "energy":
      return rent(c, row, meta);
    case "rented":
      if ((await c.grid.energyAvailable(meta.deposit)) >= meta.energy!) return transfer(c, row, meta);
      if (c.now - meta.rentAt! <= ENERGY_WAIT_MS) return pending("waiting for rented energy");
      return failStep(c, row, "rented", "energy did not arrive", {
        backoff: true,
        ...(meta.paid === true ? { count: "rented energy that never arrived" } : {}),
        alert: ["sweep.failing", `energy rented for the Tron deposit ${meta.deposit} (TronSave order ${meta.orderId ?? "unknown"}) did not arrive in time; the payment is retried in a day`],
      });
    case "transfer":
      return reconcile(c, row, meta);
    default:
      throw new Error(`tron sweep ${row.id}: unknown step`);
  }
}

async function rent(c: Ctx, row: Row, meta: Meta): Promise<Advance> {
  const energy = meta.energy ?? ((await hotUsdtZero(c)) ? ENERGY_NEW_HOLDER : ENERGY_NORMAL);
  const base: Meta = { ...meta, energy };
  if ((await c.grid.energyAvailable(meta.deposit)) >= energy) return transfer(c, row, base);
  if (!c.env.TRONSAVE_API_KEY) {
    await recordAlert(c.env.DB, "sweep.stuck", CHAIN, `a Tron sweep needs energy but ${TRONSAVE_MISSING}: set it to continue`, c.now);
    return pending(TRONSAVE_MISSING);
  }
  // `paid` from here on: once the buy is sent an order may exist, whatever the answer.
  const m: Meta = { ...base, rentAt: c.now, paid: true };
  if (!(await cas(c, row.id, "energy", "rented", m))) return pending();
  c.budget.left -= 2;
  try {
    m.orderId = await rentEnergy(c.env, meta.deposit, rentAmount(energy), ENERGY_PRICE_CAP_SUN_PER_UNIT);
    await c.env.DB.prepare("UPDATE sweeps SET meta=? WHERE id=? AND status='pending' AND step='rented'").bind(JSON.stringify(m), row.id).run();
  } catch (e) {
    if (!(e instanceof TronSaveError)) throw e;
    if (!e.definite) {
      // An order may exist: wait for the energy (or the timeout) rather than renting twice.
      console.warn(`0crypto: sweep tron energy rental unclear: ${e.message}`);
      return pending("waiting for rented energy");
    }
    // No order was placed: back to the energy step; a later run tries again. `req` goes back to what it was, so a sweep
    // that keeps being refused still ages and shows on the dashboard as stuck.
    await c.env.DB.prepare("UPDATE sweeps SET step='energy', meta=?, req=? WHERE id=? AND status='pending' AND step='rented'").bind(JSON.stringify(base), row.req, row.id).run();
    if (e.tooExpensive) await recordAlert(c.env.DB, "sweep.too_expensive", CHAIN, `energy for a Tron sweep costs more than ${ENERGY_PRICE_CAP_SUN_PER_UNIT} sun per unit; not renting (${e.message})`, c.now);
    else await recordAlert(c.env.DB, "sweep.failing", CHAIN, `TronSave did not rent energy for a Tron sweep: ${e.message}`, c.now);
    return pending(e.tooExpensive ? "energy over the price cap" : "energy rental refused");
  }
  if ((await c.grid.energyAvailable(meta.deposit)) >= energy) return transfer(c, { ...row, step: "rented" }, m);
  return { done: false, result: { status: "skipped", reason: "waiting for rented energy", paymentIds: idsOf(row) } };
}

async function transfer(c: Ctx, row: Row, meta: Meta): Promise<Advance> {
  const ids = idsOf(row);
  if (tronDepositAddress(c.env.MASTER_SEED ?? "", meta.index) !== meta.deposit)
    return failStep(c, row, row.step, "deposit key mismatch", {
      backoff: true,
      alert: ["sweep.payment_failed", `the key derived for ${ids.join(", ")} no longer matches its Tron deposit (was MASTER_SEED changed?); not sweeping`],
    });
  // The deposit's real balance, not payment.final: whatever is there goes (late top-ups included).
  const amount = await c.grid.trc20Balance(c.usdt, meta.deposit, c.hot.address);
  if (amount === 0n)
    return failStep(c, row, row.step, "no USDT at the deposit", { backoff: true, alert: ["sweep.payment_failed", `no USDT at the Tron deposit of ${ids.join(", ")}: nothing to sweep`] });
  const u = await c.grid.triggerTrc20Transfer(meta.deposit, c.usdt, c.hot.address, amount, FEE_LIMIT_SUN);
  let exp: number;
  try {
    exp = assertTronTx(u, { type: "TriggerSmartContract", owner: meta.deposit, to: c.hot.address, amount, contract: c.usdt }, c.now).expiration;
  } catch (e) {
    // A lagging node: not an attack, nothing signed; the next run asks again (sweep.failing after 3 in a row).
    if (e instanceof StaleTx) {
      await staleSeen(c, ids);
      return pending("stale node answer");
    }
    if (!(e instanceof TxMismatch)) throw e;
    // Always counted (paid or not): a compromised node can neither make us rent energy every day nor raise an alert every
    // day; at the cap the payment waits for an admin.
    return failStep(c, row, row.step, "tx_mismatch", {
      backoff: true,
      count: "TronGrid built a USDT transfer that is not the one asked for",
      alert: ["sweep.tx_mismatch", `TronGrid built a USDT transfer for ${ids.join(", ")} that is not the one asked for (${e.reason}); nothing was signed`],
    });
  }
  await staleReset(c, ids);
  const txid = localTxId(u.raw_data_hex);
  const sig = signTronTx(c.env.MASTER_SEED ?? "", { role: "deposit", index: meta.index }, u.raw_data_hex, [c.hotProof]).signature;
  const m: Meta = { ...meta, amount: amount.toString(), exp };
  // Step and lock in one batch, before the broadcast: a crash after it can never lose the tx, and the payment keeps
  // its credit while the address empties. The lock is only written if this run won the step change.
  const [upd] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sweeps SET step='transfer', tx=?, txs=?, meta=?, req=? WHERE id=? AND status='pending' AND step=?").bind(
      txid, JSON.stringify([...txsOf(row), txid]), JSON.stringify(m), progress(c.now), row.id, row.step,
    ),
    ...ids.map((pid) => c.env.DB.prepare("UPDATE payments SET sweep_tx=? WHERE id=? AND EXISTS (SELECT 1 FROM sweeps WHERE id=? AND status='pending' AND tx=?)").bind(txid, pid, row.id, txid)),
  ]);
  if ((upd!.meta.changes ?? 0) !== 1) return pending();
  const r = await broadcast(c, u.raw_data_hex, sig);
  if (r === "sent" || r === "unknown") return { done: false, result: { status: "sent", tx: txid, paymentIds: ids } };
  return failStep(c, { ...row, step: "transfer" }, "transfer", `broadcast failed: ${r.code}`, {
    release: [txid],
    alert: ["sweep.failing", `the node refused a Tron sweep tx for ${ids.join(", ")} (${r.code})`],
  });
}

async function reconcile(c: Ctx, row: Row, meta: Meta): Promise<Advance> {
  const ids = idsOf(row);
  const tx = row.tx!;
  const amount = BigInt(meta.amount!);
  const info = await c.grid.solidTxInfo(tx, c.hot.address);
  if (info === null) {
    if (c.now <= meta.exp! + DROP_GRACE_MS) return pending();
    if (await c.grid.fullNodeKnows(tx)) return pending("waiting for the transfer to solidify");
    // Past expiration and unknown to the full node: it cannot land any more. Released and retried at once (like an
    // EVM drop); the new sweep re-reads the deposit's TRX, which the attempt may have spent.
    return failStep(c, row, "transfer", "dropped", { release: [tx], alert: ["sweep.failing", `a Tron sweep tx for ${ids.join(", ")} was dropped; it is retried`] });
  }
  if (info.value === amount) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE sweeps SET status='confirmed', req=? WHERE id=? AND status='pending'").bind(progress(c.now), row.id),
      ...ids.map((pid) =>
        c.env.DB.prepare(
          `UPDATE payments SET swept_at=?, sweep_tx=?, sweep_error=NULL, sweep_retry_at=NULL, sweep_paid_attempts=0, sweep_stale=0, unexpected_left=${TRX_LEFT} WHERE id=? AND swept_at IS NULL AND EXISTS (SELECT 1 FROM sweeps WHERE id=? AND status='confirmed' AND tx=?)`,
        ).bind(c.now, tx, pid, row.id, tx),
      ),
    ]);
    return { done: true, result: { status: "idle", reason: "swept", tx, paymentIds: ids } };
  }
  // Solid but not exactly the amount to the hot wallet: a revert (0) or something unexplained. Nothing is marked swept.
  const why = info.value === 0n ? "reverted" : "amount mismatch";
  return failStep(c, row, "transfer", why, {
    release: [tx],
    backoff: true,
    ...(meta.paid === true ? { count: `the transfer ${why === "reverted" ? "reverted" : "paid another amount"} after energy was rented` } : {}),
    alert: ["sweep.payment_failed", `the Tron sweep of ${ids.join(", ")} ${why === "reverted" ? "reverted" : `paid ${info.value} instead of ${amount}`}; retried in a day`],
  });
}

/**
 * A deposit that reads 0 USDT may have been swept by an earlier attempt that was written off (an admin "mark failed",
 * a crash) after its tx landed. If one of this payment's earlier transfer txs paid the hot wallet, mark it swept.
 */
async function sweptEarlier(c: Ctx, p: PaymentRow): Promise<boolean> {
  const { results } = await c.env.DB.prepare(
    "SELECT tx FROM sweeps WHERE chain=? AND payment_ids=? AND status<>'pending' AND step='transfer' AND tx IS NOT NULL ORDER BY created_at DESC LIMIT 3",
  )
    .bind(CHAIN, JSON.stringify([p.id]))
    .all<{ tx: string }>();
  for (const r of results) {
    const info = await c.grid.solidTxInfo(r.tx, c.hot.address);
    if (info && info.value > 0n) {
      await c.env.DB.prepare(
        `UPDATE payments SET swept_at=?, sweep_tx=?, sweep_error=NULL, sweep_retry_at=NULL, sweep_paid_attempts=0, sweep_stale=0, unexpected_left=${TRX_LEFT} WHERE id=? AND swept_at IS NULL`,
      )
        .bind(c.now, r.tx, p.id)
        .run();
      return true;
    }
  }
  return false;
}

/**
 * A candidate that holds only unexpected TRX and never received USDT (an expired payment that got only TRX). The sweeper
 * moves USDT only, so there is nothing for it to do: no RPC call is made. Such a payment is a candidate only past its
 * invoice's expiry + 7 days + 1 hour, after the watcher stopped observing it, so no USDT can be credited to it later.
 */
export const trxOnly = (p: PaymentRow): boolean =>
  p.received === 0n && p.final === 0n && p.unexpected != null && Object.keys(p.unexpected).length > 0 && Object.keys(p.unexpected).every((k) => k === "tron:trx");

/**
 * Parks a TRX-only candidate: unexpected_left=1 (the dashboard shows the TRX as left at the deposit) and a retry time that
 * is never due by itself, so it stops taking a candidate slot. unexpected_left doubles as the "already flagged" marker:
 * the alert is raised only by the run that set it, so once per payment, also after an admin's Retry sweep.
 */
async function parkTrxOnly(env: Env, now: number, p: PaymentRow): Promise<void> {
  const [flag] = await env.DB.batch([
    env.DB.prepare("UPDATE payments SET unexpected_left=1 WHERE id=? AND unexpected_left=0 AND swept_at IS NULL").bind(p.id),
    env.DB.prepare("UPDATE payments SET sweep_error=?, sweep_retry_at=? WHERE id=? AND swept_at IS NULL").bind(TRX_ONLY, NEEDS_ADMIN_RETRY_AT, p.id),
  ]);
  if ((flag!.meta.changes ?? 0) === 1)
    await recordAlert(
      env.DB,
      "sweep.payment_failed",
      CHAIN,
      `the Tron deposit ${p.address} of ${p.id} holds only TRX (${p.unexpected!["tron:trx"]} sun), no USDT: TRX recovery is not supported yet, so it stays at the deposit and is not retried`,
      now,
      { dedupe: false },
    );
}

/** Starts a sweep for one due payment. Null: nothing was done (skipped, backed off, or another run has it). */
async function startOne(c: Ctx, p: PaymentRow): Promise<SweepResult | null> {
  if (tronDepositAddress(c.env.MASTER_SEED ?? "", p.derivation_index) !== p.address) {
    await backoff(c, [p.id], "deposit key does not match the address");
    await recordAlert(c.env.DB, "sweep.payment_failed", CHAIN, `the derived key of ${p.id} does not match its Tron address; not sweeping`, c.now);
    return null;
  }
  if ((await c.grid.trc20Balance(c.usdt, p.address, c.hot.address)) === 0n) {
    if (await sweptEarlier(c, p)) return { status: "idle", reason: "swept by an earlier attempt", paymentIds: [p.id] };
    await backoff(c, [p.id], "no USDT at the deposit");
    await recordAlert(c.env.DB, "sweep.payment_failed", CHAIN, `no USDT at the Tron deposit of ${p.id}: nothing to sweep`, c.now);
    return null;
  }
  const id = `swp_${crypto.randomUUID().replaceAll("-", "")}`;
  const meta: Meta = { deposit: p.address, index: p.derivation_index };

  if ((await c.grid.trxBalance(p.address)) >= TOPUP_SUN) {
    if (!(await insert(c, id, p.id, "energy", meta, null))) return null;
    return (await advance(c, { id, tx: null, txs: null, step: "energy", meta: JSON.stringify(meta), payment_ids: JSON.stringify([p.id]), req: progress(c.now) })).result;
  }

  // Top-up: exactly TOPUP_SUN from the hot wallet, verified, signed, recorded with the guarded insert, then broadcast.
  c.hotTrxLeft ??= await c.grid.trxBalance(c.hot.address);
  if (c.hotTrxLeft < HOT_MIN_SUN) {
    await recordAlert(c.env.DB, "sweep.insufficient_gas", CHAIN, `the Tron hot wallet ${c.hot.address} holds too little TRX for more deposit top-ups (each needs ${HOT_MIN_SUN} sun)`, c.now);
    return { status: "skipped", reason: "insufficient TRX in the hot wallet", paymentIds: [] };
  }
  const u = await c.grid.createTrxTransfer(c.hot.address, p.address, TOPUP_SUN);
  let exp: number;
  try {
    exp = assertTronTx(u, { type: "TransferContract", owner: c.hot.address, to: p.address, amount: TOPUP_SUN }, c.now).expiration;
  } catch (e) {
    if (e instanceof StaleTx) {
      await staleSeen(c, [p.id]); // a lagging node: asked again next run
      return null;
    }
    if (!(e instanceof TxMismatch)) throw e;
    // Recorded as a failed sweep (no pending row was ever taken), so the refusal shows next to the others.
    await c.env.DB.prepare("INSERT INTO sweeps(id,chain,tx,created_at,status,payment_ids,error,step,meta,req) VALUES(?,?,NULL,?,'failed',?,'tx_mismatch','topup',?,?)")
      .bind(id, CHAIN, c.now, JSON.stringify([p.id]), JSON.stringify(meta), progress(c.now))
      .run();
    await backoff(c, [p.id], "tx_mismatch");
    await recordAlert(c.env.DB, "sweep.tx_mismatch", CHAIN, `TronGrid built a TRX top-up for ${p.id} that is not the one asked for (${e.reason}); nothing was signed`, c.now, { dedupe: false });
    // Counted like a transfer mismatch: at the cap the payment waits for an admin, so these alerts are bounded.
    const escalation = await paidFailure(c, [p.id], "TronGrid built a TRX top-up that is not the one asked for");
    if (escalation) await recordAlert(c.env.DB, escalation[0], CHAIN, escalation[1], c.now, { dedupe: false });
    await checkFailing(c.env, CHAIN, c.now);
    return { status: "failed", reason: "tx_mismatch", paymentIds: [p.id] };
  }
  await staleReset(c, [p.id]);
  const txid = localTxId(u.raw_data_hex);
  // The top-up pays our own deposit (derived again by the guard from its index), nothing else.
  const sig = signTronTx(c.env.MASTER_SEED ?? "", { role: "hot" }, u.raw_data_hex, [await allowedDestination(c.env, CHAIN, p.address, { depositIndex: p.derivation_index })]).signature;
  if (!(await insert(c, id, p.id, "topup", { ...meta, topup: { txid, exp } }, txid))) return null;
  c.hotTrxLeft -= HOT_MIN_SUN;
  const r = await broadcast(c, u.raw_data_hex, sig);
  if (r === "sent" || r === "unknown") return { status: "sent", tx: txid, paymentIds: [p.id] };
  const reason = `top-up broadcast failed: ${r.code}`;
  await fail(c, { id, payment_ids: JSON.stringify([p.id]) }, "topup", reason, { alert: ["sweep.failing", `the node refused a TRX top-up for ${p.id} (${r.code})`] });
  return { status: "failed", reason, paymentIds: [p.id] };
}

/** One result for the run: sent if anything was sent, else failed, else skipped, else idle (Tron and Solana). */
export function summarize(results: SweepResult[]): SweepResult {
  const by = (s: SweepResult["status"]) => results.filter((r) => r.status === s);
  const pick = [by("sent"), by("failed"), by("skipped")].find((g) => g.length > 0);
  const paymentIds = [...new Set(results.flatMap((r) => r.paymentIds))];
  if (!pick) return { status: "idle", paymentIds, ...(results[0]?.reason ? { reason: results[0].reason } : {}) };
  const tx = [...pick].reverse().find((r) => r.tx)?.tx;
  const reason = pick.find((r) => r.reason)?.reason;
  return { status: pick[0]!.status, paymentIds, ...(tx ? { tx } : {}), ...(reason ? { reason } : {}) };
}
const errored = (e: unknown): SweepResult => {
  const name = e instanceof Error ? e.name : "Error";
  console.warn(`0crypto: sweep tron step failed: ${name}`);
  return { status: "failed", reason: name, paymentIds: [] };
};

/**
 * One Tron sweep run: advance every pending Tron sweep by what is safe, then start new ones (oldest due first) up to
 * TRON_MAX_PENDING, within the run's subrequest budget and RUN_DEADLINE_MS of wall time (the rest waits for the next run). Without TRONSAVE_API_KEY only
 * the energy step is blocked (one deduped sweep.stuck alert) and no new sweep starts; detection never depends on it.
 * A failure is isolated to its sweep.
 */
export async function runTronSweep(env: Env, now: number = Date.now(), o: RunOptions = {}): Promise<SweepResult> {
  const late = deadline(o);
  const rows = (await env.DB.prepare("SELECT id,tx,txs,step,meta,payment_ids,req FROM sweeps WHERE chain=? AND status='pending' ORDER BY created_at, rowid").bind(CHAIN).all<Row>()).results;
  const hasKey = !!env.TRONSAVE_API_KEY;
  const stuckAlert = async () => {
    let due = false;
    for (const p of await listSweepCandidates(env.DB, CHAIN, now, MAX_CANDIDATES)) {
      if (!trxOnly(p)) due = true;
      else await parkTrxOnly(env, now, p); // nothing to rent energy for
    }
    if (due)
      await recordAlert(env.DB, "sweep.stuck", CHAIN, `Tron deposits are due for a sweep but ${TRONSAVE_MISSING} (energy rental): set it to sweep them`, now);
  };
  if (!hasKey && rows.length === 0) {
    await stuckAlert();
    return { status: "skipped", reason: TRONSAVE_MISSING, paymentIds: [] };
  }
  const budget = { left: SUBREQUEST_BUDGET };
  const hot = { address: tronHotAddress(env.MASTER_SEED ?? "") };
  const c: Ctx = { env, grid: budgeted(tronGrid(env), budget), hot, hotProof: await allowedDestination(env, CHAIN, hot.address), usdt: getAsset("tron:usdt").contract!, now, budget };
  const results: SweepResult[] = [];
  const deferred = (): SweepResult => ({ status: "skipped", reason: "subrequest budget reached; continued next run", paymentIds: [] });
  const timedOut = (): SweepResult => ({ status: "skipped", reason: DEADLINE_REACHED, paymentIds: [] });

  const busy = new Set<string>();
  for (const row of rows) {
    if (budget.left < STEP_RESERVE || late()) {
      results.push(budget.left < STEP_RESERVE ? deferred() : timedOut());
      for (const r of rows) for (const id of idsOf(r)) busy.add(id);
      break;
    }
    try {
      const a = await advance(c, row);
      results.push(a.result);
      if (!a.done) for (const id of idsOf(row)) busy.add(id);
    } catch (e) {
      results.push(errored(e));
      for (const id of idsOf(row)) busy.add(id);
    }
  }
  if (!hasKey) {
    await stuckAlert();
    results.push({ status: "skipped", reason: TRONSAVE_MISSING, paymentIds: [] });
    return summarize(results);
  }

  let open = await pendingCount(c);
  const due = (await listSweepCandidates(env.DB, CHAIN, now, MAX_CANDIDATES)).filter((p) => p.asset === "tron:usdt" && !busy.has(p.id));
  for (const p of due) {
    if (trxOnly(p)) {
      await parkTrxOnly(env, now, p);
      continue;
    }
    if (open >= TRON_MAX_PENDING) break;
    if (budget.left < STEP_RESERVE) {
      results.push(deferred());
      break;
    }
    if (late()) {
      results.push(timedOut());
      break;
    }
    try {
      const r = await startOne(c, p);
      if (r) results.push(r);
    } catch (e) {
      results.push(errored(e));
    }
    open = await pendingCount(c);
  }
  return summarize(results);
}
