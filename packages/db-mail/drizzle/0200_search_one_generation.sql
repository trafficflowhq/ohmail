-- SEARCH, ONE GENERATION. The first entry of the 2.0 line: what search no longer reads goes.
--
-- THE OLD SEARCH LEAVES A STORE ONLY WHEN NOTHING ON IT IS FOUND BY THE OLD SEARCH ALONE. A letter
-- with no search document, in an account whose search index was never stamped built, is read
-- through `messages.subject_tsv` and `message_bodies.body_tsv`. That is every letter on a desktop
-- paired to a server, and the letters a store's own pass has not reached yet. So the guard is the
-- store's state, never its kind: no such letter, and the two columns, the trigger, its functions
-- and the indexes go here; one such letter, and all of it stays, search goes on reading it, and
-- the search setup runs these same statements at a later start, once the pass has built what it
-- owes (`retireOldSearch`). It refuses nothing: a count decides which branch runs.
--
-- IF EXISTS where a store made from empty and a server differ: the trigram and hot-path indexes
-- exist only where the setup ran, the body index only where the setup has not retired it yet.
--
-- First in the journal on purpose: where the vector's column goes, 0201's fill of `message_bodies`
-- writes each row once and frees the vector's space in the same pass.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @retire_old_search_where_nothing_is_owed
DO $$
DECLARE owed bigint;
BEGIN
  SELECT count(*) INTO owed FROM "messages" m
   WHERE m."deleted_at" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "message_search" s WHERE s."message_id" = m."id")
     AND NOT EXISTS (SELECT 1 FROM "account_settings" st WHERE st."account_id" = m."account_id" AND st."search_index_built_at" IS NOT NULL);
  IF owed > 0 THEN
    RAISE NOTICE 'the old search stays on this store: % living letters are found by it alone', owed;
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS "message_bodies_body_tsv_tg" ON "message_bodies";
  DROP FUNCTION IF EXISTS "message_bodies_body_tsv_bounded"();
  DROP FUNCTION IF EXISTS "message_bodies_body_tsv_cleared"();
  DROP INDEX IF EXISTS "message_bodies_body_tsv_idx";
  ALTER TABLE "message_bodies" DROP COLUMN IF EXISTS "body_tsv";
  DROP INDEX IF EXISTS "messages_subject_tsv_idx";
  DROP INDEX IF EXISTS "messages_subject_trgm_idx";
  DROP INDEX IF EXISTS "messages_from_address_trgm_idx";
  ALTER TABLE "messages" DROP COLUMN IF EXISTS "subject_tsv";
END $$;
--> statement-breakpoint
-- Two indexes nothing reads any more: the arrival order on mail 0139's key, which no page walks
-- since 0171, and the held page of the retired Screener auto-apply pass, keyed on the floor version
-- that 0201 drops. `messages_account_msg_order_idx` stays: search's History walk reads it. So does
-- `folder_state_screener_held_idx`, the held rows by letter, where a setup built it.
-- @drop_superseded_indexes
DROP INDEX IF EXISTS "messages_account_arrival_order_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "folder_state_screener_held_floor_idx";
--> statement-breakpoint
-- The read flag leaves its index: a flag that flips with every letter read made the index churn
-- for a count the two leading columns already bound.
-- @build_account_mailbox_index
CREATE INDEX "messages_account_mailbox_idx" ON "messages" USING btree ("account_id","mailbox_id");
--> statement-breakpoint
-- @drop_read_flag_index
DROP INDEX "messages_account_mailbox_unread_idx";
