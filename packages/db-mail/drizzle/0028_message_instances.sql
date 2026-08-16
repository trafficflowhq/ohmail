-- PHYSICAL IDENTITY, THE ATTACHMENT CONTENT DIGEST, AND SLICE 3's VERDICT COLUMN.
--
-- The consent boundary: what a message instance may carry across accounts, and what it may not.
-- ADDITIVE ONLY: one new table, two new nullable columns, and one INSERT…SELECT that copies a
-- locator verbatim. Nothing is dropped, nothing is rewritten, and no constraint moves.
--
-- ══ WHAT THIS FIXES, AND WHY IT NEEDED SCHEMA ════════════════════════════════════════════
--
-- One string answered three different questions: is this the SAME LOGICAL MESSAGE, WHICH BYTES ON
-- THE SERVER is it, and DID THE USER MOVE IT. `messages.dedup_key` was the first,
-- `messages.native_locator` was the second, and the third was inferred from the second. That
-- inference is the defect:
--
--   `classifyDedup` answered `external_move` — "the user moved this, the user wins" — for ANY
--   observation of a known logical identity in a folder we did not record. A pure CREATE is such
--   an observation. So a stranger who sends the same message twice caused ohmail to adopt the
--   placement of their second delivery, and the second message escaped the Screener on the
--   strength of the first. First contact held for your consent is the founding premise of the
--   product, and two deliveries and a wait defeated it.
--
-- The discriminator needs no cryptography: **a sender can only cause a locator to APPEAR; only the
-- user (or a client they own) can cause a stored locator to DISAPPEAR.** Adoption requires a
-- disappearance. Expressing that needs somewhere to record the locators a message occupies and
-- somewhere to notice one going away — hence `message_instances`.
--
-- ══ `message_instances` — THE THREE CONSTRAINTS ARE THE MODEL ═════════════════════════════
--
--   UNIQUE (mailbox_id, folder, uidvalidity, uid)
--       One UID inside one server epoch is ONE place. `uidvalidity` is IN the key because a UID
--       number is meaningless outside the epoch that issued it: a folder that resets commonly
--       re-allocates from low numbers, and treating a reused number as already-known means the new
--       message's body is never fetched and the cursor is then persisted past it — permanently.
--       (That exact bug was found one layer up, by an earlier security review.)
--
--   UNIQUE (message_id) WHERE is_primary
--       Exactly one of a message's instances is the one `messages.native_locator` mirrors and the
--       one `adapter.move` acts on. PARTIAL, because a non-partial unique on `message_id` would
--       refuse the second instance this whole table exists to hold. A partial unique index is
--       precisely the kind of object PGlite can mislead you about, so it is asserted against real
--       Postgres, and pinned line-for-line by
--       the journal's own real-Postgres test.
--
--   INDEX (message_id)
--       Every read is by message: the primary lookup, the vanished-primary probe, the join in
--       `listKnownLocators`.
--
-- A row's EXISTENCE means "this locator is on the server". There is deliberately no `absent`
-- column: absence is the row being gone, and the delete is performed only by the worker consuming
-- the adapter's `deletes`, and only when the folder's epoch matches what the server just reported.
-- On a UIDVALIDITY change all evidence is void — re-establish, never adopt.
--
-- ══ THE BACKFILL IS SAFE **BECAUSE IT COPIES A LOCATOR VERBATIM** ════════════════════════
--
-- This is the one data statement here and the distinction it rests on is the whole reason the
-- ruling permits it while PROHIBITING a fingerprint backfill in the same breath.
--
-- It reads `messages.native_locator` — a value ingest itself wrote, unchanged — and re-states it
-- in columns. It computes nothing. A FINGERPRINT backfill would compute, and it would compute a
-- DIFFERENT answer than ingest does for the same message: `message_bodies.text` is redacted for
-- sensitive mail, which is stored redacted by design, `html` has been through
-- `prepareHtmlForStorage` and a 256 KiB cap,
-- `attachments` has no content digest before this migration, and `messages.to_addresses` is NEVER
-- WRITTEN. Every row such a job touched would carry a key ingest cannot reproduce, so the first
-- re-observation of that mail would insert a SECOND `messages` row — which no delta ever removes
-- (the delta stream is append-only per account) — and mint a second `threads` row with it,
-- because the re-entry guard in
-- `pipeline.ts` is `stored.thread_id` and a brand-new row has none. The key format therefore
-- migrates at READ time, per message, on the one path that holds the raw bytes: the dual-key
-- lookup in `planChange`. `dedup_key NOT LIKE 'fp1:%'` is its progress query, and it only ever
-- decreases.
--
-- Two mechanical notes on the SELECT, both of which keep it total rather than clever:
--
--   · `ref` is `'<uidvalidity>:<uid>'`, written by `makeRef`. A ref that does not match that shape
--     cannot be cast, so it lands as `0`/`0` rather than being SKIPPED — which keeps the row count
--     exactly equal to the `native_locator IS NOT NULL` count (an acceptance criterion), and epoch
--     `0` is already the sentinel `buildCursor` drops, so such an entry is simply re-enumerated.
--     Same outcome as the `parseUidValidity` fallback it replaces.
--   · `ON CONFLICT DO NOTHING` with NO target, so it covers both uniques. `openLocalDb` re-runs
--     both journals on every launch and any recovery from a `PartialMigrationError` replays this
--     file, by which time instances have legitimately moved; a bare INSERT would then fail on the
--     partial unique and take the whole migration with it.
--
-- ══ `attachments.content_sha256` ═════════════════════════════════════════════════════════
--
-- The attachment half of the fingerprint. Computed in `mime.ts#toAttachmentMeta`, where the decoded
-- bytes are already resident and were previously read for `.length` and thrown away — the only
-- moment it CAN be computed, because §13.2/§14 forbid persisting the bytes at all. Nullable and NOT
-- backfilled: for every existing row the bytes are gone and no digest can be invented. Without it,
-- two messages identical in every header and body but carrying DIFFERENT files of the same name,
-- type and size share one logical identity, and the second is filed as a duplicate and never shown.
--
-- ══ `messages.auth_verdict` — LANDED HERE ON PURPOSE, WRITTEN BY NOTHING YET ══════════════
--
-- Slice 3's column, added by slice 2's migration exactly as the ruling instructs, so that slice 3
-- needs no DDL, no second journal edit and no second deploy-ordering exercise for a feature whose
-- risk is entirely in the code. Nothing reads or writes it in this deploy.
--
-- When slice 3 wires it, the vocabulary is `aligned | signed_unaligned | unsigned | fail |
-- temperror | unavailable`, computed offline from the raw RFC822 bytes plus a DNS TXT lookup of the
-- DKIM selector — never from a header anyone wrote. **NULL resolves to the PERMISSIVE value**, and
-- that is a rule about consent rather than a convenience: every pre-slice row was already decided
-- under the old rules, and making a missing verdict fail closed would put previously-accepted
-- senders back in the Screener — the one outcome the acceptance criteria roll a deploy back for.
--
-- No CHECK, on 0023's rule: the set belongs to the code that computes it, and a new member must be
-- a code deploy, not a migration that has to land first.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════
--
-- Migration → API → worker, as always. `MailboxService`/`MessageService` select WHOLE ROWS through
-- the drizzle schema, so an API deployed ahead of this answers Postgres 42703 on every message
-- read; `["message_instances","is_primary"]` therefore joins `MAIL_SCHEMA_MARKERS` in
-- `packages/api/src/routes/health.ts`, which turns that into a `503 schema_incomplete` naming this
-- migration instead of a 500 nobody can attribute. Same reasoning, same shape, as 0023/0024/0027.
--
-- The WORKER is deliberately last: it is the only process that writes `message_instances` and the
-- only one that reads it back through `listKnownLocators`.
--
-- A worker binary that PREDATES this migration keeps working against the new schema — it reads
-- `native_locator` for the known-set and never touches the table — which is what makes the rollout
-- reversible in practice as well as on paper.
--
-- ROLLBACK is `DROP TABLE message_instances`, then `DROP COLUMN` on the two columns. The cost is
-- that the known-set falls back to one locator per message, so declined copies are re-fetched each
-- cycle again — a cost regression, not a data loss. `messages` is untouched by this migration apart
-- from gaining a nullable column, and `native_locator` remains the primary's mirror throughout,
-- which is what makes the drop safe.

CREATE TABLE IF NOT EXISTS "message_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"uid" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_instances_locator_uq" UNIQUE("mailbox_id","folder","uidvalidity","uid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_instances_primary_uq" ON "message_instances" USING btree ("message_id") WHERE "is_primary";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_instances_message_idx" ON "message_instances" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "content_sha256" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "auth_verdict" text;--> statement-breakpoint
INSERT INTO "message_instances" ("account_id", "mailbox_id", "message_id", "folder", "uidvalidity", "uid", "is_primary", "first_seen_at", "last_seen_at")
SELECT m."account_id", m."mailbox_id", m."id",
       coalesce(m."native_locator"->>'folder', ''),
       CASE WHEN m."native_locator"->>'ref' ~ '^[0-9]+:[0-9]+$' THEN (split_part(m."native_locator"->>'ref', ':', 1))::bigint ELSE 0 END,
       CASE WHEN m."native_locator"->>'ref' ~ '^[0-9]+:[0-9]+$' THEN (split_part(m."native_locator"->>'ref', ':', 2))::integer ELSE 0 END,
       true, m."created_at", m."updated_at"
  FROM "messages" m
 WHERE m."native_locator" IS NOT NULL
ON CONFLICT DO NOTHING;
