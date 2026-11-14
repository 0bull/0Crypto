-- Payment-link invoice budget: one row per (key, UTC minute). key is "link:<link id>" (30 invoices a minute per link) or
-- "link:*" (120 a minute across every link). Counted with one atomic upsert per key; rows older than a minute are pruned
-- on the next reservation. D1 rather than the Rate Limiting binding: one exact, global count (the binding counts per
-- Cloudflare location) that tests can read and seed.
CREATE TABLE link_budget (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,   -- floor(unix ms / 60000)
  n INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
