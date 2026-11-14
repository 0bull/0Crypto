// Migration 0027: indexes for the hot queries. The SQL below is copied from the code (literal binds).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { dueSql } from "../../src/db/repo";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const plan = async (sql: string) =>
  (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((r) => r.detail);

const cases: [string, string, RegExp, RegExp?][] = [
  [
    "expiry sweep (watcher/expiry.ts)",
    "SELECT id FROM invoices i WHERE status='open' AND expires_at < 1000 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id=i.id) ORDER BY expires_at LIMIT 500",
    /USING (COVERING )?INDEX invoices_status_expires/,
    /SCAN i/,
  ],
  [
    "hasOpenInvoices (prices/cache.ts)",
    "SELECT 1 FROM invoices WHERE status IN ('open','partially_paid') AND expires_at > 1000 LIMIT 1",
    /USING (COVERING )?INDEX invoices_status_expires/,
    /SCAN invoices/,
  ],
  [
    "overview received (admin/stats.ts)",
    "SELECT currency, CAST(SUM(CAST(paid_minor AS INTEGER)) AS TEXT) AS s FROM invoices WHERE created_at>=1 AND created_at<2000 AND CAST(paid_minor AS INTEGER)>0 GROUP BY currency",
    /USING INDEX invoices_created/,
  ],
  [
    "overview created count (admin/stats.ts)",
    "SELECT COUNT(*) AS n FROM invoices WHERE created_at>=1 AND created_at<2000",
    /USING (COVERING )?INDEX invoices_created/,
  ],
  [
    "invoices list, newest first (admin/stats.ts)",
    "SELECT i.id FROM invoices i ORDER BY i.created_at DESC, i.id DESC LIMIT 50",
    /INDEX invoices_created/,
    /TEMP B-TREE/,
  ],
  [
    "unexpected deposits (db/repo.ts)",
    "SELECT * FROM payments WHERE unexpected IS NOT NULL ORDER BY created_at DESC, id LIMIT 50",
    /USING INDEX payments_unexpected/,
  ],
  [
    "sweep candidates (db/repo.ts)",
    `SELECT p.*, i.expires_at AS invoice_expires_at FROM payments p JOIN invoices i ON i.id=p.invoice_id
     WHERE p.chain='btc' AND p.swept_at IS NULL AND (p.sweep_retry_at IS NULL OR p.sweep_retry_at<=5)
       AND ${dueSql("5", "6")}
     ORDER BY COALESCE(p.confirmed_at,p.created_at), p.id LIMIT 50`,
    /SEARCH p USING INDEX (payments_unswept_chain|payments_sweep)/,
    /SCAN p/,
  ],
];

describe("hot queries use their indexes", () => {
  it.each(cases)("%s", async (_name, sql, uses, avoids) => {
    const lines = await plan(sql);
    expect(lines.join("\n")).toMatch(uses);
    if (avoids) expect(lines.join("\n")).not.toMatch(avoids);
  });

  it("drops the redundant single-column status index", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_invoices_status'").all();
    expect(results).toEqual([]);
  });
});
