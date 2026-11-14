import { base32 } from "@scure/base";
import { enabledAssets } from "../config";
import { formatFiat, parseDecimal } from "../core/money";
import type { AssetId } from "../core/types";
import { pageOf, type Page } from "../api/page";
import { recordAlert } from "../db/alerts";
import type { Env } from "../env";

/** Stored times are unix ms; money is TEXT bigint minor units. A null price means the customer enters the amount. */
export interface LinkRow {
  id: string;
  title: string;
  price_minor: bigint | null;
  currency: string;
  allowed_assets: AssetId[] | null;
  active: boolean;
  created_at: number;
}

type Raw = { id: string; title: string; price_minor: string | null; currency: string; allowed_assets: string | null; active: number; created_at: number };
const fromRaw = (r: Raw): LinkRow => ({
  id: r.id,
  title: r.title,
  price_minor: r.price_minor === null ? null : BigInt(r.price_minor),
  currency: r.currency,
  allowed_assets: r.allowed_assets === null ? null : (JSON.parse(r.allowed_assets) as AssetId[]),
  active: r.active === 1,
  created_at: r.created_at,
});

export const CURRENCIES = ["USD", "EUR"] as const;
/**
 * Open-amount bounds. Invoices only support USD and EUR (both 2 minor digits), so the rule is simply $1 to $10,000
 * (or the same figures in EUR) in the link's own currency minor units; there is no FX conversion.
 */
export const OPEN_MIN_MINOR = 100n;
export const OPEN_MAX_MINOR = 1_000_000n;
const MAX_FIXED_MINOR = 100_000_000n; // the invoice API's own ceiling
export const MAX_TITLE = 120;

export const newLinkId = (): string => "lnk_" + base32.encode(crypto.getRandomValues(new Uint8Array(10))).toLowerCase().replaceAll("=", "");

export async function createLink(
  db: D1Database,
  l: { title: string; price_minor: bigint | null; currency: string; allowed_assets: AssetId[] | null },
): Promise<LinkRow> {
  const row: LinkRow = { id: newLinkId(), ...l, active: true, created_at: Date.now() };
  await db
    .prepare("INSERT INTO links(id,title,price_minor,currency,allowed_assets,active,created_at) VALUES(?,?,?,?,?,1,?)")
    .bind(row.id, row.title, row.price_minor === null ? null : row.price_minor.toString(), row.currency, row.allowed_assets ? JSON.stringify(row.allowed_assets) : null, row.created_at)
    .run();
  return row;
}

export async function getLink(db: D1Database, id: string): Promise<LinkRow | null> {
  const r = await db.prepare("SELECT id,title,price_minor,currency,allowed_assets,active,created_at FROM links WHERE id=?").bind(id).first<Raw>();
  return r ? fromRaw(r) : null;
}

const LINK_COLS = "id,title,price_minor,currency,allowed_assets,active,created_at";

/** Every link, newest first (the admin page). */
export async function listLinks(db: D1Database): Promise<LinkRow[]> {
  const { results } = await db.prepare(`SELECT ${LINK_COLS} FROM links ORDER BY created_at DESC, id DESC`).all<Raw>();
  return results.map(fromRaw);
}

/** One API page of links, newest first (keyset on created_at, id). */
export async function listLinksPage(db: D1Database, page: Page): Promise<{ links: LinkRow[]; next: string | null }> {
  const { rows, next } = await pageOf<Raw>(db, "links", LINK_COLS, page);
  return { links: rows.map(fromRaw), next };
}

export async function setLinkActive(db: D1Database, id: string, active: boolean): Promise<boolean> {
  const r = await db.prepare("UPDATE links SET active=? WHERE id=?").bind(active ? 1 : 0, id).run();
  return (r.meta.changes ?? 0) > 0;
}

export type LinkInput = { title: unknown; price_amount?: unknown; price_currency: unknown; allowed_assets?: unknown };

