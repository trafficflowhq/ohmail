-- 0149_messages_sender_check_by — which writer gave a message its identity fact.
--
-- messages.sender_check_by: 'ingest' = the fact was written when the message was stored, 'backfill'
-- = written later for a row stored before the fact existed (the backfill, a pass or a press reading
-- unchecked mail). NULL = written by a build older than this column, which cannot be told apart. The
-- Screener reads it to keep mail from before the update out of the Waiting list. The CHECK (an
-- IMMUTABLE closed set, `closed-sets.ts`) is NOT VALID on a growth table; every existing row is NULL
-- and passes it anyway. No backfill here. ROLLBACK: drop the CHECK, then the column.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sender_check_by" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_check_by_closed"
    CHECK ("sender_check_by" in ('ingest', 'backfill')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
