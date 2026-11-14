import { EVM_CHAINS, isEvmChain, type EvmChain } from "../chains/evm/config";
import { evmFeeQuote } from "../chains/evm/fees";
import { solBalance, tokenAccounts } from "../chains/solana/adapter";
import { findAta } from "../chains/solana/pda";
import { assertSolRouteMessage, compileSolRoute, routeFee, routePlan, type SolRouteAsset } from "../chains/solana/routetx";
import { RpcRejected, solRpc } from "../chains/solana/rpc";
import { SolTxMismatch, USDC_MINT } from "../chains/solana/sweeptx";
import { utxoExplorer } from "../chains/registry";
import type { UtxoChain } from "../chains/utxo/networks";
import { DUST, outputScript, ownScriptLength, routeFeeRate, spendFee } from "../chains/utxo/spend";
import { getAsset } from "../core/assets";
import { parseDecimal } from "../core/money";
import { acquireHotNonce, holdsHotNonce, HOT_WALLET_BUSY, releaseHotNonce } from "../db/noncelease";
import { getInvoice, getPayment, SWEEP_AFTER_EXPIRY_MS, type PaymentRow } from "../db/repo";
import type { Env } from "../env";
import { evmHotAddress, solHotAddress } from "../signing/addresses";
import { signEvmTx } from "../signing/evm";
import { signSolanaTx } from "../signing/solana";
import { buildUtxoSpend } from "../signing/utxo";
import { ATA_RENT_LAMPORTS } from "../sweep/solana";
import { validateAssetAddress } from "./addr";
import { ROUTE_GAS_RESERVE } from "./config";
import { allowedDestination, normalizeDestination, type Allowed } from "./guard";
import { allocateOwnAddress } from "./own";
import { recordRefundApproved } from "./refund-alert";
import { acquireRouterLock, committedAmount, holdsRouterLock, hotAvailable, releaseRouterLock } from "./router";
import { latestBlockhash, plainWallet, reservedOutpoints } from "./swap";

/*
 * Dashboard refunds (src/admin/refunds.tsx: CSRF, a passkey confirmation, at most one per hour). A refund pays the
 * customer from the gateway's own funds, never from a routing destination:
 *   EVM, Solana  from the chain's HOT wallet (the payment's asset, exact amount): EVM native value or ERC-20 transfer,
 *                Solana SOL transfer or USDC (ATA create for the customer + transferChecked, chains/solana/routetx.ts)
 *   BTC/LTC/DOGE from the payment's own deposit UTXOs, only while they are unrouted (routed_at NULL), not already
 *                refunded (refunded_at NULL) and no route leg holds them; change, if any, to a fresh own address
 *                (own_addresses, purpose change). The tx is recorded together with payments.refunded_at, in one
 *                transaction, so the router never plans those outputs again (routableInputs honours it).
 *   Tron         refused for now: the hot wallet's USDT transfer needs rented energy (the swap executor's multi-run
 *                TronSave step), which an admin request cannot wait for. Refund Tron USDT by hand.
 * Every refund action (create + send, re-approve, cancel) holds the router lease (withRefundLease): while a router run
 * or another action holds it, the refund is refused with 409 and nothing is recorded or consumed. An EVM refund also
 * holds its chain's hot nonce lease (src/db/noncelease.ts; an EVM sweep may be sending): held -> 409 likewise. Before the proof is
 * minted the lease is re-checked, and the amount must fit what routing has not committed: EVM and Solana, amount <=
 * hotAvailable(asset) (which keeps GAS_RESERVE / ROUTE_GAS_RESERVE and fees) - committedAmount(asset), the router's own
 * accounting; BTC/LTC/DOGE, the payment's own deposit outputs that no route leg holds (only that address is read).
 * Confirmed payments, and partial or expired ones once their invoice expired more than SWEEP_AFTER_EXPIRY_MS ago
 * (refundBlock). The amount is > 0 and at most refundBound (BTC/LTC/DOGE: what the deposit holds; EVM, Solana: the
 * payment's final amount) minus every earlier refund of it that was not cancelled (checked in the INSERT itself). The row is
 * inserted approved; the send then claims it (compare-and-set), runs the pre-sign checks (balances, reserve), mints
 * the refund proof with allowedDestination({ refundId }) (which consumes it: once only, bound to the payment's asset
 * and this amount), signs through the chain's signer, records the tx while the claim still holds, and only then
 * broadcasts. A failure after the mint leaves the refund "consumed, unsent": nothing was broadcast (no tx was
 * recorded), and it is sent again only after the operator re-approves it (a new passkey confirmation).
 * Warning shown on the form: REFUND_WARNING.
 */

export const REFUND_WARNING = "This refund links the gateway's hot wallet to this customer on-chain.";
export const TRON_REFUNDS_REFUSED =
  "Tron refunds are not supported yet: the hot wallet's USDT transfer needs rented energy, which a dashboard request cannot wait for. Refund this payment by hand from a wallet you control.";
