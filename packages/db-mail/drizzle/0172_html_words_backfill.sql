-- 0172_html_words_backfill — the html-words backfill's stamp and resume point, per account.
--
-- `account_settings.html_words_backfill_at`: when the store-only pass had walked every stored
-- message, giving an html-only letter stored before ingest kept its html's words those words as its
-- text. NULL means owed. `account_settings.html_words_backfill_cursor`: the last message id the walk
-- decided, in id order; NULL means from the start, and it is cleared with the stamp.
--
-- NULL on every existing row, no backfill, no index. Metadata only: rules, mailboxes and drafts are
-- not touched.
--
-- LOCK: a brief ACCESS EXCLUSIVE on account_settings, no scan; one table only.
-- DEPLOY ORDER: setup, migration, then API and worker (both select `account_settings` whole).
-- ROLLBACK: `ALTER TABLE account_settings DROP COLUMN html_words_backfill_at, DROP COLUMN html_words_backfill_cursor`.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "html_words_backfill_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "html_words_backfill_cursor" uuid;
