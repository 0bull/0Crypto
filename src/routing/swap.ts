import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { solBalance, tokenAccounts } from "../chains/solana/adapter";
import { findAta, isOnCurve } from "../chains/solana/pda";
import { assertSolRouteMessage, compileSolRoute, routeFee, routePlan, type SolRouteAsset } from "../chains/solana/routetx";
import { RpcRejected, solRpc } from "../chains/solana/rpc";
import { SolTxMismatch, SYSTEM_PROGRAM, USDC_MINT } from "../chains/solana/sweeptx";
import { tronGrid } from "../chains/tron/trongrid";
import { rentEnergy, TronSaveError } from "../chains/tron/tronsave";
import { assertTronTx, encodeSignedTx, StaleTx, TxMismatch } from "../chains/tron/txcheck";
import { accountFromSeed, deriveUtxoAddress } from "../chains/utxo/derive";
import type { UtxoExplorer } from "../chains/utxo/explorer";
import type { UtxoChain } from "../chains/utxo/networks";
import { planUtxoSpend, routeFeeRate, type SpendInput } from "../chains/utxo/spend";
import { chainConfigError, startIndex, utxoExplorer } from "../chains/registry";
import { getAsset } from "../core/assets";
import type { AssetInfo } from "../core/types";
import { recordAlert } from "../db/alerts";
import type { Env } from "../env";
import { solHotAddress, tronHotAddress } from "../signing/addresses";
import { signSolanaTx } from "../signing/solana";
import { signTronTx } from "../signing/tron";
import { buildUtxoSpend } from "../signing/utxo";
import { ATA_RENT_LAMPORTS } from "../sweep/solana";
import { DROP_GRACE_MS, ENERGY_NEW_HOLDER, ENERGY_NORMAL, ENERGY_PRICE_CAP_SUN_PER_UNIT, ENERGY_WAIT_MS, FEE_LIMIT_SUN, rentAmount, TRONSAVE_MISSING } from "../sweep/tron";
import { allocateOwnAddress, markOwnChecked, ownSourcesToCheck } from "./own";
import { OWN_CHECKS_PER_RUN, OWN_FUNDED_SLOTS, PAYMENT_CHECKS_PER_RUN, PAYMENT_FUNDED_SLOTS, ROUTE_GAS_RESERVE } from "./config";
import { markSourceChecked, paymentSourcesToCheck, RETIRE_CONFIRM_MS, RETIRE_EMPTY, RETIRE_EMPTY_AFTER_MS, retireSource } from "./sources";
import { allowedDestination, type Allowed } from "./guard";
import { MAX_ABANDONS, parseChunks, parseLegs, readBatch, routingEventStmt, updateLeg, wornChunk, type BatchRow, type LegInput, type SwapLeg } from "./legs";
import { TROCADOR_TICKERS, TrocadorError, TrocadorNotVerified, trocador, type Coin, type TradeStatus } from "./trocador";
import { validateXmrAddress } from "./xmr";

export { updateLeg, type SwapLeg } from "./legs";

/*
 * Trocador swap execution for BTC, LTC, DOGE (straight from the deposit UTXOs), Tron USDT and Solana SOL/USDC (from
 * the hot wallet), to the batch's frozen XMR destination.
 *
 * executeSwapChunk advances the leg of one chunk of an `executing` batch, a multi-run state machine like the Tron
 * sweeper (src/routing/legs.ts lists the steps). Every step change is a compare-and-set on the batch row (updateLeg),
 * and a call goes on to the next step while nothing needs waiting, broadcasting at most one tx:
 *   quote     the leg is appended (UTXO: its inputs planned, at least the Trocador minimum), then quote() and trade()
 *             with xmrAddress = the batch's destination (frozen when the batch was created, never the current env),
 *             refundAddress = the chain's hot wallet (Tron, Solana) or an own deposit-chain address (UTXO: fresh for a
 *             chunk's first leg, recorded on the leg first, reused by the chunk's retries: chunkRefundAddress), and
 *             quotedAmountTo = the quote's amount. Any failure abandons the leg (no trade is ever paid twice: a new
 *             leg gets a new trade).
 *   traded    from here until the tx is signed, a leg whose trade expires within EXPIRY_MARGIN_MS is abandoned. The
 *             expiry must be ISO-8601 with an explicit zone (parseExpiry): an unreadable one abandons the leg before
 *             any claim; an absent one lets the leg be paid only inside the call that created the trade, by a send that
 *             needs no multi-run wait (no Tron energy rental), and never re-broadcast later. After MAX_ABANDONS
 *             abandoned legs in a row for one chunk the batch takes no new legs (routing.failing; an operator resolves).
 *   sending   the claim (step `sending`) is persisted BEFORE any proof is minted or anything signed (the guard mints a
 *             swap proof only for a claimed leg with no tx); the signed tx (id and wire bytes) is persisted BEFORE the
 *             broadcast. A lost compare-and-set means nothing is broadcast. Proofs are single-use in memory only: the
 *             claim in D1 is what keeps two runs from signing twice.
 * Never sent after expiry, never sent twice: a signed tx is only ever re-broadcast unchanged, and only while the
 * trade's window is open. Only one that can provably no longer land goes back to `traded` to be signed again, inside
 * the window: Tron, expired + DROP_GRACE_MS and unknown to the full node, or a pre-acceptance refusal
 * (TRON_DEFINITE_REFUSALS; any other code or a lost answer keeps the tx); Solana, the finalized height past its
 * lastValidBlockHeight with no status, or RpcRejected (no URL can have received it). A Tron tx must itself expire
 * within TRON_TX_MAX_AHEAD_MS and before the trade's window closes, or nothing is signed (sweep.tx_mismatch).
 *
 * Sends (all through the spending guard):
 *   UTXO    inputs: confirmed outputs of routed-mode payments (routed_at NULL) and of our own change and refund
 *           addresses, never ones another leg holds; each signed with its own key (src/signing/utxo.ts). Output: the
 *           trade deposit, exactly the leg amount (swap proof); optional change to a freshly allocated index (change
 *           proof). Fee: chains/utxo/spend.ts. Watch-mode (xpub) chains are never routed. Once the broadcast is
 *           accepted (or the explorer knows the txid) the leg is `sent` and routed_at is set on the payments it spent,
 *           in the same transaction; pollSwapLegs does the same on any terminal exit of a leg with a tx. A sent leg
 *           keeps its raw tx and is re-broadcast unchanged while unconfirmed and inside the window.
 *   Tron    the hot wallet pays USDT: energy for it first (estimate 65k, or 131k for a deposit holding no USDT, rented
 *           from TronSave under the sweeper's price cap, waited for), then transfer(deposit, amount) built by the node,
 *           checked by assertTronTx (owner hot, fee_limit capped), signed with the leg proof. `sent` once solid.
 *   Solana  the hot wallet pays SOL (System transfer) or USDC (createAssociatedTokenIdempotent for the deposit owner,
 *           then transferChecked): chains/solana/routetx.ts builds and self-checks it. The deposit must be a plain
 *           wallet (on the curve, owned by the System program or unfunded). `sent` once confirmed.
 * The hot wallets keep ROUTE_GAS_RESERVE: a send that would leave less is refused and alerted (sweep.insufficient_gas).
 *
 * pollSwapLegs maps Trocador's status onto `sent` legs (and `sending` ones with a signed tx): finished (all chunks) -> batch `completed` + routing.completed;
 * failed/expired/refunded/halted -> batch `failed` + routing.failed (refunded: the funds return to the leg's refund
 * address); `sent` for over STUCK_AFTER_MS without finishing -> routing.stuck, once per leg. Funds are never re-sent.
 */

