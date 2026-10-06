-- 0145_press_decided_at — when a decision about a message's placement, read state or triage was placed.
--
-- The stamp a press replayed past its 24 h idempotency record is judged against: the request's floor
-- (server clock minus the press age) when it carried one, else the server's now. The worker's
-- observations never write it. NULL on every existing row and NULL admits; no backfill. The request
-- refusal CHECK gains `superseded` (an aged move behind a newer placement), widened in 0091's shape.
-- ROLLBACK is `ALTER TABLE <table> DROP COLUMN decided_at` on the three tables and 0094's CHECK.

ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flag_state" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_states" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_refused_reason_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_refused_reason_closed"
  CHECK ("refused_reason" IS NULL OR "refused_reason" IN (
    'unauthenticated', 'conflict', 'wrong_mailbox', 'invalid_payload',
    'malformed', 'unhandled_kind', 'stale', 'account_erased',
    'no_such_message', 'no_trash_folder', 'no_such_rule', 'superseded'
  ));
