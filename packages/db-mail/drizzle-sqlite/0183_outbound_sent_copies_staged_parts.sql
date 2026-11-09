-- 0183_outbound_sent_copies_staged_parts — the pg columns' twins (files_until and files_next_attempt_at in epoch ms).

ALTER TABLE "outbound_sent_copies" ADD COLUMN "staged_parts" text;
--> statement-breakpoint
ALTER TABLE "outbound_sent_copies" ADD COLUMN "files_until" integer;
--> statement-breakpoint
ALTER TABLE "outbound_sent_copies" ADD COLUMN "files_next_attempt_at" integer;
