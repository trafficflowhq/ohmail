-- WHICH VERB WROTE THE PRESS — the field that decides whether a press may take a live holder.
--
-- `takeover_authorized_at` records THAT a person asked for this install; it has never recorded
-- WHAT they asked for. The lease's rule 6 therefore gave the mailbox to whoever's press was
-- newest, and an install with no takeover verb at all — a phone, where the press is a launch —
-- could take a mailbox a computer was actively organizing, through the window between the poll
-- that reads the row and the write that claims the folder. The rule existed; it was enforced at a
-- precheck over a row up to one poll old rather than at the fence.
--
-- One additive column beside the stamp, read only when the stamp is non-NULL, written in the same
-- statement by every door that stamps. `join` asks for a mailbox nobody is organizing; `takeover`
-- asks for it whoever holds it.
--
-- DEFAULT 'join' AND NOT 'takeover', which is the opposite of the wire's default and deliberate.
-- The claim header is descriptive and absent means `takeover`, because every record any shipped
-- build wrote lacks it and those installs do take over. This column DECIDES, and a stamp whose
-- verb nobody recorded must be able to take an available mailbox and must not be able to take a
-- live holder's — the direction that cannot produce two organizers. It also covers the rows that
-- carry a live stamp at the moment this migration runs: an in-flight press that predates the
-- column is honoured against a free mailbox and yields against a busy one.
--
-- Desktop and Cloud behaviour is unchanged: their three stamp writers name 'takeover' explicitly.
--
-- Idempotent in both statements (the shape 0103 uses), because a desktop engine replays this
-- journal at every launch. Neither can fail on a live table: the column arrives with a default so
-- no row is rewritten by hand, and no existing value can be outside the closed set.

ALTER TABLE "mailboxes"
  ADD COLUMN IF NOT EXISTS "takeover_intent" text NOT NULL DEFAULT 'join';--> statement-breakpoint

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_takeover_intent_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_takeover_intent_closed"
  CHECK ("takeover_intent" IN ('join', 'takeover'));
