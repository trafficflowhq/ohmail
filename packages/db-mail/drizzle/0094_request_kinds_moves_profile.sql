-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0094 — TWO MORE THINGS A READER MAY ASK FOR, AND A PLACE TO KEEP WHAT THE ORGANIZER ANSWERED
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Until now an install that does not organize a mailbox could ask its organizer for exactly one
-- thing: a Screener decision. Everything else it could reach on that mailbox it either could not
-- do at all, or — worse — appeared to do. Moving a message answered `409`. Editing an away
-- responder, a signature, a dormancy window or a screening preference answered `200`, wrote the
-- row belonging to the install that is NOT organizing, and showed the edit as done. The organizer's
-- own pass never reads that row, so the change never happened anywhere a person could observe it.
-- A refusal is a product decision somebody can argue with; a success that changes nothing is not.
--
-- This migration is the schema half of closing that. Two new request kinds, and one table to hold
-- the configuration the organizer publishes so a reader has something true to render instead of
-- its own dead row.
--
-- ── (1) THE KIND SET IS WIDENED, NEVER NARROWED ───────────────────────────────────────────────
--
-- 0088 closed `kind` to four members; 0091's own marker states the rule this follows: **a build
-- that adds a member ships the widening migration ahead of the code that writes it**, so a row an
-- older build wrote still satisfies the constraint and an older build keeps working against a
-- migrated database. Narrowing is what needs a fleet-wide stop, and nothing here narrows.
--
-- `message.move`  — move ONE message to ONE destination. The natural key is `(dedupKey,
--                   destination)` and it rides `messages_mailbox_dedup_uq`, which is what makes an
--                   idempotent re-apply expressible: the same message asked to the same place twice
--                   is one outcome, not two moves.
-- `profile.update`— a PARTIAL edit of the per-mailbox configuration: away responder, signature,
--                   dormancy window, screening preference. Each field present replaces; each field
--                   absent is untouched. A partial is what a settings pane produces, and a
--                   whole-document replace would let two panes edited a minute apart silently undo
--                   one another.
--
-- The four existing members are re-stated verbatim rather than referenced, because a CHECK has no
-- other way to say it. `rule.create|update|delete` have been in this set since 0088 with no applier
-- on the organizer side; they get one in the same wave as these two.
--
-- An unrecognised kind is still not representable in this column, and that is the point the
-- constraint exists to make: the drain's fall-through branch is the one that moves somebody's mail.
--
-- ── (2) `mailbox_profile_mirror` — WHAT THE ORGANIZER SAYS THE CONFIGURATION IS ───────────────
--
-- The organizer publishes a versioned profile document into `ohmail/_meta` (`organizer-profile.ts`).
-- A reader can read that folder, but doing it per pane render is an IMAP dial per viewer, and a
-- reader that is offline has nothing to show at all. This table is the reader's copy of the last
-- document it managed to read: one row per mailbox, replaced whole.
--
-- It is a MIRROR and never a source. Nothing organizes from it, nothing merges into it, and a
-- reader that has never read a document has no row — which is a state the pane must render as "no
-- profile from <holder> yet" rather than as an empty configuration. Those two look identical in a
-- table of defaults and mean opposite things, which is why absence is a missing ROW here and not a
-- row full of nulls.
--
-- ── THE UID IS STORED WITH ITS UIDVALIDITY, AND THAT IS NOT A SPARE COLUMN ────────────────────
--
-- The shape this table was specified with carried `uid` alone. A remembered IMAP uid is a fact
-- only under the UIDVALIDITY it was read under: a server that renumbers a folder re-issues the
-- same small integers to different messages, and a memo that survived the renumber is then a
-- confident pointer at the wrong message. This repository already decided that question everywhere
-- else it stores a locator — `message_instances_locator_uq` and `message_failures_locator_uq` are
-- both `(mailbox_id, folder, uidvalidity, uid)`, and 0028's marker says why in as many words: "one
-- UID inside one server epoch is ONE place". `ProfileReadResult` hands back a `ref` that is already
-- the pair (`'<uidvalidity>:<uid>'`, `makeRef`), so storing half of it would be discarding a fact
-- the reader had in its hand.
--
-- So: both, and a read whose generation does not match the folder's current UIDVALIDITY discards
-- the row rather than trusting it. `bigint`, matching every other uidvalidity column here —
-- RFC 3501 makes it a 32-bit UNSIGNED value, which does not fit `integer`.
--
-- ── AND IT CARRIES `account_id`, WHICH THE SPECIFIED SHAPE DID NOT ───────────────────────────
--
-- Every seeded table in this schema carries the account it belongs to, because account isolation
-- is structural rather than remembered: a read keyed on `mailbox_id` alone is correct only for as long
-- as every caller remembers to join `mailboxes` to find out whose mailbox it is. `organizer_requests`
-- carries both for exactly this reason. The document mirrored here is configuration rather than
-- mail — screener entries, rule names, an away-responder body — but it is still one account's, and
-- the erasure sweep and the isolation census both work by this column.
--
-- ── DEPLOY ORDER ──────────────────────────────────────────────────────────────────────────────
--
-- Migration → organizer (worker and desktop engine) → reader doors. The widened CHECK admits rows
-- no code writes yet; the appliers land next; the doors that produce them land after that. Running
-- it in the other order is what would put a `message.move` row in front of a database that refuses
-- it, and the person who pressed the button would see a 500.
--
-- ROLLBACK: re-state the 0088 CHECK with its four members (which fails while any row holds one of
-- the new kinds — drain or delete them first), and drop the table. Nothing outside this feature
-- reads either.
--
-- ── SQLITE TWIN: REQUIRED, THREE OBJECTS ──────────────────────────────────────────────────────
--
-- Stated here by name because the journal-lockstep guard asks this entry for a twin or a reason,
-- and "a device never runs this" is FALSE for all three.
--
-- The standalone phone is built on SQLite and it is never a host — but "not a host" is not "always
-- the organizer". It is an ordinary install of the same product: it organizes the mailbox when it
-- holds the claim and is a READER whenever something else does, which is the common case for a
-- phone beside a desktop or Cloud. A reader is precisely the install that WRITES `organizer_requests`
-- rows and READS `mailbox_profile_mirror` — the objects here are the reader half of the protocol,
-- so the device that is most often a reader is the one that needs them most.
--
-- The three, and each needs its own twin:
--
--   1. `organizer_requests.kind` — the CHECK widened by the same two members. SQLite enforces
--      CHECK constraints, and a narrower one there would make a phone refuse a request it is the
--      intended AUTHOR of.
--   2. `mailbox_profile_mirror` — created with the same six columns. `uidvalidity` is `INTEGER` in
--      SQLite, which is 64-bit there and so holds the same range as `bigint` here.
--   3. `organizer_requests.refused_reason` — the CHECK widened by `no_such_message` and
--      `no_trash_folder`. This is the one easiest to miss, because it is the only one a phone
--      needs as a READER RECEIVING an answer rather than as an author: the organizer writes the
--      refusal, and the reader stores what came back. A phone whose constraint still holds eight
--      words rejects the row at the moment it records why its own move did not happen — a failure
--      on the path whose only job is to explain a refusal, which is the worst place for one.
--
-- Idempotent (dropped-then-added / `IF NOT EXISTS`, the shape `0007_staff_users` established),
-- because a desktop engine replays this journal at every launch.

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_kind_closed";--> statement-breakpoint

ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_kind_closed"
  CHECK ("kind" IN (
    'screener.decide', 'rule.create', 'rule.update', 'rule.delete',
    'message.move', 'profile.update'
  ));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mailbox_profile_mirror" (
  -- ONE ROW PER MAILBOX, replaced whole. The mailbox is the identity of the document, so it is the
  -- primary key rather than a surrogate with a unique index beside it: two mirrors of one mailbox
  -- is not a state this feature has, and a key that cannot express it is cheaper than a constraint
  -- that forbids it.
  "mailbox_id" uuid PRIMARY KEY NOT NULL,
  -- WHOSE. See the marker above: account isolation is a column, not a convention.
  "account_id" uuid NOT NULL,
  -- THE SERVER EPOCH THE UID BELOW WAS READ UNDER. NULL means the reader could not learn it, which
  -- reads as "this locator is not usable" — never as "any generation will do".
  "uidvalidity" bigint,
  -- The message the document was read from, inside that epoch.
  "uid" integer,
  -- THE DOCUMENT AS PARSED — the envelope included, so a reader can see the version and the
  -- producer that wrote it rather than inferring them.
  "doc" jsonb NOT NULL,
  -- WHEN THIS INSTALL LAST READ IT. The pane says "as of <t>" from this; a reader that has been
  -- offline for a day must be able to say so rather than present a day-old document as current.
  "read_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- THE ERASURE SWEEP'S OWN READ, and the isolation census's. Both ask by ACCOUNT, and the primary
