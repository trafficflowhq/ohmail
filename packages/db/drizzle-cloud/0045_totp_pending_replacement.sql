-- REPLACING AN ACTIVE AUTHENTICATOR (cloud 0045). An enrol over an activated `totp_secrets` row
-- inserted a second row for the user and `unique(user_id)` refused it (23505), so nobody could move
-- their second factor to a new phone. The replacement in progress lives on the SAME row: the enrol
-- writes these three columns and never the live pair, a second enrol overwrites them, and the
-- activation promotes them in one statement once a code from the new secret verifies. Until then
-- the authenticator in use keeps working. `unique(user_id)` stays.
--
-- DEPLOY ORDER: migration, then API (an API ahead of it fails every enrol with 42703). ROLLBACK,
-- after the API: drop the constraint, then the three columns. No existing row is rewritten.

ALTER TABLE "totp_secrets" ADD COLUMN IF NOT EXISTS "pending_secret_enc" text;
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD COLUMN IF NOT EXISTS "pending_key_version" integer;
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD COLUMN IF NOT EXISTS "pending_started_at" timestamp with time zone;

-- ONE CHECK seals all three, where 0036 sealed a pair: a start time without a secret would read as
-- a replacement that is fresh for ever, and a secret without its version cannot be decrypted.
--> statement-breakpoint
ALTER TABLE "totp_secrets" DROP CONSTRAINT IF EXISTS "totp_secrets_pending_sealed_together";
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_pending_sealed_together"
  CHECK (("pending_secret_enc" IS NULL) = ("pending_key_version" IS NULL)
     AND ("pending_secret_enc" IS NULL) = ("pending_started_at" IS NULL));