/** What a hot wallet always keeps (atomic units): 50 TRX on Tron (sun), 0.05 SOL on Solana (lamports). */
export { ROUTE_GAS_RESERVE };
/** A leg is not sent when its trade expires sooner than this. */
export const EXPIRY_MARGIN_MS = 10 * 60_000;
/** A Tron route tx must expire within this long of being built (and before the trade's window closes). */
export const TRON_TX_MAX_AHEAD_MS = 5 * 60_000;
export { MAX_ABANDONS };
/**
 * Pre-acceptance refusals of /wallet/broadcasthex (java-tron Return.response_code, as trongrid.ts passes them through):
 * the node rejected the tx before relaying it, so it can never land and may be signed again. Every other code
 * (OTHER_ERROR, CONTRACT_EXE_ERROR, NO_CONNECTION, UNKNOWN, ...) keeps the tx until it provably expired.
 */
export const TRON_DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  "SIGERROR",
  "TAPOS_ERROR",
  "TRANSACTION_EXPIRATION_ERROR",
  "CONTRACT_VALIDATE_ERROR",
  "BANDWITH_ERROR",
  "SERVER_BUSY",
  "NOT_ENOUGH_EFFECTIVE_CONNECTION",
]);
/** A `quote` or `sending` claim older than this with no trade / no tx is from a run that died: it is taken over. */
export const CLAIM_STALE_MS = 5 * 60_000;
/** A leg `sent` this long without Trocador finishing raises routing.stuck (once). */
export const STUCK_AFTER_MS = 6 * 3_600_000;

const MIN = 60_000;
const FAILED: readonly TradeStatus[] = ["failed", "expired", "refunded", "halted"];
const UTXO_CHAINS = new Set(["btc", "ltc", "doge"]);

export class SwapError extends Error {
  override name = "SwapError";
}

export interface SwapResult {
  /**
   * sent: a tx was broadcast now. waiting: a tx is in flight (or energy, a confirmation). skipped: nothing done now,
   * try again (another run holds it, balance, reserve, explorer...). abandoned: the leg was given up before paying
   * anything; the next call starts a new one. failed: the leg failed after paying (see pollSwapLegs). done: the leg is
   * already sent or terminal. unknown: a tx was broadcast but the answer was lost or ambiguous; it is kept and
   * settled from the chain.
   */
  status: "sent" | "waiting" | "skipped" | "abandoned" | "failed" | "done" | "unknown";
  leg?: SwapLeg;
  reason?: string;
  tx?: string;
}

interface Ctx {
  env: Env;
  now: number;
  batch: BatchRow;
  asset: AssetInfo;
  coin: Coin;
  idx: number;
  leg: SwapLeg;
  /** This call created the leg's trade (a trade without an expiry may be paid only in that call). */
  fresh?: boolean;
  /** UTXO: the run's routableInputs (read once per asset per run by the router); absent: read here. */
  inputs?: SpendInput[][];
}

const result = (c: Ctx | null, status: SwapResult["status"], extra: Partial<SwapResult> = {}): SwapResult => ({ status, ...(c ? { leg: c.leg } : {}), ...extra });
const errName = (e: unknown) => (e instanceof TrocadorError ? e.message : e instanceof Error ? e.name : "Error");

/** Moves the context's leg to `next` (compare-and-set); false: another run changed it, nothing written. */
async function put(c: Ctx, next: SwapLeg, also?: (legs: string) => D1PreparedStatement[]): Promise<boolean> {
  const ok = await updateLeg(c.env.DB, c.batch.id, c.idx, c.leg, { ...next, updatedAt: c.now }, { now: c.now, also });
  if (ok) c.leg = { ...next, updatedAt: c.now };
  return ok;
}

/** Abandons a leg that never paid anything: the next call starts a new trade for its chunk. */
async function abandon(c: Ctx, reason: string): Promise<SwapResult> {
  const { claim: _c, claimedAt: _a, ...rest } = c.leg;
  if (!(await put(c, { ...rest, step: "abandoned", reason }))) return result(c, "skipped", { reason: "another run changed the leg" });
  return result(c, "abandoned", { reason });
}

/**
 * The trade can still be paid: its expiry is more than EXPIRY_MARGIN_MS away. A trade Trocador gave no expiry for is
 * payable only inside the executeSwapChunk call that created it, and only by a send that needs no multi-run wait.
 */
const windowOpen = (c: Ctx) => (c.leg.expiresAt !== undefined ? c.now < c.leg.expiresAt - EXPIRY_MARGIN_MS : c.fresh === true);

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/**
 * Trocador's expiresAt as unix ms. Only ISO-8601 with an explicit zone ("Z" or "+hh:mm") is accepted (the docs show
 * that form; nothing implies epoch numbers): undefined when absent, null when present but anything else.
 */