/**
 * One refund per this window, kept by the refunds table alone (D1: createRefund's INSERT and reapproveRefund's UPDATE
 * check it in the same statement; refundWindowTaken is the dashboard's read-only pre-check). Only a refund whose proof
 * was minted (consumed_at, set at the mint; every recorded tx was minted first) counts: one refused before the mint (a
 * short hot wallet, a busy lease) leaves the window free.
 */
export const REFUND_WINDOW_MS = 3_600_000;
/** A UTXO refund tx recorded this recently is never cancelled: it may still be relayed (an explorer can lag). */
export const CANCEL_MIN_AGE_MS = 6 * 3_600_000;
/** SQL: a refund other than ?id minted inside the window (?since = now - REFUND_WINDOW_MS). */
const MINTED_SINCE = "SELECT 1 FROM refunds WHERE consumed_at > ?";
export const ONE_PER_HOUR = "only one refund per hour";
export const NOT_REAPPROVABLE = "Only a refund that was not sent (no tx recorded) and not cancelled can be re-approved.";
/** A send claim older than this (no tx recorded) is from a request that died: it may be taken over. */
const CLAIM_STALE_MS = 2 * 60_000;

export const ROUTING_BUSY = "routing is running, try again in a few minutes";

export class RefundRefused extends Error {
  override name = "RefundRefused";
  constructor(
    message: string,
    readonly code: 400 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export interface RefundRow {
  id: string;
  payment_id: string;
  to_address: string;
  amount: string;
  approved_at: number | null;
  tx: string | null;
  consumed_at: number | null;
  created_at: number | null;
  claim: string | null;
  claimed_at: number | null;
  sent_at: number | null;
  error: string | null;
  cancelled_at: number | null;
  inputs: string | null;
  /** When the signed tx was recorded (migration 0016; older rows: null, claimed_at stands in). */
  tx_at: number | null;
}

/** sent; broadcast_failed (a tx was recorded but the node did not take it); consumed_unsent; approved_unsent; cancelled. */
export type RefundState = "sent" | "broadcast_failed" | "consumed_unsent" | "approved_unsent" | "cancelled";
export function refundState(r: RefundRow): RefundState {
  if (r.cancelled_at) return "cancelled";
  if (r.tx) return r.sent_at ? "sent" : "broadcast_failed";
  return r.consumed_at ? "consumed_unsent" : "approved_unsent";
}

export async function listRefunds(db: D1Database, paymentId: string): Promise<RefundRow[]> {
  return (await db.prepare("SELECT * FROM refunds WHERE payment_id=? ORDER BY created_at, id").bind(paymentId).all<RefundRow>()).results;
}

/** What may still be refunded of `bound` given `prior` (the payment's refund rows): every refund not cancelled is taken off. */
function leftAfter(bound: bigint, prior: RefundRow[]): bigint {
  const left = bound - prior.filter((r) => !r.cancelled_at).reduce((s, r) => s + BigInt(r.amount), 0n);
  return left > 0n ? left : 0n;
}

/**
 * The most a payment may be refunded in all (before earlier refunds):
 *   BTC/LTC/DOGE  what its deposit address holds now (every confirmed output, read from the explorer): the refund tx
 *                 spends exactly those outputs, so it can never pay out more than this customer sent there, whatever
 *                 was recorded (a partial payment's late top-up, an expired one's deposit the watcher no longer saw).
 *                 The send re-reads them and fits amount + fee inside them.
 *   EVM, Solana   the payment's final amount: what arrived in the payment's own asset (credited, or for a partial
 *                 payment received). Unexpected deposits of other tokens are not refunded from the dashboard.
 */
async function refundBound(env: Env, p: PaymentRow): Promise<bigint> {
  if (!UTXO.has(p.chain)) return p.final;
  return (await utxoExplorer(env, p.chain as UtxoChain).utxos(p.address)).filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0n);
}

/** What may still be refunded: refundBound minus every refund recorded for it, cancelled ones excepted. */
export async function refundable(env: Env, p: PaymentRow): Promise<bigint> {
  return leftAfter(await refundBound(env, p), await listRefunds(env.DB, p.id));
}

const UTXO = new Set(["btc", "ltc", "doge"]);
const xpubOf = (env: Env, chain: string) => env[`${chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`];

/**
 * Why this payment cannot be refunded from the dashboard at all, or null. `invoiceExpiresAt` is its invoice's expiry:
 * a partial payment, or an expired one with funds, is refundable only once that is more than SWEEP_AFTER_EXPIRY_MS
 * ago (the sweeps' and the router's window: the watcher has stopped following the address, so a refund cannot race a
 * late credit).
 */
export function refundBlock(env: Env, p: PaymentRow, invoiceExpiresAt: number | null, now: number): string | null {
  if (p.status !== "confirmed" && p.status !== "partial" && p.status !== "expired") return `only a confirmed, partial or expired payment can be refunded (this one is ${p.status})`;
  if (p.status !== "confirmed" && (invoiceExpiresAt === null || invoiceExpiresAt + SWEEP_AFTER_EXPIRY_MS >= now))
    return "a partial or expired payment can be refunded only once its invoice expired more than 7 days and an hour ago (until then the payment may still complete)";
  if (p.chain === "tron") return TRON_REFUNDS_REFUSED;
  if (UTXO.has(p.chain)) {
    if (xpubOf(env, p.chain)) return `${p.chain} is in watch mode (xpub): the gateway holds no key for this deposit`;
    if (p.route_note) return `this payment's deposit was ${p.route_note}: refund by hand`;
    if (p.routed_at != null) return "this payment's deposit was already routed to the private destination; the gateway no longer holds its funds: refund by hand";
    if (p.refunded_at != null) return "this payment's deposit was already spent by a refund (any change went to an address of yours): refund by hand";
    return null;
  }
  if (p.final <= 0n) return "nothing arrived in this payment's own asset (unexpected deposits of other tokens are refunded by hand)";
  if (isEvmChain(p.chain) || p.chain === "sol") return null;
  return `refunds are not supported on ${p.chain}`;
}

/** refundBlock with the payment's invoice read. */
export async function refundBlockOf(env: Env, p: PaymentRow, now: number): Promise<string | null> {
  const inv = await getInvoice(env.DB, p.invoice_id);
  return refundBlock(env, p, inv?.expires_at ?? null, now);
}

/** The refund address, normalized for the payment's chain, or RefundRefused. Never one of the gateway's own addresses. */
export async function checkRefundAddress(env: Env, p: PaymentRow, raw: string): Promise<string> {
  const to = raw.trim();
  let a: string;
  try {
    if (isEvmChain(p.chain)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/i.test(to)) throw new Error("bad");
      a = to.toLowerCase();
    } else {
      validateAssetAddress(p.asset, to);
      a = normalizeDestination(p.chain, to);
    }
  } catch {
    throw new RefundRefused(`that is not a valid ${p.chain} address`);
  }
  const own = isEvmChain(p.chain) ? (await evmHotAddress(env)).toLowerCase() : p.chain === "sol" ? solHotAddress(env.MASTER_SEED ?? "") : null;
  const deposit = await env.DB.prepare(isEvmChain(p.chain) ? "SELECT 1 AS x FROM payments WHERE lower(address)=? LIMIT 1" : "SELECT 1 AS x FROM payments WHERE address=? LIMIT 1").bind(a).first();
  const ownUtxo = await env.DB.prepare("SELECT 1 AS x FROM own_addresses WHERE address=? LIMIT 1").bind(a).first();
  if (a === own || deposit || ownUtxo) throw new RefundRefused("that is one of the gateway's own addresses, not the customer's");
  return a;
}

