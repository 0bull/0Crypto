-- POS PIN login attempt counters, kept in D1 so check-and-reserve is one atomic statement (KV is not atomic).
-- key: "ip:<hmac of the address>" or "global". window_start is unix ms; a stale window resets in the upsert.
CREATE TABLE pos_attempts (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
