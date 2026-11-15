import type { AssetId, ChainId } from "../core/types";

export type InvoiceStatus = "open" | "partially_paid" | "paid" | "expired";
export type PaymentStatus = "awaiting" | "detected" | "confirming" | "confirmed" | "partial" | "expired";

export interface InvoiceRow {
  id: string;
  created_at: number;
  expires_at: number;
  price_minor: bigint;
  currency: string;
  order_id: string | null;
  metadata: Record<string, unknown> | null;
  success_url: string | null;
  allowed_assets: AssetId[] | null;
  status: InvoiceStatus;
  late: boolean;
  overpaid: boolean;
  paid_minor: bigint;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  asset: AssetId;
  chain: ChainId;
  address: string;
  derivation_index: number;
  reference: string | null;
  expected: bigint;
  price_e8: bigint;
  rate_locked_until: number;
  received: bigint;
  final: bigint;
  txids: string[];
  status: PaymentStatus;
  created_at: number;
  /** First time any funds were seen (unix ms); set once, never changed. */
  detected_at: number | null;
  confirmed_at: number | null;
  credited_minor: bigint;
  credit_price_e8: bigint | null;
  /** Other assets' balances at the deposit address (EVM only), atomic units; null when none. Never credited. */
  unexpected: Record<AssetId, bigint> | null;
  /**
   * Migration 0028, written by applyTransition (src/core/state.ts creditState). Absent on rows written before it, which
   * step derives from credit_price_e8 and detected_at. locked_received: funds the rate lock covers (seen while it ran, never
   * grown after it); later_atomic / later_minor: the final amount credited outside the lock and what it was credited at;
   * expiry_received: funds seen before the invoice expired (the late flag). Atomic units except later_minor (fiat minor).
   */
  locked_received?: bigint;
  later_atomic?: bigint;
  later_minor?: bigint;
  expiry_received?: bigint;
  /** EVM sweeps (migration 0005). Written only by the sweeper, never by applyTransition. */
  swept_at?: number | null;
  /** Migration 0029: `received` when the EVM or Solana sweeper last swept the address (atomic units); null before. */
  swept_base?: bigint | null;
  sweep_tx?: string | null;
  sweep_error?: string | null;
  sweep_retry_at?: number | null;
  /** Migration 0006: 1 when the sweep left some unexpected registry tokens at the address (own-token fallback). */
  unexpected_left?: number;
  /** Migration 0011: when a UTXO payment's deposit outputs were spent by a route leg (never set for hot-pooled chains). */
  routed_at?: number | null;
  /** Migration 0014: when a UTXO refund's tx (spending all of the deposit's outputs) was recorded. */
  refunded_at?: number | null;
  /** Migration 0016: why routed_at was set without a route leg (a retired routing source, src/routing/sources.ts). */
  route_note?: string | null;
  /** Only set by listSweepCandidates: the payment's invoice expiry, for the partial-payment sweep window. */
  invoice_expires_at?: number | null;
}

export interface EventRow {
  id: string;
  created_at: number;
  type: string;
  invoice_id: string;
  payload: string;
}

export interface Transition {
  payment: PaymentRow;
  invoice: InvoiceRow;
  events: EventRow[];
  /** A swept EVM or Solana address holds the payment's asset again: clear the swept mark so the sweeper takes it again. */
  resweep?: boolean;
}

type Raw = Record<string, unknown>;

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const parseJson = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (JSON.parse(v as string) as T));
const big = (v: unknown): bigint => BigInt(v as string);
const parseUnexpected = (v: unknown): Record<AssetId, bigint> | null => {
  const raw = parseJson<Record<string, string>>(v);
  return raw ? Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, BigInt(x)])) : null;
};
const unexpectedJson = (u: Record<AssetId, bigint> | null): string | null =>
  u && Object.keys(u).length > 0 ? JSON.stringify(Object.fromEntries(Object.entries(u).map(([k, x]) => [k, x.toString()]))) : null;
const bigOrNull = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));

