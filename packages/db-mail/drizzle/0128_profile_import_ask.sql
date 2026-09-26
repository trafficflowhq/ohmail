-- A PRESS OF "IMPORT SETTINGS" THE REQUEST COULD NOT FINISH — four nullable columns on `mailboxes`.
--
-- On a slow mail provider the dial and the settings read do not fit one request's budget, so the
-- press is recorded here and the mailbox's organizer finishes it on its own connection. The
-- fingerprint is the ticket (the exact document the card showed); `_at` is when it was pressed;
-- `_outcome` is NULL while it waits, then 'imported' or 'refused'; `_reason` says why a refusal.
-- Both value sets are closed at the writer, as `release_refusal` (0121) is on the same row. The
-- mailbox erasure nulls all four in its first statement. Additive, `IF NOT EXISTS`, no default
-- and no backfill, so a desktop engine replaying this journal at every launch changes nothing.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "profile_import_ask_fingerprint" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "profile_import_ask_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "profile_import_ask_outcome" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "profile_import_ask_reason" text;
