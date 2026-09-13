-- THE ONE-TIME GATE RELEASE, PER ACCOUNT — one nullable column, so the repair runs once.
--
-- Every account that confirmed its seed before 0.19.0 carries rules written with no retro request
-- at all, and mail from those senders imported before the confirmation is still settled at the
-- screening gate. Nothing was ever owed for it, so no pass will ever reach it; the Screener
-- meanwhile lists those senders as first-time. `gateReleasePass` arms the release on each such
-- rule, releases the held mail of senders who are only `contacts` rows, and stamps this column so
-- it never runs again for that account.
--
-- Nullable, no default and no backfill: absent means "this account has not been swept", which is
-- true of every existing row and is what makes the pass pick them up. Idempotent, because a
-- desktop engine replays this journal at every launch.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "gate_release_done_at" timestamptz;
