-- THE MAILBOX'S OWN SENT FOLDER — one nullable column beside mail 0065's `junk_folder`/`trash_folder`.
--
-- Correspondent knowledge counts a copy in the mailbox's Sent folder as the person's own writing,
-- and it knew that folder only by the shapes of its name. A server that marks Sent under a name of
-- its own (a localized Outlook folder) was never read as Sent. The attach writes the path it
-- resolved beside Junk and Trash. Nullable, no default, no backfill: every row heals at its next
-- attach. Idempotent, because a desktop engine replays this journal at every launch.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "sent_folder" text;
