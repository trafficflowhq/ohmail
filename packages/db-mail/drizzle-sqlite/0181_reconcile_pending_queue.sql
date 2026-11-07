-- 0181_reconcile_pending_queue — the pg entry's twin: each reconcile poll's pending rows in its
-- queue order, so the poll stops walking every message of the mailbox. Replay-safe.

CREATE INDEX IF NOT EXISTS "folder_state_pending_queue_idx" ON "folder_state" ("updated_at", "message_id") WHERE "reconcile_status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flag_state_pending_queue_idx" ON "flag_state" ("updated_at", "message_id") WHERE "reconcile_status" = 'pending';
