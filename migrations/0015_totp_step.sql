-- The last TOTP step accepted for a money action (src/admin/confirm.ts): advanced only by a compare-and-set
-- (UPDATE ... WHERE totp_last_step < step), so two requests carrying the same code cannot both pass.
ALTER TABLE admin ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
