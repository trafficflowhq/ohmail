-- ACCOUNT SUSPENSION. The operator's off switch, and a HOSTED-ONLY fact.
--
-- ══ WHY A CLOUD TABLE, NOT `accounts.suspended_at` ════════════════════════════════════════
--
-- Suspension is an act of the hosted operations surface: a staff member stops serving an
-- account. It is meaningless on a LOCAL desktop install — no operator, nobody to suspend — so it
-- lives on the private half, exactly like `staff_users`. Two rules make this the only legal
-- placement, not a preference:
--
--   · `accounts` is a MAIL table (`schema-mail.ts`, partitioned MAIL in `journal-split.test.ts`).
--     A cloud migration running `ALTER TABLE "accounts"` breaks the closure rule — no cloud
--     statement may perform DDL on a shared object. So the column cannot live on `accounts` and
--     be added here at the same time.
--   · The actor is a `staff_users` id. `staff_users` is CLOUD; a MAIL statement may never name a
--     private object, so `accounts.suspended_by` is unrepresentable in the mail journal — and the
--     actor is the one thing this table exists to record.
--
-- ══ PRESENCE IS THE STATE ═════════════════════════════════════════════════════════════════
--
-- A row means "suspended"; its absence means "not". Resume DELETEs the row rather than stamping a
-- `resumed_at`, so no reader (`accountsWithSyncDisabled`, `spendState`, `readMailboxAllowance`,
-- the billing service) has an `AND resumed_at IS NULL` predicate it can forget — the forgotten
-- predicate being exactly the failure the staff-blindness rule warns about. The audit trail of every suspend and
-- resume lives in `audit_log`; this table holds only the current fact the entitlement gates read.
--
-- The PRIMARY KEY on `account_id` is the mutual exclusion the write keys on: suspend is
-- `INSERT … ON CONFLICT (account_id) DO NOTHING RETURNING`, so two concurrent suspends yield one
-- row and one audit entry, and a replay is a no-op.
--
-- ══ THE CONSOLE'S BLIND ROLE READS ONLY TWO COLUMNS ══════════════════════════════════════
--
-- `ohmail_admin` is granted `SELECT (account_id, suspended_at)` in `scripts/harden-staff-role.sql`
-- — enough to show who is suspended and since when. `suspended_by`/`note` stay ungranted until a
-- screen renders them. The WRITE runs on the runtime connection, never on the blind role: a write
-- grant there would fail its boot attestation. Widen the SELECT allowlist BEFORE running the
-- harden script (a held grant outside the allowlist refuses the handle; a missing one only warns).

CREATE TABLE IF NOT EXISTS "account_suspensions" (
  "account_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."accounts"("id"),
  "suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
  "suspended_by" uuid NOT NULL REFERENCES "public"."staff_users"("id"),
  "note" text
);