function toInvoice(r: Raw): InvoiceRow {
  return {
    id: r.id as string,
    created_at: r.created_at as number,
    expires_at: r.expires_at as number,
    price_minor: big(r.price_minor),
    currency: r.currency as string,
    order_id: (r.order_id as string | null) ?? null,
    metadata: parseJson<Record<string, unknown>>(r.metadata),
    success_url: (r.success_url as string | null) ?? null,
    allowed_assets: parseJson<AssetId[]>(r.allowed_assets),
    status: r.status as InvoiceStatus,
    late: r.late === 1,
    overpaid: r.overpaid === 1,
    paid_minor: big(r.paid_minor),
  };
}

function toPayment(r: Raw): PaymentRow {
  return {
    id: r.id as string,
    invoice_id: r.invoice_id as string,
    asset: r.asset as AssetId,
    chain: r.chain as ChainId,
    address: r.address as string,
    derivation_index: r.derivation_index as number,
    reference: (r.reference as string | null) ?? null,
    expected: big(r.expected),
    price_e8: big(r.price_e8),
    rate_locked_until: r.rate_locked_until as number,
    received: big(r.received),
    final: big(r.final),
    txids: JSON.parse(r.txids as string) as string[],
    status: r.status as PaymentStatus,
    created_at: r.created_at as number,
    detected_at: (r.detected_at as number | null) ?? null,
    confirmed_at: (r.confirmed_at as number | null) ?? null,
    credited_minor: big(r.credited_minor),
    credit_price_e8: bigOrNull(r.credit_price_e8),
    unexpected: parseUnexpected(r.unexpected),
    ...(r.locked_received != null ? { locked_received: big(r.locked_received) } : {}),
    ...(r.later_atomic != null ? { later_atomic: big(r.later_atomic) } : {}),
    ...(r.later_minor != null ? { later_minor: big(r.later_minor) } : {}),
    ...(r.expiry_received != null ? { expiry_received: big(r.expiry_received) } : {}),
    swept_at: (r.swept_at as number | null) ?? null,
    swept_base: bigOrNull(r.swept_base),
    sweep_tx: (r.sweep_tx as string | null) ?? null,
    sweep_error: (r.sweep_error as string | null) ?? null,
    sweep_retry_at: (r.sweep_retry_at as number | null) ?? null,
    unexpected_left: (r.unexpected_left as number | null) ?? 0,
    routed_at: (r.routed_at as number | null) ?? null,
    refunded_at: (r.refunded_at as number | null) ?? null,
    route_note: (r.route_note as string | null) ?? null,
    ...(r.invoice_expires_at !== undefined ? { invoice_expires_at: r.invoice_expires_at as number } : {}),
  };
}

/** The invoices columns the repo writes, `id` first. invoiceCols gives the values after `id`, in this order. */
export const INVOICE_COLUMNS = [
  "id",
  "created_at",
  "expires_at",
  "price_minor",
  "currency",
  "order_id",
  "metadata",
  "success_url",
  "allowed_assets",
  "status",
  "late",
  "overpaid",
  "paid_minor",
] as const;
const INVOICE_PLACEHOLDERS = INVOICE_COLUMNS.map(() => "?").join(",");
const INVOICE_INSERT = `INSERT INTO invoices(${INVOICE_COLUMNS.join(",")}) VALUES(${INVOICE_PLACEHOLDERS})`;
/** Same columns and values; inserts only when the previous statement of the batch changed a row. */
const INVOICE_INSERT_IF_CHANGED = `INSERT INTO invoices(${INVOICE_COLUMNS.join(",")}) SELECT ${INVOICE_PLACEHOLDERS} WHERE changes()=1`;
const INVOICE_UPDATE = `UPDATE invoices SET ${INVOICE_COLUMNS.slice(1).map((c) => `${c}=?`).join(",")} WHERE id=?`;
const PAYMENT_INSERT =
  "INSERT INTO payments(id,invoice_id,asset,chain,address,derivation_index,reference,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,detected_at,confirmed_at,credited_minor,credit_price_e8,unexpected,locked_received,later_atomic,later_minor,expiry_received) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const PAYMENT_UPDATE =
  "UPDATE payments SET invoice_id=?,asset=?,chain=?,address=?,derivation_index=?,reference=?,expected=?,price_e8=?,rate_locked_until=?,received=?,final=?,txids=?,status=?,created_at=?,detected_at=?,confirmed_at=?,credited_minor=?,credit_price_e8=?,unexpected=?,locked_received=?,later_atomic=?,later_minor=?,expiry_received=? WHERE id=?";

