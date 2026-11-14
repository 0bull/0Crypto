-- Plan 4 final fix wave: fair routing windows, retired sources, the EVM hot-wallet nonce lease.

-- UTXO routing sources (payments) are checked like own_addresses: a rotating cursor by oldest route_checked_at, a few
-- slots for the ones funded at their last check (src/routing/sources.ts). route_note says why routed_at was set
-- without a route leg spending the deposit: a retired source (never re-derives, watch mode, emptied long ago).
-- No backfill: payments created before this migration (including any from a chain that was in watch mode then) are
-- left to the cursor, which checks each and retires it on evidence, never on a guess.
ALTER TABLE payments ADD COLUMN route_checked_at INTEGER;
ALTER TABLE payments ADD COLUMN route_funded_at INTEGER;
ALTER TABLE payments ADD COLUMN route_note TEXT;
CREATE INDEX payments_route_cursor ON payments(chain, routed_at, route_checked_at);

-- The router's execute and poll windows rotate: each visit stamps the batch, the least recently visited go first.
ALTER TABLE route_batches ADD COLUMN executed_at INTEGER;
ALTER TABLE route_batches ADD COLUMN polled_at INTEGER;

-- Which routed asset a run starts with (round robin), so one slow asset never starves the others.
ALTER TABLE router_lock ADD COLUMN asset_offset INTEGER NOT NULL DEFAULT 0;

-- One EVM hot-wallet send at a time per chain (sweeps, shields, refunds): read the pending nonce, sign, broadcast.
CREATE TABLE hot_nonce_lease (
  chain TEXT PRIMARY KEY,
  holder TEXT,
  expires_at INTEGER
);

-- When a refund's signed tx was recorded (the UTXO cancel waits CANCEL_MIN_AGE_MS from it).
ALTER TABLE refunds ADD COLUMN tx_at INTEGER;
