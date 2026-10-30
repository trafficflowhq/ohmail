-- 0172_html_words_backfill — the pg columns' twins (epoch ms, and the cursor's id as text).

ALTER TABLE "account_settings" ADD COLUMN "html_words_backfill_at" integer;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "html_words_backfill_cursor" text;
