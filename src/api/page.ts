import { base64urlnopad } from "@scure/base";

/*
 * Keyset pagination for API lists, newest first: `?limit=` (1-100, default 50) and `?cursor=` (opaque, from the previous
 * page's `next_cursor`; null on the last page). The key is (created_at, id), so rows sharing a created_at are never
 * skipped or repeated, and a row created while paging never shifts the pages.
 */

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export interface Cursor {
  created_at: number;
  id: string;
}
export type Page = { limit: number; after: Cursor | null };

export const encodeCursor = (c: Cursor): string => base64urlnopad.encode(new TextEncoder().encode(`${c.created_at}:${c.id}`));

function decodeCursor(s: string): Cursor | null {
  try {
    const m = /^(\d{1,16}):([a-z]{2,4}_[a-z2-7]{8,64})$/.exec(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64urlnopad.decode(s)));
    return m ? { created_at: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
}

/** Reads ?limit= and ?cursor=. A malformed value is an error (400), never silently the first page. */
export function parsePage(query: (k: string) => string | undefined): { ok: true; page: Page } | { ok: false; message: string } {
  const rawLimit = query("limit");
  let limit = PAGE_DEFAULT;
  if (rawLimit !== undefined) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > PAGE_MAX) return { ok: false, message: `limit must be an integer from 1 to ${PAGE_MAX}` };
    limit = Number(rawLimit);
  }
  const rawCursor = query("cursor");
  let after: Cursor | null = null;
  if (rawCursor !== undefined && rawCursor !== "") {
    after = decodeCursor(rawCursor);
    if (!after) return { ok: false, message: "cursor is not valid" };
  }
  return { ok: true, page: { limit, after } };
}

/**
 * Runs one page of `SELECT <cols> FROM <table> [WHERE keyset] ORDER BY created_at DESC, id DESC`. `table` and `cols`
 * are code constants, never input. Returns the raw rows and the cursor of the next page.
 */
export async function pageOf<R extends { id: string; created_at: number }>(db: D1Database, table: string, cols: string, page: Page): Promise<{ rows: R[]; next: string | null }> {
  const where = page.after ? "WHERE created_at < ?1 OR (created_at = ?1 AND id < ?2)" : "";
  const stmt = db.prepare(`SELECT ${cols} FROM ${table} ${where} ORDER BY created_at DESC, id DESC LIMIT ${page.after ? "?3" : "?1"}`);
  const { results } = await (page.after ? stmt.bind(page.after.created_at, page.after.id, page.limit + 1) : stmt.bind(page.limit + 1)).all<R>();
  const more = results.length > page.limit;
  const rows = more ? results.slice(0, page.limit) : results;
  const last = rows[rows.length - 1];
  return { rows, next: more && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null };
}
