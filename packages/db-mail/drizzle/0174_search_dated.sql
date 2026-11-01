-- 0174_search_dated — the month each search document's letter is dated in, so the server's search reads
-- an account's newest months first instead of every match, and the account's mark that all of them have it.
--
-- `message_search.search_week` (the name kept; it holds a month): the letter's month in UTC, year × 12 +
-- month − 1, from `messages.date` (`message_search_week`); -1 for a letter with no Date; -2 for one dated
-- past the month after it was written, a bucket every dated read asks first, so such a letter keeps its
-- place newest first after that month has passed. NULL = not filled yet. Every document writer writes it;
-- the BEFORE INSERT trigger fills it where an older writer leaves it out, so no document written after
-- this entry is without it; the worker's `search_dates_fill` fills the documents written before.
-- `account_settings.search_dated_at`: when every document of the account had its month. NULL = owed.
-- The dated indexes are built CONCURRENTLY by setup after the migrator, never here, and only once no
-- account with living mail is still owed its months (each month written would re-insert its document
-- into them): the first setup after this entry builds none, a later one builds them.
--
-- Tables altered: message_search (one nullable column, one trigger) and account_settings (one nullable
-- column). Rules, mailboxes and drafts are not touched. No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on each table, no scan, no rewrite.
-- DEPLOY ORDER: migration, setup, then API and worker (the settings reads select `account_settings`
-- whole). Search reads without months until a setup run after the fill builds the dated indexes.
-- Every statement repeats safely.
-- ROLLBACK: leave everything in place. The earlier build never reads the two columns, the functions or
-- the trigger, and the trigger keeps giving every document that build writes its month, so nothing is
-- owed after a roll forward. Only if they must be dropped: first UPDATE account_settings SET
-- search_dated_at = NULL and restart the API and the worker (each remembers a written mark per handle),
-- so the fill walks every account again after the roll forward; then DROP TRIGGER IF EXISTS
-- "message_search_week_tg" ON "message_search" and DROP FUNCTION IF EXISTS message_search_week_fill();
-- drop message_search_week(timestamptz, timestamptz) only once no process of this build runs (its
-- writers call it). The two columns may stay.

ALTER TABLE "message_search" ADD COLUMN IF NOT EXISTS "search_week" integer;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "search_dated_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_search_week(d timestamptz, written timestamptz) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select case when d is null then -1
    when d >= (date_trunc('month', written at time zone 'UTC') + interval '2 months') at time zone 'UTC' then -2
    else extract(year from d at time zone 'UTC')::int * 12 + extract(month from d at time zone 'UTC')::int - 1 end
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "message_search_week_fill"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_week := (SELECT message_search_week(m.date, now()) FROM public.messages m WHERE m.id = NEW.message_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'message_search_week_tg' AND tgrelid = 'public.message_search'::regclass) THEN
    CREATE TRIGGER "message_search_week_tg" BEFORE INSERT ON "message_search"
      FOR EACH ROW WHEN (NEW."search_week" IS NULL) EXECUTE FUNCTION "message_search_week_fill"();
  END IF;
END $$;
