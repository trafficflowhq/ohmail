-- 0209_app_handoff — one phone app hands its sign-in to the other, once, bound to the receiver's challenge.
--
-- A third grant on `pairing_tokens`, `app-handoff`: a single-use code the signed-in app of a phone mints for its
-- sibling app on the same phone, redeemable only with the verifier of the SHA-256 challenge the receiver sent
-- (`challenge_hash`), and only while the session that minted it lives (`handoff_from_device_id` names its device).
-- A CHECK holds that a handoff row carries both and no other grant carries either, so no unbound handoff exists.
-- `devices.handed_off_from` records whose child a handed-off device is: a reuse sweep of a family, and a take-back
-- in Devices, end everything handed off from it. No foreign key and no index: reads go through `devices_user_idx`,
-- and neither table is a growth table.
-- Idempotent (dropped, then added; IF NOT EXISTS): a desktop engine replays this journal at launch.
-- ROLLBACK is restating 0059's CHECK and dropping the three columns, once no row carries the grant.

ALTER TABLE "pairing_tokens" DROP CONSTRAINT IF EXISTS "pairing_tokens_grant_check";--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_grant_check" CHECK ("grant" IN ('invite','device-pair','app-handoff'));--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD COLUMN IF NOT EXISTS "challenge_hash" text;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD COLUMN IF NOT EXISTS "handoff_from_device_id" uuid;--> statement-breakpoint
ALTER TABLE "pairing_tokens" DROP CONSTRAINT IF EXISTS "pairing_tokens_handoff_bound";--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_handoff_bound" CHECK ((("grant" = 'app-handoff') = ("challenge_hash" IS NOT NULL)) AND (("grant" = 'app-handoff') = ("handoff_from_device_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "handed_off_from" uuid;
