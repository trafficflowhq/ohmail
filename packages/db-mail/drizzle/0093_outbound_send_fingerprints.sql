-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0093 — THE ACCOUNT CLAIMS THE CONTENT OF A SEND, NOT ONLY THE CLIENT'S KEY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `outbound_sends` is unique on `(account_id, idempotency_key)`. That key belongs to the CLIENT,
-- and it is the only thing standing between a person and a second copy of a message they cannot
-- take back.
--
-- The send path already refuses a second reservation against the SAME draft: the reserve
-- transaction holds a `FOR UPDATE` lock on the draft row, refuses any status but `draft`, and
-- flips the row to `sending` before it commits, so two keys against one draft serialize and the
-- second is refused. The hole that survives is a SECOND DRAFT ROW: a client that mints a fresh key
-- and composes a fresh draft holding the same message collides with nothing, and the message is
-- delivered twice. A reinstalled client, a second device, a browser store cleared in a private
-- window and an older build all reach that state without anybody doing anything unusual.
--
-- So the account claims the CONTENT as well. One row per distinct message per sending mailbox,
-- and a send whose content already has a live claim is refused with a sentence naming the first.
--
-- ── WHAT IS IN THE FINGERPRINT ────────────────────────────────────────────────────────────────
--
-- A SHA-256, lowercase hex, over everything a recipient can perceive: the three address lists
-- (trimmed, lowercased, deduped, sorted, display names excluded), the subject, the text actually
-- sent, the reply target, the forward target, the schedule, and one sorted attachment manifest of
-- names, content types and sizes. Not in it: the draft id — which is precisely the field the
-- defect moves — the thread, the minted Message-ID, the idempotency key, and the mailbox, which is
-- a KEY COLUMN here and would otherwise be counted twice.
--
-- ── WHY A TABLE, AND WHY THE ROW IS RE-POINTABLE ──────────────────────────────────────────────
--
-- The claim outlives any one attempt and the reservation does not. The send path RECLAIMS a row —
-- repointing `send_id`, restamping `created_at` — when the claim is older than the duplicate
-- window, or when the reservation it names ended `failed`. The second case is not an optimisation:
-- after a definite non-delivery the draft is returned to `draft` and the person must be able to
-- press Send again on the same unedited text, and without the reclaim its own claim would refuse
-- it. A nullable column on the permanent `outbound_sends` row cannot express a re-pointable claim,
-- and the window cannot be a partial index predicate at all, because such a predicate must be
-- immutable and `now()` is not.
--
-- ── THE WINDOW IS ENFORCED AT THE DECISION ────────────────────────────────────────────────────
--
-- One hour, compared against the request clock inside the conflict arm. The DELETE that a
-- maintenance pass runs at twenty-four hours is hygiene and nothing depends on it — which is the
-- point: a standalone install runs this same code and has no maintenance pass, so a window
-- enforced by pruning would be unbounded there and identical re-sends would be refused for ever.
--
-- ── COMPATIBILITY ─────────────────────────────────────────────────────────────────────────────
--
-- Purely additive: one new table, its unique constraint and its CHECK. No drop, no rename, no type
-- change, and nothing reads it but the send path. `account_id` carries NO foreign key, matching
-- `outbound_sends` and required by the closure rule this journal is held to — the mail journal
-- must run first against an empty database, so no statement here may name an object the private
-- journal creates. `send_id` references `outbound_sends`, which is on this side.
--
-- Deploy order: migration → API. The API is the only writer and it 42P01s against an un-migrated
-- database; the worker's prune is additive and tolerates the table being absent for one release if
-- the order is ever reversed. The standalone engine self-migrates at launch and needs no ordering.
--
-- ROLLBACK: drop the table. Nothing outside the send path reads it, and losing the claims costs
-- only the duplicate defence for the length of the window.
--
-- Idempotent throughout (`IF NOT EXISTS`, the constraint dropped-then-added, the shape
-- `0007_staff_users` established), because a standalone engine replays this journal at every
-- launch.

CREATE TABLE IF NOT EXISTS "outbound_send_fingerprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "send_id" uuid NOT NULL REFERENCES "outbound_sends"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- THE CLAIM ITSELF. One live claim per (account, sending mailbox, content); the send path takes
-- it with `ON CONFLICT DO NOTHING RETURNING`, so a loser blocks on this index until the winner
-- commits and then re-reads rather than racing it.
ALTER TABLE "outbound_send_fingerprints"
  DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_content_uq";--> statement-breakpoint
ALTER TABLE "outbound_send_fingerprints"
  ADD CONSTRAINT "outbound_send_fingerprints_content_uq" UNIQUE ("account_id", "mailbox_id", "fingerprint");--> statement-breakpoint

-- CLOSED BY SHAPE, IN THE DATABASE. The value is a SHA-256 this codebase computes and nothing a
-- mail server, a sender or a message body can choose. The write path being closed is not enough on
-- its own — the operator console's content sweep classifies a text column with no constraint as
-- tainted, and correctly, because an argument about the write path stops being true the day
-- somebody adds a second one. The same reasoning mail 0091 wrote out for
-- `organizer_requests.refused_reason`.
ALTER TABLE "outbound_send_fingerprints"
  DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_hex";--> statement-breakpoint
ALTER TABLE "outbound_send_fingerprints"
  ADD CONSTRAINT "outbound_send_fingerprints_hex" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');
