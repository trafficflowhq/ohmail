-- 0209_app_handoff — the phone apps' handoff of a sign-in: the three columns, as the server carries them.
-- This store declares neither CHECK of the shared entry (its twin declares no CHECK on `pairing_tokens`, as for
-- 0059); the grant and its binding are held by the one burn every redeem goes through, which asks for the
-- challenge's hash as a conjunct.

ALTER TABLE "pairing_tokens" ADD COLUMN "challenge_hash" text;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD COLUMN "handoff_from_device_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "handed_off_from" text;
