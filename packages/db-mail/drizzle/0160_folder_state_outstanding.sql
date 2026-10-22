-- 0160_folder_state_outstanding — the mailbox poll reads one account's outstanding filings, not every
-- message of the mailbox. `folder_state.outstanding_account_id` is the message's account on every row
-- that is an outstanding filing of ours (pending, ours, desired <> observed), copied by a BEFORE
-- trigger that re-derives it from `messages` on each write leaving the row outstanding, so no
-- application writer can make it drift; on other rows it may be stale or NULL, and every reader
-- excludes them with the same predicate. A partial index keyed by it serves the poll's filing facts.
-- No counter: the facts change with the clock (due, stuck) and are minimums and picks of rows.
-- `db:setup:prod` adds the column and builds the index CONCURRENTLY ahead of the migrator
-- (FOLDER_STATE_OUTSTANDING_PREBUILD_SPEC), so on a live server the first and fourth statements
-- no-op. The column guard reads the catalog first, so a database that has the column takes no
-- table lock; the trigger is created only where it is missing (no DROP TRIGGER, and no CREATE OR
-- REPLACE TRIGGER, which needs Postgres 14). Erasure and export stay keyed by message.
-- LOCK-WAIT: the backfill updates only the filings outstanding before this entry, read through the index above it.
-- DEPLOY ORDER: setup (prebuild), migration, then API. Every statement repeats safely.
-- ROLLBACK: DROP TRIGGER IF EXISTS "folder_state_outstanding_account_tg" ON "folder_state"; DROP FUNCTION IF EXISTS folder_state_outstanding_account(); DROP INDEX IF EXISTS "folder_state_outstanding_idx"; the column may stay.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'folder_state' AND column_name = 'outstanding_account_id') THEN
    ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "outstanding_account_id" uuid;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "folder_state_outstanding_account"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.outstanding_account_id := (SELECT m.account_id FROM public.messages m WHERE m.id = NEW.message_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'folder_state_outstanding_account_tg' AND tgrelid = 'public.folder_state'::regclass) THEN
    CREATE TRIGGER "folder_state_outstanding_account_tg" BEFORE INSERT OR UPDATE ON "folder_state"
      FOR EACH ROW WHEN (NEW."reconcile_status" = 'pending' and NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder")
      EXECUTE FUNCTION "folder_state_outstanding_account"();
  END IF;
END $$;
--> statement-breakpoint
create index if not exists "folder_state_outstanding_idx" on public.folder_state using btree ("outstanding_account_id","message_id") where "reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder";
--> statement-breakpoint
UPDATE "folder_state" SET "outstanding_account_id" = m."account_id" FROM "messages" m
 WHERE m."id" = "folder_state"."message_id" AND "folder_state"."outstanding_account_id" IS NULL
   AND "folder_state"."reconcile_status" = 'pending' and "folder_state"."last_set_by" = 'us' and "folder_state"."desired_folder" <> "folder_state"."observed_folder";
