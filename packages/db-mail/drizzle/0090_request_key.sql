-- THE REFUSAL AN ORGANIZER CAN CARRY BACK, AND THE READ THAT FINDS IT (0.14.1).
--
-- ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════════════════════
--
-- 0088 built a channel in which an install that READS a mailbox appends its screener decisions to
-- `ohmail/_meta` and the install that ORGANIZES that mailbox applies them. This migration carries
-- the half of that channel which needs storage: the outcome an organizer sends back.
--
-- ── WHY THERE IS NO KEY COLUMN HERE, THOUGH THE FILE IS NAMED FOR ONE ───────────────────────
--
-- A record has to be signed, or an organizer cannot tell this account's own reader from anything
-- else with write access to the mailbox — a shared-folder ACL, a sieve `fileinto`, a leaked device
-- credential. The first cut of this migration stored a per-account key in `account_settings` and
-- handed it to each install over the hosted API.
--
-- That is withdrawn, and the reason is a boundary rather than a preference: a LOCAL install talks
-- only to the mail server and never to the hosted service, so there is no authenticated call it
-- could fetch a key on, and giving it one would mean giving the sealed local artifact a session it
-- deliberately does not have.
--
-- The two installs already share exactly one secret, and it is the right one: **the mailbox
-- password**. The key is HKDF-SHA256 over it, salted with the mailbox address, computed at use and
-- NEVER STORED — so there is nothing here to hold, nothing to leak from this table, and no
-- rotation plumbing: changing the password changes the key, which is precisely when older records
-- should stop verifying. See `deriveRequestKey` (`@trafficflow/core/adapters/organizer-lease`).
--
-- The file keeps its name because the journal tag is immutable once written: an adopting database
-- records the tag it ran, and renaming it here would make this file disagree with that record.
--
-- ══ THE REFUSAL ════════════════════════════════════════════════════════════════════════════
--
-- 0088's four states could not express "the organizer looked at this and said no". A reader
-- inferred `applied` from the record's ABSENCE from the folder, and a record the organizer REFUSED
-- and expunged is absent in exactly the same way — so a decision that had been thrown away was
-- reported to the person as carried out. `refused` is the fifth state, and `refused_reason` is what
-- the organizer said, carried back on a signed acknowledgement and shown rather than swallowed.
--
-- The reason is a CLOSED vocabulary this codebase defines and the organizer chooses; it is never a
-- sentence a payload supplied. No CHECK on it, on `organized_by_name`'s precedent: a NEWER
-- organizer may answer with a member this build has not heard of, and a closed set here would make
-- the row unwritable the day that ships. The reader drops an unrecognised reason to NULL rather
-- than rendering a stranger's token.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════════
--
-- Purely additive: one nullable column, one WIDENED CHECK, one new index. No drop, no rename, no
-- type change. The CHECK is widened and never narrowed, so a row an older build wrote still
-- satisfies it and an older build keeps working against a migrated database — it simply never
-- writes the new member.
--
-- Deploy order is migration → API → worker, 0083's and 0089's exact reason: the API selects whole
-- rows (so it 42703s against an un-migrated database) and the worker is the process that starts
-- writing the new column. The desktop engine self-migrates at launch and needs no ordering.
--
-- ROLLBACK: drop the column and the index, and narrow the CHECK back — which requires clearing any
-- `refused` rows first, so the rollback is "narrow after the fleet stops writing it" rather than a
-- bare `ALTER`. Nothing outside this feature reads any of it.
--
-- Idempotent throughout (`IF NOT EXISTS`, and the CHECK dropped-then-added, the shape
-- `0007_staff_users` established), because a desktop engine replays this journal at every launch.

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
