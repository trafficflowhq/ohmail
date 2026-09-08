-- A HELD SEND GETS AN ANSWER, AND A FINISHED ONE STOPS HOLDING THE DRAFT.
--
--   outbound_sends.resolved_by  text        NULL   -- who settled an ambiguous attempt ('person')
--   outbound_sends.resolved_at  timestamptz NULL   -- when they settled it
--   outbound_sends.draft_id            -> NULLABLE, ON DELETE SET NULL
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════════════════
--
-- A send whose outcome could not be confirmed ends at `outbound_sends.status = 'unverified'` with
-- the draft at `drafts.status = 'unverified'` (`SendService.finalizeUnverified`). The Drafts row
-- then reads "Not confirmed — it may not have been delivered. It's held here; check your Sent
-- folder", and until now there was no verb anywhere in the product for answering that sentence.
-- Discard could not answer it either: `DraftsService.remove` refused for ANY `outbound_sends` row.
-- The row was unremovable by the front door and the back one, permanently: pressing Discard could
-- not succeed once, however many times it was pressed.
--
-- The same refusal also caught a case that is not ambiguous at all. `finalizeFailed` records a
-- definitively-undelivered attempt and returns the draft to `draft` with a sentence: nothing is in
-- flight, nothing is unknown, and the delete was refused anyway — because the predicate asked
-- whether a ROW EXISTED rather than whether a send was still on record.
--
-- ══ THE RESOLUTION COLUMNS ═══════════════════════════════════════════════════════════════════
--
-- `resolved_by` is WHO decided, and it exists because the decision is not the same kind of fact as
-- the outcome. `status` says what became of the attempt; `resolved_by` says that a PERSON said so
-- rather than the machine observing it. A send finalized by the reconciler and one a reader
-- resolved by looking in their Sent folder both end at `sent`, and a later reader of this table
-- has to be able to tell those apart — the first is evidence, the second is testimony.
--
-- Free text rather than CHECK-constrained, for `mailboxes.organized_by_capabilities`'s reason: the
-- only value any build writes today is the literal `'person'`, and a closed set would make the
-- first other resolver (a probe that finds the message in Sent, say) an unwritable row on the day
-- it ships. Tainted rather than trusted, so the operator-console content census PROVES no staff
-- surface echoes it instead of this file asserting it: that census writes a marker into every
-- free-text column of every seeded table and then reads every staff response back looking for it,
-- and it pins the number of columns it swept — so a column added here without a decision about it
-- fails the count rather than passing unnoticed. This column's review is recorded with that pin.
--
-- NOT granted to `ohmail_admin`. The role's grant on this table is COLUMN-scoped to
-- `(id, account_id, status, created_at)` for the stuck-send queue (`scripts/harden-staff-role.sql`),
-- and no staff surface reads a resolution — so both new columns stay outside the grant
-- deliberately. If a console panel ever renders who resolved a send, that grant is the edit and
-- the census is what fails first.
--
-- `resolved_at` is a timestamptz and can carry nobody's words, so it is not in the census at all.
--
-- ══ AND THE FOREIGN KEY, WHICH IS THE HALF THAT MADE THE DISCARD IMPOSSIBLE ══════════════════
--
-- Narrowing the service predicate could not have admitted the delete on its own, and this is worth
-- writing down precisely because the 409 looked like a policy and was not.
--
-- `draft_id` was `NOT NULL … ON DELETE NO ACTION` (mail 0013). Measured against this database
-- before the change: `DELETE FROM drafts` for a draft carrying one `outbound_sends` row raised
-- `23503 outbound_sends_draft_id_drafts_id_fk` for a `failed`, a `sent` AND an `unverified` row
-- alike. Not being a `ServiceError`, that reaches a caller as `internal` 500 — which is exactly
-- what `remove` used to answer, and exactly why the named 409 was put in front of it. Narrowing
-- the predicate without touching the constraint would have turned the honest refusal back into the
-- fault it replaced.
--
-- So the reference becomes nullable and clears itself: `ON DELETE SET NULL`. THE LEDGER ROW
-- SURVIVES. Its identity — and the whole reason it outlives every terminal outcome — is
-- `UNIQUE(account_id, idempotency_key)`, the replay gate that makes a same-key retry replay
-- instead of delivering a second copy. That gate does not mention `draft_id`. What the column
-- holds is which draft the attempt was ABOUT, and when a person discards the text, that is the
-- stated intent: the words go, the fact that something was attempted does not.
--
-- NOT `ON DELETE CASCADE`, which would take the reservation with the draft and hand the next press
-- of the same key a clean slate for a message that may already be in somebody's inbox.
--
-- NOT a soft-delete marker on `drafts` either. That was considered and refused: it makes every
-- reader of the table responsible for remembering a filter, and the first one that forgets shows a
-- discarded message back to its author.
--
-- A `pending` row can never be orphaned this way, and that is by construction rather than by
-- hope: `pending` is inside `sendOnRecord`, so `remove` refuses while one exists, and it refuses
-- under a `FOR UPDATE` on the draft row that serializes against the `FOR KEY SHARE` the
-- reservation's own INSERT takes. Either the reserve commits first and the delete answers 409, or
-- the delete commits first and the reserve finds no draft (404). This matters because
-- `send-reconcile-pass.ts` reaches its rows through `INNER JOIN drafts`, so a NULL `draft_id`
-- would be invisible to the reconciler and to the stuck-send alarm — a `pending` row nobody would
-- ever drain. Unreachable, and named here so it stays that way.
--
-- Additive and nullable, no defaults, NO backfill: every existing row keeps the draft it names and
-- resolves to NULL/NULL, which is the truth — nobody has resolved anything before this exists.

ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "resolved_by" text;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ALTER COLUMN "draft_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "outbound_sends" DROP CONSTRAINT IF EXISTS "outbound_sends_draft_id_drafts_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
