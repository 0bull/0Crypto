import type { TradeStatus } from "./trocador";

/*
 * Route legs: one Trocador swap of one chunk of a route batch, stored in the batch row's `legs` JSON (migration 0011).
 * The batch row is the only source of leg state: every change goes through updateLeg, a compare-and-set of the whole
 * leg against the copy the caller last read, so two runs never both advance a leg and nothing a caller passes in is
 * ever taken as leg state. Amounts are atomic-unit decimal strings (bigint); times unix ms.
 *
 * Steps (src/routing/swap.ts):
 *   quote        claimed for creating the trade (UTXO: inputs planned and reserved)
 *   traded       a fixed-rate trade exists: deposit address, amount, expiry, refund address
 *   energy       Tron: the energy the hot wallet's USDT transfer needs is known
 *   energy_wait  Tron: energy rented for the hot wallet (TronSave), waiting for it to show
 *   sending      claimed for sending (persisted before any proof is minted or anything signed); once `tx` is set the
 *                signed tx is persisted too (before the broadcast)
 *   sent         the deposit was paid (UTXO: broadcast accepted; Tron, Solana: on chain); polled until terminal
 *   finished     Trocador paid out the XMR
 *   failed       the trade failed, expired, halted or was refunded after we paid, or our tx failed on chain
 *   abandoned    nothing was paid (expiry close, inputs gone, quote failed...): the chunk gets a new leg
 */

export type LegStep = "quote" | "traded" | "energy" | "energy_wait" | "sending" | "sent" | "finished" | "failed" | "abandoned";

/** A UTXO input planned for a leg. */
export interface LegInput {
  txid: string;
  vout: number;
  value: string;
  index: number;
  address: string;
  paymentId?: string;
}

export interface SwapLeg {
  chunk: number;
  step: LegStep;
  /** What the trade deposit receives (atomic units). */
  amount: string;
  createdAt: number;
  updatedAt: number;
  /** UTXO: the planned inputs, fee rate (sat/vB) and whether a change output is planned. */
  inputs?: LegInput[];
  feeRate?: string;
  withChange?: boolean;
  /** UTXO: the change output, at a freshly allocated index (set when claimed for sending). */
  change?: { index: number; address: string; amount?: string };
  // The trade.
  tradeId?: string;
  provider?: string;
  providerTradeId?: string;
  depositAddress?: string;
  refundAddress?: string;
  /** UTXO: the derivation index of the refund address. */
  refundIndex?: number;
  /** When the trade expires (unix ms). */
  expiresAt?: number;
  /** The provider's support link or id, for the dashboard. */
  support?: string;
  quote?: { rateId: string; amountTo: string; kycRating: string };
  // Tron energy for the hot wallet.
  energy?: { need: number; rentAt?: number; orderId?: string; paid?: boolean };
  // Sending.
  claim?: string;
  claimedAt?: number;
  /** The tx id (UTXO txid, Tron txID, Solana signature) and the wire-ready signed bytes. */
  tx?: string;
  raw?: string;
  /** Tron: the tx's expiration (ms). Solana: its lastValidBlockHeight. */
  validUntil?: string;
  fee?: string;
  sentAt?: number;
  // Polling.
  status?: TradeStatus;
  hashout?: string;
  finishedAt?: number;
  /** Set once when routing.stuck was emitted for this leg. */
  stuckAt?: number;
  /** An abandoned leg an operator's "resume batch" cleared from the MAX_ABANDONS backoff (src/routing/operator.ts). */
  resumed?: boolean;
  /** "Release stuck UTXO leg": the tx that was signed but never seen (its inputs were released, the leg abandoned). */
  releasedTx?: string;
  reason?: string;
}

/** Consecutive abandoned legs (trade failures, expiry, inputs gone...) of one chunk after which the batch takes no new legs. */
export const MAX_ABANDONS = 3;

/**
 * The chunk stopped by the MAX_ABANDONS backoff, if any: its last MAX_ABANDONS legs are all abandoned and none was
 * cleared by an operator's "resume batch" (`resumed`). The swap executor and the dashboard both use this.
 */
