-- 0182_mailboxes_legacy_news_clean — the pg column's twin (epoch ms).

ALTER TABLE "mailboxes" ADD COLUMN "legacy_news_clean_at" integer;
