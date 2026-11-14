-- THE PROGRESS OF THE ONE-TIME PASSES, AS ROWS. Fourteen columns on `mailboxes` (6) and
-- `account_settings` (8) recorded where nine passes stood. They become rows of one table: a new
-- pass adds rows and alters no table, and `mailboxes`, the busiest row there is, stops carrying
-- the bookkeeping of work that runs once.
--
-- A ROW MEANS EXACTLY WHAT THE COLUMNS MEANT: it exists when at least one of the pass's marks was
-- set, and each of its fields is the old column's value, unchanged. No row = every mark empty =
-- "never run". `subject_id` is the mailbox's id for a pass over one mailbox and the account's id
-- for a pass over the account. It is a plain column: no key into `mailboxes`; the two erasures
-- delete by it. `job` is the pass's name in the worker's registry, a closed list that grows: no
-- CHECK on any store; the one door that writes the table refuses a foreign name
-- (`packages/db/src/pass-progress.ts`).
--
-- The staff role, where it exists, reads when a pass was asked for, begun and finished, as it read
-- `mailboxes.kickstart_at`. Never `cursor`: it names the letter a pass stopped at.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @pass_progress_create
CREATE TABLE "pass_progress" (
  "account_id" uuid NOT NULL,
  "job" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "requested_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "done_at" timestamp with time zone,
  "cursor" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pass_progress_pk" PRIMARY KEY ("account_id","job","subject_id")
);
--> statement-breakpoint
-- @pass_progress_move_mailbox_marks
INSERT INTO "pass_progress" ("account_id","job","subject_id","started_at","done_at","cursor")
SELECT "account_id", 'kickstart', "id", NULL, "kickstart_at", NULL FROM "mailboxes" WHERE "kickstart_at" IS NOT NULL
UNION ALL
SELECT "account_id", 'sensitive_rescreen', "id", "sensitive_rescreen_started_at", "sensitive_rescreen_at", "sensitive_rescreen_cursor"::text FROM "mailboxes"
 WHERE "sensitive_rescreen_at" IS NOT NULL OR "sensitive_rescreen_started_at" IS NOT NULL OR "sensitive_rescreen_cursor" IS NOT NULL
UNION ALL
SELECT "account_id", 'sensitive_fp_backfill', "id", NULL, "sensitive_fp_backfill_at", NULL FROM "mailboxes" WHERE "sensitive_fp_backfill_at" IS NOT NULL
UNION ALL
SELECT "account_id", 'news_repair', "id", NULL, "legacy_news_clean_at", NULL FROM "mailboxes" WHERE "legacy_news_clean_at" IS NOT NULL;
--> statement-breakpoint
-- @pass_progress_move_account_marks
INSERT INTO "pass_progress" ("account_id","job","subject_id","requested_at","done_at","cursor")
SELECT "account_id", 'ohbox_tidy', "account_id", "ohbox_tidy_requested_at", "ohbox_tidy_done_at", "ohbox_tidy_cursor"::text FROM "account_settings"
 WHERE "ohbox_tidy_requested_at" IS NOT NULL OR "ohbox_tidy_done_at" IS NOT NULL OR "ohbox_tidy_cursor" IS NOT NULL
UNION ALL
SELECT "account_id", 'gate_release', "account_id", NULL, "gate_release_done_at", NULL FROM "account_settings" WHERE "gate_release_done_at" IS NOT NULL
UNION ALL
SELECT "account_id", 'search_index_backfill', "account_id", NULL, "search_index_built_at", NULL FROM "account_settings" WHERE "search_index_built_at" IS NOT NULL
UNION ALL
SELECT "account_id", 'list_address_backfill', "account_id", NULL, "list_addresses_scanned_at", NULL FROM "account_settings" WHERE "list_addresses_scanned_at" IS NOT NULL
UNION ALL
SELECT "account_id", 'html_words_backfill', "account_id", NULL, "html_words_backfill_at", "html_words_backfill_cursor"::text FROM "account_settings"
 WHERE "html_words_backfill_at" IS NOT NULL OR "html_words_backfill_cursor" IS NOT NULL;
--> statement-breakpoint
-- @pass_progress_drop_mailbox_columns
ALTER TABLE "mailboxes" DROP COLUMN "kickstart_at", DROP COLUMN "sensitive_rescreen_at", DROP COLUMN "sensitive_rescreen_cursor",
  DROP COLUMN "sensitive_rescreen_started_at", DROP COLUMN "sensitive_fp_backfill_at", DROP COLUMN "legacy_news_clean_at";
--> statement-breakpoint
-- @pass_progress_drop_account_columns
ALTER TABLE "account_settings" DROP COLUMN "ohbox_tidy_requested_at", DROP COLUMN "ohbox_tidy_done_at", DROP COLUMN "ohbox_tidy_cursor",
  DROP COLUMN "gate_release_done_at", DROP COLUMN "search_index_built_at", DROP COLUMN "list_addresses_scanned_at",
  DROP COLUMN "html_words_backfill_at", DROP COLUMN "html_words_backfill_cursor";
--> statement-breakpoint
-- @pass_progress_staff_grant
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "pass_progress" FROM ohmail_admin;
    GRANT SELECT ("account_id", "job", "subject_id", "requested_at", "started_at", "done_at", "updated_at") ON TABLE "pass_progress" TO ohmail_admin;
  END IF;
END $$;
