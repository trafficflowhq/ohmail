-- A FULL `ohmail/_meta` NAMES ITSELF — `meta_folder_full` is the eighth `sync_blocked_reason`.
--
-- A lease read the folder's size refused (past the record or byte ceiling) was `lease_unreadable`,
-- whose sentence names nothing a person can do. The cure is in their mailbox, so the row says so.
-- Drop-then-add, the shape 0105, 0124 and 0130 use, because a desktop engine replays this journal.
--
-- ROLLBACK: clear the member (`UPDATE mailboxes SET sync_blocked_reason = 'lease_unreadable' WHERE
-- sync_blocked_reason = 'meta_folder_full'`), then re-add 0130's CHECK.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off', 'account_closed',
    'provider_unavailable', 'meta_folder_full'
  ));
