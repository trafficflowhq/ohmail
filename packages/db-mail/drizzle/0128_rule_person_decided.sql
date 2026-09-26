-- WHO MADE A RULE'S DECISION — one nullable column on `rules`.
--
-- The automatic unsubscribe pass acts only for a sender the PERSON screened out. A reject folder
-- cannot say that (import adoption and the auto-act pass file there too), and `provenance` is
-- `promoted` for a press and for the auto-act pass alike. The screener's apply stamps this on the
-- rule it promotes when a person pressed; nothing else sets it. Nullable, no default, no backfill;
-- idempotent, because a desktop engine replays this journal at every launch.

ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "person_decided_at" timestamp with time zone;
