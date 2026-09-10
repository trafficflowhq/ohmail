-- A BOUNDED READ REFUSAL IS NOT A BROKEN MAILBOX — the fourth `sync_blocked_reason`.
--
-- A ceiling this codebase sets (`ImapBoundExceeded`: a folder listing past its cap, a read past
-- its clock, a body past its overrun factor) ended the cycle and reached the mailbox row through
-- `markMailboxFailed` — so `status` became `error` and Settings said the mailbox had failed. It
-- has not: it authenticated, it answered, and it sent more than one pass takes. The row now says
-- `connected` with `sync_blocked_reason = 'read_limited'`, which is the shape mail 0029 built for
-- exactly this class of "our own infrastructure is not serving this mailbox right now".
--
-- The member is what makes the sentence reachable at all: the copy renders only behind
-- `isSyncBlockReason`, which reads this closed set, so a string added to the catalogue without
-- this migration is dead by construction.
--
-- Idempotent (dropped-then-added, the shape `0094_request_kinds_moves_profile` uses for the same
-- widening), because a desktop engine replays this journal at every launch.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited'
  ));
