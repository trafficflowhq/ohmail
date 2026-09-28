-- WHEN THE WALL STOOD THIS MAILBOX DOWN, beside mail 0088's `organizer_released_at`.
--
-- The worker's park (mail 0124) releases a closed account's mailboxes to readers and writes this in
-- the same statement; a release the person asks for writes NULL. When the account reads open again a
-- `join` is stamped over every marked reader, and the promotion or stand-down that spends the stamp
-- clears the column. Additive and `IF NOT EXISTS`, no backfill. ROLLBACK is
-- `ALTER TABLE mailboxes DROP COLUMN organizer_parked_at`.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_parked_at" timestamp with time zone;
