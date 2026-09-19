-- THE DISMISSED HELD-RELEASE OFFER — the fingerprint of the exact offer the account said
-- "not now" to: a sha256 over the sorted (rule, destination, count) groups, written by the
-- dismiss door and compared by `GET /screener/held-releases`. NULL means never dismissed.
-- Any change to the set — new held mail from a decided sender, a group released — changes
-- the fingerprint and the offer returns; matching fingerprint means the offer stays away on
-- every device, which is the fact a per-session client flag could not carry. Additive,
-- `IF NOT EXISTS`, no default, no backfill. The CHECK bounds a wire-written value.
-- ROLLBACK: ALTER TABLE account_settings DROP COLUMN held_release_dismissed.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "held_release_dismissed" text;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_held_release_dismissed_len"
  CHECK ("held_release_dismissed" IS NULL OR char_length("held_release_dismissed") <= 128);
