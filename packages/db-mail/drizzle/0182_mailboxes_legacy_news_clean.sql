-- 0182_mailboxes_legacy_news_clean — when a full read found no letter of this mailbox spelled the
-- pre-0.22 way (`ohmail/Reads`), so the organizer's News repair never walks the mailbox's letters again.
--
-- `mailboxes.legacy_news_clean_at`: written once by the repair pass, inside the visit's fenced write,
-- only after its candidate read answered none. NULL on every existing row: each mailbox walks once
-- after the deploy. No default, no backfill, no index.
--
-- Tables altered: mailboxes (one nullable column). Rules and drafts are not touched. No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on mailboxes, no scan, no rewrite.
-- DEPLOY ORDER: migration, then API, then worker (both select `mailboxes` whole). The statement repeats safely.
-- ROLLBACK: ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "legacy_news_clean_at", once no process of this build runs.
-- NOTE: NULL re-arms one walk. A later change to the candidate predicate must NULL this column in its own migration.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "legacy_news_clean_at" timestamp with time zone;
