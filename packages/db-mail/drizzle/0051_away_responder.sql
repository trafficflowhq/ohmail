-- THE AWAY RESPONDER'S AUDIENCE, AND THE RECORD THAT MAKES IT REPLY ONCE.
--
-- ══ WHAT WAS ALREADY THERE, AND WHAT WAS NOT ═════════════════════════════════════════════
--
-- `away_responders` has existed since 0010 and `PUT /away-responder` has been writing rows into
-- it for as long. Nothing has ever read them. No process anywhere in this system has sent a
-- single automatic reply: the table stored a stated intention and the intention had no effect.
--
-- This migration is the schema half of making it real, and it is two things — WHO may be
-- answered, and the record that stops a sender being answered twice.
--
-- ══ `audience` — WHO GETS ONE, AND WHY THE DEFAULT IS THE NARROW ONE ═════════════════════
--
--   screened_in  (DEFAULT) only a sender already past the Screener. A message still HELD in
--                `ohmail/Screener` is not answered.
--   everyone     every sender that clears the suppression guards, including a first-contact
--                stranger waiting in the Screener.
--
-- The Screener is a consent gate and it runs in both directions. A stranger who has not been
-- admitted has been told nothing about this account; an away reply tells them the address is
-- live, read by a person, and that the person is somewhere else this week. That is a disclosure,
-- and the default may not make it on somebody's behalf. `everyone` is a deliberate choice
-- somebody makes in Settings.
--
-- NOT NULL with a DEFAULT rather than a nullable column. Every `account_settings` flag on this
-- schema is a nullable timestamp because "absent" has an honest reading there — the feature is
-- off. Here there is no off: a responder that is enabled is answering SOMEBODY, so an absent
-- value would have to be silently read as one of the two members, and a reader that guessed
-- differently from the writer would widen an audience nobody widened. The DEFAULT writes the
-- narrow member into every existing row, which is the same audience those rows have had for
-- their whole lives (nothing has ever read them, so the honest description of the past is "no
-- reply was sent to anyone").
--
-- The CHECK is closed, on `mailboxes_sync_blocked_reason_closed`'s rule: a member nobody
-- enumerated is a member no reader handles, and here an unhandled member would be resolved by
-- whichever branch the code falls through to. Dropped-then-added so a journal replay is
-- re-runnable, the shape `0007_staff_users` established.
--
-- ══ `away_responder_sent` — THE AT-MOST-ONCE RECORD ══════════════════════════════════════
--
-- One row per `(account_id, sender, responder_updated_at)`, and
-- `away_responder_sent_episode_uq` is not bookkeeping: it IS the guard. The claim is
--
--     INSERT … ON CONFLICT DO NOTHING RETURNING id
--
-- so two workers racing the same sender both attempt it, exactly one gets a row back, and the
-- loser sends nothing. No `SELECT … FOR UPDATE` and no read-then-write window — the unique index
-- is the mutual exclusion, which is the one form of it a refactor cannot delete by accident.
--
-- `responder_updated_at` IS THE EPISODE KEY, and the alternatives were worse. A boolean
-- "already replied" column on some other table cannot express "once per enablement": somebody
-- returns, turns the responder off, travels again next month, and every correspondent from the
-- first trip is permanently silenced. The responder row's own `updated_at` moves on every PUT,
-- so turning it on again starts a new episode and each sender may be answered once more.
--
-- The consequence, stated because it is a real one: ANY edit is a new episode, including fixing
-- a typo in the body mid-trip. Somebody who does that may answer an earlier correspondent a
-- second time. That is the deliberate trade — every key that avoids it (a separate `enabled_at`,
-- a nullable episode id) reintroduces the permanent-silence failure the moment two columns
-- disagree, and being answered twice is recoverable where never being answered is not.
--
-- `sender` is `lower(from_address)`, the envelope author and never a display name.
--
-- ══ THE ROW IS WRITTEN BEFORE THE SEND, NOT AFTER — SAME ARGUMENT AS 0032 ════════════════
--
-- SMTP is not transactional, so the choice is at-most-once or at-least-once and there is no
-- third option. Claiming first makes a crash between the claim and the send cost ONE unsent
-- reply. Claiming after would make it a DUPLICATE reply to a stranger, again on every re-run.
-- A missed away reply costs one correspondent one notification they can live without; a
-- duplicated one is mail sent in somebody's name that they did not send, which is the one act
-- this product promises never to perform. Recovering a stuck claim is an operator deleting one row.
--
-- ══ NO FOREIGN KEYS, AND THAT IS A DECISION ══════════════════════════════════════════════
--
-- `message_id` is EVIDENCE — which message triggered the reply — and it deliberately does not
-- reference `messages`. The record has to outlive the message: an expunge, a `uidvalidity`
-- reset or a re-ingest must not un-answer a sender, and with an FK the delete would either fail
-- or cascade the record away and let the pass reply again. `account_id` carries no FK for the
-- same reason `snippets` and `notify_rules` carry none — deletion order is explicit in
-- `account-deletion-service.ts`, where it is counted and audited.
--
-- That makes `AccountDeletionService` responsible for this table, and the catalog sweep in
-- `account-deletion.test.ts` enforces it: the sweep enumerates every table with an `account_id`
-- column and fails if any row survives erasure, so a table added here without a drop is a red
-- test rather than personal data that quietly outlives an account. `sender` is somebody's email
-- address; it must go when the account does.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════
--
-- Additive: one column with a default, one CHECK, one new table, one unique index, one plain
-- index, and NO data statement. Every existing row stays valid.
--
-- The statement that must never appear here is `UPDATE away_responders SET audience =
-- 'everyone'` — or, more plausibly, an INSERT seeding `away_responder_sent` rows for mail
-- already on disk. The second one looks like caution (it would suppress a burst of replies on
-- the first cycle after deploy) and is actually a decision about thousands of correspondents
-- taken inside a schema change where nobody would see it. The pass needs no such seed: it only
-- ever considers messages INGESTED AFTER the current episode began, so mail that arrived before
-- the responder was configured is not a candidate at all.
--
-- Deploy order is MIGRATION → API → WORKER. `AwayResponderService` selects whole rows through
-- the drizzle schema, so an API deployed ahead of this answers Postgres 42703 on both
-- `/away-responder` endpoints; `["away_responders","audience"]` therefore joins
-- `MAIL_SCHEMA_MARKERS` and `MAIL_SCHEMA_MARKER_JOURNAL_TAG` moves to this tag in the same diff,
-- so that mistake reports `503 schema_incomplete` naming this migration instead of a 500 nobody
-- can attribute. The worker is third because its pass reads the responder row AND writes
-- `away_responder_sent`: a worker ahead of the migration throws 42P01 inside the pass, which its
-- own try/catch logs and swallows, so the failure is safe (no reply is sent) but silent —
-- which is exactly the ordering to get right rather than to rely on.
--
-- ROLLBACK: `DROP TABLE "away_responder_sent";` loses the record of every reply already sent, so
-- a re-created table would answer every one of those senders again. It is a decision about
-- outbound mail, not a retry. Dropping `audience` is safe in the other direction — the pass
-- resolves an absent audience to nothing at all, because the column is NOT NULL and its absence
-- makes the whole row unreadable, so no reply is sent.

ALTER TABLE "away_responders" ADD COLUMN IF NOT EXISTS "audience" text DEFAULT 'screened_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "away_responders" DROP CONSTRAINT IF EXISTS "away_responders_audience_closed";--> statement-breakpoint
ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_audience_closed" CHECK ("audience" in ('screened_in','everyone'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "away_responder_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"responder_updated_at" timestamp with time zone NOT NULL,
	"message_id" uuid,
	"minted_message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "away_responder_sent_episode_uq" ON "away_responder_sent" USING btree ("account_id","sender","responder_updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "away_responder_sent_account_idx" ON "away_responder_sent" USING btree ("account_id");