export function parseExpiry(v: string | undefined): number | null | undefined {
  if (v === undefined || v === "") return undefined;
  if (!ISO_ZONED.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The XMR destination a new route batch freezes: env.XMR_ADDRESS, checked by validateXmrAddress (throws
 * InvalidXmrAddress). The router stores it on the batch row when it creates the batch; legs only ever pay that.
 */
export function xmrDestination(env: Pick<Env, "XMR_ADDRESS">): string {
  return validateXmrAddress(env.XMR_ADDRESS ?? "");
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Advances the leg of chunk `chunkIndex` of batch `batch.id` by what is safe now (see the module comment). Only the
 * batch row in D1 is read: nothing of `batch` but its id is used. Throws TrocadorNotVerified unless TROCADOR_LIVE_OK
 * is "1", before anything else.
 */
export async function executeSwapChunk(env: Env, batch: { id: string }, chunkIndex: number, opts: { now?: number; inputs?: SpendInput[][] } = {}): Promise<SwapResult> {
  if (env.TROCADOR_LIVE_OK !== "1") throw new TrocadorNotVerified();
  const now = opts.now ?? Date.now();
  const row = await readBatch(env.DB, batch.id);
  if (!row) throw new SwapError(`no route batch ${batch.id}`);
  if (row.status !== "executing") return result(null, "skipped", { reason: `the batch is ${row.status}` });
  const coin = Object.hasOwn(TROCADOR_TICKERS, row.asset) ? TROCADOR_TICKERS[row.asset] : undefined;
  if (!coin) throw new SwapError(`${row.asset} is not routed through Trocador`);
  const asset = getAsset(row.asset);
  validateXmrAddress(row.destination);
  const chunks = parseChunks(row.chunks);
  const chunk = chunks[chunkIndex];
  if (!Number.isInteger(chunkIndex) || chunk === undefined) throw new RangeError(`batch ${row.id} has no chunk ${chunkIndex}`);
  const problem = chainProblem(env, asset);
  if (problem) return result(null, "skipped", { reason: problem });

  const legs = parseLegs(row.legs);
  let idx = -1;
  legs.forEach((l, i) => {
    if (l.chunk === chunkIndex) idx = i;
  });
  const c: Ctx = { env, now, batch: row, asset, coin, idx, leg: legs[idx]!, ...(opts.inputs ? { inputs: opts.inputs } : {}) };
  if (idx < 0 || c.leg.step === "abandoned") return startLeg({ ...c, idx: legs.length }, chunkIndex, chunk);
  switch (c.leg.step) {
    case "quote":
      if (now - c.leg.updatedAt < CLAIM_STALE_MS) return result(c, "skipped", { reason: "another run is creating this chunk's trade" });
      if ((await abandon(c, "the run creating its trade did not finish")).status !== "abandoned") return result(c, "skipped", { reason: "another run changed the leg" });
      return startLeg({ ...c, idx: legs.length }, chunkIndex, chunk);
    case "traded":
    case "energy":
    case "energy_wait":
      return preSend(c);
    case "sending":
      if (c.leg.tx) return settle(c);
      if (now - (c.leg.claimedAt ?? 0) < CLAIM_STALE_MS) return result(c, "skipped", { reason: "another run is sending this leg" });
      // Claimed by a run that never persisted a tx: nothing was broadcast. Back to `traded` (that run's own write, if
      // it is still alive, now fails its compare-and-set).
      if (!(await release(c, "the run sending it did not finish"))) return result(c, "skipped", { reason: "another run changed the leg" });
      return preSend(c);
    case "sent":
      if (UTXO_CHAINS.has(asset.chain) && c.leg.raw) return rebroadcastSentUtxo(c);
      return result(c, "done");
    default:
      return result(c, "done");
  }
}

/** Why `asset` cannot be routed with this configuration, or null. */
function chainProblem(env: Env, asset: AssetInfo): string | null {
  const p = chainConfigError(env, asset.chain);
  if (p) return `${asset.chain} is not configured: ${p}`;
  if (UTXO_CHAINS.has(asset.chain) && env[`${asset.chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`]) return `${asset.chain} is in watch mode (xpub): it is never routed`;
  return null;
}

/** Appends a new leg for the chunk (quote), then creates its trade. */
async function startLeg(c: Ctx, chunkIndex: number, chunk: bigint): Promise<SwapResult> {
  // Backoff: a chunk whose last MAX_ABANDONS legs were all abandoned stops the batch taking new legs (the operator
  // resolves it, Task 7's dashboard).
  const all = parseLegs(c.batch.legs);
  const worn = wornChunk(all);
  if (worn !== undefined) {
    const reason = `chunk ${worn} was abandoned ${MAX_ABANDONS} times in a row (last: ${all.filter((l) => l.chunk === worn).at(-1)?.reason ?? "?"}); no new legs until an operator resolves the batch`;
    await recordAlert(c.env.DB, "routing.failing", c.asset.chain, `route batch ${c.batch.id}: ${reason}`, c.now);
    return result(null, "skipped", { reason });
  }
  let amount = chunk;
  let plan: Pick<SwapLeg, "inputs" | "feeRate" | "withChange"> = {};
  if (UTXO_CHAINS.has(c.asset.chain)) {
    const chain = c.asset.chain as UtxoChain;
    const feeRate = await routeFeeRate(c.env, chain);
    // The run's inputs, minus any a leg took since they were read (an earlier chunk of this run, say).
    const reserved = await reservedOutpoints(c.env.DB, c.asset.id);
    const groups = (c.inputs ?? (await routableInputs(c.env, chain, { now: c.now }))).filter((g) => g.every((i) => !reserved.has(`${i.txid}:${i.vout}`)));
    const p = planUtxoSpend(chain, groups, chunk, feeRate);
    if (!p) return result(null, "skipped", { reason: "no confirmed, unrouted outputs to spend" });
    amount = p.amount;
    plan = { inputs: p.inputs.map(legInput), feeRate: feeRate.toString(), withChange: p.change };
  }
  const minimum = await trocador(c.env).minimum(c.coin, c.asset.decimals);
  if (amount < minimum) return result(null, "skipped", { reason: `${amount} is below the Trocador minimum of ${minimum}` });
  const leg: SwapLeg = { chunk: chunkIndex, step: "quote", amount: amount.toString(), createdAt: c.now, updatedAt: c.now, ...plan };
  if (!(await updateLeg(c.env.DB, c.batch.id, c.idx, null, leg, { now: c.now }))) return result(null, "skipped", { reason: "another run changed the batch" });
  return trade({ ...c, leg });
}
const legInput = (i: SpendInput): LegInput => ({ txid: i.txid, vout: i.vout, value: i.value.toString(), index: i.index, address: i.address, ...(i.paymentId ? { paymentId: i.paymentId } : {}) });

/**
 * The UTXO refund address of a chunk's trade: the one an earlier, never-paid leg of the same chunk recorded (no tx,
 * none released; still one of our own refund addresses), else a fresh own address (allocated and recorded in
 * own_addresses in one transaction: a refund that arrives there is never forgotten). Retries of a chunk share one
 * address instead of each taking a new index: failed trades never walk the wallet's gap limit. They are the same
 * chunk of the same batch, so sharing the refund address links nothing new.
 */
async function chunkRefundAddress(c: Ctx): Promise<{ index: number; address: string }> {
  const chain = c.asset.chain as UtxoChain;
  const earlier = parseLegs(c.batch.legs)
    .filter((l, i) => i !== c.idx && l.chunk === c.leg.chunk && l.step === "abandoned" && !l.tx && !l.releasedTx && l.refundAddress && l.refundIndex !== undefined)
    .at(-1);
  if (earlier) {
    const own = await c.env.DB.prepare("SELECT 1 AS ok FROM own_addresses WHERE chain=? AND address=? AND derivation_index=? AND purpose='refund'")
      .bind(chain, earlier.refundAddress, earlier.refundIndex)
      .first();
    if (own) return { index: earlier.refundIndex!, address: earlier.refundAddress! };
  }
  return allocateOwnAddress(c.env, chain, "refund", c.now);
}

/** quote() and trade() for the leg, recorded as `traded`; then on to sending. A failure abandons the leg. */
async function trade(c: Ctx): Promise<SwapResult> {
  const t = trocador(c.env);
  const amount = BigInt(c.leg.amount);
  let traded: SwapLeg;
  try {
    let refundAddress: string;
    let refundIndex: number | undefined;
    if (UTXO_CHAINS.has(c.asset.chain)) {
      ({ index: refundIndex, address: refundAddress } = await chunkRefundAddress(c));
      // Recorded on the leg before any trade is asked for: a failed attempt keeps it, the chunk's next leg reuses it.
      if (c.leg.refundAddress !== refundAddress && !(await put(c, { ...c.leg, refundAddress, refundIndex }))) return result(c, "skipped", { reason: "another run changed the leg" });
    } else refundAddress = c.asset.chain === "tron" ? tronHotAddress(c.env.MASTER_SEED ?? "") : solHotAddress(c.env.MASTER_SEED ?? "");
    const q = await t.quote(c.coin, amount, c.asset.decimals);
    const tr = await t.trade({
      rateId: q.rateId,
      provider: q.provider,
      from: c.coin,
      amountFrom: amount,
      decimals: c.asset.decimals,
      xmrAddress: c.batch.destination,
      refundAddress,
      quotedAmountTo: q.amountToAtomic,
    });
    const exp = parseExpiry(tr.expiresAt);
    if (exp === null) {
      // Recorded for the dashboard, never paid: an expiry we cannot read is not one we can stay inside.
      const reason = "Trocador gave an expiry that is not an ISO-8601 time with a zone: never paid";
      if (!(await put(c, { ...c.leg, step: "abandoned", tradeId: tr.tradeId, provider: tr.provider, depositAddress: tr.depositAddress, refundAddress, reason })))
        return result(c, "skipped", { reason: "another run changed the leg" });
      return result(c, "abandoned", { reason });
    }
    c.fresh = exp === undefined;
    traded = {
      ...c.leg,
      step: "traded",
      tradeId: tr.tradeId,
      provider: tr.provider,
      ...(tr.providerTradeId ? { providerTradeId: tr.providerTradeId } : {}),
      depositAddress: tr.depositAddress,
      refundAddress,
      ...(refundIndex !== undefined ? { refundIndex } : {}),
      ...(typeof exp === "number" ? { expiresAt: exp } : {}),
      ...(tr.support ? { support: tr.support } : {}),
      quote: { rateId: q.rateId, amountTo: q.amountTo, kycRating: q.kycRating },
      status: tr.status,
    };
  } catch (e) {
    if (e instanceof TrocadorNotVerified) throw e;
    const reason = `no trade: ${errName(e)}`.slice(0, 200);
    await abandon(c, reason);
    return result(c, "skipped", { reason });
  }
  if (!(await put(c, traded))) return result(c, "skipped", { reason: "another run changed the leg" });
  return preSend(c);
}

/** traded / energy / energy_wait: abandon if the window is closing, else the chain's next step. */
async function preSend(c: Ctx): Promise<SwapResult> {
  if (!windowOpen(c))
    return abandon(c, c.leg.expiresAt === undefined ? "the trade has no expiry and was not sent in the run that created it" : "the trade expires in less than 10 minutes and nothing was sent");
  if (UTXO_CHAINS.has(c.asset.chain)) return sendUtxo(c);
  if (c.asset.chain === "tron") return tronStep(c);
  return sendSol(c);
}

/** Back from a claim without a tx (nothing signed was persisted, nothing broadcast) to `traded`. */
async function release(c: Ctx, reason: string): Promise<boolean> {
  const { claim: _c, claimedAt: _a, tx: _t, raw: _r, validUntil: _v, fee: _f, change: _ch, ...rest } = c.leg;
  return put(c, { ...rest, step: "traded", reason });
}

interface Built {
  tx: string;
  raw: string;
  validUntil?: string;
  fee?: string;
  change?: SwapLeg["change"];
}

/**
 * Claims the leg for sending (compare-and-set), then mints and signs through `build`, then persists the signed tx
 * (compare-and-set on the claim). Null: another run holds the leg, nothing was signed or nothing will be broadcast.
 * A throw from `build` releases the claim and propagates.
 */
async function claimAndBuild(c: Ctx, extra: Partial<SwapLeg>, build: () => Promise<Built>): Promise<Built | null> {
  const claim = crypto.randomUUID();
  if (!(await put(c, { ...c.leg, ...extra, step: "sending", claim, claimedAt: c.now }))) return null;
  let b: Built;
  try {
    b = await build();
  } catch (e) {
    await release(c, `not sent: ${errName(e)}`.slice(0, 200));
    throw e;
  }
  const next: SwapLeg = { ...c.leg, tx: b.tx, raw: b.raw, ...(b.validUntil ? { validUntil: b.validUntil } : {}), ...(b.fee ? { fee: b.fee } : {}), ...(b.change ? { change: b.change } : {}) };
  if (c.leg.claim !== claim || !(await put(c, next))) return null;
  return b;
}

/** Marks the leg `sent` (and runs `also` in the same transaction). */
async function markSent(c: Ctx, also?: (legs: string) => D1PreparedStatement[]): Promise<boolean> {
  // UTXO keeps the raw tx: an unconfirmed one is re-broadcast while the trade allows (rebroadcastSentUtxo).
  const { raw: _r, ...rest } = c.leg;
  return put(c, { ...(UTXO_CHAINS.has(c.asset.chain) ? c.leg : rest), step: "sent", sentAt: c.now }, also);
}

/** The payments a leg's inputs spend. */
const paymentIdsOf = (leg: SwapLeg) => [...new Set((leg.inputs ?? []).flatMap((i) => (i.paymentId ? [i.paymentId] : [])))];
/** routed_at for these payments, applied only if the batch's legs are now `legs` (the update that wrote them won). */
const routedStmts = (db: D1Database, batchId: string, pids: string[], now: number) => (legs: string) =>
  pids.map((id) => db.prepare("UPDATE payments SET routed_at=? WHERE id=? AND routed_at IS NULL AND EXISTS (SELECT 1 FROM route_batches WHERE id=? AND legs=?)").bind(now, id, batchId, legs));

/** A tx that provably never landed: back to `traded`, to be signed again inside the trade's window. */
async function dropped(c: Ctx, why: string): Promise<SwapResult> {
  if (!(await release(c, why))) return result(c, "skipped", { reason: "another run changed the leg" });
  return result(c, "waiting", { reason: `${why}; it is sent again next run if the trade still allows` });
}

/** Our tx failed on chain: nothing was paid, the leg (and so the batch) fails; nothing is re-sent automatically. */
async function failedOnChain(c: Ctx, why: string): Promise<SwapResult> {
  if (!(await put(c, { ...c.leg, step: "failed", reason: why }))) return result(c, "skipped", { reason: "another run changed the leg" });
  await recordAlert(c.env.DB, "routing.failing", c.asset.chain, `route batch ${c.batch.id}, chunk ${c.leg.chunk}: ${why}`, c.now);
  return result(c, "failed", { reason: why });
}

/** A signed leg tx in flight: settle, re-broadcast or roll back (per chain). */
function settle(c: Ctx): Promise<SwapResult> {
  if (UTXO_CHAINS.has(c.asset.chain)) return settleUtxo(c);
  if (c.asset.chain === "tron") return settleTron(c);
  return settleSol(c);
}

/** Refuses (and alerts) when the hot wallet would keep less than its reserve. */
async function reserveBreached(c: Ctx, chain: "tron" | "sol", balance: bigint, spend: bigint, unit: string): Promise<string | null> {
  const keep = ROUTE_GAS_RESERVE[chain];
  if (balance >= spend + keep) return null;
  const detail = `the ${chain} hot wallet holds ${balance} ${unit}; route batch ${c.batch.id} needs ${spend} plus the ${keep} reserve: not sending`;
  await recordAlert(c.env.DB, "sweep.insufficient_gas", chain, detail, c.now);
  return detail;
}

// ---- UTXO ------------------------------------------------------------------------------------------------------------

/** Route batches of an asset looked back over (newest first) for input reservations. */
const LEG_HISTORY = 200;

/**
 * The outpoints legs of this asset hold: every input of a leg that has a signed tx (it may still confirm), and every
 * input of a live leg (not abandoned) of a batch that is not terminal. Payments spent by a terminal leg are routed
 * (routed_at) and so never offered again. Bounded to the last LEG_HISTORY batches of the asset. Our own change and
 * refund addresses do not come from here: they are rows of own_addresses (src/routing/own.ts), never forgotten.
 */
export async function reservedOutpoints(db: D1Database, asset: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT legs, status FROM route_batches WHERE asset=? ORDER BY created_at DESC LIMIT ?").bind(asset, LEG_HISTORY).all<{ legs: string; status: string }>();
  const reserved = new Set<string>();
  for (const r of results) {
    const open = r.status !== "completed" && r.status !== "failed" && r.status !== "resolved";
    for (const l of parseLegs(r.legs)) if (l.tx || (open && l.step !== "abandoned")) for (const i of l.inputs ?? []) reserved.add(`${i.txid}:${i.vout}`);
  }
  return reserved;
}

/**
 * The confirmed outputs a routing spend of `chain` may use, grouped by source (all of a source is spent together):
 * up to PAYMENT_CHECKS_PER_RUN payment sources (src/routing/sources.ts: due payments, funded-at-last-check slots
 * first, then a rotating cursor by oldest route_checked_at; retired only after two empty reads 24 h apart), then up to OWN_CHECKS_PER_RUN of our own change and refund addresses (own_addresses, the same scheme).
 * Every check stamps its row. Outputs another leg holds are left out. Each address must re-derive from MASTER_SEED
 * at its index (else skipped with a routing.config_error alert). Watch mode (an xpub): nothing is read or written.
 * A source whose explorer read fails is skipped this call (stamped, so it rotates behind the others); if every read
 * fails the error is thrown (fail closed). The router calls this once per asset per run and passes the result to the
 * planner (hotAvailable) and to every chunk it executes (executeSwapChunk's `inputs`).
 */
export async function routableInputs(env: Env, chain: UtxoChain, o: { explorer?: UtxoExplorer; now?: number } = {}): Promise<SpendInput[][]> {
  // Watch mode: the chain's sources are not read, stamped or retired (nothing is written).
  if (env[`${chain.toUpperCase() as "BTC" | "LTC" | "DOGE"}_XPUB`]) return [];
  const now = o.now ?? Date.now();
  const sources = await paymentSourcesToCheck(env.DB, chain, now, PAYMENT_CHECKS_PER_RUN, PAYMENT_FUNDED_SLOTS);
  const asset = `${chain}:${chain}`;
  const explorer = o.explorer ?? utxoExplorer(env, chain);
  const account = accountFromSeed(env.MASTER_SEED ?? "", chain);
  const reserved = await reservedOutpoints(env.DB, asset);
  const own = await ownSourcesToCheck(env.DB, chain, OWN_CHECKS_PER_RUN, OWN_FUNDED_SLOTS);
  const groups: SpendInput[][] = [];
  const stmts: D1PreparedStatement[] = [];
  let reads = 0;
  let ok = 0;
  let failed: unknown;
  let foreign = 0;
  let retired = 0;
  type Src = { address: string; index: number; paymentId?: string; dueAt?: number; emptyAt?: number | null };
  const check = async (s: Src, mark: (funded: boolean, empty?: "start" | "keep" | "clear") => D1PreparedStatement) => {
    if (deriveUtxoAddress(account, chain, s.index) !== s.address) {
      // A wrong seed (or a foreign address) is a configuration problem, never evidence: skipped, stamped so it
      // rotates, alerted. With the right seed it is read again.
      console.warn(`0crypto: route ${chain}: ${s.paymentId ?? s.address} does not re-derive from MASTER_SEED; not spent`);
      foreign++;
      stmts.push(mark(false));
      return;
    }
    reads++;
    let all: Awaited<ReturnType<UtxoExplorer["utxos"]>>;
    try {
      all = await explorer.utxos(s.address);
    } catch (e) {
      failed = e;
      stmts.push(mark(false));
      return;
    }
    ok++;
    if (s.paymentId && s.dueAt !== undefined && all.length === 0 && now - s.dueAt > RETIRE_EMPTY_AFTER_MS) {
      // Empty long after it became due: the first such read starts the streak, one RETIRE_CONFIRM_MS later retires.
      if (s.emptyAt != null && now - s.emptyAt >= RETIRE_CONFIRM_MS) {
        stmts.push(...retireSource(env.DB, s.paymentId, RETIRE_EMPTY, now));
        retired++;
      } else stmts.push(mark(false, "start"));
      return;
    }
    const g = all
      .filter((u) => u.confirmed && !reserved.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1))
      .map((u): SpendInput => ({ txid: u.txid, vout: u.vout, value: u.value, index: s.index, address: s.address, ...(s.paymentId ? { paymentId: s.paymentId } : {}) }));
    if (g.length > 0) groups.push(g);
    stmts.push(mark(g.length > 0, all.length > 0 ? "clear" : "keep"));
  };
  for (const s of sources) await check({ address: s.address, index: s.index, paymentId: s.id, dueAt: s.dueAt, emptyAt: s.emptyAt }, (f, empty) => markSourceChecked(env.DB, s.id, f, now, empty));
  for (const s of own) await check(s, (f) => markOwnChecked(env.DB, s.address, f, now));
  if (reads > 0 && ok === 0) {
    // Every read failed: nothing is known, so nothing is stamped (fail closed: an outage is never read as "empty").
    throw failed;
  }
  if (failed !== undefined) console.warn(`0crypto: route ${chain}: an explorer read failed (${failed instanceof Error ? failed.name : "Error"}); that source is skipped this run`);
  if (stmts.length > 0) await env.DB.batch(stmts);
  if (foreign > 0)
    await recordAlert(env.DB, "routing.config_error", chain, `${foreign} ${chain} payment address does not derive from MASTER_SEED at its index: not spent (check MASTER_SEED; nothing is retired)`, now);
  if (retired > 0)
    await recordAlert(env.DB, "routing.source_retired", chain, `${retired} ${chain} payment source(s) retired: ${RETIRE_EMPTY} (routing_actions lists them)`, now);
  return groups;
}

async function sendUtxo(c: Ctx): Promise<SwapResult> {
  const chain = c.asset.chain as UtxoChain;
  const explorer = utxoExplorer(c.env, chain);
  const inputs = c.leg.inputs ?? [];
  if (inputs.length === 0 || !c.leg.feeRate || !c.leg.depositAddress) throw new SwapError("UTXO leg without inputs, fee rate or deposit");
  // The planned inputs must still be there, confirmed, and their payments unrouted.
  for (const address of new Set(inputs.map((i) => i.address))) {
    const live = await explorer.utxos(address);
    for (const i of inputs.filter((x) => x.address === address)) {
      if (!live.some((u) => u.txid === i.txid && u.vout === i.vout && u.value === BigInt(i.value) && u.confirmed)) return abandon(c, `planned input ${i.txid}:${i.vout} is no longer a confirmed unspent output`);
    }
  }
  const pids = [...new Set(inputs.flatMap((i) => (i.paymentId ? [i.paymentId] : [])))];
  for (const id of pids) {
    const p = await c.env.DB.prepare("SELECT routed_at, refunded_at FROM payments WHERE id=?").bind(id).first<{ routed_at: number | null; refunded_at: number | null }>();
    if (!p || p.routed_at !== null || p.refunded_at !== null) return abandon(c, `payment ${id} is already routed or refunded`);
  }
  const prevTx = new Map<string, string>();
  if (chain === "doge") for (const t of new Set(inputs.map((i) => i.txid))) prevTx.set(t, await explorer.txHex(t));
  let change: SwapLeg["change"];
  if (c.leg.withChange) {
    // Allocated and recorded in own_addresses in one transaction (the guard's change proof requires that row).
    change = await allocateOwnAddress(c.env, chain, "change", c.now);
  }
  const deposit = c.leg.depositAddress;
  const amount = BigInt(c.leg.amount);
  const built = await claimAndBuild(c, change ? { change } : {}, async () => {
    const proofs: Allowed[] = [await allowedDestination(c.env, chain, deposit, { batchId: c.batch.id })];
    if (change) proofs.push(await allowedDestination(c.env, chain, change.address, { changeIndex: change.index }));
    const r = buildUtxoSpend(
      c.env.MASTER_SEED ?? "",
      {
        chain,
        utxos: inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: BigInt(i.value), index: i.index, ...(prevTx.has(i.txid) ? { prevTx: prevTx.get(i.txid)! } : {}) })),
        to: deposit,
        amount,
        feeRate: BigInt(c.leg.feeRate!),
        ...(change ? { changeTo: change.address } : {}),
      },
      proofs,
    );
    const total = inputs.reduce((s, i) => s + BigInt(i.value), 0n);
    return { tx: r.txid, raw: r.hex, fee: r.fee.toString(), ...(change ? { change: { ...change, amount: (total - amount - r.fee).toString() } } : {}) };
  });
  if (!built) return result(c, "skipped", { reason: "another run is sending this leg" });
  return broadcastUtxo(c, explorer);
}

