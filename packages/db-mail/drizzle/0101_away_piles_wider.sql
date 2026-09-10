-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0101 — RECEIPTS AND THE SCREENER JOIN THE AWAY RESPONDER'S ANSWERABLE PILES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0096 closed `piles` over `{INBOX, ohmail/Reads}` and argued the other four out. Two of those
-- arguments are answered rather than dropped (owner feedback, 2026-09-10):
--
--   ohmail/Receipts   most receipts are machine mail, and `neverAutoReply` refuses those by
--                     HEADER for every pile whether or not this member is stored. What the
--                     never-answered map additionally refused was a receipt a person typed, in a
--                     pile its owner had ticked. It is out of that map now.
--   ohmail/Screener   was refused because it is the AUDIENCE's population. The order in
--                     `awayEligibility` is what stops the two contradicting — the audience
--                     refuses a waiting stranger unless it is `everyone`, and only then is the
--                     pile consulted — and both write doors refuse this member beside
--                     `screened_in`, so the contradictory row is not representable.
--
-- `ohmail/Screened` and `ohmail/Quarantine` stay out, refused by the map that keeps a rejection
-- and a phish unanswerable whatever the settings.
--
-- ══ THE BACKFILL PRESERVES BEHAVIOUR; IT DOES NOT WIDEN IT ═════════════════════════════════════
--
-- Until this migration, a responder set to `everyone` answered mail HELD IN THE SCREENER whatever
-- its `piles` held — the pile rule exempted that folder, because the audience owned it. With the
-- exemption gone, the same row would stop answering those strangers the moment this lands, which
-- is a silent change to a standing order somebody is relying on right now. So every `everyone`
-- row gains the member that keeps it doing exactly what it does today, and its pane then shows
-- that box ticked, which is true of it.
--
-- Rows on `screened_in` are NOT touched: the pass never answered a waiting stranger for them, and
-- adding the member there would both widen nothing and store the one scope the doors refuse.
-- `ohmail/Receipts` is added to NO row — receipts are not answered today, and ticking that box is
-- a decision its owner makes.
--
-- WIDENED, NEVER NARROWED (0090/0091's rule): the constraint is replaced before the UPDATE that
-- writes the new member, so no statement here can leave a row the constraint refuses. Idempotent
-- throughout, because a desktop engine replays this journal at every launch.
--
-- ROLLBACK: restore 0096's two-member CHECK, and strip `ohmail/Screener` from every `piles`
-- first — a stored member the narrower constraint refuses would fail the ADD.

ALTER TABLE "away_responders" DROP CONSTRAINT IF EXISTS "away_responders_piles_closed";--> statement-breakpoint

ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_piles_closed"
  CHECK ("piles" <@ ARRAY['INBOX', 'ohmail/Reads', 'ohmail/Receipts', 'ohmail/Screener']::text[]);--> statement-breakpoint

UPDATE "away_responders"
   SET "piles" = array_append("piles", 'ohmail/Screener')
 WHERE "audience" = 'everyone'
   AND NOT ('ohmail/Screener' = ANY("piles"));
