-- THE ORGANIZING ROLE, SPLIT OFF THE CONNECTION — and the onboarding state that rides with it.
--
-- ══ THE CONFLATION THIS ENDS ═════════════════════════════════════════════════════════════
--
-- A `mailboxes` row carries two independent facts and until now it held them in one column.
--
--   the CONNECTION   `status` — connected | error | disabled. Can ohmail reach this mailbox?
--   the ROLE         who ORGANIZES it. Exactly one active organizer per mailbox is the
--                    invariant the product rests on, enforced by a lease in `ohmail/_meta`.
--
-- The stand-down encoded the second in the first: `status='disabled'` plus a `disabled_reason`
-- of `organized_elsewhere:*`. That was correct while the only two states were "we organize it"
-- and "we are out of it entirely", and it is wrong now, because the product's answer to
-- "somebody else organizes this" is no longer silence. It is: **be another mail client.** Read
-- it, search it, mark it read, send from it — and touch nothing else. That install is CONNECTED
-- and SYNCING, so it cannot be `disabled`; `loadEnabledMailboxes` filters `disabled` out and a
-- reader has to stay on the roster to have a mirror at all.
--
-- So the role becomes its own column and `disabled` goes back to meaning what its name says:
-- a tombstone (the user removed the mailbox) or a plan disable. `disabled_reason` keeps its
-- column and its CHECK and GAINS NO NEW WRITER — it is left in place because live rows carry it
-- and because dropping a column read by an older API binary mid-deploy is the one shape this
-- journal never takes.
--
-- ══ THE COLUMNS, SO NOBODY RE-DERIVES THEM ═══════════════════════════════════════════════
--
--   organizer_role        'organizer' | 'reader'. NOT NULL, DEFAULT 'organizer' — the default
--                         is the pre-migration behaviour of every row that exists, which is what
--                         makes this additive in the only sense that matters (an un-updated
--                         worker binary reading these rows organizes exactly what it organized
--                         yesterday). A reader is a mail client: its one IMAP write verb is
--                         `setFlags`.
--   organized_by_kind     'cloud' | 'local' | 'unknown' — WHO holds the lease when we do not.
--   organized_by_name     the holder's `X-Ohmail-Display-Name`. A CUSTOMER'S MACHINE NAME:
--                         header-safe and capped at 120 at the write site, and on the admin
--                         DTO deny-list. Staff see the role and the kind, never the name.
--   organized_since       the holder's `X-Ohmail-Claimed-At` — when they became the organizer,
--                         as distinct from when they were last seen.
--   organizer_state       'held' | 'stopped' — the lease's `LeaseOccupancyState`.
--   organize_consented_at when a human asked THIS install to organize this mailbox. NULL is a
--                         mailbox nobody has consented to organize — the state `POST /mailboxes`
--                         now creates, and the reason a fresh connect builds a mirror and moves
--                         nothing.
--
--   account_settings.onboarding_completed_at   cancel and finish both stamp it. Onboarding state
--                         is DERIVED from truth-conditions and never from a step counter; this
--                         is the one condition that has no other witness.
--   account_settings.screening_scope           'window' | 'all_time'. "All time" is a MODE, not a
--                         window value: `dormancy_days` is bounded 1–365 and NULL means the
--                         product default, so there is no number that spells "no cutoff".
--   mailbox_folders.server_exists              the folder's `EXISTS` as the SELECT reported it.
--                         The adapter has always read it and always discarded it; the first-pull
--                         progress strip needs a denominator and this table held cursors only.
--
-- ══ WHY `organizer_state` IS PERSISTED NOW WHEN `lease.ts` ARGUED IT MUST NOT BE ═════════
--
-- `apps/worker/src/lease.ts` says, of this exact value: *"it is correct when produced and stale
-- one minute later, so it is never persisted"* — because a stood-down mailbox left the roster,
-- so nothing would ever refresh the column and it would keep saying "somebody is organizing
-- this" long after they stopped. **The premise moved.** A reader stays connected and cycles, so
-- there IS a later writer: every reader cycle refreshes this column from a `peekLease` read (the
-- APPEND-less IO). The value is therefore never older than one poll interval, and the mailbox
-- that has no writer for it — a tombstone — is one nothing displays. That comment is amended in
-- the same commit as this migration.
--
-- ══ THE BACKFILL, AND WITHOUT IT EVERY LIVE MAILBOX DEMOTES ON DEPLOY ════════════════════
--
-- Two statements, in this order, and both are load-bearing.
--
-- (1) STOOD-DOWN ROWS BECOME CONNECTED READERS. They are `disabled` today only because the
--     stand-down had nowhere else to write. Leaving them would mean the feature ships with its
--     entire existing population invisible: a person whose desktop organizes their mailbox would
--     open Cloud and see a disabled row, not a live mirror.
--
--     GUARDED ON THE PARTIAL UNIQUE INDEX, and this is not hypothetical. `mailboxes_active_
--     address_uq` is UNIQUE on `(account_id, lower(address)) WHERE status <> 'disabled'`. A
--     stood-down row is `disabled`, so nothing stopped the same address being connected AGAIN
--     beside it — and promoting the old row then violates the index and takes the whole migration
--     down mid-deploy. A row with a live sibling on the same address is genuinely superseded, so
--     it stays disabled and keeps its reason.
--
-- (2) EVERY CONNECTED ROW GETS `organize_consented_at`. Connecting a mailbox WAS the consent
--     under the old copy — the connect screen said ohmail would organize it — so the record is
--     true, and `created_at` is when it was given. Without this statement the new precondition
--     ("consent is NULL ⇒ this install has not been asked to organize") reads every live mailbox
--     as un-consented, and the gate stops promoting: every mailbox in production demotes to
--     reader on the deploy that ships this. It runs AFTER (1) so the rows promoted there are
--     covered by it — they consented when they connected, the same as everyone else.
--
-- `organized_since` and `organizer_state` are deliberately NOT backfilled. We do not know when
-- the foreign organizer claimed, and we have not looked at the folder; the first reader cycle
-- fills both from the lease itself. Inventing a timestamp here would be a record of an
-- observation nobody made — 0027's own rule about `takeover_authorized_at`.
--
-- ══ COMPATIBILITY ════════════════════════════════════════════════════════════════════════
--
-- Additive; every added column is nullable except the two that carry a DEFAULT equal to the
-- pre-migration behaviour. The reverse — a NEW binary against an un-migrated database — is why
-- the deploy order is migration → API → worker: `MailboxService` selects WHOLE ROWS through the
-- drizzle schema, so an API deployed first answers Postgres 42703 on the mailbox panel and on
-- the connect flow. All six `mailboxes` columns, both `account_settings` columns and
-- `mailbox_folders.server_exists` therefore join `MAIL_SCHEMA_MARKERS` (with the four closed sets
-- in `SCHEMA_CHECK_MARKERS`) in `packages/api/src/routes/health.ts`, so that mistake reports
-- `503 schema_incomplete` naming this migration instead of a 500 nobody can attribute. Same
-- reasoning, same shape, as 0023, 0025 and 0027. The sidecar self-migrates at launch.
--
-- ROLLBACK is DROP CONSTRAINT on the four CHECKs, then DROP COLUMN on the nine columns. The cost
-- is that mailboxes promoted by backfill (1) stay `connected` with no recorded reason, which
-- reads as an ordinary connected mailbox an older worker will try to organize — so a rollback of
-- this migration must be paired with a rollback of the worker, not taken on its own.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_role" text DEFAULT 'organizer' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organized_by_kind" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organized_by_name" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organized_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organizer_state" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "organize_consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "screening_scope" text DEFAULT 'window' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN IF NOT EXISTS "server_exists" integer;--> statement-breakpoint
-- IDEMPOTENT, because `ADD CONSTRAINT` has no `IF NOT EXISTS` and every statement in this journal
-- is replayable — 0027's pattern, and its reason: a real-Postgres test rewinds a fully-migrated
-- database and re-migrates, `openLocalDb` re-runs both journals on every desktop launch, and any
-- recovery from a `PartialMigrationError` replays. A bare ADD raises 42710 and takes the pass with
-- it. `IS NULL OR` is explicit on the three nullable sets because "unknown is allowed" is the
-- semantic asserted, not a three-valued accident; `organizer_role` and `screening_scope` are NOT
-- NULL and say so.
DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organizer_role_closed" CHECK ("organizer_role" IN ('organizer', 'reader'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organized_by_kind_closed" CHECK ("organized_by_kind" IS NULL OR "organized_by_kind" IN ('cloud', 'local', 'unknown'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organizer_state_closed" CHECK ("organizer_state" IS NULL OR "organizer_state" IN ('held', 'stopped'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_screening_scope_closed" CHECK ("screening_scope" IN ('window', 'all_time'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- BACKFILL (1) — see the header. `split_part('organized_elsewhere:cloud', ':', 2)` is 'cloud',
-- which is inside the CHECK above by construction: `disabled_reason`'s own CHECK closes the same
-- three kinds. The `NOT EXISTS` is the partial-unique-index guard.
UPDATE "mailboxes" AS m SET
  "status" = 'connected',
  "organizer_role" = 'reader',
  "organized_by_kind" = split_part(m."disabled_reason", ':', 2),
  "disabled_reason" = NULL
WHERE m."status" = 'disabled'
  AND m."disabled_reason" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "mailboxes" AS o
    WHERE o."account_id" = m."account_id"
      AND lower(o."address") = lower(m."address")
      AND o."id" <> m."id"
      AND o."status" <> 'disabled'
  );--> statement-breakpoint
-- BACKFILL (2) — see the header. Runs after (1), so the rows it promoted are covered.
UPDATE "mailboxes" SET "organize_consented_at" = COALESCE("created_at", now())
WHERE "status" = 'connected' AND "organize_consented_at" IS NULL;
