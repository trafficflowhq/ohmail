-- 0167_rules_refile — the pg columns' twins: the phone and the desktop run the same walk over this
-- store. `integer` (epoch ms) for the instant. NULL for every existing rule.

ALTER TABLE "rules" ADD COLUMN "refile_from" text;
--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "refile_at" integer;
