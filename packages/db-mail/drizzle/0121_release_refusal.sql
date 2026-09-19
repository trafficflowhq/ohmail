-- WHY A STANDING STOP HAS NOT FINISHED — one nullable column on `mailboxes` (mail 0121). The engine's
-- release pass writes 'sibling_lapse' when the server refuses the release because a FRESH claim
-- carries this install's id under a nonce it never wrote — a restored image or clone, the one
-- refusal `release_requested_at` alone cannot tell from an ordinary pending confirm. Before the
-- column the pane rendered "Stopping…" for ever, a false state at exactly the moment a person is
-- fighting a clone; with it the pane says the doc's sentence ("Another copy of this computer
-- keeps organizing this mailbox until its claim lapses."). The value set is closed at the writer;
-- NULL is every other row, and every site that spends, cancels or re-makes the request clears it
-- in the same statement.
--
-- Additive, `IF NOT EXISTS`, no default and no backfill, so a desktop engine replaying this
-- journal at every launch applies it repeatedly without effect. ROLLBACK is one DROP COLUMN:
-- the refusal renders as ordinary pending again.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "release_refusal" text;