/**
 * The format checks of a refund form (address and amount), with no side effects: the dashboard runs them before the
 * passkey confirmation, so a typo never spends one. Returns the normalised address and the atomic amount. Throws
 * RefundRefused.
 */
export async function checkRefundInput(env: Env, p: PaymentRow, toRaw: string, amountText: string): Promise<{ to: string; amount: bigint }> {
  const to = await checkRefundAddress(env, p, toRaw);
  const asset = getAsset(p.asset);
  let amount: bigint;
  try {
    amount = parseDecimal(amountText.trim(), asset.decimals);
  } catch {
    throw new RefundRefused(`the amount must be a decimal number of ${asset.symbol} with at most ${asset.decimals} decimals`);
  }
  if (amount <= 0n) throw new RefundRefused("the amount must be more than zero");
  return { to, amount };
}

/**
 * Whether a refund other than `exceptId` was minted inside the window ending at `now`: read-only, so the dashboard can
 * refuse (429) before a passkey confirmation is spent. Not the gate itself: the INSERT / UPDATE re-check it atomically.
 */
export async function refundWindowTaken(env: Env, now: number, exceptId?: string): Promise<boolean> {
  const q = exceptId === undefined ? env.DB.prepare(MINTED_SINCE).bind(now - REFUND_WINDOW_MS) : env.DB.prepare(`${MINTED_SINCE} AND id<>?`).bind(now - REFUND_WINDOW_MS, exceptId);
  return (await q.first()) !== null;
}

/**
 * Validates and records an approved refund of `amountText` (a decimal in the payment's asset) to `toRaw`. At most
 * one refund is recorded per REFUND_WINDOW_MS (checked in the same INSERT). Then records the refund.approved alert and
 * webhook event (recordRefundApproved), before anything is sent: if that fails it throws and the caller sends nothing.
 * Throws RefundRefused.
 */