/** Broadcasts the persisted tx; accepted: `sent` with routed_at on its payments, in one transaction. */
async function broadcastUtxo(c: Ctx, explorer: UtxoExplorer): Promise<SwapResult> {
  const tx = c.leg.tx!;
  try {
    const id = await explorer.broadcast(c.leg.raw!);
    if (id.trim().toLowerCase() !== tx) console.warn(`0crypto: route ${c.asset.chain}: the explorer answered another txid than ours; ours is tracked`);
  } catch (e) {
    await recordAlert(c.env.DB, "routing.failing", c.asset.chain, `route batch ${c.batch.id}: the ${c.asset.chain} explorer did not take tx ${tx} (${errName(e)}); it is re-broadcast while the trade allows`, c.now);
    return result(c, "waiting", { tx, reason: `broadcast failed: ${errName(e)}` });
  }
  return sentUtxo(c, "sent");
}

async function sentUtxo(c: Ctx, status: "sent" | "waiting"): Promise<SwapResult> {
  const tx = c.leg.tx!;
  const ok = await markSent(c, routedStmts(c.env.DB, c.batch.id, paymentIdsOf(c.leg), c.now));
  if (!ok) return result(c, "skipped", { tx, reason: "another run changed the leg" });
  return result(c, status, { tx });
}

