-- Plan 5 Task 3: recurring invoices. One row per (subscription, period) that produced an invoice; the primary key is a
-- second line of defence behind the next_at compare-and-set, so a period can never be billed twice. The yearly anchor
-- month needs no column: it is the (invariant) UTC month of next_at, set from start_at at creation.
CREATE TABLE subscription_periods (
  subscription_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,   -- unix ms of the period the invoice bills
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (subscription_id, period_start)
);
CREATE INDEX idx_subscriptions_due ON subscriptions(active, next_at);
