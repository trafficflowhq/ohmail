-- ENROLLMENT-SCOPED sessions (migration 0017).
--
-- Before this column there was no wire path from `POST /auth/register` to a first
-- session: register returned no session, login on a 2FA-less user returned
-- `{twofa_required, methods: []}` (a dead end), and every 2FA-enrollment endpoint
-- demands a session. `sessions.scope` marks the short-lived, single-purpose
-- password-only session that register (and a zero-method re-entry login) mints:
--
--   'full'       — a completed two-factor login. THE DEFAULT, so every pre-existing
--                  row keeps exactly the privileges it had.
--   'enrollment' — reaches only the `enrollmentOk` routes (/auth/2fa/*,
--                  /auth/session, /auth/logout); `withSession` rejects it
--                  everywhere else. Never carries `last_twofa_at`, so step-up
--                  stays out of reach, and no refresh_tokens row is ever minted
--                  for it (it cannot be extended — it expires in ~5 min).
--
-- The CHECK makes the two values exhaustive: an unknown scope cannot be written, so
-- reader code can never mis-classify a session into a privilege it should not have.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_scope_check" CHECK ("scope" IN ('full','enrollment'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
