-- Tron sweeps run side by side (up to TRON_MAX_PENDING in src/sweep/tron.ts): each waits minutes between steps, and
-- Tron txs carry no nonce, so one per chain would leave deposits queued for hours.
-- The one-pending-per-chain backstop stays exactly as it was for every other chain ...
DROP INDEX sweeps_one_pending;
CREATE UNIQUE INDEX sweeps_one_pending ON sweeps(chain) WHERE status='pending' AND chain<>'tron';
-- ... and Tron gets one pending sweep per payment (a Tron sweep row always covers exactly one payment).
CREATE UNIQUE INDEX sweeps_tron_one_pending_per_payment ON sweeps(payment_ids) WHERE status='pending' AND chain='tron';
-- Sweep attempts of this payment that paid for energy and then failed (revert, energy never arrived). At 2 the payment
-- stops auto-retrying until an admin clicks "Retry sweep", which resets it.
ALTER TABLE payments ADD COLUMN sweep_paid_attempts INTEGER NOT NULL DEFAULT 0;
