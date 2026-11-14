-- Passkey admin (Plan 7). The old `admin` table (password + TOTP) stays until the passkey routes replace it.

-- The one admin. session_gen is part of every session cookie; bumping it signs every session out. user_id is the
-- WebAuthn user handle (16 random bytes, hex), fixed for the life of the gateway.
CREATE TABLE admin_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  session_gen INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0  -- unix ms (0 until set)
);
INSERT INTO admin_state(id,user_id) VALUES(1, lower(hex(randomblob(16))));

-- Registered passkeys. id is the credential id (base64url); counter is the last signature counter (0 = it does not count).
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,            -- JSON array, as the browser reported it
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Single-use WebAuthn challenges (src/admin/challenges.ts). id is the challenge itself (32 random bytes, base64url).
-- A check deletes the row only when kind and payload_hash (the binding of what it was issued for) both match.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL  -- unix ms
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges(expires_at);

-- One-time setup and recovery codes printed to the Worker logs (src/admin/setup-codes.ts). Only the SHA-256 hex of the
-- normalised phrase is stored.
CREATE TABLE setup_codes (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('setup','recover')),
  created_at INTEGER NOT NULL,  -- unix ms
  expires_at INTEGER NOT NULL   -- unix ms
);

-- Wrong-code counters, same shape and upsert as pos_attempts. key: "ip:<hmac of the client key>" or "global".
CREATE TABLE setup_attempts (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  window_start INTEGER NOT NULL  -- unix ms
);