/** A persisted UTXO tx not yet accepted: known to the explorer (by txid) -> sent; else re-broadcast while the trade allows. */
async function settleUtxo(c: Ctx): Promise<SwapResult> {
  const explorer = utxoExplorer(c.env, c.asset.chain as UtxoChain);
  if ((await explorer.txStatus(c.leg.tx!)).known) return sentUtxo(c, "waiting");
  if (!windowOpen(c)) {
    await recordAlert(c.env.DB, "routing.stuck", c.asset.chain, `route batch ${c.batch.id}, chunk ${c.leg.chunk}: tx ${c.leg.tx} was signed but never seen, and trade ${c.leg.tradeId} is about to expire: not re-broadcast; resolve by hand`, c.now);
    return result(c, "waiting", { tx: c.leg.tx, reason: "signed, never seen, and the trade is expiring: not re-broadcast" });
  }
  return broadcastUtxo(c, explorer);
}

/** A sent UTXO leg whose tx is not confirmed yet: the same bytes are re-broadcast while the trade allows (best effort). */
async function rebroadcastSentUtxo(c: Ctx): Promise<SwapResult> {
  const explorer = utxoExplorer(c.env, c.asset.chain as UtxoChain);
  const st = await explorer.txStatus(c.leg.tx!);
  if (st.confirmed || !windowOpen(c)) return result(c, "done", { tx: c.leg.tx });
  try {
    await explorer.broadcast(c.leg.raw!);
  } catch (e) {
    console.warn(`0crypto: route ${c.asset.chain}: re-broadcast of ${c.leg.tx} not taken (${errName(e)})`);
  }
  return result(c, "waiting", { tx: c.leg.tx, reason: "sent, not confirmed yet: re-broadcast" });
}

