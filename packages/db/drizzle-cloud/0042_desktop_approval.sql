-- SIGNING A COMPUTER IN BY CONFIRMING IN THE BROWSER — the approval row (cloud 0042).
--
-- The desktop asks for an approval before anyone has confirmed it, so the row exists with NO
-- user: `user_id` loses its NOT NULL, and the CHECK below admits a NULL for this one purpose
-- only, so every other row in the table stays bound exactly as before. `label` and `platform`
-- are what the page names the computer by; `ip_class` is a CLASS (the first two IPv4 octets or
-- the IPv6 /48), never an address. `approved_at` is the confirm, `revoked_at` the denial or the
-- wrong-verifier kill, `attempts` the wrong-verifier count. All additive, no backfill: no row
-- here predates the purpose. The CHECK is NOT VALID (a growth table; every existing row is bound,
-- and every new one is checked). Deploy order: migration, then API.
ALTER TABLE "login_tokens" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "platform" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "ip_class" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "login_tokens" DROP CONSTRAINT IF EXISTS "login_tokens_unbound_is_approval";
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_unbound_is_approval"
  CHECK ("user_id" IS NOT NULL OR "purpose" = 'desktop_approval') NOT VALID;
