-- THE PER-ACCOUNT REQUEST KEY, AND THE OUTCOME A REFUSAL CARRIES BACK (0.14.1).
--
-- ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════════════════════
--
-- 0088 built a channel in which an install that READS a mailbox appends its screener decisions to
-- `ohmail/_meta` and the install that ORGANIZES that mailbox applies them. 0089 gave a reader a
-- way to ask, from a row alone, whether the holder is a build that drains such records at all.
-- Neither answered the question that decides whether the channel may be switched on: how does the
-- organizer know the record came from a reader of the SAME account?
--
-- It could not. `ohmail/_meta` is a folder on an IMAP server, and a request record is an RFC822
-- message. ANYONE with APPEND rights on that mailbox — a shared-folder ACL, a sieve `fileinto`, a
-- leaked device credential, any mail client the person ever signed in — could write one, and the
-- organizer would have applied it: a `promoted` rule, a `contacts` whitelist (a permanent Screener
-- bypass), a mark-read pushed to the server. Indistinguishable, in the product, from the account
-- owner's own press. That is why the channel shipped OFF in 0.14.1's first cut.
--
-- This migration is the first half of switching it on. `request_key` is 32 random bytes, minted
-- per account, held by every install that can prove it holds a session for that account, and used
-- to HMAC the fields of a request record. An organizer verifies that signature BEFORE it decodes
-- the payload; a record it cannot verify is refused and never parsed. A key nobody holds means an
-- organizer that advertises no `requests` capability, which is the honest degraded mode rather
-- than an open door.
--
-- ── WHY TEXT AND NOT `bytea` ────────────────────────────────────────────────────────────────
--
-- The key is base64url of the 32 raw bytes — 43 characters, which the CHECK below closes. This
-- half of the schema runs on BOTH a hosted Postgres (through postgres-js) and the desktop's
-- PGlite, and the two drivers hand a `bytea` back as different runtime types (a node `Buffer`
-- versus a `Uint8Array`). The key also travels to a local organizer as JSON over HTTP, where it
-- has to be a string in any case. One representation from the column to the wire means no
-- encoding seam for a signature to disagree across, and a signature that disagrees across a seam
-- fails as "forged".
--
-- ── WHY NOT A CHECK ON THE ALPHABET ─────────────────────────────────────────────────────────
--
-- The length is the property worth closing in the database, because it is the one a partial write
-- or a truncating client could break silently. The ALPHABET is closed at the single write site
-- (`mintRequestKey`), which is the only thing that ever produces a value here; a CHECK with a
-- regexp would restate that at a layer where it can only ever fire on a bug this schema cannot
-- otherwise have.
--
-- ── ROTATION ────────────────────────────────────────────────────────────────────────────────
--
-- The key rotates on a password change and on a consent reset, and rotation is an overwrite: the
-- old key stops verifying, so records signed with it are refused and expire. `request_key_rotated_at`
-- records WHEN, so an operator reading a run of `unauthenticated` refusals can tell a rotation
-- (expected, self-healing on the reader's next cycle) from an attack (not).
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────────────────────
--
-- Nothing owed. `account_settings` is deleted WHOLE by `deleteAccount` — `account-deletion.test.ts`
-- asserts the row count for this table goes to zero — so a column added here is erased by
-- construction rather than by a new clause someone has to remember. That is the reason the key
-- lives on this table rather than on a table of its own.
--
-- ══ THE REFUSAL AN ACK CARRIES ═════════════════════════════════════════════════════════════
--
-- 0088's four states could not express "the organizer looked at this and said no". A reader
-- inferred `applied` from the record's ABSENCE from the folder, which is the same shape as a
-- record the organizer refused and expunged — and the two mean opposite things to the person who
-- pressed. `refused` is the fifth state, and `refused_reason` is what the organizer said, carried
-- back on an ack record and surfaced to the person rather than swallowed.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════════
--
-- Purely additive: three nullable columns, one widened CHECK, one new index. No drop, no rename,
-- no type change. The CHECK is WIDENED, never narrowed, so a row an older build wrote still
-- satisfies it and an older build keeps working against a migrated database — it simply never
-- writes the new member.
--
-- Deploy order is migration → API → worker, 0083's and 0089's exact reason: the API selects whole
-- rows (so it 42703s against an un-migrated database) and the worker is the process that starts
-- writing the new columns. The desktop engine self-migrates at launch and needs no ordering.
--
-- ROLLBACK: drop the three columns and the index, and narrow the CHECK back — which requires
-- clearing any `refused` rows first, so the rollback is "narrow after the fleet stops writing it"
-- rather than a bare `ALTER`. Nothing outside this feature reads any of it; with `request_key`
-- absent no organizer advertises `requests`, which is the fail-safe direction (the channel is off)
-- rather than a fault.
--
-- Idempotent throughout (`IF NOT EXISTS`, and the CHECK dropped-then-added, the shape
-- `0007_staff_users` established), because a desktop engine replays this journal at every launch.

-- ── THE KEY ──────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "request_key" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "request_key_rotated_at" timestamptz;--> statement-breakpoint

ALTER TABLE "account_settings" DROP CONSTRAINT IF EXISTS "account_settings_request_key_len";--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_request_key_len"
  CHECK ("request_key" IS NULL OR octet_length("request_key") = 43);--> statement-breakpoint

-- ── WHAT THE ORGANIZER SAID ──────────────────────────────────────────────────────────────────

ALTER TABLE "organizer_requests" ADD COLUMN IF NOT EXISTS "refused_reason" text;--> statement-breakpoint

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_state_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_state_closed"
  CHECK ("state" IN ('pending', 'sent', 'applied', 'expired', 'refused'));--> statement-breakpoint

-- THE SCREENER LIST'S OWN READ. `listOutstandingForAccount` runs on every `GET /screener` to
-- exclude a sender the person has already decided on, and it asks by ACCOUNT — not by mailbox, so
-- 0088's `(mailbox_id, state)` index does not serve it. Without this the read is a sequential scan
-- of every request the install has ever made, on the hottest list in the product. No query is
-- wrong and every test stays green, which is the shape of absence the index census exists for.
CREATE INDEX IF NOT EXISTS "organizer_requests_account_state_idx"
  ON "organizer_requests" ("account_id", "state");