-- key above has a different leading column, so it does not serve them — a different leading column
-- is a different index, and the miss is invisible to every test.
CREATE INDEX IF NOT EXISTS "mailbox_profile_mirror_account_idx"
  ON "mailbox_profile_mirror" ("account_id");--> statement-breakpoint

-- ── (3) TWO MORE WORDS A REFUSAL MAY CARRY, FOR THE KIND THIS MIGRATION ADMITS ────────────────
--
-- 0091 closed `refused_reason` to eight words. `message.move` has two outcomes none of them can
-- say, and both are things the reader could not have known when it decided:
--
--   `no_such_message`  — the message is not in THIS organizer's store. Never synced here, or since
--                        deleted. Two installs of one mailbox legitimately hold different subsets
--                        of it, so this is not a fault of the record and not an error.
--   `no_trash_folder`  — the destination was `trash` and no Trash path has been discovered for
--                        this mailbox. ohmail never expunges, so there is nowhere to put it and no
--                        default that would not be a lie about where the mail went.
--
-- They live here rather than in a migration of their own because they exist ONLY because
-- `message.move` exists, and that is this file. A separate migration for two words of one feature
-- is worse history, not safer.
--
-- WHY THEY MUST BE WORDS RATHER THAN NULL. NULL already means "a refusal whose named cause this
-- build does not recognise", which is the honest answer for a NEWER organizer's vocabulary — and
-- it is the wrong answer here, where this build knows exactly which of the two happened. A reader
-- told nothing cannot tell "the message is not on that machine" from "that machine has no Trash",
-- and those want different things from the person.
--
-- WIDENED, NEVER NARROWED, on 0091's own rule: the eight existing members are re-stated verbatim
-- and two are added, so every row an older build wrote still satisfies the constraint. No DML —
-- there is nothing to repair, because no write path could have put either word there before this.
--
-- `request-refusal-closed.pg.test.ts` reads the vocabulary FROM THE CODE, so this constraint and
-- `REQUEST_REFUSAL_REASONS` cannot drift apart quietly: a word in one and not the other is red on
-- a real server rather than a row the database rejects at the instant the drain records a refusal.

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_refused_reason_closed";--> statement-breakpoint

ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_refused_reason_closed"
  CHECK ("refused_reason" IS NULL OR "refused_reason" IN (
    'unauthenticated', 'conflict', 'wrong_mailbox', 'invalid_payload',
    'malformed', 'unhandled_kind', 'stale', 'account_erased',
    'no_such_message', 'no_trash_folder'
  ));
