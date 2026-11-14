-- Sweeps: moving confirmed EVM deposits from their forwarder addresses to the hot wallet.
ALTER TABLE payments ADD COLUMN swept_at INTEGER;
ALTER TABLE payments ADD COLUMN sweep_tx TEXT;
-- Why the last sweep attempt for this payment failed (short), and when to try again (unix ms).
ALTER TABLE payments ADD COLUMN sweep_error TEXT;
ALTER TABLE payments ADD COLUMN sweep_retry_at INTEGER;
CREATE INDEX payments_sweep ON payments(chain, status, swept_at);

-- One row per sweep transaction. id prefix "swp_" = a normal sweep (confirming it sets payments.swept_at),
-- "rec_" = an admin recovery (never marks the payment swept: the funds may be unrelated to its invoice).
CREATE TABLE sweeps (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  tx TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL, -- pending | confirmed | failed
  payment_ids TEXT NOT NULL, -- JSON array
  error TEXT,
  nonce INTEGER, -- the hot wallet nonce every tx of this sweep uses (replacements reuse it)
  txs TEXT, -- JSON array of every tx hash broadcast for this sweep (`tx` is the latest)
  req TEXT -- JSON {data,gas,type,maxFeePerGas,maxPriorityFeePerGas,gasPrice,at}: what is needed to re-sign with higher fees
);
CREATE INDEX sweeps_chain_status ON sweeps(chain, status);
-- Backstop for the one-sweep-in-flight rule.
CREATE UNIQUE INDEX sweeps_one_pending ON sweeps(chain) WHERE status='pending';

-- Operator alerts shown on the admin dashboard (not webhooks).
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  chain TEXT,
  detail TEXT NOT NULL,
  resolved_at INTEGER
);
