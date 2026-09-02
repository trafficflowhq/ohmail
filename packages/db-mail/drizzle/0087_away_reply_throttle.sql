-- THE AWAY RESPONDER, REWORKED: A PER-PERSON THROTTLE, A LEDGER, AND AN ENABLEMENT INSTANT.
--
-- ══ WHAT THIS REPLACES, AND WHY ════════════════════════════════════════════════════════════
--
-- 0051 made the responder reply once per sender per "enablement episode", where the episode key
-- was the responder row's own `updated_at`. That key has two failures, and both are the kind that
-- only appear once somebody actually travels:
--
--   · ANY SAVE STARTS A NEW EPISODE. Switching the responder off on Friday and on again on Monday
--     — or opening Settings and pressing Save having changed nothing — re-arms a reply to every
--     correspondent already answered. A save is not an edit.
--   · AN EDIT STRANDS THE BACKLOG. `updated_at` was also the candidate floor, so fixing a typo
--     mid-trip pushed the floor past mail that had already arrived, and every correspondent behind
--     it was never answered at all — not by the old text and not by the new one. Fixed here.
--
-- The replacement separates the three questions 0051's one column was answering: WHEN THE WINDOW
-- OPENED (`enabled_at`, moving only on OFF → ON), WHAT THE RESPONDER SAYS (a hash of the text, so
-- "once until you change it" means the text and not the row), and HOW OFTEN ONE PERSON MAY BE
-- ANSWERED (`throttle`, an explicit setting rather than a consequence of the episode key).
--
-- ══ ADDITIVE ONLY. `subject` IS NOT DROPPED, AND THAT IS DELIBERATE ═════════════════════════
--
-- The responder becomes REPLY-ONLY in this release — it carries no subject of its own and derives
-- `Re: <the message it answers>` — so `subject` stops being read and stops being written. It is
-- NOT dropped here, on 0083's rule: an API one deploy older than this migration selects whole rows,
-- and dropping a column out from under it is a 500 on every read for the length of the rollout.
-- It goes in a 0.15 contract migration together with `away_responder_sent`, once no live deploy
-- names either. Until then it is an unread, unwritten column, which costs a byte and no behaviour.
--
-- `away_responder_sent` is likewise left standing and left populated. It is the SOURCE of the seed
-- below, and it is the only record of who was answered before this migration ran.
--
-- ══ THE SEED, AND WHY IT ONLY EVER SUPPRESSES ══════════════════════════════════════════════
--
-- A responder that is live RIGHT NOW when this migration runs must not answer everybody a second
-- time the moment the new pass starts. So `away_sender_state` is seeded from the old record: one
-- row per (account, sender) at that sender's most recent `sent_at`.
--
-- That seed is suppressive for `per_day` and `per_week` — a sender answered an hour ago stays
-- unanswered for the rest of the window — and it is deliberately NOT suppressive for
-- `per_message`, because there is no honest value to seed `last_text_hash` with: the old table
-- never recorded what the responder said. The sentinel below cannot equal any real hash (it is not
-- 64 hex characters), so a `per_message` responder treats every seeded sender as "the text has
-- changed" and answers them once more. That is the safe direction: being answered once more is
-- recoverable, and never being answered is not — the same ruling 0051 made about its own episode
-- key, applied to the migration that replaces it.
--
-- `ON CONFLICT DO NOTHING` because the pass may already be running against a database mid-deploy;
-- a live row is newer than anything this seed could write and must win.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════════
--
-- Purely additive: two new tables and two new columns, no drop, no rename, no type change. An API
-- one deploy older ignores all four and keeps working — it selects `away_responders` whole, which
-- still has every column it knew. The new pass refuses to run against a database without these,
-- which is what the schema marker (`["away_responders","throttle"]`) is for.
--
-- ROLLBACK: drop the two tables and the two columns. Nothing outside this feature reads them, and
-- the old worker pass — which is deleted in this release but is what a rollback restores — reads
-- `away_responder_sent`, which this migration leaves exactly as it found it.
--
-- Idempotent throughout (`IF NOT EXISTS`, and the CHECKs dropped-then-added, the shape
-- `0007_staff_users` established), because a desktop engine replays this journal at every launch.

-- ── THE RESPONDER ROW ────────────────────────────────────────────────────────────────────────

