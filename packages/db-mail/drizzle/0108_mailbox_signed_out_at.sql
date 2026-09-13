-- THE SIGN-OUT'S DURABLE STAMP — one nullable column, so a password cannot be sealed back over a
-- sign-out that has already reported success.
--
-- The local door's credential clear deletes the row and reads it back inside one transaction, and
-- a `FOR UPDATE` there serializes a competing credential write without stopping it COMMITTING a
-- moment later: the writer dialled before the clear ran, and its insert lands after. The epoch the
-- engine already keeps closes that for writers inside its own process; it cannot close it for the
-- shared `PATCH /mailboxes/:id`, which is what a paired phone sends and what the route table
-- serves. This column is the fact both halves can read: the clear stamps it, and every writer that
-- seals a secret re-reads it under the mailbox's row lock and refuses when it has moved.
--
-- Nullable, no default and no backfill: absent means nobody has signed out of this mailbox on this
-- install, which is true of every existing row. Idempotent, because a desktop engine replays this
-- journal at every launch.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "signed_out_at" timestamptz;
