-- PAIRING TOKENS — the mint/redeem/revoke lifecycle every pairing ceremony stands on: the
-- standalone server's first-account setup token, a family invite handed across a room, and the
-- QR device-pair flows that sign a new device into an existing account.
--
-- ══ WHY THIS TABLE IS IN THE MAIL JOURNAL ════════════════════════════════════════════════════
--
-- A pairing token is redeemed against the server that will serve the resulting session, and the
-- desktop-as-host arm runs the MAIL journal only — the same reason `users`, `devices` and
-- `sessions` are mail-half (`0003_identity_core`): a host that mints sessions needs the identity
-- core, and a host that pairs devices needs this. The identity CEREMONY (passwords, login
-- tokens, refresh rotation) stays in the Cloud journal; this table is not part of that ceremony —
-- it is a consumable credential whose whole authority is its own entropy, like an invite, and it
-- names no private table. The seam rule holds: every statement below touches only shared objects.
--
-- ══ THE COLUMNS ══════════════════════════════════════════════════════════════════════════════
--
--   created_by_user_id  uuid NULL, FK users(id)
--       Who minted it. NULL is FIRST-BOOT ONLY: the standalone server's composition root mints
--       one invite-grant token with no user when it boots against zero users (the Vaultwarden
--       pattern — the raw token is printed once to the server's own stdout, and reading the
--       operator's logs is the proof of box control). Every API mint carries the session's user.
--       A device-pair token REQUIRES a creator — the session its redeem mints is the creator's —
--       and the service refuses to mint one without; the column stays nullable because the
--       first-boot invite mint is the one legitimate ownerless row.
--
--   grant  text NOT NULL, CHECK IN ('invite','device-pair')
--       What redeeming buys. 'invite': consume + mint an email-bound invites row for the address
--       the redeemer presents — the existing verified-email invite path does the rest.
--       'device-pair': consume + establish a device-labelled session for the creator. The CHECK
--       closes the set so an unknown grant is unrepresentable at rest; the redeem statement also
--       names the grant in its WHERE, so a token can only ever be spent as what it was minted as.
--
--   token_hash  text NOT NULL UNIQUE
--       sha256 of the raw token (32 random bytes, base64url — the same `generateToken` every
--       other credential here uses, well above the 128-bit floor). The raw value exists once, in
--       the minter's response (or the boot log), and is never stored: the `login_tokens`
--       discipline. UNIQUE is also the redeem lookup's index.
--
--   label  text NOT NULL DEFAULT ''
--       The minter's own words ("first-run setup", "grandma's invite", "kitchen iPad"). For a
--       device-pair token the label becomes the paired device's `devices.label`, which is what
--       makes GET /devices legible and DELETE /devices/:id aimable afterwards.
--
--   expires_at / consumed_at / revoked_at / created_at
--       The invite lifecycle, exactly: single-use is one atomic
--       `UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND
--       revoked_at IS NULL AND expires_at > now() RETURNING`, so the row lock decides a race and
--       exactly one presenter wins. Revocation is a conjunct of that same statement, never a
--       check beside it.
--
-- No account_id column, deliberately: the creator user carries the account, and a first-boot
-- token has neither. No index beyond the UNIQUE — the table holds a handful of rows per server,
-- the list read is per-creator over that handful, and an index for it would be a measured,
-- separate decision (0058's rule).
--
-- ADDITIVE ONLY: one new table, one FK, nothing dropped, no data statement. An API deployed
-- ahead of this migration answers Postgres 42P01 on the pairing surface; the health marker
-- ["pairing_tokens","token_hash"] turns that into a 503 schema_incomplete naming this file.
-- ROLLBACK is `DROP TABLE "pairing_tokens";` — the cost is every outstanding pairing token,
-- which their holders remedy by asking for fresh ones; no session already established is
-- touched, because sessions never reference this table.

CREATE TABLE IF NOT EXISTS "pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" uuid,
	"grant" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_grant_check" CHECK ("grant" IN ('invite','device-pair'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
