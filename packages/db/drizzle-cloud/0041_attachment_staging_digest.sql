-- WHAT THE BYTES WERE DECLARED TO BE — content identity for a staged attachment (cloud 0041).
-- `attachment_staging` carried name, type and size and no digest, so declare → upload → send was
-- correlated by the ticket id alone: whatever ended up at the object path was sent, whether or
-- not it was the file the composer showed. The size was the only thing re-measured, and a
-- different file of the same length passes that.
--
-- NULLABLE, and the two states are named: NULL is "this client stated no digest" — every client
-- that predates this column, and any runtime with no SHA-256 to hand — and the send then checks
-- what it always checked. A value is a PROMISE the send holds the bytes to: the download is
-- hashed and a mismatch refuses the send rather than delivering something else.
--
-- The CHECK is the shape, so a malformed digest cannot be stored and then fail to match for the
-- wrong reason: 64 lowercase hex, which is what `sha256(bytes)` renders to on every writer.
-- Dropped first so the migration is re-runnable, and added NOT VALID because `attachment_staging`
-- is a growth table (the lock-cost rule in `packages/db-mail/drizzle/README.md`): it enforces
-- every write from the moment it commits and skips the scan, and every row that predates it
-- holds the NULL the column was born with. Its `VALIDATE CONSTRAINT` ships one release later.
--
-- DEPLOY ORDER: migration, then API. The reverse costs a 42703 on the mint's insert, which is the
-- staged send path refusing loudly; nothing is sent wrongly in the window.
--
-- ROLLBACK is dropping the constraint and the column. Tickets in flight lose their declaration
-- and fall back to the size check, which is where they were before this migration.

ALTER TABLE "attachment_staging" ADD COLUMN IF NOT EXISTS "content_sha256" text;
--> statement-breakpoint
ALTER TABLE "attachment_staging" DROP CONSTRAINT IF EXISTS "attachment_staging_content_sha256_hex";
--> statement-breakpoint
ALTER TABLE "attachment_staging" ADD CONSTRAINT "attachment_staging_content_sha256_hex"
  CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$') NOT VALID;
