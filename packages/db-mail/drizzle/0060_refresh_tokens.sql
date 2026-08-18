-- 0060_refresh_tokens — the rotating-refresh store becomes SHARED (Phase 3, device pairing).
--
-- `refresh_tokens` was created by the single-journal era's 0003 and carried into the CLOUD
-- journal's 0000 on the ruling "a local install mints a session per launch: no password login,
-- no first factor, no refresh rotation". Phase 3 falsifies the last clause: QR device pairing
-- signs a REMOTE device into the desktop-as-host tier, that device holds a bearer pair, and its
-- refresh family — rotation, reuse detection, family revocation — is the SAME machinery Cloud
-- runs (`packages/services/src/auth/session-lifecycle.ts`), against the store that will serve
-- it. The desktop arm runs the mail journal only, so the table moves for exactly the argument
-- that put `users`/`devices`/`sessions`/`pairing_tokens` here. The identity CEREMONY — password
-- hashes, login tokens, factors — stays private; a refresh row holds a digest of a credential
-- this same database minted, the `pairing_tokens`/`sessions` discipline exactly.
--
-- EVERY statement is guarded, because this table already exists almost everywhere:
--  · a HOSTED or self-host database has it from cloud 0000 — the CREATE skips, both journals
--    stay runnable in either order (cloud 0000's own CREATE is IF NOT EXISTS and its FK ALTERs
--    catch duplicate_object, so a fresh database that runs mail-first is identical to one that
--    ran the legacy path; `journal-split.pg.test.ts` diffs the catalogs).
--  · an existing DESKTOP database lacks it — this is the migration that gives it one.
--
-- The FKs are INLINE and NAMED (not cloud 0000's separate guarded ALTERs) under the exact names
-- that journal established, so the two creations converge on one catalog object. Deliberately
-- NOT byte-identical to the cloud statements: the split's permutation oracle
-- (`journal-split.test.ts`) exempts post-split statements by content hash, and a byte-identical
-- copy would read as the legacy statement duplicated rather than as new work.
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_idx" ON "refresh_tokens" ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_session_idx" ON "refresh_tokens" ("session_id");
