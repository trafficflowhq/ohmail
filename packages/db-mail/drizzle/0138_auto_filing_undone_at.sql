-- 0138_auto_filing_undone_at — the Screener's automatic filing, put back by the person.
--
-- The auto-apply pass files obvious bulk out of the Screener and records the undo in `audit_log`.
-- Put back moves the message to the gate through the ordinary move door, which writes
-- `last_set_by = 'us'` (the only value the reconciler carries), so the pass's own candidate
-- statement would file it again on its next full walk. This column is the durable "not again":
-- written by the undo, read as the pass's sixth exclusion (`auto_filing_undone_at IS NULL`). NULL
-- on every existing row, no backfill. ROLLBACK is
-- `ALTER TABLE folder_state DROP COLUMN auto_filing_undone_at`.

ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "auto_filing_undone_at" timestamp with time zone;
