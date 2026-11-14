-- Plan 4 final fix N1: a payment source is never retired on configuration alone (an xpub, a wrong seed), only on
-- evidence that its deposit stayed empty: two empty reads at least 24 h apart. route_empty_at is the first of them
-- (NULL again once outputs show up).
ALTER TABLE payments ADD COLUMN route_empty_at INTEGER;

-- Undo what 0016's code could have retired on configuration (watch mode, a seed that does not derive the address):
-- those deposits are routable again once the configuration is right. A no-op where 0016's code never ran.
UPDATE payments SET routed_at=NULL, route_note=NULL, route_checked_at=NULL, route_funded_at=NULL
  WHERE route_note IN (
    'retired: watch mode (an xpub is set): the gateway never spends this chain''s deposits',
    'retired: the deposit address does not re-derive from MASTER_SEED at its index: the gateway cannot spend it'
  );