// ---- Tron ------------------------------------------------------------------------------------------------------------

const localTxId = (rawHex: string) => bytesToHex(sha256(hexToBytes(rawHex)));

/** Hot balances for a USDT leg: the USDT itself, and TRX for the burn ceiling plus the reserve. Null: fine. */
async function tronFunds(c: Ctx, grid: ReturnType<typeof tronGrid>, hot: string, usdt: string): Promise<string | null> {
  const amount = BigInt(c.leg.amount);
  const held = await grid.trc20Balance(usdt, hot, hot);
  if (held < amount) {
    const detail = `the Tron hot wallet holds ${held} USDT (atomic); route batch ${c.batch.id} needs ${amount}: not sending`;
    await recordAlert(c.env.DB, "sweep.insufficient_gas", "tron", detail, c.now);
    return detail;
  }
  return reserveBreached(c, "tron", await grid.trxBalance(hot), FEE_LIMIT_SUN, "sun");
}

async function tronStep(c: Ctx): Promise<SwapResult> {
  const grid = tronGrid(c.env);
  const hot = tronHotAddress(c.env.MASTER_SEED ?? "");
  const usdt = getAsset("tron:usdt").contract!;
  const deposit = c.leg.depositAddress!;
  if (c.leg.step === "traded") {
    const why = await tronFunds(c, grid, hot, usdt);
    if (why) return result(c, "skipped", { reason: why });
    // A recipient that never held USDT costs a new holder slot.
    const need = (await grid.trc20Balance(usdt, deposit, hot)) === 0n ? ENERGY_NEW_HOLDER : ENERGY_NORMAL;
    if (!(await put(c, { ...c.leg, step: "energy", energy: { need } }))) return result(c, "skipped", { reason: "another run changed the leg" });
  }
  const need = c.leg.energy!.need;
  if (c.leg.step === "energy") {
    if ((await grid.energyAvailable(hot)) >= need) return tronSend(c, grid, hot, usdt);
    // Renting means waiting across runs: a trade without an expiry may only be paid now.
    if (c.leg.expiresAt === undefined) return abandon(c, "the trade has no expiry and the hot wallet needs energy first (a multi-run wait)");
    if (!c.env.TRONSAVE_API_KEY) {
      await recordAlert(c.env.DB, "sweep.stuck", "tron", `a Tron route leg needs energy for the hot wallet but ${TRONSAVE_MISSING}: set it to continue`, c.now);
      return result(c, "skipped", { reason: TRONSAVE_MISSING });
    }
    // `paid` from here on: once the buy is sent an order may exist, whatever the answer.
    const before = c.leg;
    if (!(await put(c, { ...c.leg, step: "energy_wait", energy: { need, rentAt: c.now, paid: true } }))) return result(c, "skipped", { reason: "another run changed the leg" });
    try {
      const orderId = await rentEnergy(c.env, hot, rentAmount(need), ENERGY_PRICE_CAP_SUN_PER_UNIT);
      await put(c, { ...c.leg, energy: { ...c.leg.energy!, orderId } });
    } catch (e) {
      if (!(e instanceof TronSaveError)) throw e;
      if (!e.definite) return result(c, "waiting", { reason: "waiting for rented energy (the rental answer was unclear)" });
      await put(c, { ...before, step: "energy" });
      if (e.tooExpensive) await recordAlert(c.env.DB, "sweep.too_expensive", "tron", `energy for a Tron route leg costs more than ${ENERGY_PRICE_CAP_SUN_PER_UNIT} sun per unit; not renting (${e.message})`, c.now);
      else await recordAlert(c.env.DB, "sweep.failing", "tron", `TronSave did not rent energy for a Tron route leg: ${e.message}`, c.now);
      return result(c, "skipped", { reason: e.tooExpensive ? "energy over the price cap" : "energy rental refused" });
    }
  }
  if ((await grid.energyAvailable(hot)) >= need) return tronSend(c, grid, hot, usdt);
  if (c.now - (c.leg.energy!.rentAt ?? c.now) > ENERGY_WAIT_MS) {
    await recordAlert(c.env.DB, "sweep.failing", "tron", `energy rented for the Tron hot wallet (TronSave order ${c.leg.energy!.orderId ?? "unknown"}) did not arrive in time; route leg abandoned`, c.now);
    return abandon(c, "rented energy did not arrive");
  }
  return result(c, "waiting", { reason: "waiting for rented energy" });
}