ALTER TABLE "away_responders" ADD COLUMN IF NOT EXISTS "throttle" text NOT NULL DEFAULT 'per_day';--> statement-breakpoint
ALTER TABLE "away_responders" ADD COLUMN IF NOT EXISTS "enabled_at" timestamptz;--> statement-breakpoint

-- The closed four-member enum. A member nobody enumerated is a member no reader handles, and here
-- an unhandled member would be resolved by whichever branch the pass falls through to — which is
-- the branch that sends mail.
ALTER TABLE "away_responders" DROP CONSTRAINT IF EXISTS "away_responders_throttle_closed";--> statement-breakpoint
ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_throttle_closed"
  CHECK ("throttle" IN ('always', 'per_message', 'per_day', 'per_week'));--> statement-breakpoint

-- The backfill: a row that is enabled right now has been enabled since SOME instant nobody
-- recorded, and `updated_at` is the closest true statement available about it. A row that is not
-- enabled gets NULL, which the pass reads as "not live" rather than as "the beginning of time".
-- Guarded on IS NULL so a replay never moves an instant the application has since written.
UPDATE "away_responders" SET "enabled_at" = "updated_at"
  WHERE "enabled" = true AND "enabled_at" IS NULL;--> statement-breakpoint

-- ── THE LEDGER: ONE ROW PER DECIDED CANDIDATE ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "away_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  -- NO foreign key, on `away_responder_sent`'s rule: the record has to outlive the message that
  -- triggered it, and an expunge must not un-answer a correspondent.
  "message_id" uuid NOT NULL,
  "sender" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "text_hash" text,
  "minted_message_id" text,
  "decided_at" timestamptz DEFAULT now() NOT NULL,
  "sent_at" timestamptz
);--> statement-breakpoint

ALTER TABLE "away_replies" DROP CONSTRAINT IF EXISTS "away_replies_outcome_closed";--> statement-breakpoint
ALTER TABLE "away_replies" ADD CONSTRAINT "away_replies_outcome_closed"
  CHECK ("outcome" IN ('pending', 'sent', 'unverified', 'throttled', 'suppressed'));--> statement-breakpoint

-- THE RESERVATION. Two runners racing one message both attempt the INSERT; exactly one gets a row.
-- This is the structural half of "one automatic reply per message" — not a diagnostic index.
CREATE UNIQUE INDEX IF NOT EXISTS "away_replies_message_uq"
  ON "away_replies" ("account_id", "message_id");--> statement-breakpoint

-- "Why was this person not answered", and the throttle's own diagnostic.
CREATE INDEX IF NOT EXISTS "away_replies_sender_idx"
  ON "away_replies" ("account_id", "sender", "decided_at");--> statement-breakpoint

-- ── THE THROTTLE STATE: ONE ROW PER CORRESPONDENT ────────────────────────────────────────────
--
-- The PRIMARY KEY is the serialiser. "Has this person been answered recently" is answerable as a
-- READ over the ledger, but a read-then-write has a gap two runners fit through, and there is no
-- row to lock for a sender who has never been answered. An upsert against this key has no gap: the
-- INSERT arm and the UPDATE arm are one statement and the key is what orders them.

CREATE TABLE IF NOT EXISTS "away_sender_state" (
  "account_id" uuid NOT NULL,
  "sender" text NOT NULL,
  "last_replied_at" timestamptz NOT NULL,
  "last_text_hash" text NOT NULL,
  CONSTRAINT "away_sender_state_pk" PRIMARY KEY ("account_id", "sender")
);--> statement-breakpoint

-- The seed — suppressive direction only. See the header for why `last_text_hash` is a sentinel
-- rather than a hash: the old record never stored what the responder said, and this value cannot
-- equal any real `awayTextHash` output (which is 64 hex characters), so `per_message` reads every
-- seeded sender as "the text has changed" and answers them once more.
INSERT INTO "away_sender_state" ("account_id", "sender", "last_replied_at", "last_text_hash")
SELECT "account_id", "sender", max("sent_at"), 'seeded-from-0051-no-recorded-text'
  FROM "away_responder_sent"
 GROUP BY "account_id", "sender"
ON CONFLICT ("account_id", "sender") DO NOTHING;