export async function createRefund(env: Env, paymentId: string, toRaw: string, amountText: string, now: number): Promise<RefundRow> {
  const p = await getPayment(env.DB, paymentId);
  if (!p) throw new RefundRefused("no such payment", 404);
  const block = await refundBlockOf(env, p, now);
  if (block) throw new RefundRefused(block, 409);
  const { to, amount } = await checkRefundInput(env, p, toRaw, amountText);
  const asset = getAsset(p.asset);
  const prior = await listRefunds(env.DB, p.id);
  const max = leftAfter(await refundBound(env, p), prior);
  if (amount > max) throw new RefundRefused(`the amount is more than what can still be refunded (${max} atomic units of ${asset.symbol})`);
  const id = `rf_${crypto.randomUUID().replaceAll("-", "")}`;
  // One statement: the hourly window, and the bound above, which holds only while the payment's live refunds are
  // exactly the ones it was computed from (a refund recorded meanwhile fails it; a cancel only makes it stricter). The
  // sum itself stays in JS: amounts are atomic-unit decimals that overflow SQLite's 64-bit integers (18-decimal EVM
  // assets above ~9.2 coins).
  const r = await env.DB.prepare(
    `INSERT INTO refunds(id,payment_id,to_address,amount,approved_at,created_at) SELECT ?1,?2,?3,?4,?5,?5
     WHERE NOT EXISTS (SELECT 1 FROM refunds WHERE consumed_at > ?6)
       AND NOT EXISTS (SELECT 1 FROM refunds WHERE payment_id=?2 AND cancelled_at IS NULL AND id NOT IN (SELECT value FROM json_each(?7)))`,
  )
    .bind(id, p.id, to, amount.toString(), now, now - REFUND_WINDOW_MS, JSON.stringify(prior.filter((x) => !x.cancelled_at).map((x) => x.id)))
    .run();
  if ((r.meta.changes ?? 0) !== 1) {
    if (await refundWindowTaken(env, now)) throw new RefundRefused(ONE_PER_HOUR, 429);
    throw new RefundRefused("another refund of this payment was recorded meanwhile: reload and check what can still be refunded", 409);
  }
  await env.DB.prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) VALUES(?,?,?,NULL,NULL,?,?)")
    .bind(`act_${crypto.randomUUID().replaceAll("-", "")}`, now, "refund_approve", id, `refund of ${amount} ${asset.id} for payment ${p.id} approved`)
    .run();
  const row = (await env.DB.prepare("SELECT * FROM refunds WHERE id=?").bind(id).first<RefundRow>())!;
  await recordRefundApproved(env, row, p, now);
  return row;
}

/**
 * Re-approves a refund that was not sent (no tx recorded): its consumed proof and any claim are cleared, so the next
 * send mints a fresh proof (a run still between its mint and its tx record then loses its compare-and-set). Re-approving
 * sends (mints) again, so another refund already minted inside the window refuses it (429), as for a new refund: the
 * UPDATE's own clause checks that against the refunds table. Concurrent create / re-approve + send are serialised by the
 * router lease the caller holds (withRefundLease), not by this clause: two unsent refunds re-approved at once have
 * nothing minted yet to see. A sent or cancelled refund is refused with 409 before the window is looked at, and a
 * missing one with 404. A re-approval records the refund.approved alert and webhook event before returning (throws if
 * it cannot: the caller then sends nothing).
 */
