-- Tron sweeps span several cron runs: TRX top-up -> energy rental -> USDT transfer -> reconcile (src/sweep/tron.ts).
-- `step` is where a pending Tron sweep stands: topup (top-up broadcast, waiting until solid) | energy (to rent) |
-- rented (waiting for the rented energy) | transfer (USDT transfer broadcast, waiting until solid). NULL on EVM rows.
-- `meta` is that step's JSON state: {deposit, index, topup?: {txid, exp}, energy?, rentAt?, orderId?, amount?, exp?}.
-- No keys or signatures are ever stored.
ALTER TABLE sweeps ADD COLUMN step TEXT;
ALTER TABLE sweeps ADD COLUMN meta TEXT;