// Column order after the leading `id` (insert) / before the trailing `id` (update).
const invoiceCols = (i: InvoiceRow) => [
  i.created_at,
  i.expires_at,
  i.price_minor.toString(),
  i.currency,
  i.order_id,
  json(i.metadata),
  i.success_url,
  json(i.allowed_assets),
  i.status,
  i.late ? 1 : 0,
  i.overpaid ? 1 : 0,
  i.paid_minor.toString(),
];
/** Every value bound by INVOICE_INSERT, in INVOICE_COLUMNS order (exported for the column parity test). */
export const invoiceRowValues = (i: InvoiceRow) => [i.id, ...invoiceCols(i)];

const paymentCols = (p: PaymentRow) => [
  p.invoice_id,
  p.asset,
  p.chain,
  p.address,
  p.derivation_index,
  p.reference,
  p.expected.toString(),
  p.price_e8.toString(),
  p.rate_locked_until,
  p.received.toString(),
  p.final.toString(),
  JSON.stringify(p.txids),
  p.status,
  p.created_at,
  p.detected_at,
  p.confirmed_at,
  p.credited_minor.toString(),
  p.credit_price_e8 === null ? null : p.credit_price_e8.toString(),
  unexpectedJson(p.unexpected),
  p.locked_received?.toString() ?? null,
  p.later_atomic?.toString() ?? null,
  p.later_minor?.toString() ?? null,
  p.expiry_received?.toString() ?? null,
];

/**
 * Atomically allocates the next derivation index for a chain. The first index is `start` (default 0);
 * a counter already past `start` keeps counting, one below it jumps up to `start`. Never goes backwards.
 */
export async function allocateIndex(db: D1Database, chain: ChainId | "evm", start = 0): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO derivation_counters(chain,next) VALUES(?1,?2+1) ON CONFLICT(chain) DO UPDATE SET next=max(next,?2)+1 RETURNING next-1 AS idx",
    )
    .bind(chain, start)
    .first<{ idx: number }>();
  if (!row) throw new Error("allocateIndex: no row returned");
  return row.idx;
}

export async function insertInvoice(db: D1Database, inv: InvoiceRow): Promise<void> {
  await db
    .prepare(INVOICE_INSERT)
    .bind(inv.id, ...invoiceCols(inv))
    .run();
}

export async function getInvoice(db: D1Database, id: string): Promise<InvoiceRow | null> {
  const r = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(id).first<Raw>();
  return r ? toInvoice(r) : null;
}

export async function insertPayment(db: D1Database, p: PaymentRow): Promise<void> {
  await db
    .prepare(PAYMENT_INSERT)
    .bind(p.id, ...paymentCols(p))
    .run();
}

export async function getPayment(db: D1Database, id: string): Promise<PaymentRow | null> {
  const r = await db.prepare("SELECT * FROM payments WHERE id=?").bind(id).first<Raw>();
  return r ? toPayment(r) : null;
}

export async function listPayments(db: D1Database, invoiceId: string): Promise<PaymentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at, id")
    .bind(invoiceId)
    .all<Raw>();
  return results.map(toPayment);
}

/** Payments with unexpected deposits (other assets at their address), newest first, for the admin overview. */
export async function listUnexpectedDeposits(db: D1Database, limit = 50): Promise<PaymentRow[]> {
  const { results } = await db.prepare("SELECT * FROM payments WHERE unexpected IS NOT NULL ORDER BY created_at DESC, id LIMIT ?").bind(limit).all<Raw>();
  return results.map(toPayment);
}

