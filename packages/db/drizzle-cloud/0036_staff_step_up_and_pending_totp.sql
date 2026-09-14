-- THE STAFF CONSOLE'S TWO SECURITY CONTROLS, MADE REAL.
--
-- ══ 1. A PENDING AUTHENTICATOR, SO AN ENROLMENT CANNOT LOCK AN OPERATOR OUT ════════════════
--
-- Cloud 0007's header says an abandoned enrolment "leaves a row nobody can sign in with,
-- instead of an operator locked out of their own console". That was true of the FIRST enrolment
-- and false of every one after it: `totp/begin` wrote straight into `totp_secret_enc`, the live
-- column, while `totp_activated` stayed true. Two tabs is all it takes — A confirms, B's begin
-- lands a moment later and its response is lost (the tab closed, the connection dropped). The
-- row then reads activated against a secret nobody holds: A's codes stop working, and once the
-- session expires there is no way back through the console at all.
--
-- The new columns hold an enrolment IN PROGRESS. `begin` writes the pending pair and never the
-- live one; `confirm` promotes the pending pair into the live one and sets activation in a
-- single statement; a second `begin` supersedes the pending pair only. There is then no ordering
-- in which the credential in use is replaced by one that has not been confirmed.
--
-- `totp_pending_started_at` bounds it: an enrolment nobody finished is not a credential this
-- deployment keeps offering, and the confirm route refuses a stale pending pair rather than
-- promoting a secret from last month.
--
-- ══ 2. `last_twofa_at` ON THE SESSION, SO A STAFF WRITE CAN ASK FOR A RECENT SECOND FACTOR ══
--
-- A staff session is a working day (12 h). The console's Actions page has always said that "a
-- staff session without a recent step-up gets 403 before any of it runs" — and nothing enforced
-- it, because the session row carried no answer to "when did this person last prove a second
-- factor". It does now: stamped at mint (every staff session is minted behind the TOTP wall) and
-- re-stamped by `POST /admin/staff/step-up`. `expires_at` is untouched by a step-up, so the
-- absolute twelve-hour cap on a stolen cookie stays exactly where it was.
--
-- Backfilled from `created_at` rather than left null, because that is the truth: a session that
-- exists was minted behind the second factor at the moment it was created. NOT NULL after the
-- backfill so "never proved" is not representable — the two states this column could otherwise
-- collapse are "not answered yet" and "answered long ago", and only the second one is real.
--
-- ══ 3. `staff_audit_log` — THE RECORD A RECOVERY LEAVES ════════════════════════════════════
--
-- `audit_log.account_id` is NOT NULL, so it cannot hold an act about a staff member: an operator
-- clearing a colleague's second factor after a lost phone is about a person, not an account.
-- This table is that record, append-only, and nothing in the console reads or writes it — the
-- recovery is an operator command against the API, deliberately not a second door in the UI.
--
-- The content-blind role reaches none of it: `scripts/harden-staff-role.sql` revokes ALL TABLES
-- IN SCHEMA public on every run and re-grants an allowlist this is not on, so a new table
-- arrives unreachable by construction. The explicit REVOKE below is 0007's belt, for a database
-- that was migrated without being re-hardened.
--
-- ROLLBACK: drop `staff_audit_log`, drop the four columns, drop the two constraints. No data is
-- rewritten and no existing column changes type.

ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "totp_pending_secret_enc" text;
--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "totp_pending_key_version" integer;
--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "totp_pending_started_at" timestamp with time zone;

-- The pending ciphertext and the version that sealed it are one fact, exactly as the live pair
-- is (0007's `staff_users_totp_sealed_together`). A half-null pending row cannot be decrypted
-- and would be discovered at confirmation, which is the worst moment to discover it.
--> statement-breakpoint
ALTER TABLE "staff_users" DROP CONSTRAINT IF EXISTS "staff_users_totp_pending_sealed_together";
--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_totp_pending_sealed_together"
  CHECK (("totp_pending_secret_enc" IS NULL) = ("totp_pending_key_version" IS NULL));

--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "last_twofa_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "staff_sessions" SET "last_twofa_at" = "created_at" WHERE "last_twofa_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "staff_sessions" ALTER COLUMN "last_twofa_at" SET NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_user_id" uuid NOT NULL,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "note" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "staff_audit_log" ADD CONSTRAINT "staff_audit_log_staff_user_id_fk"
    FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_audit_log_staff_at_idx" ON "staff_audit_log" ("staff_user_id","created_at");

-- 0007's belt, verbatim in shape: the role name is UNQUOTED so the journal-split parser does not
-- read a REVOKE's FROM as a relation, and the block is guarded on the role existing because
-- local, PGlite and CI databases have no `ohmail_admin`.
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "staff_audit_log" FROM ohmail_admin;
  END IF;
END $$;