export async function reapproveRefund(env: Env, id: string, now: number): Promise<boolean> {
  const [r] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE refunds SET consumed_at=NULL, claim=NULL, claimed_at=NULL, approved_at=?1, error=NULL
       WHERE id=?2 AND tx IS NULL AND cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM refunds WHERE consumed_at > ?3 AND id<>?2)`,
    ).bind(now, id, now - REFUND_WINDOW_MS),
    env.DB.prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) SELECT ?,?,?,NULL,NULL,?,? WHERE EXISTS (SELECT 1 FROM refunds WHERE id=? AND tx IS NULL AND approved_at=?)").bind(
      `act_${crypto.randomUUID().replaceAll("-", "")}`,
      now,
      "refund_reapprove",
      id,
      "refund re-approved (it was not sent)",
      id,
      now,
    ),
  ]);
  if ((r!.meta.changes ?? 0) !== 1) {
    // The row's own state first: a sent or cancelled refund is never re-approvable, whatever the window says.
    const cur = await env.DB.prepare("SELECT tx, cancelled_at FROM refunds WHERE id=?").bind(id).first<{ tx: string | null; cancelled_at: number | null }>();
    if (!cur) throw new RefundRefused("no such refund", 404);
    if (cur.tx || cur.cancelled_at) throw new RefundRefused(NOT_REAPPROVABLE, 409);
    if (await refundWindowTaken(env, now, id)) throw new RefundRefused(ONE_PER_HOUR, 429);
    return false;
  }
  const row = (await env.DB.prepare("SELECT * FROM refunds WHERE id=?").bind(id).first<RefundRow>())!;
  const p = await getPayment(env.DB, row.payment_id);
  if (!p) throw new RefundRefused("no such payment", 404);
  await recordRefundApproved(env, row, p, now);
  return true;
}

export interface RefundSendResult {
  status: "sent" | "broadcast_failed" | "unsent";
  tx?: string;
  reason?: string;
}

interface Hooks {
  /** Mints the refund proof (consumes the refund), after re-checking the lease. */
  mint: () => Promise<Allowed>;
  /**
   * Records the tx while the claim holds; false: nothing may be broadcast. UTXO: with the outpoints it spends, and
   * payments.refunded_at in the same transaction.
   */
  persist: (tx: string, utxo?: { inputs: { txid: string; vout: number; value: string }[] }) => Promise<boolean>;
}

/**
 * Runs `f` holding the router lease (refunds and routing never interleave), or throws RefundRefused(409,
 * ROUTING_BUSY) without running it. For an EVM payment's `chain` it also holds that chain's hot nonce lease (an EVM
 * sweep may be sending from the hot wallet outside the router): held by another sender -> RefundRefused(409,
 * HOT_WALLET_BUSY), nothing run.
 */
export async function withRefundLease<T>(env: Env, now: number, f: (holder: string) => Promise<T>, chain?: PaymentRow["chain"]): Promise<T> {
  const holder = `refund_${crypto.randomUUID()}`;
  if (!(await acquireRouterLock(env.DB, holder, now))) throw new RefundRefused(ROUTING_BUSY, 409);
  const evm = chain !== undefined && isEvmChain(chain) ? chain : null;
  try {
    if (evm && !(await acquireHotNonce(env.DB, evm, holder, now))) throw new RefundRefused(HOT_WALLET_BUSY, 409);
    return await f(holder);
  } finally {
    if (evm) await releaseHotNonce(env.DB, evm, holder);
    await releaseRouterLock(env.DB, holder);
  }
}

/**
 * Sends refund `id` (see the module comment); `holder` is the router lease the caller holds (withRefundLease). Never
 * throws for a send problem: the refund row records it.
 */
export async function sendRefund(env: Env, id: string, now: number, holder: string): Promise<RefundSendResult> {
  const r = await env.DB.prepare("SELECT * FROM refunds WHERE id=?").bind(id).first<RefundRow>();
  if (!r) return { status: "unsent", reason: "no such refund" };
  if (r.tx) return { status: r.sent_at ? "sent" : "broadcast_failed", tx: r.tx };
  const p = await getPayment(env.DB, r.payment_id);
  if (!p) return { status: "unsent", reason: "no such payment" };
  const claim = crypto.randomUUID();
  const c = await env.DB.prepare(
    "UPDATE refunds SET claim=?, claimed_at=?, error=NULL WHERE id=? AND tx IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL AND approved_at IS NOT NULL AND (claim IS NULL OR claimed_at < ?)",
  )
    .bind(claim, now, id, now - CLAIM_STALE_MS)
    .run();
  if ((c.meta.changes ?? 0) !== 1)
    return { status: "unsent", reason: r.cancelled_at ? "the refund was cancelled" : r.consumed_at ? "consumed, unsent: re-approve" : "another request is sending this refund" };
  let minted = false;
  const h: Hooks = {
    mint: async () => {
      if (!(await holdsRouterLock(env.DB, holder, now))) throw new RefundRefused("the router lease was lost before the refund was signed; nothing was sent", 409);
      const proof = await allowedDestination(env, p.chain, r.to_address, { refundId: id });
      minted = true;
      return proof;
    },
    persist: async (tx, utxo) => {
      const record = env.DB.prepare("UPDATE refunds SET tx=?, tx_at=?, inputs=? WHERE id=? AND claim=? AND tx IS NULL AND cancelled_at IS NULL").bind(tx, now, utxo ? JSON.stringify(utxo.inputs) : null, id, claim);
      if (!utxo) return (await record.run()).meta.changes === 1;
      const [a] = await env.DB.batch([
        record,
        env.DB.prepare("UPDATE payments SET refunded_at=? WHERE id=? AND refunded_at IS NULL AND EXISTS (SELECT 1 FROM refunds WHERE id=? AND tx=? AND claim=?)").bind(now, p.id, id, tx, claim),
      ]);
      return (a!.meta.changes ?? 0) === 1;
    },
  };
  const amount = BigInt(r.amount);
  let out: RefundSendResult;
  try {
    const block = await refundBlockOf(env, p, now);
    if (block) throw new RefundRefused(block, 409);
    // EVM, Solana: the router's accounting: what the hot wallet holds beyond reserves and fees, minus what executing
    // route batches committed. A refund never takes funds routing counts on. BTC/LTC/DOGE: only this payment's own
    // deposit is read (sendUtxo): its confirmed outputs that no route leg holds, which the refund spends whole; the
    // chain-wide routable sum is not asked for (it would read other deposits, capped by the cursor).
    const asset = getAsset(p.asset);
    if (!UTXO.has(p.chain)) {
      const free = (await hotAvailable(env, asset, now)) - (await committedAmount(env.DB, asset));
      if (amount > free) throw new RefundRefused(`only ${free > 0n ? free : 0n} atomic units of ${asset.id} are free (beyond the gas reserve and what routing has committed); the refund needs ${amount}`);
    }
    if (isEvmChain(p.chain)) out = await sendEvm(env, p.chain, p, r.to_address, amount, h, now, holder);
    else if (p.chain === "sol") out = await sendSol(env, p, r.to_address, amount, h);
    else out = await sendUtxo(env, p, r.to_address, amount, h, now, holder);
  } catch (e) {
    const why = e instanceof RefundRefused ? e.message : e instanceof Error ? e.name : "Error";
    const reason = (minted ? `consumed, unsent: re-approve (${why})` : `not sent: ${why}`).slice(0, 300);
    await env.DB.prepare("UPDATE refunds SET claim=NULL, error=? WHERE id=? AND claim=? AND tx IS NULL").bind(reason, id, claim).run();
    return { status: "unsent", reason };
  }
  if (out.status === "unsent") {
    await env.DB.prepare("UPDATE refunds SET error=? WHERE id=? AND tx IS NULL").bind((out.reason ?? "not sent").slice(0, 300), id).run();
    return out;
  }
  await env.DB.prepare("UPDATE refunds SET claim=NULL, sent_at=?, error=? WHERE id=? AND tx=?")
    .bind(out.status === "sent" ? now : null, out.status === "sent" ? null : (out.reason ?? "broadcast failed").slice(0, 300), id, out.tx!)
    .run();
  await env.DB.prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) VALUES(?,?,?,NULL,NULL,?,?)")
    .bind(`act_${crypto.randomUUID().replaceAll("-", "")}`, now, "refund_send", id, `refund tx ${out.tx}: ${out.status}`)
    .run();
  return out;
}

const NOT_RECORDED: RefundSendResult = { status: "unsent", reason: "the refund changed while it was being sent; nothing was broadcast" };

async function sendEvm(env: Env, chain: EvmChain, p: PaymentRow, to: string, amount: bigint, h: Hooks, now: number, holder: string): Promise<RefundSendResult> {
  // The pending nonce is read, signed and broadcast only under the chain's hot nonce lease (withRefundLease).
  if (!(await holdsHotNonce(env.DB, chain, holder, now))) throw new RefundRefused(HOT_WALLET_BUSY, 409);
  const [{ evmClient }, { encodeFunctionData, erc20Abi, keccak256 }] = await Promise.all([import("../chains/evm/chains"), import("viem")]);
  const client = await evmClient(env, chain);
  const hot = await evmHotAddress(env);
  const asset = getAsset(p.asset);
  const token = asset.contract as `0x${string}` | undefined;
  const txTo = (token ?? to) as `0x${string}`;
  const data = token ? encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount] }) : "0x";
  const value = token ? 0n : amount;
  if (token) {
    const held = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [hot] });
    if (held < amount) throw new RefundRefused(`the ${chain} hot wallet holds ${held} of ${asset.id}; the refund needs ${amount}`);
  }
  const gas = await client.estimateGas({ account: hot, to: txTo, data, value });
  const q = await evmFeeQuote(client, chain, (gas * 12n) / 10n);
  const balance = await client.getBalance({ address: hot });
  if (balance < q.cost + value) throw new RefundRefused(`the ${chain} hot wallet holds ${balance} wei; the refund needs about ${q.cost + value}`);
  const nonce = await client.getTransactionCount({ address: hot, blockTag: "pending" });
  const proof = await h.mint();
  const base = { chainId: EVM_CHAINS[chain].chainId, nonce, to: txTo, data, value, gas: q.gasLimit };
  const raw = await signEvmTx(
    env,
    q.fee.type === "legacy"
      ? { ...base, type: "legacy", gasPrice: BigInt(q.fee.gasPrice!) }
      : { ...base, type: "eip1559", maxFeePerGas: BigInt(q.fee.maxFeePerGas!), maxPriorityFeePerGas: BigInt(q.fee.maxPriorityFeePerGas!) },
    [proof],
  );
  const tx = keccak256(raw);
  if (!(await h.persist(tx))) return NOT_RECORDED;
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    return { status: "broadcast_failed", tx, reason: `the node did not take the tx (${e instanceof Error ? e.name : "Error"}); check the explorer before doing anything else` };
  }
  return { status: "sent", tx };
}

async function sendSol(env: Env, p: PaymentRow, to: string, amount: bigint, h: Hooks): Promise<RefundSendResult> {
  const rpc = solRpc(env);
  const hot = solHotAddress(env.MASTER_SEED ?? "");
  const asset = p.asset as SolRouteAsset;
  if (asset !== "sol:sol" && asset !== "sol:usdc") throw new RefundRefused(`${p.asset} is not refundable`);
  if (!(await plainWallet(rpc, to))) throw new RefundRefused("the refund address is not a plain Solana wallet (a program-derived or token account)");
  const life = await latestBlockhash(rpc);
  const plan = routePlan(hot, to, asset, amount, life);
  const lamports = await solBalance(rpc, hot, "confirmed");
  const spend = routeFee(plan) + (asset === "sol:sol" ? amount : ATA_RENT_LAMPORTS);
  if (lamports < spend + ROUTE_GAS_RESERVE.sol) throw new RefundRefused(`the Solana hot wallet holds ${lamports} lamports; the refund needs ${spend} plus the ${ROUTE_GAS_RESERVE.sol} reserve`);
  if (asset === "sol:usdc") {
    const ata = findAta(hot, USDC_MINT)[0];
    const held = (await tokenAccounts(rpc, hot, USDC_MINT, "confirmed")).live.find((t) => t.pubkey === ata)?.amount ?? 0n;
    if (held < amount) throw new RefundRefused(`the Solana hot wallet's USDC account holds ${held}; the refund needs ${amount}`);
  }
  const compiled = await compileSolRoute(plan);
  try {
    await assertSolRouteMessage(compiled.messageBytes, plan);
  } catch (e) {
    if (e instanceof SolTxMismatch) throw new RefundRefused(`the built Solana tx is not the intended one (${e.reason}); nothing was signed`);
    throw e;
  }
  const proof = await h.mint();
  const s = await signSolanaTx(env.MASTER_SEED ?? "", compiled, [{ role: "hot" }], [proof]);
  const tx = s.signature;
  if (!(await h.persist(tx))) return NOT_RECORDED;
  try {
    await rpc.send("sendTransaction", [s.wire, { encoding: "base64", preflightCommitment: "confirmed" }]);
  } catch (e) {
    const why = e instanceof RpcRejected ? "the node refused it" : "the answer was lost";
    return { status: "broadcast_failed", tx, reason: `${why}; check the explorer before doing anything else` };
  }
  return { status: "sent", tx };
}

