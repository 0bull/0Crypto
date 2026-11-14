-- DEV ONLY: demo data for local browser checks of the admin. Never run against a real database.
--
--   npx wrangler d1 migrations apply DB --local --persist-to <dir>
--   (claim /admin/setup first: this file inserts no passkeys and no settings, so it never bypasses setup)
--   npx wrangler d1 execute DB --local --persist-to <dir> --file tools/dev-seed.sql
--
-- What it adds, relative to the time it runs (re-running is a no-op: every row has a fixed id and INSERT OR IGNORE):
--   * 40 invoices over the last 30 days, USD with every fifth in EUR: mostly paid, some partially paid, waiting and
--     expired; 12 older paid USD invoices between 31 and 89 days ago (the previous period and the 90-day chart).
--   * A confirmed payment per paid invoice of the last 30 days, in BTC, USDC on Base or Lightning BTC; every on-chain
--     one has a 64-character transaction hash.
--   * One payment holding an unexpected DAI deposit (the Unexpected deposits panel).
--   * One unresolved sweep.failing alert on sol ("1 thing needs you").
--   * Three payment links: fixed price, open amount, inactive.

-- Recent invoices: the last 30 days.
INSERT OR IGNORE INTO invoices(id,created_at,expires_at,price_minor,currency,order_id,metadata,success_url,allowed_assets,status,late,overpaid,paid_minor)
WITH RECURSIVE
  n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40),
  t(now) AS (SELECT CAST(strftime('%s','now') AS INTEGER) * 1000),
  r AS (
    SELECT i,
      t.now - ((i * 7) % 30) * 86400000 - ((i * 13) % 20) * 3600000 - 60000 AS created,
      t.now AS now,
      CASE WHEN i % 5 = 0 THEN 'EUR' ELSE 'USD' END AS currency,
      1200 + (i * 1237) % 18000 AS price,
      CASE WHEN i % 9 = 0 THEN 'expired' WHEN i % 7 = 0 THEN 'partially_paid' WHEN i % 11 = 0 OR i = 1 THEN 'open' ELSE 'paid' END AS status
    FROM n, t
  )
SELECT printf('inv_seed%03d', i), created,
  CASE WHEN status IN ('open','partially_paid') THEN now + 86400000 ELSE created + 3600000 END,
  CAST(price AS TEXT), currency, printf('#%d', 1000 + i), NULL, NULL, NULL, status, 0, 0,
  CAST(CASE status WHEN 'paid' THEN price WHEN 'partially_paid' THEN price / 2 ELSE 0 END AS TEXT)
FROM r;

-- Older paid invoices: 31 to 89 days ago.
INSERT OR IGNORE INTO invoices(id,created_at,expires_at,price_minor,currency,order_id,metadata,success_url,allowed_assets,status,late,overpaid,paid_minor)
WITH RECURSIVE
  n(i) AS (SELECT 41 UNION ALL SELECT i + 1 FROM n WHERE i < 52),
  t(now) AS (SELECT CAST(strftime('%s','now') AS INTEGER) * 1000)
SELECT printf('inv_seed%03d', i), t.now - (31 + (i * 11) % 58) * 86400000, t.now - (31 + (i * 11) % 58) * 86400000 + 3600000,
  CAST(900 + (i * 977) % 9000 AS TEXT), 'USD', printf('#%d', 1000 + i), NULL, NULL, NULL, 'paid', 0, 0, CAST(900 + (i * 977) % 9000 AS TEXT)
FROM n, t;

-- A confirmed payment for each recent paid invoice: BTC, USDC on Base, Lightning BTC in turn.
INSERT OR IGNORE INTO payments(id,invoice_id,asset,chain,address,derivation_index,reference,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,detected_at,confirmed_at,credited_minor,credit_price_e8,unexpected,swept_at)
SELECT printf('pay_seed%03d', CAST(substr(i.id, 9) AS INTEGER)), i.id,
  CASE CAST(substr(i.id, 9) AS INTEGER) % 3 WHEN 0 THEN 'btc:btc' WHEN 1 THEN 'base:usdc' ELSE 'ln:btc' END,
  CASE CAST(substr(i.id, 9) AS INTEGER) % 3 WHEN 0 THEN 'btc' WHEN 1 THEN 'base' ELSE 'ln' END,
  CASE CAST(substr(i.id, 9) AS INTEGER) % 3
    WHEN 0 THEN printf('bc1qseed%032d', CAST(substr(i.id, 9) AS INTEGER))
    WHEN 1 THEN printf('0x5eed%036d', CAST(substr(i.id, 9) AS INTEGER))
    ELSE printf('lnbc-seed-%03d', CAST(substr(i.id, 9) AS INTEGER)) END,
  1000 + CAST(substr(i.id, 9) AS INTEGER), NULL, '1', '100000000', i.created_at + 900000, '1', '1',
  CASE CAST(substr(i.id, 9) AS INTEGER) % 3
    WHEN 0 THEN '["' || lower(hex(randomblob(32))) || '"]'
    WHEN 1 THEN '["0x' || lower(hex(randomblob(32))) || '"]'
    ELSE '[]' END,
  'confirmed', i.created_at + 60000, i.created_at + 120000, i.created_at + 600000, i.paid_minor, '100000000', NULL,
  CASE CAST(substr(i.id, 9) AS INTEGER) % 3 WHEN 1 THEN i.created_at + 1200000 ELSE NULL END
