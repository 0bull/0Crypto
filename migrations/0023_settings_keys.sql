-- Gateway settings edited from the admin (src/settings.ts). A row overrides the Wrangler var of the same name, even when
-- its value is empty; PUBLIC_URL is the exception (a non-empty var wins). Keys are the SETTING_KEYS names.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL  -- unix ms
);

-- Keys the Worker generates for itself (src/keys.ts), used when the matching secret is blank: "session" fills
-- SESSION_SECRET, "webhook" fills WEBHOOK_SECRET (as whsec_<value>). 32 random bytes, base64url. Created once.
CREATE TABLE instance_keys (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL  -- unix ms
);
