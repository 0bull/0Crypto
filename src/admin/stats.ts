import type { InvoiceStatus } from "../db/repo";

export const DAY = 86_400_000;
export const PERIODS = ["7d", "30d", "90d"] as const;
export type Period = (typeof PERIODS)[number];
export const STATUSES: InvoiceStatus[] = ["open", "partially_paid", "paid", "expired"];

export const parsePeriod = (v: string | undefined): Period => ((PERIODS as readonly string[]).includes(v ?? "") ? (v as Period) : "30d");
export const parseStatus = (v: string | undefined): InvoiceStatus | undefined => STATUSES.find((s) => s === v);

/** Same rule as the pills: an open invoice past its expiry counts as expired. */
function statusWhere(status: InvoiceStatus | undefined): string {
  if (status === "open") return "WHERE i.status='open' AND i.expires_at>=?";
  if (status === "expired") return "WHERE (i.status='expired' OR (i.status='open' AND i.expires_at<?))";
  return status ? `WHERE i.status='${status}'` : "";
}

export interface RecentRow {
  id: string;
  order_id: string | null;
  price_minor: bigint;
  currency: string;
  status: InvoiceStatus;
  created_at: number;
  expires_at: number;
  paid_with: string[];
}

export interface Dashboard {
  period: Period;
  now: number;
  /** The currency the chart and coin shares are drawn in: the one with the most received (default USD). */
  currency: string;
  received: { currency: string; minor: bigint }[];
  /** Change of the primary currency vs the previous period, in tenths of a percent; null when the previous period is 0. */
  changeTenths: bigint | null;
  paid: { currency: string; count: number; sum: bigint }[];
  /** Invoices created in the period (any status, any currency): the base of the paid rate. */
  created: number;
  awaiting: number;
  partial: number;
  daily: { start: number; minor: bigint }[];
  coins: { asset: string; minor: bigint }[];
  /** The five latest invoices (any period). */
  recent: RecentRow[];
}

// paid_minor / credited_minor are TEXT columns holding integers; SQLite sums them as int64 and we read the result back as text.
const SUM = (col: string) => `CAST(SUM(CAST(${col} AS INTEGER)) AS TEXT)`;

/**
 * The latest invoices, newest first, optionally filtered by status (same rule as the pills). Each row's coins come from
 * one correlated subquery per returned row (payments are indexed by invoice_id), so the cost is bounded by `limit`.
 */
