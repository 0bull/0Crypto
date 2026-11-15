-- The rate lock covers only funds seen while it ran (src/core/state.ts creditState). NULL on older rows: step derives
-- the same values from credit_price_e8 and detected_at, so no backfill is needed.
ALTER TABLE payments ADD COLUMN locked_received TEXT;
ALTER TABLE payments ADD COLUMN later_atomic TEXT;
ALTER TABLE payments ADD COLUMN later_minor TEXT;
ALTER TABLE payments ADD COLUMN expiry_received TEXT;
