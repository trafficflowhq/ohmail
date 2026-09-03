-- SYMMETRIC TAKEOVER: THE NOTICE'S TWO INSTANTS, THE RELEASE REQUEST, AND THE REQUEST QUEUE.
--
-- ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════════════════════
--
-- Four additive columns on `mailboxes` and one new table. Every one of them exists because a
-- fact that used to live in a client's memory, or in no store at all, has to live in a row
-- instead.
--
--   · `organizer_event_at` / `organizer_event_seen_at` — WHEN THE ORGANIZING SITUATION LAST
--     CHANGED, and when the person last acknowledged it. The notice a client shows ("another
--     install organizes this mailbox now") is derived as `event_at > coalesce(seen_at, -infinity)`
--     rather than held as client state, which is what makes it appear exactly once per event on
--     every door the account is open on — a phone, a laptop and a browser agree because they read
--     one row. Two events between two reads collapse to the later one by construction: there is no
--     queue to drain and nothing to replay.
--
--     NO KIND COLUMN, deliberately. The sentence is derived at read time from the role, the state
--     and the holder the row already carries. Storing the sentence's identity as well would be a
--     second copy of a fact three columns already hold, and the copies would drift the first time a
--     writer updated one and not the other.
--
--   · `release_requested_at` / `organizer_released_at` — the ASK and the RECORD.
--     `release_requested_at` is "stop organizing this mailbox, keep my mail", as a request rather
--     than as an act. The route that writes it opens no socket: the organizer's own next pass is
--     what expunges the claim, because expunging is an IMAP write and IMAP writes belong to the
--     process that holds the connection. The column is cleared by that pass, so it is a one-shot
--     in exactly the way `takeover_authorized_at` is.
--
--   · `organizer_requests` — a decision made on an install that reads a mailbox, waiting for the
--     install that organizes it to apply. The reader appends the record to the mailbox itself (the
--     only medium two installs share) and keeps this row as its own bookkeeping: which requests
--     have been handed over, which have been applied, which have aged out. The table is created
--     here rather than in the release that first writes to it so that there is ONE migration for
--     this feature and no second deploy ordering to get right.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════════
--
-- Purely additive: four nullable columns and one new table. No drop, no rename, no type change.
-- An API or worker one deploy older ignores all five and keeps working — it selects `mailboxes`
-- whole, which still has every column it knew.
--
-- Deploy order is migration → API → worker, for 0083's exact reason: the API selects whole rows
-- (so it 42703s against an un-migrated database) and the worker is the process that starts writing
-- the new columns. The desktop engine self-migrates at launch and needs no ordering.
--
-- ROLLBACK: drop the table and the four columns. Nothing outside this feature reads them.
--
-- Idempotent throughout (`IF NOT EXISTS`, and the CHECKs dropped-then-added, the shape
-- `0007_staff_users` established), because a desktop engine replays this journal at every launch.

-- ── THE NOTICE'S TWO INSTANTS ────────────────────────────────────────────────────────────────

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_event_at" timestamptz;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_event_seen_at" timestamptz;--> statement-breakpoint

-- ── THE RELEASE REQUEST ──────────────────────────────────────────────────────────────────────

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "release_requested_at" timestamptz;--> statement-breakpoint

-- ── AND THE MARKER THAT SAYS THE CEASING ACTUALLY HAPPENED ───────────────────────────────────
--
-- `release_requested_at` is the ASK and is cleared the moment it is honoured. `organizer_released_at`
-- is the RECORD, and it exists because the row a release leaves behind is otherwise
-- indistinguishable from a row a stand-down leaves behind once the winner's claim goes away:
-- both are `organizer_role='reader'` with a consent stamp and four NULL holder columns, because
-- the reader's own per-cycle peek writes those columns NULL whenever it finds an empty folder.
--
-- Telling the two apart is not cosmetic. "Somebody took this mailbox from you" and "you stopped
-- organizing it here" want different sentences on the claim-back screen, and one of them owes a
-- pending scheduled send an ending while the other has already given it one. Deriving the answer
-- from an ABSENCE that three other writers also produce is how a fact quietly becomes wrong; a
-- marker only the release writes is how it stays right.
--
-- Cleared by every promotion, so it describes the CURRENT state rather than a history.
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_released_at" timestamptz;--> statement-breakpoint

-- NO BACKFILL FOR ANY OF THE FOUR, and that is a decision rather than an omission. An existing
-- row has had no organizing EVENT under a build that records one, so stamping `organizer_event_at`
-- from `updated_at` (0087's backfill shape) would announce a notice to every user on the deploy
-- that introduced the feature — for a change that happened at some instant nobody recorded and
-- which they have very likely already seen in the pane. A NULL `event_at` renders no notice, which
-- is the truthful answer and the quiet one.

-- ── THE REQUEST QUEUE ────────────────────────────────────────────────────────────────────────
--
-- One row per decision a reader has made and the organizer has not applied yet. It is the READER'S
-- bookkeeping: the record the organizer actually acts on is the message the reader appends to the
-- mailbox, and this row is how the reader knows which of its own decisions are still in flight.
--
-- NO FOREIGN KEYS, on `away_replies`'s rule: the record has to outlive the message and the mailbox
-- row it was made against, and a cascade would erase the evidence that a decision was ever made.
-- The account erasure deletes these rows explicitly instead.

CREATE TABLE IF NOT EXISTS "organizer_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  -- What was decided: a screener verdict, or a rule written on a reader. Free text closes no set
  -- on its own, so the CHECK below closes it — the value chooses which applier runs, and an
  -- unhandled member would be resolved by whichever branch the drain falls through to.
  "kind" text NOT NULL,
  -- The decision itself, bounded at the write site. It is a CUSTOMER'S OWN input travelling
  -- through an RFC822 header and back, so it is validated by the same function the organizer's own
  -- door validates with before anything is applied.
  "payload" jsonb NOT NULL,
  -- WHEN THE PERSON DECIDED, by the deciding door's clock. The drain applies in this order, so two
  -- doors deciding one sender in one cycle land in the order the human made them.
  "decided_at" timestamptz NOT NULL,
  -- pending: written, not yet handed to the mailbox.
  -- sent:    appended to the mailbox; the organizer has not drained it yet.
  -- applied: the record is gone from the mailbox, so the organizer took it.
  -- expired: still in the mailbox 24 h later; nobody is organizing, and the person is told.
  "state" text NOT NULL DEFAULT 'pending',
  "sent_at" timestamptz,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_state_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_state_closed"
  CHECK ("state" IN ('pending', 'sent', 'applied', 'expired'));--> statement-breakpoint

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_kind_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_kind_closed"
  CHECK ("kind" IN ('screener.decide', 'rule.create', 'rule.update', 'rule.delete'));--> statement-breakpoint

-- THE DRAIN'S OWN READ. Every cycle on a reader asks "what of mine is still outstanding on this
-- mailbox", which is this index exactly. Without it that read is a sequential scan of every
-- request the install has ever made, per mailbox, per cycle — no query is wrong and every test
-- stays green, which is the shape of absence the index census exists for.
CREATE INDEX IF NOT EXISTS "organizer_requests_mailbox_state_idx"
  ON "organizer_requests" ("mailbox_id", "state");
