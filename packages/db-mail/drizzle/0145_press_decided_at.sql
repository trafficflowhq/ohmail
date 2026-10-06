-- 0145_press_decided_at — when a decision about a message's placement, read state or triage was placed.
--
-- The stamp a press replayed past its 24 h idempotency record is judged against: the request's floor
-- (server clock minus the press age) when it carried one, else the server's now. The worker's
-- observations never write it. NULL on every existing row and NULL admits; no backfill.
-- ROLLBACK is `ALTER TABLE <table> DROP COLUMN decided_at` on the three tables.

ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flag_state" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_states" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
