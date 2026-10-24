-- 0167_rules_refile — a Rules-page Change re-files the rule's own pile, two nullable columns on `rules`.
--
-- rules.refile_from: the canonical place the re-filing takes mail from (where the rule filed before
-- the Change). rules.refile_at: the press. A walk is a refile walk only while refile_at equals
-- retro_requested_at; every other writer that starts a walk moves retro_requested_at and lifts it.
-- NULL on every existing row: nullable, no default, no backfill, no index, no DML; nothing granted to
-- staff; not on the profile document. The statements survive a second application.
-- LOCK-WAIT: a brief ACCESS EXCLUSIVE on rules for the two nullable columns (no rewrite, no scan); rules
-- readers and writers wait for it. No other table.
-- DEPLOY ORDER: migration, then API, then worker, then web.
-- ROLLBACK: revert the code, then ALTER TABLE "rules" DROP COLUMN IF EXISTS "refile_from" and
-- DROP COLUMN IF EXISTS "refile_at".

ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "refile_from" text;
--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "refile_at" timestamp with time zone;
