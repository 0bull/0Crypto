-- Plan 4: our own UTXO change and refund addresses (fresh deposit-chain indexes allocated by the swap executor).
-- A row is written in the same transaction as its index allocation (src/routing/own.ts), so an allocated own
-- address is never unrecorded. The router checks them round-robin by checked_at (funded-at-last-check first) and
-- offers funded ones as routing inputs: none is ever forgotten, whatever its age.
CREATE TABLE own_addresses (
  chain TEXT NOT NULL,
  address TEXT PRIMARY KEY,
  derivation_index INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('change', 'refund')),
  created_at INTEGER NOT NULL,
  last_seen_funded_at INTEGER,
  checked_at INTEGER
);
CREATE UNIQUE INDEX own_addresses_index ON own_addresses(chain, derivation_index);
CREATE INDEX own_addresses_cursor ON own_addresses(chain, checked_at);
