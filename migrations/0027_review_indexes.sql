-- Indexes for the hot queries (expiry sweep, hasOpenInvoices, admin stats and lists, unexpected deposits, sweeps).
CREATE INDEX IF NOT EXISTS invoices_status_expires ON invoices(status, expires_at);
-- Its prefix; status-only lookups use the composite.
DROP INDEX IF EXISTS idx_invoices_status;
CREATE INDEX IF NOT EXISTS invoices_created ON invoices(created_at, id);
CREATE INDEX IF NOT EXISTS payments_unexpected ON payments(created_at) WHERE unexpected IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_unswept_chain ON payments(chain) WHERE swept_at IS NULL;
