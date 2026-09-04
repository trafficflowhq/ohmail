-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0091 — `organizer_requests.refused_reason` IS A CLOSED SET, AND THE DATABASE SAYS SO
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0090 added `refused_reason` as free text. The write path is already closed — an organizer's
-- acknowledgement is VERIFIED under the account's key before it is read at all, and the parser maps
-- any reason outside its own vocabulary to NULL, so the column can only ever hold one of eight
-- words this codebase chose or nothing. Nothing a mail server, a sender or a message body picked
-- can reach it.
--
-- ── WHY THAT ARGUMENT IS NOT ENOUGH ON ITS OWN ────────────────────────────────────────────────
--
-- The operator console's content-isolation sweep classifies every text column on a seeded table as
-- either echoed on purpose, refused by the database, or TAINTED — and a column whose closed set
-- lives only in application code is tainted, because the sweep can see a constraint and cannot see
-- a parser. That is the honest classification: an argument about the write path stops being true
-- the day somebody adds a second write path, and nothing fails when it does. `mailboxes.
-- disabled_reason` (0027) and `mailboxes.sync_blocked_reason` (0029) are the same shape and both
-- carry their own CHECK for exactly this reason, which their markers state at length.
--
-- So the closed set moves into the schema, where the sweep can read it and where a second write
-- site is refused by the database rather than by review.
--
-- ── THE VOCABULARY ────────────────────────────────────────────────────────────────────────────
--
-- The eight members of `REQUEST_REFUSAL_REASONS` (`packages/core/src/adapters/organizer-lease.ts`),
-- and NULL, which already means "a refusal whose named cause this build does not recognise" — a
-- newer organizer's word, deliberately stored as nothing rather than as free text.
--
-- ── AND IT IS WIDENED, NEVER NARROWED ─────────────────────────────────────────────────────────
--
-- Same rule as 0090's own state CHECK: a build that adds a ninth reason ships the widening
-- migration ahead of the code that writes it, so a row an older build wrote still satisfies the
-- constraint and an older build keeps working against a migrated database. Narrowing is what needs
-- a fleet-wide stop.
--
-- The tidy-up below cannot fire against any database this fleet has produced — there is no write
-- path that could have put an unrecognised word there. It is here because the alternative to a
-- repair is a FAILED MIGRATION on somebody's mailbox at launch, and because NULL is already this
-- column's word for "a refusal I cannot name": forgetting an unreadable hint is exactly what the
-- reader does with one at parse time, so the repair says the same thing the parser would have.
--
-- Deploy order: this constrains a column the API only ever reads and the worker only ever writes
-- from the closed set, so migration → API → worker is unchanged and no step is newly load-bearing.
--
-- ROLLBACK: drop the constraint. Nothing outside this feature reads the column.
--
-- Idempotent (dropped-then-added, the shape `0007_staff_users` established), because a desktop
-- engine replays this journal at every launch.

UPDATE "organizer_requests" SET "refused_reason" = NULL
  WHERE "refused_reason" IS NOT NULL
    AND "refused_reason" NOT IN (
      'unauthenticated', 'conflict', 'wrong_mailbox', 'invalid_payload',
      'malformed', 'unhandled_kind', 'stale', 'account_erased'
    );--> statement-breakpoint

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_refused_reason_closed";--> statement-breakpoint

ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_refused_reason_closed"
  CHECK ("refused_reason" IS NULL OR "refused_reason" IN (
    'unauthenticated', 'conflict', 'wrong_mailbox', 'invalid_payload',
    'malformed', 'unhandled_kind', 'stale', 'account_erased'
  ));
