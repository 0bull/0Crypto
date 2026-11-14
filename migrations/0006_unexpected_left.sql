-- Set (with swept_at) when a sweep had to leave a registry token at the address because flushing it reverted
-- (a blacklisted forwarder, a paused token): the payment's own funds moved, the rest waits for a single-token recovery.
ALTER TABLE payments ADD COLUMN unexpected_left INTEGER NOT NULL DEFAULT 0;