/** BTC/LTC/DOGE: spends the payment's own confirmed deposit outputs (all of them), under the router lease (the caller's). */
async function sendUtxo(env: Env, p: PaymentRow, to: string, amount: bigint, h: Hooks, now: number, holder: string): Promise<RefundSendResult> {
  const chain = p.chain as UtxoChain;
  if (!(await holdsRouterLock(env.DB, holder, now))) throw new RefundRefused(ROUTING_BUSY, 409);
  {
    const fresh = await getPayment(env.DB, p.id);
    if (!fresh || fresh.routed_at != null || fresh.refunded_at != null) throw new RefundRefused("this payment's deposit was already routed or refunded: refund by hand", 409);
    const explorer = utxoExplorer(env, chain);
    const outs = (await explorer.utxos(p.address)).filter((u) => u.confirmed);
    if (outs.length === 0) throw new RefundRefused("the deposit address holds no confirmed outputs", 409);
    const reserved = await reservedOutpoints(env.DB, p.asset);
    if (outs.some((u) => reserved.has(`${u.txid}:${u.vout}`))) throw new RefundRefused("a route leg holds this deposit's outputs: resolve the routing batch first", 409);
    const feeRate = await routeFeeRate(env, chain);
    const total = outs.reduce((s, u) => s + u.value, 0n);
    const toLen = outputScript(chain, to).length;
    const fee1 = spendFee(chain, outs.length, [toLen], feeRate);
    const fee2 = spendFee(chain, outs.length, [toLen, ownScriptLength(chain)], feeRate);
    let changeTo: { index: number; address: string } | undefined;
    if (amount === total - fee1) changeTo = undefined;
    else if (total - amount - fee2 >= DUST[chain]) changeTo = await allocateOwnAddress(env, chain, "change", now);
    else throw new RefundRefused(`with the network fee, refund either exactly ${total - fee1} or at most ${total - fee2 - DUST[chain]} atomic units (the deposit holds ${total})`);
    const prevTx = new Map<string, string>();
    if (chain === "doge") for (const t of new Set(outs.map((u) => u.txid))) prevTx.set(t, await explorer.txHex(t));
    const proofs: Allowed[] = [await h.mint()];
    if (changeTo) proofs.push(await allowedDestination(env, chain, changeTo.address, { changeIndex: changeTo.index }));
    const built = buildUtxoSpend(
      env.MASTER_SEED ?? "",
      {
        chain,
        utxos: outs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, index: p.derivation_index, ...(prevTx.has(u.txid) ? { prevTx: prevTx.get(u.txid)! } : {}) })),
        to,
        amount,
        feeRate,
        ...(changeTo ? { changeTo: changeTo.address } : {}),
      },
      proofs,
    );
    if (!(await h.persist(built.txid, { inputs: outs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value.toString() })) }))) return NOT_RECORDED;
    try {
      await explorer.broadcast(built.hex);
    } catch (e) {
      return { status: "broadcast_failed", tx: built.txid, reason: `the explorer did not take the tx (${e instanceof Error ? e.name : "Error"}); check it before doing anything else` };
    }
    return { status: "sent", tx: built.txid };
  }
}