async function tronSend(c: Ctx, grid: ReturnType<typeof tronGrid>, hot: string, usdt: string): Promise<SwapResult> {
  const why = await tronFunds(c, grid, hot, usdt);
  if (why) return result(c, "skipped", { reason: why });
  const deposit = c.leg.depositAddress!;
  const amount = BigInt(c.leg.amount);
  const u = await grid.triggerTrc20Transfer(hot, usdt, deposit, amount, FEE_LIMIT_SUN);
  let exp: number;
  try {
    exp = assertTronTx(u, { type: "TriggerSmartContract", owner: hot, to: deposit, amount, contract: usdt }, c.now).expiration;
    // Never sendable after the trade: the tx itself must expire soon and before the trade's window closes.
    const limit = Math.min(c.now + TRON_TX_MAX_AHEAD_MS, c.leg.expiresAt === undefined ? Infinity : c.leg.expiresAt - EXPIRY_MARGIN_MS);
    if (exp > limit) throw new TxMismatch(`expiration ${exp} is past ${limit} (5 minutes ahead, or the trade's window)`);
  } catch (e) {
    if (e instanceof StaleTx) return result(c, "skipped", { reason: "stale node answer" });
    if (!(e instanceof TxMismatch)) throw e;
    await recordAlert(c.env.DB, "sweep.tx_mismatch", "tron", `TronGrid built a USDT transfer for route batch ${c.batch.id} that is not the one asked for (${e.reason}); nothing was signed`, c.now, { dedupe: false });
    return result(c, "skipped", { reason: "tx_mismatch" });
  }
  const built = await claimAndBuild(c, {}, async () => {
    const proof = await allowedDestination(c.env, "tron", deposit, { batchId: c.batch.id });
    const s = signTronTx(c.env.MASTER_SEED ?? "", { role: "hot" }, u.raw_data_hex, [proof]);
    return { tx: localTxId(u.raw_data_hex), raw: encodeSignedTx(u.raw_data_hex, s.signature), validUntil: String(exp) };
  });
  if (!built) return result(c, "skipped", { reason: "another run is sending this leg" });
  let r: { ok: true } | { ok: false; code: string } | "unknown";
  try {
    r = await grid.broadcastHex(built.raw);
  } catch {
    r = "unknown"; // it may have been accepted: expiry settles it
  }
  if (r === "unknown") return result(c, "unknown", { tx: built.tx, reason: "the broadcast answer was lost; it is settled from the chain" });
  if (!r.ok) {
    await recordAlert(c.env.DB, "routing.failing", "tron", `the node refused a Tron route tx for batch ${c.batch.id} (${r.code})`, c.now);
    // Only a pre-acceptance refusal frees the leg to be signed again; anything else keeps the tx until it expired.
    if (TRON_DEFINITE_REFUSALS.has(r.code)) return dropped(c, `the node refused the tx (${r.code})`);
    return result(c, "unknown", { tx: built.tx, reason: `the node answered ${r.code}; the tx is kept until it provably expired` });
  }
  return result(c, "sent", { tx: built.tx });
}

async function settleTron(c: Ctx): Promise<SwapResult> {
  const grid = tronGrid(c.env);
  const tx = c.leg.tx!;
  const info = await grid.solidTxInfo(tx, c.leg.depositAddress!);
  if (info === null) {
    const exp = Number(c.leg.validUntil);
    if (c.now <= exp && windowOpen(c)) {
      try {
        await grid.broadcastHex(c.leg.raw!); // unchanged bytes; a duplicate is fine
      } catch {
        // retried next run while it is valid
      }
      return result(c, "waiting", { tx, reason: "the transfer is not solid yet" });
    }
    if (c.now <= exp + DROP_GRACE_MS || (await grid.fullNodeKnows(tx))) return result(c, "waiting", { tx, reason: "the transfer is not solid yet" });
    return dropped(c, "the Tron transfer expired without landing");
  }
  if (info.value === BigInt(c.leg.amount)) {
    if (!(await markSent(c))) return result(c, "skipped", { reason: "another run changed the leg" });
    return result(c, "waiting", { tx });
  }
  return failedOnChain(c, info.value === 0n ? `the Tron transfer ${tx} reverted` : `the Tron transfer ${tx} paid ${info.value} instead of ${c.leg.amount}`);
}

// ---- Solana ----------------------------------------------------------------------------------------------------------

type Rpc = ReturnType<typeof solRpc>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function latestBlockhash(rpc: Rpc): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const r = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const v = isObj(r) && isObj(r.value) ? r.value : undefined;
  const h = v?.lastValidBlockHeight;
  if (!v || typeof v.blockhash !== "string" || typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("solana: malformed getLatestBlockhash");
  return { blockhash: v.blockhash, lastValidBlockHeight: BigInt(h) };
}

/** The deposit may receive: a wallet key (on the curve) that is unfunded or a plain System account. */
export async function plainWallet(rpc: Rpc, address: string): Promise<boolean> {
  if (!isOnCurve(address)) return false;
  const r = await rpc.call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  if (!isObj(r) || !("value" in r)) throw new Error("solana: malformed getAccountInfo");
  if (r.value === null) return true;
  if (!isObj(r.value) || typeof r.value.owner !== "string") throw new Error("solana: malformed getAccountInfo");
  return r.value.owner === SYSTEM_PROGRAM;
}

async function sendSol(c: Ctx): Promise<SwapResult> {
  const rpc = solRpc(c.env);
  const hot = solHotAddress(c.env.MASTER_SEED ?? "");
  const deposit = c.leg.depositAddress!;
  const asset = c.asset.id as SolRouteAsset;
  const amount = BigInt(c.leg.amount);
  if (!(await plainWallet(rpc, deposit))) return abandon(c, `the trade deposit ${deposit} is not a plain wallet (a program-derived or token account): never paid`);
  const life = await latestBlockhash(rpc);
  const plan = routePlan(hot, deposit, asset, amount, life);
  const lamports = await solBalance(rpc, hot, "confirmed");
  const why = await reserveBreached(c, "sol", lamports, routeFee(plan) + (asset === "sol:sol" ? amount : ATA_RENT_LAMPORTS), "lamports");
  if (why) return result(c, "skipped", { reason: why });
  if (asset === "sol:usdc") {
    const hotAta = findAta(hot, USDC_MINT)[0];
    const held = (await tokenAccounts(rpc, hot, USDC_MINT, "confirmed")).live.find((t) => t.pubkey === hotAta)?.amount ?? 0n;
    if (held < amount) {
      const detail = `the Solana hot wallet's USDC account holds ${held}; route batch ${c.batch.id} needs ${amount}: not sending`;
      await recordAlert(c.env.DB, "sweep.insufficient_gas", "sol", detail, c.now);
      return result(c, "skipped", { reason: detail });
    }
  }
  const compiled = await compileSolRoute(plan);
  try {
    await assertSolRouteMessage(compiled.messageBytes, plan);
  } catch (e) {
    if (!(e instanceof SolTxMismatch)) throw e;
    await recordAlert(c.env.DB, "sweep.tx_mismatch", "sol", `the Solana route tx for batch ${c.batch.id} is not the intended one (${e.reason}); nothing was signed`, c.now, { dedupe: false });
    return result(c, "skipped", { reason: "tx_mismatch" });
  }
  const built = await claimAndBuild(c, {}, async () => {
    const proof = await allowedDestination(c.env, "sol", deposit, { batchId: c.batch.id });
    const s = await signSolanaTx(c.env.MASTER_SEED ?? "", compiled, [{ role: "hot" }], [proof]);
    return { tx: s.signature, raw: s.wire, validUntil: life.lastValidBlockHeight.toString() };
  });
  if (!built) return result(c, "skipped", { reason: "another run is sending this leg" });
  try {
    await rpc.send("sendTransaction", [built.raw, { encoding: "base64", preflightCommitment: "confirmed" }]);
  } catch (e) {
    if (e instanceof RpcRejected) {
      await recordAlert(c.env.DB, "routing.failing", "sol", `the node refused a Solana route tx for batch ${c.batch.id}${e.code === undefined ? "" : ` (${e.code})`}`, c.now);
      return dropped(c, "the node refused the tx");
    }
    // Kept: it may have been accepted; settleSol releases it only past lastValidBlockHeight. (RpcRejected is definite:
    // rpc.ts throws it only when no URL can have received the request.)
    return result(c, "unknown", { tx: built.tx, reason: "the send answer was lost; it is settled from the chain" });
  }
  return result(c, "sent", { tx: built.tx });
}

