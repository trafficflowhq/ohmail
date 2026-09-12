-- A COMPUTER WHOSE CLOCK IS WRONG IS NOT A MAILBOX THAT CANNOT BE READ — the fifth
-- `sync_blocked_reason`.
--
-- The organizer lease is arbitrated through instants: heartbeats, a staleness window, the moment
-- somebody pressed. An install whose own clock disagrees with the mail server's therefore writes
-- records every other install misreads, in both directions, and the cure is that it refuses to
-- claim until the clock is corrected. That refusal arrived at the row as `lease_unreadable`,
-- whose sentence — "ohmail cannot read its own folder on that server" — is false here and names
-- nothing anybody can act on. The one thing a person can do about this is set the clock, so the
-- state says so.
--
-- Self-hosted is where it fires: a deployment's own machine keeps its own time.
--
-- The member is what makes the sentence reachable at all: the copy renders only behind
-- `isSyncBlockReason`, which reads this closed set, so a string added to the catalogue without
-- this migration is dead by construction (mail 0102's rule, unchanged).
--
-- Idempotent (dropped-then-added, the shape mail 0102 uses for the same widening), because a
-- desktop engine replays this journal at every launch.
--
-- ROLLBACK is the same two statements with `'clock_off'` removed from the list, after
-- `UPDATE mailboxes SET sync_blocked_reason = NULL WHERE sync_blocked_reason = 'clock_off'` —
-- the column is a live state the worker rewrites every pass, so clearing it loses nothing.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off'
  ));
