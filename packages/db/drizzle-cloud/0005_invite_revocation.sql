-- SPLIT FROM `0021_login_identity_and_invite_revocation` (single-journal era) — the CLOUD half.
--
-- ══ AN INVITE CAN BE REVOKED ══════════════════════════════════════════════════════════════
--
-- The table had `expires_at`, `consumed_at` and `consumed_by_user_id` — every way an invite
-- can END except the one an operator needs on the day it matters. A code mailed to the wrong
-- address, or forwarded, or pasted into a support ticket, could not be taken back: the
-- documented remedy was `--force`, which issues a SECOND code and leaves the compromised one
-- working for the rest of its 14 days. Both then open an account.
--
-- `revoked_at` joins the consumption predicate (`invites.ts:consumeInvite`), so a revoked
-- code stops working inside the same single statement that enforces single-use — not in a
-- second check some later caller can forget. `revoked_by` and `revoked_reason` exist because
-- "why is this invite dead" is asked exactly once, months later, by someone who was not
-- there.
--
-- Nullable, no default, purely additive: every existing row reads as "not revoked".
--
-- The original migration's first half — the globally unique login email — is a mail-domain
-- constraint and lives in the mail journal's `0018_login_email_identity`.

ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "revoked_by" text;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "revoked_reason" text;
