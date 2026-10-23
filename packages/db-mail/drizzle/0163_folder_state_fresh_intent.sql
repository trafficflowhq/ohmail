-- 0163_folder_state_fresh_intent — a new filing starts with a fresh schedule. When a write changes
-- `folder_state.desired_folder`, a BEFORE UPDATE trigger resets `attempts`, `next_attempt_at` and
-- `last_error_class`, whichever writer made it (the move door, the rule pass, Screener apply, an
-- adoption). Before this a message filed somewhere new kept the old refusal's sleep and reason.
-- Filing into the same folder again is not a new filing and keeps its schedule; a deferral writes
-- no desired folder and keeps what it writes. No backfill.
-- LOCK: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE on folder_state; no table scan. The
-- trigger is created only where pg_trigger lacks it, as mail 0160 does.
-- DEPLOY ORDER: migration, then API. Works with any worker.
-- ROLLBACK: DROP TRIGGER IF EXISTS "folder_state_fresh_intent_tg" ON "folder_state"; DROP FUNCTION IF EXISTS folder_state_fresh_intent();

CREATE OR REPLACE FUNCTION "folder_state_fresh_intent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.attempts := 0;
  NEW.next_attempt_at := NULL;
  NEW.last_error_class := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'folder_state_fresh_intent_tg' AND tgrelid = 'public.folder_state'::regclass) THEN
    CREATE TRIGGER "folder_state_fresh_intent_tg" BEFORE UPDATE ON "folder_state"
      FOR EACH ROW WHEN (NEW."desired_folder" IS DISTINCT FROM OLD."desired_folder")
      EXECUTE FUNCTION "folder_state_fresh_intent"();
  END IF;
END $$;
