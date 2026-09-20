-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0123 — `ohmail/News` JOINS THE AWAY SCOPE'S CLOSED SET (the 0.22 folder rename)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The News pile's folder is `ohmail/News` from 0.22 on; a 0.22 build's scope save stores that
-- spelling and 0101's CHECK would refuse it. WIDENED, NEVER NARROWED (0090/0091's rule): the
-- legacy member `ohmail/Reads` STAYS, because rows written before the rename keep it and a
-- pre-0.22 build still writes it — readers canonicalize the two spellings to one pile
-- (`away-scope.ts#readAwayPiles`). No row is rewritten: an older engine reading its own stored
-- `ohmail/Reads` keeps answering that pile, which a rewrite would silently stop. Idempotent
-- (drop-then-add, 0007's shape) because a desktop engine replays this journal at every launch.
--
-- ROLLBACK: restore 0101's four-member CHECK, stripping `ohmail/News` from every `piles` first.

ALTER TABLE "away_responders" DROP CONSTRAINT IF EXISTS "away_responders_piles_closed";--> statement-breakpoint

ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_piles_closed"
  CHECK ("piles" <@ ARRAY['INBOX', 'ohmail/Reads', 'ohmail/News', 'ohmail/Receipts', 'ohmail/Screener']::text[]);
