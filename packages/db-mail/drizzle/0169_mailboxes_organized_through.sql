-- 0169_mailboxes_organized_through — where a hand-back's gap window starts.
--
-- `mailboxes.organized_through`: the server's stamp (INTERNALDATE) on this install's lease claim at
-- the start of its last organizing drain that took mail in and finished the inbound backlog. A
-- release opens the gap window there rather than at the Stop press, so a letter that reached the
-- server after that drain is filed by its rule or offered. Cleared with every role change. NULL on
-- every existing row, no backfill, no index.
--
-- LOCK: a brief ACCESS EXCLUSIVE on mailboxes, no scan.
-- DEPLOY ORDER: migration, then API and worker (both select `mailboxes` whole).
-- ROLLBACK: `ALTER TABLE mailboxes DROP COLUMN organized_through`.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organized_through" timestamp with time zone;
