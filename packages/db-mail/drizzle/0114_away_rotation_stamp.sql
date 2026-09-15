-- THE AWAY RESPONDER'S ROTATION STAMP — one column, so a per-run bound decides how much work
-- happens and not whose.
--
-- The pass draws at most `AWAY_ACCOUNTS_PER_RUN` responders per tick, ordered by `enabled_at`.
-- Deterministic, so it drew the SAME page every tick: past that many live responders, the ones
-- behind the page were shown as enabled and answered nobody for as long as the page ahead of
-- them stayed on. This column is where the walk stops: the pass stamps the accounts it actually
-- entered, the probe orders by it first, and the page rotates.
--
-- `to_timestamp(0)` means NEVER WALKED — every existing row starts there and sorts first, so the
-- first tick after this migration draws exactly the page it drew before. NOT NULL with that
-- default rather than nullable: the two stores order NULLs in opposite directions by default,
-- and a sentinel the pass never writes cannot be confused with an instant it did.
--
-- Idempotent, because a desktop engine replays this journal at every launch.

ALTER TABLE "away_responders" ADD COLUMN IF NOT EXISTS "last_considered_at" timestamptz NOT NULL DEFAULT to_timestamp(0);
