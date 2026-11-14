-- Each passkey's relying party ID: the host it was created on (src/admin/rp.ts). Only passkeys for the host of
-- PUBLIC_URL can sign in and confirm; the others (an old domain after a move) are listed so they can be removed.
-- 0024 was never deployed, but a dev DB may have applied it, so the column is added here rather than there.
ALTER TABLE passkeys ADD COLUMN rp_id TEXT;

-- Until now every passkey was created on the host of the stored PUBLIC_URL (an origin: scheme://host[:port]).
UPDATE passkeys SET rp_id = (
  SELECT CASE WHEN instr(h, ':') > 0 THEN substr(h, 1, instr(h, ':') - 1) ELSE h END
  FROM (SELECT substr(value, instr(value, '://') + 3) AS h FROM settings WHERE key = 'PUBLIC_URL' AND instr(value, '://') > 0 AND value <> '')
)
WHERE rp_id IS NULL;
