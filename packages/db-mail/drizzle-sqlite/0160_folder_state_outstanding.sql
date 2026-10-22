-- 0160_folder_state_outstanding — the pg entry's twin: the column, kept by two triggers that run
-- only when the new row is an outstanding filing of ours, the partial index, and the backfill.
--
-- AFTER triggers (0154's pattern): this store has no BEFORE trigger that can set NEW, so each sets
-- the column on the row it just wrote. The update trigger's own guard (`IS NOT` the message's
-- account) stops it firing again on the row it sets. The backfill reads the filings outstanding
-- before this entry. Replay-safe after the column: IF NOT EXISTS throughout, and the backfill only
-- touches NULL rows.

ALTER TABLE "folder_state" ADD COLUMN "outstanding_account_id" text;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS folder_state_outstanding_account_insert AFTER INSERT ON folder_state
  WHEN NEW."reconcile_status" = 'pending' and NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder"
BEGIN
  UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS folder_state_outstanding_account_update AFTER UPDATE ON folder_state
  WHEN NEW."reconcile_status" = 'pending' and NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder"
BEGIN
  UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id AND outstanding_account_id IS NOT (SELECT account_id FROM messages WHERE id = NEW.message_id);
END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_state_outstanding_idx" ON "folder_state" ("outstanding_account_id", "message_id") WHERE "reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder";
--> statement-breakpoint
UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = folder_state.message_id)
 WHERE outstanding_account_id IS NULL AND "reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder";
