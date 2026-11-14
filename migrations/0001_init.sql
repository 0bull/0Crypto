CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  price_minor TEXT NOT NULL,
  currency TEXT NOT NULL,
  order_id TEXT,
  metadata TEXT,
  success_url TEXT,
  allowed_assets TEXT,
  status TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  overpaid INTEGER NOT NULL DEFAULT 0,
  paid_minor TEXT NOT NULL DEFAULT '0'
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  asset TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  derivation_index INTEGER NOT NULL,
  reference TEXT,
  expected TEXT NOT NULL,
  price_e8 TEXT NOT NULL,
  rate_locked_until INTEGER NOT NULL,
  received TEXT NOT NULL DEFAULT '0',
  final TEXT NOT NULL DEFAULT '0',
  txids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  credited_minor TEXT NOT NULL DEFAULT '0',
  credit_price_e8 TEXT
);

CREATE TABLE derivation_counters (
  chain TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE deliveries (
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status INTEGER,
  error TEXT
);

CREATE TABLE api_keys (
  hash TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  totp_secret TEXT
);

CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_invoices_status ON invoices(status);