async function settleSol(c: Ctx): Promise<SwapResult> {
  const rpc = solRpc(c.env);
  const tx = c.leg.tx!;
  // Height first: past lastValidBlockHeight, a status read after it sees the tx if it ever landed.
  const h = await rpc.call("getBlockHeight", [{ commitment: "finalized" }]);
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) throw new Error("solana: malformed block height");
  const r = await rpc.call("getSignatureStatuses", [[tx], { searchTransactionHistory: true }]);
  const v = isObj(r) && Array.isArray(r.value) && r.value.length === 1 ? r.value[0] : undefined;
  if (v === undefined || (v !== null && (!isObj(v) || !("err" in v)))) throw new Error("solana: malformed signature status");
  if (v !== null) {
    if (v.err !== null && v.err !== undefined) return failedOnChain(c, `the Solana transfer ${tx} failed on chain: ${JSON.stringify(v.err).slice(0, 80)}`);
    if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") {
      if (!(await markSent(c))) return result(c, "skipped", { reason: "another run changed the leg" });
      return result(c, "waiting", { tx });
    }
    return result(c, "waiting", { tx, reason: "the transfer is not confirmed yet" });
  }
  if (BigInt(h) > BigInt(c.leg.validUntil!)) return dropped(c, "the Solana transfer expired without landing");
  if (!windowOpen(c)) return result(c, "waiting", { tx, reason: "the transfer is not confirmed yet (not re-sent: the trade's window is closing)" });
  try {
    await rpc.send("sendTransaction", [c.leg.raw!, { encoding: "base64", preflightCommitment: "confirmed" }]);
  } catch {
    // unchanged bytes; retried next run while the blockhash is valid
  }
  return result(c, "waiting", { tx, reason: "the transfer is not confirmed yet" });
}

// ---- Polling ---------------------------------------------------------------------------------------------------------

export interface PollResult {
  batch: "executing" | "completed" | "failed" | string;
  updated: number;
  stuck: number;
}

const summary = (b: BatchRow, legs: SwapLeg[]) => ({
  batch: b.id,
  asset: b.asset,
  total: b.total,
  legs: legs
    .filter((l) => l.step !== "abandoned")
    .map((l) => ({ chunk: l.chunk, amount: l.amount, step: l.step, tradeId: l.tradeId, provider: l.provider, tx: l.tx, status: l.status, hashout: l.hashout, refundAddress: l.refundAddress })),
});

/**
 * Maps Trocador's status onto the batch's `sent` legs and settles the batch (see the module comment). Read-only
 * towards the chains: it never sends anything. A status that cannot be read leaves the leg as it is.
 */
export async function pollSwapLegs(env: Env, batch: { id: string }, opts: { now?: number } = {}): Promise<PollResult> {
  const now = opts.now ?? Date.now();
  let row = await readBatch(env.DB, batch.id);
  if (!row) throw new SwapError(`no route batch ${batch.id}`);
  const out: PollResult = { batch: row.status, updated: 0, stuck: 0 };
  const t = trocador(env);
  const legs = parseLegs(row.legs);
  for (let idx = 0; idx < legs.length; idx++) {
    const leg = legs[idx]!;
    // `sending` with a tx: it may have landed while the executor cannot settle it (the batch failed meanwhile).
    if (!leg.tradeId || !(leg.step === "sent" || (leg.step === "sending" && leg.tx))) continue;
    let st: Awaited<ReturnType<typeof t.status>>;
    try {
      st = await t.status(leg.tradeId);
    } catch (e) {
      console.warn(`0crypto: route batch ${row.id}: trade status unreadable (${errName(e)})`);
      continue;
    }
    let next: SwapLeg = { ...leg, status: st.status, ...(st.support ? { support: st.support } : {}), updatedAt: now };
    let stuck = false;
    if (st.status === "finished") next = { ...next, step: "finished", finishedAt: now, ...(st.hashout ? { hashout: st.hashout } : {}) };
    else if (FAILED.includes(st.status))
      next = { ...next, step: "failed", reason: st.status === "refunded" ? `trade refunded: the funds return to ${leg.refundAddress ?? "the refund address"}` : `trade ${st.status}` };
    else if (leg.stuckAt === undefined && leg.sentAt !== undefined && now - leg.sentAt > STUCK_AFTER_MS) {
      next = { ...next, stuckAt: now };
      stuck = true;
    }
    if (JSON.stringify({ ...next, updatedAt: leg.updatedAt }) === JSON.stringify(leg)) continue;
    const terminal = next.step === "finished" || next.step === "failed";
    const id = row.id;
    const after = [...legs];
    after[idx] = next;
    const payload = { ...summary(row, after), chunk: leg.chunk, tradeId: leg.tradeId };
    // In the same transaction as the leg update: routed_at for a UTXO leg's payments on every terminal exit from a
    // signed tx (finished or failed alike: the outputs are spent or may still be), and the stuck event, once.
    const also = (legsJson: string) => [
      ...(terminal && leg.tx ? routedStmts(env.DB, id, paymentIdsOf(leg), now)(legsJson) : []),
      ...(stuck ? [routingEventStmt(env.DB, "routing.stuck", id, payload, now, { sql: "id=? AND legs=?", binds: [id, legsJson] }, idx)] : []),
    ];
    if (!(await updateLeg(env.DB, row.id, idx, leg, next, { now, executing: false, also }))) continue;
    legs[idx] = next;
    out.updated++;
    if (stuck) {
      out.stuck++;
      const detail = `route batch ${row.id}, chunk ${leg.chunk}: sent ${Math.floor((now - leg.sentAt!) / MIN)} min ago and Trocador trade ${leg.tradeId} (${leg.provider ?? "?"}) is still ${st.status}; support: ${next.support ?? leg.providerTradeId ?? "see the provider"}. Funds are never re-sent automatically.`;
      await recordAlert(env.DB, "routing.stuck", row.asset.split(":")[0] ?? null, detail, now, { dedupe: false });
    }
  }
  row = (await readBatch(env.DB, batch.id))!;
  out.batch = row.status;
  if (row.status !== "executing") return out;
  const now_legs = parseLegs(row.legs);
  const chunks = parseChunks(row.chunks);
  const live = now_legs.filter((l) => l.step !== "abandoned");
  const failed = live.filter((l) => l.step === "failed");
  const allFinished = chunks.every((_, i) => live.some((l) => l.chunk === i && l.step === "finished"));
  let to: "completed" | "failed" | null = null;
  let error: string | null = null;
  if (failed.length > 0) {
    to = "failed";
    error = failed.map((l) => `chunk ${l.chunk}: ${l.reason ?? l.status ?? "failed"}`).join("; ").slice(0, 500);
  } else if (allFinished) to = "completed";
  if (!to) return out;
  const type = to === "completed" ? "routing.completed" : "routing.failed";
  await env.DB.batch([
    env.DB.prepare("UPDATE route_batches SET status=?, error=?, updated_at=? WHERE id=? AND status='executing' AND legs=?").bind(to, error, now, row.id, row.legs),
    routingEventStmt(env.DB, type, row.id, { ...summary(row, now_legs), ...(error ? { error } : {}) }, now, { sql: "id=? AND status=? AND legs=?", binds: [row.id, to, row.legs] }),
  ]);
  out.batch = (await readBatch(env.DB, batch.id))!.status;
  return out;
}
