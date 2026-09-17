-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0117 — "NOT JUNK" BECOMES A COMMAND THE ORGANIZER EXECUTES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Organization lands in real IMAP folders, and the API never opens IMAP TO APPLY IT — moves defer
-- to the worker through desired state, so no request can leave a mailbox half-moved. The junk
-- rescue was that rule's one open instance: the route applied the Junk→INBOX move itself, and the
-- optional "always allow this sender" rule committed in its own transaction BEFORE it, so an
-- interrupted request left a rule standing with no move behind it.
--
-- ── WHY `folder_state` COULD NOT CARRY IT ─────────────────────────────────────────────────────
--
-- `folder_state.message_id` references `messages`, and the whole apply path is messages-row-bound:
-- the pending read inner-joins `messages` and takes the locator it moves from
-- `messages.native_locator`. Junk is structurally outside the mirror (FOLDERS-SPEC.md §16.2 — the
-- window reads the folder itself), so the ordinary case, a message the mail server's OWN filter
-- filed, has no row to hang a desired state on. Minting one contradicts §16.2. The command needs a
-- table keyed by a COORDINATE instead.
--
-- ── THE SHAPE, ON `folder_ops`' PRECEDENT ─────────────────────────────────────────────────────
--
-- The API records the command, rings the doorbell, and the worker's pass executes it inside the
-- mailbox's serial cycle and DELETES the row — `folder_ops` exactly. The pass is driven from the
-- repo inside the sync cycle rather than through an injected port, so every composition that runs
-- the sync reaches it: the hosted worker, the desktop engine and the standalone phone alike.
--
-- `folder` is `mailboxes.junk_folder` AS IT STOOD AT THE PRESS, never re-derived: a rescue names
-- one message in one place. `(mailbox_id, folder, uidvalidity, uid)` is UNIQUE on
-- `message_failures_locator_uq`'s shape — a UID means nothing outside its epoch — so a second press
-- on the same row resets the one command rather than queueing a duplicate move.
--
-- NO FOREIGN KEY TO `messages`, which is the entire point, and NO `kind` column: the table is the
-- kind and INBOX is the destination §16.2 names. `status` is CHECK-closed with two members and the
-- set is IMMUTABLE — a LANDED rescue leaves no row, so there is no third state — which is what
-- lets the device store carry the same CHECK (`closed-sets.ts`). `last_error_class` is
-- `folder_state`'s column verbatim: a CLASS somebody can act on, never the provider's own words,
-- which belong in the audit row.
--
-- NEVER GRANTED TO THE STAFF ROLE. The row is coordinates plus a closed status, and the
-- information is in its EXISTENCE — `message_failures`' argument, and the reason no projection
-- closes it.
--
-- ── COMPATIBILITY ─────────────────────────────────────────────────────────────────────────────
--
-- Purely additive: one new table, its unique constraint and one partial index. No drop, no rename,
-- no type change. `account_id` carries NO foreign key, matching every other mail-side table and
-- required by the closure rule this journal is held to — the mail journal runs first against an
-- empty database, so no statement here may name an object the private journal creates.
--
-- Deploy order: migration → API → worker. The API is the only writer and 42P01s against an
-- un-migrated database; the worker's pass reads an absent table the same way and its failure is
-- caught per cycle. The standalone engine self-migrates at launch and needs no ordering.
--
-- ROLLBACK: drop the table. Queued rescues are lost and the person presses again; nothing else
-- reads it.
--
-- Idempotent throughout (`IF NOT EXISTS`, the constraint dropped-then-added), because a standalone
-- engine replays this journal at every launch.

CREATE TABLE IF NOT EXISTS "junk_rescues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL REFERENCES "mailboxes"("id"),
  "folder" text NOT NULL,
  "uidvalidity" bigint NOT NULL,
  "uid" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_error_class" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "junk_rescues_status_closed" CHECK ("status" in ('pending', 'refused')),
  -- `folder_state`'s four classes, verbatim and for its reason: the schema forbids an error
  -- column holding someone else's server's words, and this is the class instead. Migration-only,
  -- like its twin: the set widens whenever a new IMAP response code earns its own sentence, and a
  -- widenable set may not be a CHECK on a store that cannot drop one.
  CONSTRAINT "junk_rescues_error_class_check"
    CHECK ("last_error_class" IS NULL
      OR "last_error_class" IN ('refused', 'no_such_folder', 'read_only', 'over_quota'))
);--> statement-breakpoint

-- ONE COMMAND IN FLIGHT PER LOCATOR. A second press on the same row resets the existing command
-- (status back to pending, the schedule cleared) through this constraint's `ON CONFLICT` — never a
-- second row, which would be a second move against one message.
ALTER TABLE "junk_rescues"
  DROP CONSTRAINT IF EXISTS "junk_rescues_locator_uq";--> statement-breakpoint
ALTER TABLE "junk_rescues"
  ADD CONSTRAINT "junk_rescues_locator_uq" UNIQUE ("mailbox_id", "folder", "uidvalidity", "uid");--> statement-breakpoint

-- The due probe, partial for `message_failures_due_idx`'s reason: without the predicate every
-- cycle would walk the mailbox's whole refused history to find what is outstanding.
CREATE INDEX IF NOT EXISTS "junk_rescues_due_idx" ON "junk_rescues"
  USING btree ("mailbox_id","next_attempt_at") WHERE "status" = 'pending';