/** Shared by the JSON API and the admin form. A missing/null/"" price_amount makes an open-amount link. */
export function parseLinkInput(env: Env, i: LinkInput): { ok: true; value: { title: string; price_minor: bigint | null; currency: string; allowed_assets: AssetId[] | null } } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof i.title !== "string" || i.title.trim() === "" || i.title.trim().length > MAX_TITLE) return bad(`title must be 1 to ${MAX_TITLE} characters`);
  if (i.price_currency !== "USD" && i.price_currency !== "EUR") return bad("price_currency must be USD or EUR");
  let price: bigint | null = null;
  if (i.price_amount !== undefined && i.price_amount !== null && i.price_amount !== "") {
    if (typeof i.price_amount !== "string") return bad("price_amount must be a decimal string");
    try {
      price = parseDecimal(i.price_amount, 2);
    } catch {
      return bad("price_amount must be a decimal with at most 2 fraction digits");
    }
    if (price <= 0n || price > MAX_FIXED_MINOR) return bad("price_amount must be > 0 and <= 1000000.00");
  }
  let assets: AssetId[] | null = null;
  if (i.allowed_assets !== undefined && i.allowed_assets !== null) {
    const enabled = new Set(enabledAssets(env).map((a) => a.id));
    if (!Array.isArray(i.allowed_assets) || i.allowed_assets.length === 0 || !i.allowed_assets.every((a) => typeof a === "string" && enabled.has(a as AssetId)))
      return bad("allowed_assets must be a non-empty list of enabled assets");
    assets = [...new Set(i.allowed_assets as AssetId[])];
  }
  return { ok: true, value: { title: i.title.trim(), price_minor: price, currency: i.price_currency, allowed_assets: assets } };
}

// ---------- invoice budget (D1) ----------
// Only a POST of a link's Pay form creates an invoice. Each one first reserves a slot: per link (10 a UTC minute) and
// then globally (40 a minute across every link), each one atomic upsert on link_budget. A refused per-link attempt does
// not touch the global count, so one hammered link cannot use the others' budget by itself. Any D1 error throws, and the
// caller refuses (fail closed). Invoices are cheap (no address, payment or watcher until the customer picks an asset),
// so the budget bounds table growth and webhook volume rather than money.

export const LINK_BUDGET_PER_MIN = 10;
export const LINK_BUDGET_GLOBAL_PER_MIN = 40;
export const LINK_BUDGET_GLOBAL_KEY = "link:*";

async function bump(db: D1Database, key: string, bucket: number): Promise<number> {
  const r = await db
    .prepare("INSERT INTO link_budget(key,bucket,n) VALUES(?1,?2,1) ON CONFLICT(key,bucket) DO UPDATE SET n=n+1 RETURNING n")
    .bind(key, bucket)
    .first<{ n: number }>();
  if (!r) throw new Error("link_budget: no row returned");
  return r.n;
}

/** Reserves one invoice for this link in the current UTC minute. ok=false: over a budget, create nothing. Throws on D1 errors. */
export async function reserveLinkBudget(db: D1Database, linkId: string, now = Date.now()): Promise<{ ok: boolean; scope?: "link" | "global" }> {
  const bucket = Math.floor(now / 60_000);
  await db.prepare("DELETE FROM link_budget WHERE bucket < ?").bind(bucket - 1).run();
  if ((await bump(db, `link:${linkId}`, bucket)) > LINK_BUDGET_PER_MIN) return { ok: false, scope: "link" };
  const g = await bump(db, LINK_BUDGET_GLOBAL_KEY, bucket);
  if (g === LINK_BUDGET_GLOBAL_PER_MIN + 1)
    await recordAlert(db, "links.budget", null, `Payment links asked for more than ${LINK_BUDGET_GLOBAL_PER_MIN} invoices in one minute: link checkouts were refused until the minute ended. Check access logs; deactivate a link that is being abused.`, now).catch(() => false);
  if (g > LINK_BUDGET_GLOBAL_PER_MIN) return { ok: false, scope: "global" };
  return { ok: true };
}

export const linkUrl = (publicUrl: string, id: string): string => `${publicUrl.replace(/\/+$/, "")}/l/${id}`;

/** Public API shape of a link; money is a string. */
export function serializeLink(l: LinkRow, publicUrl: string) {
  return {
    id: l.id,
    title: l.title,
    price_amount: l.price_minor === null ? null : formatFiat(l.price_minor),
    price_currency: l.currency,
    allowed_assets: l.allowed_assets,
    active: l.active,
    url: linkUrl(publicUrl, l.id),
    created_at: new Date(l.created_at).toISOString(),
  };
}
