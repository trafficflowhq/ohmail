-- A LAPSED SUBSCRIPTION IS NOT A BROKEN MAILBOX — the sixth `sync_blocked_reason` (the wall).
--
-- An account whose managed subscription ended is parked by the worker's roster: the organizer
-- stands down, the lease in `ohmail/_meta` is released, and nothing syncs. Until this member the
-- row said nothing — a `connected` mailbox that silently stopped moving, which is the shape mail
-- 0029 exists to prevent. The row now says `connected` with
-- `sync_blocked_reason = 'account_closed'`: the mailbox is untouched, the credentials, consent
-- and mirror are kept, and the worker clears the reason the moment the account reads open again.
--
-- The member is what makes the sentence reachable at all: the copy renders only behind
-- `isSyncBlockReason`, which reads this closed set, so a string added to the catalogue without
-- this migration is dead by construction (mail 0102's rule, unchanged).
--
-- Idempotent (dropped-then-added, the shape mail 0102 and 0105 use for the same widening),
-- because a desktop engine replays this journal at every launch. Hosted-only in effect: no
-- self-hosted install composes an entitlements program, so no writer there produces the value.
--
-- ROLLBACK is the same two statements with 'account_closed' removed from the list, after
-- `UPDATE mailboxes SET sync_blocked_reason = NULL WHERE sync_blocked_reason = 'account_closed'` —
-- the column is a live state the worker rewrites every pass, so clearing it loses nothing.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off', 'account_closed'
  ));
