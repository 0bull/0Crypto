-- Consecutive already-expired ("stale") transactions TronGrid built for this payment's sweep. Reset when an answer
-- passes the checks; at 3 the sweeper raises sweep.failing (the node is probably lagging). Per payment because a stale
-- top-up answer comes before any sweep row exists.
ALTER TABLE payments ADD COLUMN sweep_stale INTEGER NOT NULL DEFAULT 0;
