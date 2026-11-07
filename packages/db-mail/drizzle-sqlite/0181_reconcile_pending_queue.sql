-- 0181_reconcile_pending_queue — the pg entry's twin: each reconcile poll's pending rows by account,
-- in its queue order, so a poll stops walking every message of the mailbox. Two more triggers keep
-- `folder_state.outstanding_account_id` on every pending row 0160's leave (the user's own moves, rows
-- whose two sides agree); `flag_state.pending_account_id` and its two triggers keep the account on
-- every pending read mark. AFTER triggers (0160's pattern); the update triggers' own guard stops them
-- rewriting a row that already carries its account. The backfills read the rows pending before this
-- entry. Replay-safe after the column.

CREATE TRIGGER IF NOT EXISTS folder_state_pending_account_insert AFTER INSERT ON folder_state
  WHEN NEW."reconcile_status" = 'pending' and not (NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder")
BEGIN
  UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS folder_state_pending_account_update AFTER UPDATE ON folder_state
  WHEN NEW."reconcile_status" = 'pending' and not (NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder")
BEGIN
  UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id AND outstanding_account_id IS NOT (SELECT account_id FROM messages WHERE id = NEW.message_id);
END;
--> statement-breakpoint
UPDATE folder_state SET outstanding_account_id = (SELECT account_id FROM messages WHERE id = folder_state.message_id)
 WHERE "reconcile_status" = 'pending' AND outstanding_account_id IS NOT (SELECT account_id FROM messages WHERE id = folder_state.message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_state_pending_queue_idx" ON "folder_state" ("outstanding_account_id", "updated_at", "message_id") WHERE "reconcile_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "flag_state" ADD COLUMN "pending_account_id" text;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS flag_state_pending_account_insert AFTER INSERT ON flag_state
  WHEN NEW."reconcile_status" = 'pending'
BEGIN
  UPDATE flag_state SET pending_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS flag_state_pending_account_update AFTER UPDATE ON flag_state
  WHEN NEW."reconcile_status" = 'pending'
BEGIN
  UPDATE flag_state SET pending_account_id = (SELECT account_id FROM messages WHERE id = NEW.message_id)
   WHERE id = NEW.id AND pending_account_id IS NOT (SELECT account_id FROM messages WHERE id = NEW.message_id);
END;
--> statement-breakpoint
UPDATE flag_state SET pending_account_id = (SELECT account_id FROM messages WHERE id = flag_state.message_id)
 WHERE "reconcile_status" = 'pending' AND pending_account_id IS NOT (SELECT account_id FROM messages WHERE id = flag_state.message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flag_state_pending_queue_idx" ON "flag_state" ("pending_account_id", "updated_at", "message_id") WHERE "reconcile_status" = 'pending';
