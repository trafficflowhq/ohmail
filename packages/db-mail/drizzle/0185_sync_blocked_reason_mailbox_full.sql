-- A CLAIM REFUSED FOR ROOM NAMES ITSELF — `mailbox_full` is the tenth `sync_blocked_reason`.
--
-- A mailbox at its own quota at the provider refuses the lease's claim APPEND, and the row said
-- ohmail could not read its own folder. The cure is room in that mailbox. Drop-then-add, 0143's
-- shape, for the desktop replay.
--
-- ROLLBACK: clear the member (`UPDATE mailboxes SET sync_blocked_reason = 'lease_unreadable' WHERE
-- sync_blocked_reason = 'mailbox_full'`), then re-add 0143's CHECK.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off', 'account_closed',
    'provider_unavailable', 'meta_folder_full', 'meta_undeletable', 'mailbox_full'
  ));
