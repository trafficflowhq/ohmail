-- 0176_messages_unconfirmed_hold — a letter the gate holds because nothing confirmed a company's own address.
--
-- `messages.unconfirmed_hold`: true when the ingest, or the gap catch-up's screen, placed the letter at
-- the Screener because its From is at a company's own domain, neither the mailbox's provider nor the
-- company's signature confirmed it, and no person had consented to the address. The Screener's claim
-- term, its page and count, the release doors and the act read it beside `sender_check`; such a letter
-- moves only on a person's press on its own address. NULL on every existing row and on every letter not
-- held this way: no default, no backfill, no index.
--
-- Tables altered: messages (one nullable column). Rules, mailboxes and drafts are not touched. No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on messages, no scan, no rewrite.
-- DEPLOY ORDER: migration, then API and worker (both select `messages` whole). The statement repeats safely.
-- ROLLBACK: ALTER TABLE "messages" DROP COLUMN IF EXISTS "unconfirmed_hold", once no process of this build runs.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "unconfirmed_hold" boolean;
