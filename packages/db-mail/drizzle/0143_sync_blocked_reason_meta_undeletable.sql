-- A `_meta` THAT TAKES NO DELETE NAMES ITSELF — `meta_undeletable` is the ninth `sync_blocked_reason`.
--
-- A server that refuses ohmail's deletes in `ohmail/_meta` grew it by one claim a renew until it
-- was too full to read. Renewals now stop after repeated proven refusals and the row says so; the
-- cure is a delete permission on that folder. Drop-then-add, 0142's shape, for the desktop replay.
--
-- ROLLBACK: clear the member (`UPDATE mailboxes SET sync_blocked_reason = 'lease_unreadable' WHERE
-- sync_blocked_reason = 'meta_undeletable'`), then re-add 0142's CHECK.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_sync_blocked_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_sync_blocked_reason_closed"
  CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" IN (
    'lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited', 'clock_off', 'account_closed',
    'provider_unavailable', 'meta_folder_full', 'meta_undeletable'
  ));
