-- 0137_draft_forward_of — a draft keeps the message it forwards.
--
-- A forward rode the send request alone, so a forward kept as a draft and opened again left as a
-- plain mail with "Fwd:" on it. The row names the original beside `in_reply_to_message_id`, keyed
-- to the account as mail 0118 keys that column, and the two are exclusive: a draft answers one
-- message or forwards one. NULL on every existing row, no backfill. Replay-safe: the column is
-- IF NOT EXISTS and each constraint is dropped before it is added. ROLLBACK is
-- `ALTER TABLE drafts DROP COLUMN forward_of_message_id`, which takes both constraints with it.

ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "forward_of_message_id" uuid;--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_forward_of_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_forward_of_message_id_account_fk" FOREIGN KEY ("forward_of_message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_reply_xor_forward";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_reply_xor_forward" CHECK ("in_reply_to_message_id" IS NULL OR "forward_of_message_id" IS NULL);
