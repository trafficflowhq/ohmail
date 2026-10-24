-- 0166_account_storage_facts — the pg columns' twins, because the counter's shared writers name them:
-- instants in epoch milliseconds, the month as 'YYYY-MM-01' text. No backfill and no grant: the device
-- store is unmetered, and the erase's finish recounts the count here.

ALTER TABLE "account_storage" ADD COLUMN "recounted_at" integer;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "recount_drift" integer;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "husked_for_space" integer NOT NULL DEFAULT 0 CONSTRAINT "account_storage_husked_nonneg" CHECK ("husked_for_space" >= 0);
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "first_husked_at" integer;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "last_husked_at" integer;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "kept_from" text;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN "withheld_on_arrival" integer NOT NULL DEFAULT 0;