export function wornChunk(legs: SwapLeg[]): number | undefined {
  return [...new Set(legs.map((l) => l.chunk))].find((ch) => {
    const tail = legs.filter((l) => l.chunk === ch).slice(-MAX_ABANDONS);
    return tail.length === MAX_ABANDONS && tail.every((l) => l.step === "abandoned" && l.resumed !== true);
  });
}

export interface BatchRow {
  id: string;
  asset: string;
  total: string;
  chunks: string;
  destination: string;
  due_at: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  legs: string;
  error: string | null;
}

export async function readBatch(db: D1Database, id: string): Promise<BatchRow | null> {
  return db.prepare("SELECT * FROM route_batches WHERE id=?").bind(id).first<BatchRow>();
}

/** The legs JSON as stored; anything but an array of objects throws (a corrupt row is never read as "no legs"). */
export function parseLegs(json: string): SwapLeg[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "object" || x === null || Array.isArray(x))) throw new Error("route batch legs are not an array of legs");
  return v as SwapLeg[];
}

/** The batch's chunks: atomic-unit decimal strings. */
export function parseChunks(json: string): bigint[] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !/^(0|[1-9]\d*)$/.test(x))) throw new Error("route batch chunks are not decimal strings");
  return (v as string[]).map((x) => BigInt(x));
}

const same = (a: SwapLeg | undefined, b: SwapLeg | null) => (a === undefined ? b === null : b !== null && JSON.stringify(a) === JSON.stringify(b));

export interface UpdateLegOptions {
  now: number;
  /** Only while the batch is `executing` (default). Polling a finished leg of a failed batch passes false. */
  executing?: boolean;
  /** Statements run in the same D1 batch (a transaction), after the leg update; build them conditional on the new legs. */
  also?: (legsJson: string) => D1PreparedStatement[];
}

/**
 * Compare-and-set of leg `idx` of batch `batchId`: writes `next` only if the stored leg is still exactly `expected`
 * (null: append, idx must be the current length), the whole legs JSON is unchanged since it was read, and (unless
 * `executing: false`) the batch is `executing`. Returns false, writing nothing, otherwise. `also` statements run in the
 * same transaction: make them conditional on `legs = <the new JSON>` so they apply only when this update did.
 */
export async function updateLeg(db: D1Database, batchId: string, idx: number, expected: SwapLeg | null, next: SwapLeg, o: UpdateLegOptions): Promise<boolean> {
  const row = await db.prepare("SELECT legs, status FROM route_batches WHERE id=?").bind(batchId).first<{ legs: string; status: string }>();
  const executing = o.executing !== false;
  if (!row || (executing && row.status !== "executing")) return false;
  const legs = parseLegs(row.legs);
  if (expected === null ? idx !== legs.length : !same(legs[idx], expected)) return false;
  const out = [...legs];
  out[idx] = next;
  const json = JSON.stringify(out);
  const [r] = await db.batch([
    db.prepare(`UPDATE route_batches SET legs=?, updated_at=? WHERE id=? AND legs=?${executing ? " AND status='executing'" : ""}`).bind(json, o.now, batchId, row.legs),
    ...(o.also?.(json) ?? []),
  ]);
  return (r!.meta.changes ?? 0) === 1;
}

/** The routing webhook events (events/outbox: the cron enqueues rows with enqueued_at NULL). */
export type RoutingEvent = "routing.completed" | "routing.failed" | "routing.stuck";

/**
 * An INSERT of a routing event, recorded only if `when` (a condition on route_batches, e.g. the new status) holds when
 * it runs. The id is deterministic (`<type>:<batch>[:<leg>]`), so it is recorded once whatever runs again. The
 * events table keys events by invoice: routing events carry the batch id there (Task 7 delivers them).
 */
export function routingEventStmt(db: D1Database, type: RoutingEvent, batchId: string, payload: unknown, now: number, when: { sql: string; binds: unknown[] }, leg?: number): D1PreparedStatement {
  const id = `${type}:${batchId}${leg === undefined ? "" : `:${leg}`}`;
  return db
    .prepare(`INSERT INTO events(id,created_at,type,invoice_id,payload) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM route_batches WHERE ${when.sql}) ON CONFLICT(id) DO NOTHING`)
    .bind(id, now, type, batchId, JSON.stringify(payload), ...when.binds);
}
