import { base32 } from "@scure/base";
import { pageOf, type Page } from "../api/page";
import { reservedMetadataError } from "../core/metadata";
import { formatFiat, parseDecimal } from "../core/money";
import { INTERVALS, type Interval } from "./schedule";

/** Stored times are unix ms; money is TEXT bigint minor units. */
export interface SubRow {
  id: string;
  label: string;
  price_minor: bigint;
  currency: string;
  interval: Interval;
  anchor_day: number;
  next_at: number;
  active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

type Raw = { id: string; label: string; price_minor: string; currency: string; interval: string; anchor_day: number; next_at: number; active: number; metadata: string | null; created_at: number };
const COLS = "id,label,price_minor,currency,interval,anchor_day,next_at,active,metadata,created_at";
/** A stored row that cannot be read back (bad money, interval, anchor day or metadata JSON). Its message names no data. */
export class CorruptSubscription extends Error {
  override name = "CorruptSubscription";
}

/** Throws CorruptSubscription on a row that does not hold a valid subscription; never returns half-parsed data. */
function fromRaw(r: Raw): SubRow {
  const bad = (): never => {
    throw new CorruptSubscription("subscription row is not valid");
  };
  if (typeof r.price_minor !== "string" || !/^[1-9]\d{0,17}$/.test(r.price_minor)) bad();
  if (!(INTERVALS as readonly string[]).includes(r.interval)) bad();
  if (!Number.isInteger(r.anchor_day) || r.anchor_day < 1 || r.anchor_day > 31 || !Number.isSafeInteger(r.next_at)) bad();
  let metadata: Record<string, unknown> | null = null;
  if (r.metadata !== null) {
    try {
      metadata = JSON.parse(r.metadata) as Record<string, unknown>;
    } catch {
      bad();
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) bad();
  }
  return {
    id: r.id,
    label: r.label,
    price_minor: BigInt(r.price_minor),
    currency: r.currency,
    interval: r.interval as Interval,
    anchor_day: r.anchor_day,
    next_at: r.next_at,
    active: r.active === 1,
    metadata,
    created_at: r.created_at,
  };
}

/** Rows that read back, and the ids of those that do not (logged by id only). */
function readRows(results: Raw[], where: string): { rows: SubRow[]; corrupt: string[] } {
  const rows: SubRow[] = [];
  const corrupt: string[] = [];
  for (const r of results) {
    try {
      rows.push(fromRaw(r));
    } catch (e) {
      if (!(e instanceof CorruptSubscription)) throw e;
      corrupt.push(r.id);
      console.warn(`${where}: subscription ${r.id} is corrupt`);
    }
  }
  return { rows, corrupt };
}

export const MAX_LABEL = 120;
const MAX_PRICE_MINOR = 100_000_000n; // the invoice API's own ceiling
/** The invoice limit is 4096 bytes; leave room for the `subscription_id` key the cron adds. */
export const MAX_SUB_METADATA_BYTES = 4000;
const TEN_YEARS = 10 * 365 * 86_400_000;

export const newSubId = (): string => "sub_" + base32.encode(crypto.getRandomValues(new Uint8Array(10))).toLowerCase().replaceAll("=", "");

export async function createSubscription(
  db: D1Database,
  v: { label: string; price_minor: bigint; currency: string; interval: Interval; start_at: number; metadata: Record<string, unknown> | null },
  now = Date.now(),
): Promise<SubRow> {
  const row: SubRow = {
    id: newSubId(),
    label: v.label,
    price_minor: v.price_minor,
    currency: v.currency,
    interval: v.interval,
    anchor_day: new Date(v.start_at).getUTCDate(),
    next_at: v.start_at,
    active: true,
    metadata: v.metadata,
    created_at: now,
  };
  await db
    .prepare(`INSERT INTO subscriptions(${COLS}) VALUES(?,?,?,?,?,?,?,1,?,?)`)
    .bind(row.id, row.label, row.price_minor.toString(), row.currency, row.interval, row.anchor_day, row.next_at, row.metadata ? JSON.stringify(row.metadata) : null, row.created_at)
    .run();
  return row;
}

export async function getSubscription(db: D1Database, id: string): Promise<SubRow | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM subscriptions WHERE id=?`).bind(id).first<Raw>();
  return r ? fromRaw(r) : null;
}

/** Every subscription, newest first. A corrupt row is left out (and logged by id) rather than failing the whole list. */
export async function listSubscriptions(db: D1Database): Promise<SubRow[]> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM subscriptions ORDER BY created_at DESC, id DESC`).all<Raw>();
  return readRows(results, "listSubscriptions").rows;
}

