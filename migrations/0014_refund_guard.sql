-- Plan 4 Task 7 fix round: refunds share the router's lease and accounting.

-- When a refund's signed tx was recorded for a UTXO payment: that tx spends all of the deposit's outputs, so the router
-- never plans them again (routableInputs) and no second refund is taken from them (refundBlock). Its own column, not
-- routed_at: routed_at means "spent by a route leg" (an operator's "release" clears it for a leg), and a cancelled
-- refund clears only this one.
ALTER TABLE payments ADD COLUMN refunded_at INTEGER;
-- A refund the operator cancelled (never sent, or a UTXO tx that provably never landed): no longer counted against
-- the payment's refundable amount, never minted, sent or re-approved.
ALTER TABLE refunds ADD COLUMN cancelled_at INTEGER;
-- UTXO refunds: the outpoints the signed tx spends (JSON [{txid,vout,value}]), for the cancel check.
ALTER TABLE refunds ADD COLUMN inputs TEXT;
