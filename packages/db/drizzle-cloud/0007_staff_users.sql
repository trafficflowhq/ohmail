-- STAFF IDENTITY FOR THE ADMIN CONSOLE. One operator, no RBAC, no invites.
--
-- ══ WHY THIS IS NOT A COLUMN ON `users` ═══════════════════════════════════════════════════
--
-- `users` is the CUSTOMER identity. It is joined to `accounts`, it carries the product's own
-- 2FA, and a session over it authorises reading somebody's mail. A `role='staff'` column there
-- would mean any over-broad predicate, forgotten `AND`, or future join anywhere in the
-- product's auth path is a privilege escalation into cross-account access — a class of bug
-- that is easy to write and very hard to notice.
--
-- Staff lives in a table the product's auth never queries. There is then no code path in the
-- product that can promote anybody into it, which is a stronger guarantee than any amount of
-- care in the code that would have had to be careful.
--
-- ══ WHY THE CONSOLE'S OWN BLIND ROLE CANNOT READ IT ═══════════════════════════════════════
--
-- Every admin READ runs on `ohmail_admin`, the content-blind role (`packages/db/src/staff-grants.ts`).
-- That role is granted column by column against an allowlist, and NOTHING here is on it — so
-- the role that serves the console cannot read a password hash or a sealed TOTP secret, even
-- though the console it serves is what those credentials protect.
--
-- This needs no `REVOKE`. `scripts/harden-staff-role.sql` blanket-revokes `ALL TABLES IN
-- SCHEMA public` from the role on every run and then re-grants the allowlist, and it
-- deliberately sets no `ALTER DEFAULT PRIVILEGES`. A new table therefore arrives unreachable
-- by construction rather than by remembering. The census in `staff-grants.ts` reports only
-- capabilities the role HOLDS, so a table it holds nothing on produces no rows and the boot
-- attestation stays green across this migration.
--
-- Staff sign-in and staff writes run on the RUNTIME connection (`deps.db`) instead. That is
-- the whole reason this slice changes no grant and touches no attestation.
--
-- ══ THE TOTP SECRET IS SEALED, NEVER PLAINTEXT ════════════════════════════════════════════
--
-- Same envelope as `totp_secrets`: ciphertext plus the KEK version that sealed it, so a
-- database dump is not a set of working authenticators. `totp_last_consumed_step` is the
-- single-use-per-timestep guard — without it the same six digits stay valid for the rest
-- of their 30-second window, which is a live login for anyone who read them over a shoulder.
--
-- `totp_activated` is deliberately separate from "a secret exists": enrolment writes the
-- secret first and flips the flag only after a code generated from it has verified. An
-- abandoned enrolment then leaves a row nobody can sign in with, instead of an operator locked
-- out of their own console.

CREATE TABLE IF NOT EXISTS "staff_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "totp_secret_enc" text,
  "totp_key_version" integer,
  "totp_activated" boolean DEFAULT false NOT NULL,
  "totp_last_consumed_step" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);

-- The ciphertext and the version that sealed it are one fact. A row holding one without the
-- other cannot be decrypted and cannot be re-sealed; it is a corrupted enrolment that would be
-- discovered at sign-in, which is the worst possible moment to discover it.
--> statement-breakpoint
ALTER TABLE "staff_users" DROP CONSTRAINT IF EXISTS "staff_users_totp_sealed_together";
--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_totp_sealed_together"
  CHECK (("totp_secret_enc" IS NULL) = ("totp_key_version" IS NULL));

-- Activation without a secret is not a state that can be signed in with; refusing it here
-- means the sign-in path never has to consider it.
--> statement-breakpoint
ALTER TABLE "staff_users" DROP CONSTRAINT IF EXISTS "staff_users_activated_needs_secret";
--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_activated_needs_secret"
  CHECK ("totp_activated" = false OR "totp_secret_enc" IS NOT NULL);

-- ══ THE SESSION IS A ROW, NOT A SIGNED COOKIE ═════════════════════════════════════════════
--
-- The console's outer gate uses a stateless signed token and should: it hides the surface, it
-- has no identity, and rotating one variable invalidates every token at once with no state.
--
-- This credential authorises WRITES and names the actor an audit row will blame, so it has to
-- be withdrawable. A self-verifying token is not: a laptop lost at 09:00 stays signed in until
-- the expiry it was minted with, and the only remedy — rotating the signing secret — signs out
-- everybody and looks exactly like an outage. The row IS the session, so `revoked_at` is a
-- sign-out that actually signs out.
--
-- `expires_at` is the authority, NOT the cookie's `Max-Age`: that attribute is client-side, and
-- a cookie whose attribute was stripped is still presented.
--
-- `token_hash` and never the token: a dump, or a read-only injection anywhere, is then a list
-- of useless digests instead of a set of live staff sessions.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash")
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_user_id_fk"
    FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_sessions_user_idx" ON "staff_sessions" ("staff_user_id");

-- The lookup every authorised write performs: hash → live session. Partial, because an expired
-- or revoked row is never the answer to that question and does not belong in the index.
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_sessions_live_idx"
  ON "staff_sessions" ("token_hash") WHERE "revoked_at" IS NULL;

-- ══ BELT AND BRACES ═══════════════════════════════════════════════════════════════════════
--
-- The harden script's blanket revoke already covers this, but that script is run by hand and
-- this migration is not. If the role exists when this runs, say the quiet part explicitly, so
-- a database that was migrated but not re-hardened still has staff credentials out of reach of
-- the console's own connection. Guarded on the role existing: local, PGlite and CI databases
-- have no `ohmail_admin` and must not fail this migration.
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    -- The role name is deliberately UNQUOTED. `journal-split.test.ts` classifies every table
    -- a statement names, and its parser reads `FROM "x"` as a relation — which is true of a
    -- SELECT and false of a REVOKE, where the FROM names a ROLE. Unquoted is identical to
    -- Postgres (the identifier is already lower-case) and does not ask the shared parser to
    -- special-case this file.
    REVOKE ALL ON TABLE "staff_users" FROM ohmail_admin;
    REVOKE ALL ON TABLE "staff_sessions" FROM ohmail_admin;
  END IF;
END $$;
