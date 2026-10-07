-- 0148_messages_sender_check — the identity fact, stored once per message, and who made a contact.
--
-- messages.sender_check: NULL = never checked (every row older than this column, the backfill's
-- question), 'none' = checked and nothing found, 'impersonation' = the sender's name claims a
-- dictionary brand the address does not own; sender_check_brand names that brand. contacts.source:
-- NULL = unknown and read as 'person' (every row older than this column), 'person' or 'inferred'.
-- The CHECK (an IMMUTABLE closed set, `closed-sets.ts`) is NOT VALID on a growth table; every
-- existing row is NULL and passes it anyway. The
-- backfill's partial index is a hot-path spec built CONCURRENTLY after the migrator
-- (`hot-path-indexes.ts`, messages_sender_check_owed_idx). No backfill here, and no person's rule
-- or contact is edited. ROLLBACK: drop the CHECK, then the three columns.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sender_check" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sender_check_brand" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_check_closed"
    CHECK ("sender_check" in ('none', 'impersonation')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
