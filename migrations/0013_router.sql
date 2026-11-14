-- Plan 4 Task 7: the router cron, the routing dashboard and guarded refunds.

-- EVM batches: one Railgun ShieldProgress per chunk (JSON array, index = chunk), written only by the router through a
-- compare-and-set on this column (src/routing/router.ts). Swap batches keep their state in `legs`.
ALTER TABLE route_batches ADD COLUMN progress TEXT NOT NULL DEFAULT '[]';
-- When routing.stuck was first raised for an EVM batch (swap legs carry their own stuckAt).
ALTER TABLE route_batches ADD COLUMN stuck_at INTEGER;
-- When an operator marked the batch resolved (status 'resolved', terminal; nothing is done on chain).
ALTER TABLE route_batches ADD COLUMN resolved_at INTEGER;
-- At most one scheduled (not yet executing) batch per asset.
CREATE UNIQUE INDEX route_batches_one_scheduled ON route_batches(asset) WHERE status = 'scheduled';

-- Refund sends: `claim` is taken (compare-and-set) before the guard proof is minted; the signed tx is recorded only
-- while the claim still holds, before the broadcast. `error` is the last send problem shown on the dashboard.
ALTER TABLE refunds ADD COLUMN created_at INTEGER;
ALTER TABLE refunds ADD COLUMN claim TEXT;
ALTER TABLE refunds ADD COLUMN claimed_at INTEGER;
ALTER TABLE refunds ADD COLUMN sent_at INTEGER;
ALTER TABLE refunds ADD COLUMN error TEXT;

-- Audit log of operator actions that change money state (dashboard routing actions and refunds).
CREATE TABLE routing_actions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  batch_id TEXT,
  leg INTEGER,
  refund_id TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX routing_actions_batch ON routing_actions(batch_id, created_at);
