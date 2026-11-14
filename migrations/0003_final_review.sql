-- When funds for a payment were first seen (unix ms). The rate lock and the late flag are judged
-- against this, not against finality. NULL until the first sighting.
ALTER TABLE payments ADD COLUMN detected_at INTEGER;

CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_events_invoice ON events(invoice_id);
CREATE INDEX idx_deliveries_event ON deliveries(event_id);
