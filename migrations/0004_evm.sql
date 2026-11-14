-- Balances of assets other than the payment's own, seen at its EVM deposit address:
-- JSON {"<assetId>": "<decimal atomic amount>"}, NULL when there are none. Informational only (never credited).
ALTER TABLE payments ADD COLUMN unexpected TEXT;