/** The payments with these ids (one query; up to a few dozen). */
export async function getPaymentsByIds(db: D1Database, ids: string[]): Promise<PaymentRow[]> {
  if (ids.length === 0) return [];
  const { results } = await db.prepare(`SELECT * FROM payments WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Raw>();
  return results.map(toPayment);
}

/**
 * Partial payments, and expired ones holding unexpected deposits, are swept only this long after their invoice expired:
 * past the watcher's give-up (7 days after expiry) plus an hour, so no poll can follow the emptied address any more.
 */
export const SWEEP_AFTER_EXPIRY_MS = 7 * 86_400_000 + 3_600_000;

/**
 * SQL condition: payment `p` (joined with its invoice `i`) holds funds that are the gateway's to move at `now`: confirmed,
 * or partial, or expired with deposits (unexpected tokens, or any amount received), once the invoice expired more
 * than `window` (SWEEP_AFTER_EXPIRY_MS) ago. Shared by sweeps (listSweepCandidates) and UTXO routing sources
 * (src/routing/sources.ts). `now` and `window` are the statement's placeholders, e.g. "?2".
 */
export function dueSql(now: string, window: string): string {
  return `(p.status='confirmed'
           OR (p.status='partial' AND i.expires_at+${window}<${now})
           OR (p.status='expired' AND (p.unexpected IS NOT NULL OR p.received<>'0') AND i.expires_at+${window}<${now}))`;
}

/**
 * Unswept payments of a chain that are due for a sweep, oldest confirmation first: confirmed ones, and partial or
 * expired-with-unexpected-deposits ones once their invoice expired more than SWEEP_AFTER_EXPIRY_MS ago (the watcher
 * has given up). Rows waiting for a retry are left out.
 */
export async function listSweepCandidates(db: D1Database, chain: ChainId, now: number, limit = 50): Promise<PaymentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, i.expires_at AS invoice_expires_at FROM payments p JOIN invoices i ON i.id=p.invoice_id
       WHERE p.chain=?1 AND p.swept_at IS NULL AND (p.sweep_retry_at IS NULL OR p.sweep_retry_at<=?2)
         AND ${dueSql("?2", "?3")}
       ORDER BY COALESCE(p.confirmed_at,p.created_at), p.id LIMIT ?4`,
    )
    .bind(chain, now, SWEEP_AFTER_EXPIRY_MS, limit)
    .all<Raw>();
  return results.map(toPayment);
}

/** Updates the payment and invoice rows and inserts events in one atomic batch. */
export async function applyTransition(db: D1Database, t: Transition): Promise<void> {
  const stmts = [
    db.prepare(PAYMENT_UPDATE).bind(...paymentCols(t.payment), t.payment.id),
    db.prepare(INVOICE_UPDATE).bind(...invoiceCols(t.invoice), t.invoice.id),
    ...t.events.map((e) =>
      db
        .prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .bind(e.id, e.created_at, e.type, e.invoice_id, e.payload),
    ),
  ];
  if (t.resweep)
    stmts.push(
      db.prepare("UPDATE payments SET swept_at=NULL, sweep_tx=NULL, sweep_error=NULL, sweep_retry_at=NULL WHERE id=? AND swept_at IS NOT NULL").bind(t.payment.id),
    );
  await db.batch(stmts);
}

export async function getEvent(db: D1Database, id: string): Promise<EventRow | null> {
  const r = await db.prepare("SELECT * FROM events WHERE id=?").bind(id).first<EventRow>();
  return r ?? null;
}

export interface DeliveryRow {
  event_id: string;
  attempt: number;
  at: number;
  status: number;
  error: string | null;
}

export async function recordDelivery(db: D1Database, d: DeliveryRow): Promise<void> {
  await db
    .prepare("INSERT INTO deliveries(event_id,attempt,at,status,error) VALUES(?,?,?,?,?)")
    .bind(d.event_id, d.attempt, d.at, d.status, d.error)
    .run();
}

/**
 * Batch statement: inserts the invoice only if the immediately preceding statement in the same batch changed a row
 * (`WHERE changes()=1`, the compare-and-set pattern of routing/own.ts). Used by the subscription cron.
 */
export function insertInvoiceIfChanged(db: D1Database, inv: InvoiceRow): D1PreparedStatement {
  return db
    .prepare(INVOICE_INSERT_IF_CHANGED)
    .bind(inv.id, ...invoiceCols(inv));
}

/** Inserts an invoice and its creation event in one atomic batch. */
export async function insertInvoiceWithEvent(db: D1Database, inv: InvoiceRow, event: EventRow): Promise<void> {
  await db.batch([
    db.prepare(INVOICE_INSERT).bind(inv.id, ...invoiceCols(inv)),
    db
      .prepare("INSERT INTO events(id,created_at,type,invoice_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(event.id, event.created_at, event.type, event.invoice_id, event.payload),
  ]);
}
