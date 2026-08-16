-- THE FUNNEL (migration 0020). Two tables, both purely additive:
-- `waitlist` (who asked to be let in) and `invites` (who was let in, once, before when).
-- Rollback is two DROP TABLEs; nothing a paying customer owns lives here.
--
-- ── WHY A TABLE AT ALL, WHEN `AuthConfig.inviteCodes` ALREADY EXISTS ─────────────────────
--
-- It does, and it stays (see below) — but a `Set<string>` in the API process cannot express
-- any of the three refusals a registering human must be able to READ:
--
--   · "this invite has already been used"  — a Set has no consumption
--   · "this invite expired on 12 August"   — a Set has no clock
--   · "that code is not for this address"  — a Set has no binding
--
-- And the missing binding is not a copy problem, it is a SECURITY one. `POST /auth/register`
-- answers 201 for a fresh address and 409 for a registered one. Behind an unbound code, that
-- pair is an account-existence oracle for ANY address the caller cares to type — which is the
-- exact enumeration primitive the login-hardening pass spent a whole decision removing from
-- `POST /auth/login`, re-created one endpoint over. An EMAIL-BOUND invite closes it
-- structurally: the only address the holder of a code can put through the register endpoint
-- is the address the code was mailed to, i.e. an inbox they already control, so the 409 tells
-- them a fact about themselves and nothing about anybody else. This is the funnel's
-- recorded enumeration-oracle decision.
--
-- This is also the open item the session-hardening work named verbatim and deferred for want of a
-- migration number ("hashed, expiring, ideally email-bound invite rows consumed
-- transactionally with account creation"). 0018 took the number it was waiting on; this is it.
--
-- ── WHAT THE STATIC `inviteCodes` SET IS NOW ─────────────────────────────────────────────
--
-- The OPERATOR BOOTSTRAP, and only that: a code an operator puts in `TF_INVITE_CODES` to open
-- their own account on a database with no invite rows in it yet (and the one the test suite
-- uses, `INVITE-OK`). It is unbound and reusable, so it carries the oracle above — which is
-- why production runs with the variable EMPTY once the first invite row exists, and why
-- `AuthService.register` consults it only after the invite table has declined to recognise
-- the code at all. Removing it outright would have been a bigger change to the auth surface
-- than this slice is entitled to make, and would have left no way to bootstrap a fresh
-- deployment.
--
-- ── CODES ARE STORED HASHED ──────────────────────────────────────────────────────────────
--
-- `code_hash` is `sha256(raw)`, the same `hashToken` every other bearer credential in this
-- schema is stored under (`login_tokens`, `sessions`, `refresh_tokens`, `oauth_auth_codes`).
-- An invite code IS a bearer credential — it is the single thing standing between a stranger
-- and an account during the invite-gated beta — so a database dump must not be a list of
-- working invites. The raw value exists exactly twice: in the operator's terminal when it is
-- minted, and in the recipient's inbox.
--
-- Core Postgres only (no CREATE EXTENSION, RC8) so this replays into PGlite unchanged.

CREATE TABLE IF NOT EXISTS "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Normalised (trimmed, lower-cased) by `normalizeRecipient` before it ever reaches here,
	-- so the UNIQUE below is a real uniqueness and not a case-sensitive near-miss.
	"email" text NOT NULL,
	-- Mirrors `SignupTier` in apps/webapp/app/(marketing)/components/Signup.tsx and `WaitlistTier` in
	-- packages/services/src/mail/templates.ts. The CHECK is what makes the template's
	-- exhaustive `Record<WaitlistTier, string>` lookup total at runtime too: a tier this
	-- column cannot hold is a tier the mail cannot fail to label.
	"tier" text DEFAULT 'undecided' NOT NULL,
	-- Where the signup came from. One value today ('landing'); present because the first
	-- question asked of any waitlist is "where did these people come from".
	"source" text DEFAULT 'landing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Advances when someone re-submits the form with a different tier. The row is UPSERTed,
	-- never duplicated: a person who signs up three times is one entry and one mail.
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Stamped by the operator invite path, so "who is still waiting" is one indexed query
	-- and an invite is not sent twice by accident.
	"invited_at" timestamp with time zone,
	-- Stamped by `AuthService.register` when this address completes registration. Closes the
	-- funnel: waitlist → invited → registered, all three readable from one table.
	"registered_at" timestamp with time zone,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email"),
	CONSTRAINT "waitlist_tier_check" CHECK ("tier" IN ('desktop','solo','plus','pro','undecided'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_created_idx" ON "waitlist" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_invited_idx" ON "waitlist" ("invited_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- sha256(raw). UNIQUE because the single-use consumption is
	-- `UPDATE … WHERE code_hash = $1 AND consumed_at IS NULL … RETURNING id`, and that is
	-- only a single-use guarantee if at most one row can match.
	"code_hash" text NOT NULL,
	-- THE BINDING. Normalised like `waitlist.email`. NOT NULL: an unbound invite row would
	-- re-open the enumeration oracle this table exists to close, so the schema refuses to
	-- represent one rather than relying on every future caller remembering to pass an address.
	"email" text NOT NULL,
	-- Free-text provenance for the human who minted it ('operator', a staff email later).
	"issued_by" text DEFAULT 'operator' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- NOT NULL and with no default: an invite that never expires is a permanent key to the
	-- beta sitting in an inbox, and forgetting the argument must not be how one is created.
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	-- Who redeemed it. No FK to `users`: erasing an account (Art. 17, `DELETE /account`) must
	-- not have to decide between deleting the audit trail of how it was created and failing
	-- on a constraint. The id is retained as a bare reference.
	"consumed_by_user_id" uuid,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
-- "has this person got a live invite already?" — the operator mint path's only lookup.
CREATE INDEX IF NOT EXISTS "invites_email_idx" ON "invites" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invites_expires_idx" ON "invites" ("expires_at");
