-- Should the composer offer draft replies? Defaults to true for existing and new accounts.
--
-- Tables altered: account_settings (one column). No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on account_settings. The constant default avoids a table rewrite.
-- DEPLOY ORDER: migration, then API and worker, which read the settings row.
-- Idempotent (IF NOT EXISTS): the desktop engine replays this journal at launch.
-- ROLLBACK: drop draft_replies once no process of this build runs.
--
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "draft_replies" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
