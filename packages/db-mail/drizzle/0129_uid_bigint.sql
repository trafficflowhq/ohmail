-- A UID ANY SERVER GIVES IS A UID WE CAN STORE (mail 0129). IMAP UIDs are unsigned 32-bit
-- (RFC 3501), and nothing keeps a server below 2^31. The four locator columns were `integer`, so a
-- message at such a UID was refused 22003 at ingest, at the failure ledger, at "Not junk" and at
-- the settings cache — never stored, and offered again every cycle. `bigint` holds the whole range.
--
-- The type change only: no USING, no data touched. Each table is rewritten and its indexes rebuilt
-- under ACCESS EXCLUSIVE, held to the end of the migrator's transaction, so ingest waits for it.
-- Idempotent: altering a column to the type it has is a no-op. The SQLite store needs nothing —
-- its INTEGER is already 64-bit.
--
-- DEPLOY ORDER: migration, then API and worker. An API ahead of it answers 503 schema_incomplete,
-- naming this migration. ROLLBACK: none needed; an older build reads the wider column unchanged.

ALTER TABLE "message_instances" ALTER COLUMN "uid" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "message_failures" ALTER COLUMN "uid" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "junk_rescues" ALTER COLUMN "uid" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "mailbox_profile_mirror" ALTER COLUMN "uid" TYPE bigint;
