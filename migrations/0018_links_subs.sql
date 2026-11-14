-- Plan 5: payment links and recurring-invoice subscriptions. Money is TEXT bigint minor units; times are unix ms.
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price_minor TEXT,              -- NULL: the customer enters the amount
  currency TEXT NOT NULL,
  allowed_assets TEXT,           -- JSON array of asset ids, NULL = every enabled asset
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  price_minor TEXT NOT NULL,
  currency TEXT NOT NULL,
  interval TEXT NOT NULL,
  anchor_day INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