/** One API page, newest first (keyset on created_at, id). A corrupt row is left out; the cursor still moves past it. */
export async function listSubscriptionsPage(db: D1Database, page: Page): Promise<{ subscriptions: SubRow[]; next: string | null }> {
  const { rows, next } = await pageOf<Raw>(db, "subscriptions", COLS, page);
  return { subscriptions: readRows(rows, "listSubscriptions").rows, next };
}

/**
 * Active subscriptions due at `now`, oldest next_at first, plus the ids of due rows that cannot be read (the cron
 * deactivates those). One corrupt row never aborts the list.
 */
export async function listDue(db: D1Database, now: number, limit: number): Promise<{ due: SubRow[]; corrupt: string[] }> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM subscriptions WHERE active=1 AND next_at<=? ORDER BY next_at, id LIMIT ?`).bind(now, limit).all<Raw>();
  const { rows, corrupt } = readRows(results, "listDue");
  return { due: rows, corrupt };
}

/** Takes a subscription out of billing (active=0). Used by the cron for rows it can never bill. */
export async function deactivateSubscriptionRow(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE subscriptions SET active=0 WHERE id=?").bind(id).run();
}

/** Deactivates (never deletes; billed periods keep their history). False when the id is unknown. Idempotent. */
export async function deactivateSubscription(db: D1Database, id: string): Promise<boolean> {
  await db.prepare("UPDATE subscriptions SET active=0 WHERE id=?").bind(id).run();
  return (await db.prepare("SELECT 1 AS x FROM subscriptions WHERE id=?").bind(id).first()) !== null;
}

export type SubInput = { label: unknown; price_amount: unknown; price_currency: unknown; interval: unknown; start_at?: unknown; metadata?: unknown };
export type SubValue = { label: string; price_minor: bigint; currency: string; interval: Interval; start_at: number; metadata: Record<string, unknown> | null };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Shared by the JSON API and the admin form. start_at: ISO 8601 string (UTC when no zone is given) or unix ms; blank = now. */
export function parseSubscriptionInput(i: SubInput, now: number): { ok: true; value: SubValue } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof i.label !== "string" || i.label.trim() === "" || i.label.trim().length > MAX_LABEL) return bad(`label must be 1 to ${MAX_LABEL} characters`);
  if (typeof i.price_amount !== "string") return bad("price_amount must be a decimal string");
  let price: bigint;
  try {
    price = parseDecimal(i.price_amount, 2);
  } catch {
    return bad("price_amount must be a decimal with at most 2 fraction digits");
  }
  if (price <= 0n || price > MAX_PRICE_MINOR) return bad("price_amount must be > 0 and <= 1000000.00");
  if (i.price_currency !== "USD" && i.price_currency !== "EUR") return bad("price_currency must be USD or EUR");
  if (typeof i.interval !== "string" || !(INTERVALS as readonly string[]).includes(i.interval)) return bad("interval must be weekly, monthly or yearly");

  let start = now;
  if (i.start_at !== undefined && i.start_at !== null && i.start_at !== "") {
    if (typeof i.start_at === "number") start = i.start_at;
    else if (typeof i.start_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(i.start_at)) {
      const s = i.start_at.includes("T") && !/(Z|[+-]\d{2}:?\d{2})$/i.test(i.start_at) ? i.start_at + "Z" : i.start_at;
      start = Date.parse(s);
    } else return bad("start_at must be an ISO 8601 date-time");
    if (!Number.isInteger(start) || start < 0 || start > now + TEN_YEARS) return bad("start_at must be a valid date within the next 10 years");
  }

  let metadata: Record<string, unknown> | null = null;
  if (i.metadata !== undefined && i.metadata !== null) {
    if (!isPlainObject(i.metadata)) return bad("metadata must be an object");
    if (new TextEncoder().encode(JSON.stringify(i.metadata)).length > MAX_SUB_METADATA_BYTES) return bad(`metadata must be at most ${MAX_SUB_METADATA_BYTES} bytes`);
    const reserved = reservedMetadataError(i.metadata);
    if (reserved) return bad(reserved);
    metadata = i.metadata;
  }
  return { ok: true, value: { label: i.label.trim(), price_minor: price, currency: i.price_currency, interval: i.interval as Interval, start_at: start, metadata } };
}

/** Public API shape; money is a string. */
export function serializeSubscription(s: SubRow) {
  return {
    id: s.id,
    label: s.label,
    price_amount: formatFiat(s.price_minor),
    price_currency: s.currency,
    interval: s.interval,
    next_at: new Date(s.next_at).toISOString(),
    active: s.active,
    metadata: s.metadata,
    created_at: new Date(s.created_at).toISOString(),
  };
}
