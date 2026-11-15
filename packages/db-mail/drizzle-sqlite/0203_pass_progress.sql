-- 0203_pass_progress — the shared entry's twin. The same table and the same move: the same passes
-- run on a device. Instants are epoch milliseconds here. Fourteen DROP COLUMN in place;
-- `mailboxes` is not rebuilt.

CREATE TABLE "pass_progress" (
  "account_id" text NOT NULL,
  "job" text NOT NULL,
  "subject_id" text NOT NULL,
  "requested_at" integer,
  "started_at" integer,
  "done_at" integer,
  "cursor" text,
  "updated_at" integer NOT NULL DEFAULT (cast(unixepoch('subsec') * 1000 as integer)),
  PRIMARY KEY ("account_id", "job", "subject_id")
);
--> statement-breakpoint
INSERT INTO "pass_progress" ("account_id", "job", "subject_id", "started_at", "done_at", "cursor")
SELECT "account_id", 'kickstart', "id", NULL, "kickstart_at", NULL FROM "mailboxes" WHERE "kickstart_at" IS NOT NULL
UNION ALL SELECT "account_id", 'sensitive_rescreen', "id", "sensitive_rescreen_started_at", "sensitive_rescreen_at", "sensitive_rescreen_cursor" FROM "mailboxes"
 WHERE "sensitive_rescreen_at" IS NOT NULL OR "sensitive_rescreen_started_at" IS NOT NULL OR "sensitive_rescreen_cursor" IS NOT NULL
UNION ALL SELECT "account_id", 'sensitive_fp_backfill', "id", NULL, "sensitive_fp_backfill_at", NULL FROM "mailboxes" WHERE "sensitive_fp_backfill_at" IS NOT NULL
UNION ALL SELECT "account_id", 'news_repair', "id", NULL, "legacy_news_clean_at", NULL FROM "mailboxes" WHERE "legacy_news_clean_at" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "pass_progress" ("account_id", "job", "subject_id", "requested_at", "done_at", "cursor")
SELECT "account_id", 'ohbox_tidy', "account_id", "ohbox_tidy_requested_at", "ohbox_tidy_done_at", "ohbox_tidy_cursor" FROM "account_settings"
 WHERE "ohbox_tidy_requested_at" IS NOT NULL OR "ohbox_tidy_done_at" IS NOT NULL OR "ohbox_tidy_cursor" IS NOT NULL
UNION ALL SELECT "account_id", 'gate_release', "account_id", NULL, "gate_release_done_at", NULL FROM "account_settings" WHERE "gate_release_done_at" IS NOT NULL
UNION ALL SELECT "account_id", 'search_index_backfill', "account_id", NULL, "search_index_built_at", NULL FROM "account_settings" WHERE "search_index_built_at" IS NOT NULL
UNION ALL SELECT "account_id", 'list_address_backfill', "account_id", NULL, "list_addresses_scanned_at", NULL FROM "account_settings" WHERE "list_addresses_scanned_at" IS NOT NULL
UNION ALL SELECT "account_id", 'html_words_backfill', "account_id", NULL, "html_words_backfill_at", "html_words_backfill_cursor" FROM "account_settings"
 WHERE "html_words_backfill_at" IS NOT NULL OR "html_words_backfill_cursor" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "kickstart_at";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "sensitive_rescreen_at";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "sensitive_rescreen_cursor";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "sensitive_rescreen_started_at";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "sensitive_fp_backfill_at";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "legacy_news_clean_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "ohbox_tidy_requested_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "ohbox_tidy_done_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "ohbox_tidy_cursor";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "gate_release_done_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "search_index_built_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "list_addresses_scanned_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "html_words_backfill_at";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "html_words_backfill_cursor";