/**
 * "Cancel refund" (dashboard, passkey confirmation, under the router lease): a refund with no tx (approved or consumed, unsent)
 * is cancelled by a compare-and-set; one whose tx was recorded but the broadcast failed only on BTC/LTC/DOGE, once the
 * tx was recorded at least CANCEL_MIN_AGE_MS ago, when the explorer does not know the tx and every input it spends is
 * still unspent (then payments.refunded_at is cleared in the
 * same transaction: the deposit is routable or refundable again). EVM and Solana txs that were recorded are not
 * cancelled here: nothing on the row proves they can no longer land (plan-4-deferred.md). Audited.
 */
export async function cancelRefund(env: Env, id: string, now: number): Promise<{ ok: true } | { ok: false; code: 404 | 409; reason: string }> {
  const r = await env.DB.prepare("SELECT * FROM refunds WHERE id=?").bind(id).first<RefundRow>();
  const p = r ? await getPayment(env.DB, r.payment_id) : null;
  if (!r || !p) return { ok: false, code: 404, reason: "no such refund" };
  if (r.cancelled_at) return { ok: false, code: 409, reason: "this refund is already cancelled" };
  if (r.sent_at) return { ok: false, code: 409, reason: "this refund was sent" };
  const audit = (detail: string) =>
    env.DB.prepare("INSERT INTO routing_actions(id,created_at,action,batch_id,leg,refund_id,detail) SELECT ?,?,?,NULL,NULL,?,? WHERE EXISTS (SELECT 1 FROM refunds WHERE id=? AND cancelled_at=?)").bind(
      `act_${crypto.randomUUID().replaceAll("-", "")}`,
      now,
      "refund_cancel",
      id,
      detail,
      id,
      now,
    );
  if (!r.tx) {
    const [u] = await env.DB.batch([
      env.DB.prepare("UPDATE refunds SET cancelled_at=?, claim=NULL WHERE id=? AND tx IS NULL AND cancelled_at IS NULL").bind(now, id),
      audit(`refund of ${r.amount} cancelled (${r.consumed_at ? "consumed" : "approved"}, nothing was broadcast)`),
    ]);
    return (u!.meta.changes ?? 0) === 1 ? { ok: true } : { ok: false, code: 409, reason: "the refund changed meanwhile: reload" };
  }
  if (!UTXO.has(p.chain)) return { ok: false, code: 409, reason: "a recorded EVM or Solana refund tx cannot be cancelled here: check it on an explorer (it may still land)" };
  let inputs: { txid: string; vout: number; value: string }[];
  try {
    inputs = JSON.parse(r.inputs ?? "[]") as typeof inputs;
  } catch {
    inputs = [];
  }
  if (inputs.length === 0) return { ok: false, code: 409, reason: "the refund's inputs were not recorded: check it on an explorer" };
  const recorded = r.tx_at ?? r.claimed_at ?? r.created_at ?? now;
  if (now - recorded < CANCEL_MIN_AGE_MS)
    return { ok: false, code: 409, reason: `tx ${r.tx} was recorded less than 6 hours ago: it may still be relayed. Try again once it is 6 hours old (if the explorer still does not know it then)` };
  const explorer = utxoExplorer(env, p.chain as UtxoChain);
  try {
    if ((await explorer.txStatus(r.tx)).known) return { ok: false, code: 409, reason: `the explorer knows tx ${r.tx}: it may still confirm` };
    const live = await explorer.utxos(p.address);
    for (const i of inputs) if (!live.some((u) => u.txid === i.txid && u.vout === i.vout && u.value === BigInt(i.value))) return { ok: false, code: 409, reason: `input ${i.txid}:${i.vout} is spent` };
  } catch (e) {
    return { ok: false, code: 409, reason: `the explorer could not be read (${e instanceof Error ? e.name : "Error"}): try again` };
  }
  const [u] = await env.DB.batch([
    env.DB.prepare("UPDATE refunds SET cancelled_at=? WHERE id=? AND tx=? AND sent_at IS NULL AND cancelled_at IS NULL").bind(now, id, r.tx),
    env.DB.prepare("UPDATE payments SET refunded_at=NULL WHERE id=? AND EXISTS (SELECT 1 FROM refunds WHERE id=? AND cancelled_at=?)").bind(p.id, id, now),
    audit(`refund tx ${r.tx} cancelled: unknown to the explorer and its ${inputs.length} input(s) unspent; the deposit is routable again`),
  ]);
  return (u!.meta.changes ?? 0) === 1 ? { ok: true } : { ok: false, code: 409, reason: "the refund changed meanwhile: reload" };
}
