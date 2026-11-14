-- Solana sweeps batch up to 8 deposits per tx (src/sweep/solana.ts). When a batch tx fails, the failure is not counted
-- against anyone (any one deposit may have caused it): every payment in it gets sweep_solo=1 and is then swept one
-- deposit per tx, where a failure is counted (payments.sweep_paid_attempts) against that payment alone. Cleared once
-- the payment is swept.
ALTER TABLE payments ADD COLUMN sweep_solo INTEGER NOT NULL DEFAULT 0;
