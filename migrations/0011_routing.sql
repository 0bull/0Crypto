-- Plan 4 privacy routing.

-- One row per routing batch of an asset: `total` and `chunks` (JSON array) are atomic-unit strings (bigint). `legs` is
-- a JSON array of the batch's sends, e.g. [{tradeId, depositAddress, amount, tx, status}]; the spending guard
-- (src/routing/guard.ts) allows a trade's depositAddress only through the batch that recorded it.
CREATE TABLE route_batches (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  total TEXT NOT NULL,
  chunks TEXT NOT NULL,
  destination TEXT NOT NULL,
  due_at INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  legs TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
CREATE INDEX route_batches_status ON route_batches(status, due_at);

-- Dashboard refunds. The guard allows `to_address` once: approved, unsent (tx NULL) and not yet consumed; minting the
-- proof sets consumed_at in the same statement that checks it.
CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  to_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  approved_at INTEGER,
  tx TEXT,
  consumed_at INTEGER
);
CREATE INDEX refunds_payment ON refunds(payment_id);

-- At most one router run at a time (a lease).
CREATE TABLE router_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  expires_at INTEGER
);

-- When a payment's funds were routed. UTXO payments are routed straight from their deposit UTXOs, never swept.
ALTER TABLE payments ADD COLUMN routed_at INTEGER;
