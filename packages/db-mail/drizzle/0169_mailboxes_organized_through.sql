-- 0169_mailboxes_organized_through — where a hand-back's gap window starts, and how far back its
-- clock allowance may reach.
--
-- `mailboxes.organized_through`: the server's stamp (INTERNALDATE) on this install's lease claim at
-- the start of its last organizing drain that took mail in and finished the inbound backlog. A
-- release opens the gap window there rather than at the Stop press, so a letter that reached the
-- server after that drain is filed by its rule or offered. Cleared with every role change.
--
-- `mailboxes.held_elsewhere_until`: the last instant this row said another install held the mailbox
-- (the look that found that holder gone or stopped, or a promotion over it), on the store's clock.
-- A letter taken in by then was taken in while held: the gap pass's clock allowance never reaches it.
--
-- NULL on every existing row, no backfill, no index.
--
-- LOCK: a brief ACCESS EXCLUSIVE on mailboxes, no scan; one table only.
-- DEPLOY ORDER: migration, then API and worker (both select `mailboxes` whole).
-- ROLLBACK: `ALTER TABLE mailboxes DROP COLUMN organized_through, DROP COLUMN held_elsewhere_until`.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organized_through" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "held_elsewhere_until" timestamp with time zone;
