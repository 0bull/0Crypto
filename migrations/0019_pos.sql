-- Plan 5: POS. One settings row. The PIN is PBKDF2-hashed (same scheme as the admin password); `version` is embedded in
-- every POS cookie, and bumps whenever the PIN is set, changed or disabled, which invalidates every POS session.
CREATE TABLE pos_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash TEXT,
  pin_salt TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO pos_config(id) VALUES (1);

-- The POS "recent" list reads the newest invoices created with metadata {"pos":true}.
CREATE INDEX idx_invoices_pos ON invoices(created_at DESC) WHERE json_extract(metadata, '$.pos') = 1;
