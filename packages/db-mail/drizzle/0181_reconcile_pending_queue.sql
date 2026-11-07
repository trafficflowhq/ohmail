-- 0181_reconcile_pending_queue — each reconcile poll reads its own account's pending rows, not the
-- whole table and not every account's queue. Every sync cycle asks each mailbox for its due folder
-- moves and `\Seen` writes, ordered by `(updated_at, message_id)`, and almost always gets none;
-- without an index each ask read every `folder_state` or `flag_state` row of the store. A partial
-- index on each holds the pending rows, keyed by the message's account and then in the poll's order,
-- so the poll, and every reader of pending rows that binds the account (the mailbox list's filing
-- facts), reads one account's queue however long another account's is.
-- The account is the store's to keep, never an application writer's. `folder_state` carries it in
-- `outstanding_account_id` on our outstanding filings (mail 0160); a second trigger copies it onto
-- every other pending row (the user's own moves, rows whose two sides agree), each trigger running
-- where the other does not. `flag_state` gains `pending_account_id`, copied onto every pending row.
-- `db:setup:prod` adds the column and builds both indexes CONCURRENTLY ahead of the migrator
-- (FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC, FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC), so on a live
-- server those statements find them and no-op; a trigger is created only where pg_trigger lacks it.
-- LOCK-WAIT: each backfill updates only the rows pending before this entry, the few a queue holds.
-- DEPLOY ORDER: setup (prebuild), migration, then API and worker. Every statement repeats safely.
-- ROLLBACK: DROP TRIGGER IF EXISTS "folder_state_pending_account_tg" ON "folder_state"; DROP TRIGGER IF EXISTS "flag_state_pending_account_tg" ON "flag_state"; DROP FUNCTION IF EXISTS flag_state_pending_account(); DROP INDEX IF EXISTS "folder_state_pending_queue_idx"; DROP INDEX IF EXISTS "flag_state_pending_queue_idx"; the column may stay.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'flag_state' AND column_name = 'pending_account_id') THEN
    ALTER TABLE "flag_state" ADD COLUMN IF NOT EXISTS "pending_account_id" uuid;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'folder_state_pending_account_tg' AND tgrelid = 'public.folder_state'::regclass) THEN
    CREATE TRIGGER "folder_state_pending_account_tg" BEFORE INSERT OR UPDATE ON "folder_state"
      FOR EACH ROW WHEN (NEW."reconcile_status" = 'pending' and not (NEW."last_set_by" = 'us' and NEW."desired_folder" <> NEW."observed_folder"))
      EXECUTE FUNCTION "folder_state_outstanding_account"();
  END IF;
END $$;
--> statement-breakpoint
UPDATE "folder_state" SET "outstanding_account_id" = m."account_id" FROM "messages" m
 WHERE m."id" = "folder_state"."message_id" AND "folder_state"."reconcile_status" = 'pending'
   AND "folder_state"."outstanding_account_id" IS DISTINCT FROM m."account_id";
--> statement-breakpoint
create index if not exists "folder_state_pending_queue_idx" on public.folder_state using btree ("outstanding_account_id","updated_at","message_id") where "reconcile_status" = 'pending';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "flag_state_pending_account"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pending_account_id := (SELECT m.account_id FROM public.messages m WHERE m.id = NEW.message_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'flag_state_pending_account_tg' AND tgrelid = 'public.flag_state'::regclass) THEN
    CREATE TRIGGER "flag_state_pending_account_tg" BEFORE INSERT OR UPDATE ON "flag_state"
      FOR EACH ROW WHEN (NEW."reconcile_status" = 'pending')
      EXECUTE FUNCTION "flag_state_pending_account"();
  END IF;
END $$;
--> statement-breakpoint
UPDATE "flag_state" SET "pending_account_id" = m."account_id" FROM "messages" m
 WHERE m."id" = "flag_state"."message_id" AND "flag_state"."reconcile_status" = 'pending'
   AND "flag_state"."pending_account_id" IS DISTINCT FROM m."account_id";
--> statement-breakpoint
create index if not exists "flag_state_pending_queue_idx" on public.flag_state using btree ("pending_account_id","updated_at","message_id") where "reconcile_status" = 'pending';