function recentStmt(db: D1Database, status: InvoiceStatus | undefined, now: number, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT i.id, i.order_id, i.price_minor, i.currency, i.status, i.created_at, i.expires_at,
         (SELECT group_concat(DISTINCT asset) FROM payments WHERE invoice_id=i.id AND status IN ('detected','confirming','confirmed','partial')) AS paid_with
       FROM invoices i ${statusWhere(status)} ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit}`,
    )
    .bind(...(status === "open" || status === "expired" ? [now] : []));
}

const recentRows = (r: D1Result): RecentRow[] =>
  (r.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    order_id: (r.order_id as string | null) ?? null,
    price_minor: BigInt(r.price_minor as string),
    currency: r.currency as string,
    status: r.status as InvoiceStatus,
    created_at: r.created_at as number,
    expires_at: r.expires_at as number,
    paid_with: r.paid_with ? String(r.paid_with).split(",") : [],
  }));

/** The invoices list (/admin/invoices): the 50 latest, optionally one status. */
export async function loadInvoices(db: D1Database, status: InvoiceStatus | undefined, now: number): Promise<RecentRow[]> {
  return recentRows(await recentStmt(db, status, now, 50).all());
}

export async function loadDashboard(db: D1Database, period: Period, now: number): Promise<Dashboard> {
  const days = Number(period.slice(0, -1));
  const today = Math.floor(now / DAY);
  const start = (today - (days - 1)) * DAY;
  const prevStart = start - days * DAY;

  const receivedSql = `SELECT currency, ${SUM("paid_minor")} AS s FROM invoices WHERE created_at>=? AND created_at<? AND CAST(paid_minor AS INTEGER)>0 GROUP BY currency`;
  const [cur, prev, paid, created, awaiting] = await db.batch([
    db.prepare(receivedSql).bind(start, now + 1),
    db.prepare(receivedSql).bind(prevStart, start),
    db
      .prepare(`SELECT currency, COUNT(*) AS n, ${SUM("paid_minor")} AS s FROM invoices WHERE status='paid' AND created_at>=? AND created_at<? GROUP BY currency`)
      .bind(start, now + 1),
    db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE created_at>=? AND created_at<?").bind(start, now + 1),
    db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(status='partially_paid'),0) AS p FROM invoices WHERE status IN ('open','partially_paid') AND expires_at>?",
      )
      .bind(now),
  ]);
  const rows = <T,>(r: D1Result) => r.results as T[];
  const received = rows<{ currency: string; s: string }>(cur!).map((r) => ({ currency: r.currency, minor: BigInt(r.s) }));
  const currency = [...received].sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : 0))[0]?.currency ?? "USD";
  const prevMinor = rows<{ currency: string; s: string }>(prev!).find((r) => r.currency === currency);
  const curMinor = received.find((r) => r.currency === currency)?.minor ?? 0n;
  const prevBig = prevMinor ? BigInt(prevMinor.s) : 0n;
  const a = rows<{ n: number; p: number }>(awaiting!)[0]!;

  const [daily, coins, recent] = await db.batch([
    db
      .prepare(
        `SELECT created_at/${DAY} AS d, ${SUM("paid_minor")} AS s FROM invoices WHERE currency=? AND created_at>=? AND created_at<? AND CAST(paid_minor AS INTEGER)>0 GROUP BY d`,
      )
      .bind(currency, start, now + 1),
    db
      .prepare(
        `SELECT p.asset AS asset, ${SUM("p.credited_minor")} AS s FROM payments p JOIN invoices i ON i.id=p.invoice_id
         WHERE p.status='confirmed' AND i.currency=? AND COALESCE(p.confirmed_at,p.created_at)>=? AND COALESCE(p.confirmed_at,p.created_at)<? GROUP BY p.asset ORDER BY CAST(SUM(CAST(p.credited_minor AS INTEGER)) AS INTEGER) DESC`,
      )
      .bind(currency, start, now + 1),
    recentStmt(db, undefined, now, 5),
  ]);
  const byDay = new Map(rows<{ d: number; s: string }>(daily!).map((r) => [r.d, BigInt(r.s)]));

  return {
    period,
    now,
    currency,
    received,
    changeTenths: prevBig > 0n ? ((curMinor - prevBig) * 1000n) / prevBig : null,
    paid: rows<{ currency: string; n: number; s: string }>(paid!).map((r) => ({ currency: r.currency, count: r.n, sum: BigInt(r.s) })),
    created: rows<{ n: number }>(created!)[0]?.n ?? 0,
    awaiting: a.n,
    partial: a.p,
    daily: Array.from({ length: days }, (_, i) => ({ start: (today - (days - 1) + i) * DAY, minor: byDay.get(today - (days - 1) + i) ?? 0n })),
    coins: rows<{ asset: string; s: string }>(coins!).map((r) => ({ asset: r.asset, minor: BigInt(r.s) })),
    recent: recentRows(recent!),
  };
}

export interface EventView {
  id: string;
  created_at: number;
  type: string;
}
export interface DeliveryView {
  event_id: string;
  attempt: number;
  at: number;
  status: number | null;
  error: string | null;
}

export async function loadEventsAndDeliveries(db: D1Database, invoiceId: string): Promise<{ events: EventView[]; deliveries: DeliveryView[] }> {
  const [ev, dl] = await db.batch([
    db.prepare("SELECT id,created_at,type FROM events WHERE invoice_id=? ORDER BY created_at, id").bind(invoiceId),
    db
      .prepare("SELECT event_id,attempt,at,status,error FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE invoice_id=?) ORDER BY event_id, attempt")
      .bind(invoiceId),
  ]);
  return { events: ev!.results as unknown as EventView[], deliveries: dl!.results as unknown as DeliveryView[] };
}
