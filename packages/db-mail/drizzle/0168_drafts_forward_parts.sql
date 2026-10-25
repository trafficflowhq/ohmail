-- 0168_drafts_forward_parts — a forward kept as a draft keeps the files the person kept.
--
-- `drafts.forward_parts`: the original's attachment ids the person kept, sorted and deduped, at most
-- 100, only beside `forward_of_message_id`. NULL means nothing was removed: every part goes. The send
-- uses the request's list, else the row's, so a forward trimmed on one device and sent from another
-- sends only the kept files. No default, no CHECK, no index, no backfill.
--
-- LOCK: a brief ACCESS EXCLUSIVE on `drafts`, no scan.
-- DEPLOY ORDER: migration, then API and worker (both select `drafts` whole).
-- ROLLBACK: roll the code back first, then `ALTER TABLE drafts DROP COLUMN forward_parts`.

ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "forward_parts" jsonb;
