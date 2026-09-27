-- TWO SOFT SYNC STATES — a provider that asks us to wait, and a first import that hit a ceiling.
--
-- `provider_unavailable` is the seventh `sync_blocked_reason`: a throttle or an RFC 5530
-- UNAVAILABLE/LIMIT answer is not a broken mailbox, so it no longer writes `status = 'error'`.
-- Drop-then-add, the shape 0102, 0105 and 0124 use, because a desktop engine replays this journal.
-- `sync_progress_at` is when a cycle last read a never-completed mailbox; the `sync_lag` alert
-- reads it after `last_sync_at`. Nullable, no default, no backfill. The alert also runs as the
-- column-granted `ohmail_admin`, so the column is granted where that role exists (0067's shape).
--
-- ROLLBACK: clear the member (`UPDATE mailboxes SET sync_blocked_reason = NULL WHERE
-- sync_blocked_reason = 'provider_unavailable'`), re-add 0124's CHECK, drop the column.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off', 'account_closed',
    'provider_unavailable'
  ));--> statement-breakpoint

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "sync_progress_at" timestamptz;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    GRANT SELECT ("sync_progress_at") ON "mailboxes" TO "ohmail_admin";
  END IF;
END $$;
