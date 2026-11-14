-- Outbox: enqueued_at is set once the event's delivery job is on the queue.
-- NULL rows older than a minute are re-enqueued by the cron (requeuePendingEvents).
ALTER TABLE events ADD COLUMN enqueued_at INTEGER;

-- Rows written before the outbox existed were enqueued inline; don't redeliver them.
UPDATE events SET enqueued_at = created_at;

CREATE INDEX idx_events_outbox ON events(enqueued_at, created_at);