FROM invoices i
WHERE i.id LIKE 'inv_seed%' AND CAST(substr(i.id, 9) AS INTEGER) <= 40 AND i.status = 'paid';

-- An unexpected deposit: 2.5 DAI sent to the USDC address of waiting invoice #1001.
INSERT OR IGNORE INTO payments(id,invoice_id,asset,chain,address,derivation_index,reference,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,detected_at,confirmed_at,credited_minor,credit_price_e8,unexpected)
SELECT 'pay_seed_unexpected', 'inv_seed001', 'base:usdc', 'base', '0x5eed00000000000000000000000000000000beef', 2001, NULL, '12000000', '100000000',
  created_at + 900000, '0', '0', '[]', 'awaiting', created_at + 60000, NULL, NULL, '0', NULL, '{"base:dai":"2500000000000000000"}'
FROM invoices WHERE id = 'inv_seed001';

-- A confirmed Tron payment whose sweep failed (invoice detail: sweep error, Refund link, Retry sweep form), and long metadata.
INSERT OR IGNORE INTO payments(id,invoice_id,asset,chain,address,derivation_index,reference,expected,price_e8,rate_locked_until,received,final,txids,status,created_at,detected_at,confirmed_at,credited_minor,credit_price_e8,unexpected,swept_at,sweep_error)
SELECT 'pay_seed_sweeperr', 'inv_seed006', 'tron:usdt', 'tron', 'TSeedSweepErrorAddress000000000000001', 3001, NULL, '10000000', '100000000',
  created_at + 900000, '10000000', '10000000', '["9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"]', 'confirmed', created_at + 60000, created_at + 120000, created_at + 180000, '1000', '100000000', NULL, NULL, 'energy delegation failed (needs admin)'
FROM invoices WHERE id = 'inv_seed006';
UPDATE invoices SET metadata = '{"customer":"<b>Ann</b> \"The Roaster\"","ref":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' WHERE id = 'inv_seed006' AND metadata IS NULL;

-- One thing that needs you: Solana sweeps failing.
INSERT OR IGNORE INTO alerts(id,created_at,kind,chain,detail,resolved_at)
SELECT 'alt_seed_sol', CAST(strftime('%s','now') AS INTEGER) * 1000 - 7200000, 'sweep.failing', 'sol',
  'A Solana sweep failed twice (blockhash not found). It retries on the next run; resolve this once it goes through.', NULL;

-- Payment links: one fixed price, one open-amount, one inactive (the Payment links page).
INSERT OR IGNORE INTO links(id,title,price_minor,currency,allowed_assets,active,created_at) VALUES
  ('lnk_seed_fixed', 'Roasted beans, 1 kg', '2450', 'USD', NULL, 1, CAST(strftime('%s','now') AS INTEGER) * 1000 - 5 * 86400000),
  ('lnk_seed_open', 'Tip jar', NULL, 'USD', '["btc:btc"]', 1, CAST(strftime('%s','now') AS INTEGER) * 1000 - 3 * 86400000),
  ('lnk_seed_off', 'Spring workshop (closed)', '8000', 'EUR', NULL, 0, CAST(strftime('%s','now') AS INTEGER) * 1000 - 40 * 86400000);

-- Subscriptions: one monthly, one weekly in EUR, one inactive (the Subscriptions page).
INSERT OR IGNORE INTO subscriptions(id,label,price_minor,currency,interval,anchor_day,next_at,active,metadata,created_at) VALUES
  ('sub_seed_pro', 'Pro plan', '1999', 'USD', 'monthly', 1, CAST(strftime('%s','now') AS INTEGER) * 1000 + 12 * 86400000, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 - 60 * 86400000),
  ('sub_seed_weekly', 'Weekly coffee box', '1250', 'EUR', 'weekly', 1, CAST(strftime('%s','now') AS INTEGER) * 1000 + 3 * 86400000, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 - 20 * 86400000),
  ('sub_seed_off', 'Legacy yearly plan', '9900', 'USD', 'yearly', 1, CAST(strftime('%s','now') AS INTEGER) * 1000 + 200 * 86400000, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 - 300 * 86400000);

-- Privacy routing: a stuck batch whose leg has a provider, a payout hash and the stuck flag (multi-value table cells).
INSERT OR IGNORE INTO route_batches(id,asset,total,chunks,destination,status,created_at,updated_at,legs)
VALUES ('rb_seed_stuck', 'btc:btc', '150000000', '["150000000"]', '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', 'executing',
  CAST(strftime('%s','now') AS INTEGER) * 1000 - 7200000, CAST(strftime('%s','now') AS INTEGER) * 1000 - 7200000,
  '[{"chunk":0,"step":"sent","amount":"150000000","createdAt":0,"updatedAt":0,"tradeId":"TRADE0123456789abcdef0123456789abcdef","provider":"acme-swap","providerTradeId":"P-77231","tx":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","hashout":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","stuckAt":1,"status":"waiting"}]');
