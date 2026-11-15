-- What a balance-based payment (EVM, Solana) had at its address when it was last swept, atomic units. Its address reads
-- 0 after a sweep, so step observes swept_base + the current balance: a refill sent to that address is credited and the
-- payment is swept again (src/core/state.ts). Set by the EVM and Solana sweepers; NULL until a payment is swept.
ALTER TABLE payments ADD COLUMN swept_base TEXT;
