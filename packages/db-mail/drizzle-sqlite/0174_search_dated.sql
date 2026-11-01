-- 0174_search_dated — the pg columns' twins (the month as an integer, the stamp in epoch ms). Every writer
-- writes the month on this store too; nothing here reads it, so the server's trigger has no twin.

ALTER TABLE "message_search" ADD COLUMN "search_week" integer;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "search_dated_at" integer;
