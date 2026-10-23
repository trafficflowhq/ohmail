-- 0164_messages_server_missing — a letter the mail server lost stays in the mirror, and a filing
-- that failed on our side says so.
--
-- `messages.server_missing_at`: when ohmail found that the server holds no copy of a letter it knows
-- of (the legacy News repair, after the 0.22 rename). The reaper never tombstones a row carrying it,
-- so the body stays for a re-append; a copy seen again clears it. NULL on every existing row, no
-- backfill, no index (the reaper reads it beside predicates it already has).
--
-- The filing class CHECK (0097, and its 0117 twin on `junk_rescues`) gains two members that are not
-- a refusal by the server: `stale_locator` (the folder was renumbered and the letter was not found
-- under its new number) and `unconfirmed` (our own check could not prove the move). Drop-then-add
-- under the same names, 0134's shape: NOT VALID and no VALIDATE, because the migrator runs the file
-- in one transaction and every stored value already satisfies the narrower set.
--
-- LOCK: a brief ACCESS EXCLUSIVE on each of the three tables, no scan.
-- DEPLOY ORDER: migration, then API and worker (both select `messages` whole).
-- ROLLBACK: `UPDATE folder_state SET last_error_class = 'refused' WHERE last_error_class IN
-- ('stale_locator', 'unconfirmed')` (and on `junk_rescues`), re-add 0097's and 0117's CHECKs, then
-- `ALTER TABLE messages DROP COLUMN server_missing_at`.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "server_missing_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "folder_state" DROP CONSTRAINT IF EXISTS "folder_state_last_error_class_check";
--> statement-breakpoint
ALTER TABLE "folder_state" ADD CONSTRAINT "folder_state_last_error_class_check"
  CHECK ("last_error_class" IS NULL OR "last_error_class" IN (
    'refused', 'no_such_folder', 'read_only', 'over_quota', 'stale_locator', 'unconfirmed'
  )) NOT VALID;
--> statement-breakpoint
ALTER TABLE "junk_rescues" DROP CONSTRAINT IF EXISTS "junk_rescues_error_class_check";
--> statement-breakpoint
ALTER TABLE "junk_rescues" ADD CONSTRAINT "junk_rescues_error_class_check"
  CHECK ("last_error_class" IS NULL OR "last_error_class" IN (
    'refused', 'no_such_folder', 'read_only', 'over_quota', 'stale_locator', 'unconfirmed'
  )) NOT VALID;
