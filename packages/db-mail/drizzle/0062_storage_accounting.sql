-- STORAGE ACCOUNTING — the managed storage cap's two facts: how many stored-body
-- bytes an account holds, and which body rows hold no content BECAUSE the account was at cap.
--
-- ══ THE SEMANTICS THIS SCHEMA SERVES ═════════════════════════════════════════════════════════
--
-- At cap, ingest stops STORING new message bodies in the hosted Postgres store and changes
-- nothing else: the message row (with its real snippet), the attachment metadata, the thread,
-- the delta feed, the folder move, the Screener verdict all land exactly as below cap, and the
-- mail on the IMAP server — the master — is untouched. Nothing existing is ever deleted; a
-- billing state must never destroy user data. Enforcement reads the cap from the subscription
-- row's sold-at `storage_bytes_limit` (cloud 0019); on desktop and self-host no cap is wired
-- and this table is only bookkeeping.
--
-- ══ WHY THIS IS IN THE MAIL JOURNAL ══════════════════════════════════════════════════════════
--
-- The bytes it counts are `message_bodies` bytes, a mail-schema table present on every tier.
-- The CAP is a Cloud fact and stays in the Cloud schema; what the local journals gain here is
-- inert bookkeeping, exactly as `messages.auth_verdict` is inert where nothing demotes.
--
-- ══ ACCOUNT_STORAGE ══════════════════════════════════════════════════════════════════════════
--
-- One row per account: `octet_length(text) + octet_length(html)` summed over its body rows.
-- Maintained in the SAME transaction as every body write (the ingest reserve, the repair
-- passes' clamped deltas, account deletion drops the row), so the counter cannot describe a
-- state the table is not in. What deliberately does NOT count: `headers` (still written at
-- cap — the organizing passes read stored headers, and counting undeclinable bytes would grow
-- a number the user cannot act on), snippets, drafts, attachment metadata (attachment bytes
-- are never stored server-side), the transient outbound staging (its own quota), and the
-- derived `body_tsv`.
--
-- `bytes` is bigint (an ordinary mailbox outruns int4 at 2 GiB) and `CHECK (bytes >= 0)` is
-- the floor of last resort: every app-side decrement is written `GREATEST(0, …)`, and even a
-- future bug that bypasses them cannot COMMIT a negative count.
CREATE TABLE IF NOT EXISTS "account_storage" (
  "account_id" uuid PRIMARY KEY,
  "bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "account_storage_bytes_nonneg" CHECK ("bytes" >= 0)
);
--> statement-breakpoint

-- ══ THE WITHHELD MARKER ══════════════════════════════════════════════════════════════════════
--
-- NULL on every ordinarily stored body. `'storage_cap'` marks a row ingest wrote WITHOUT
-- content — `text = ''`, `html` NULL, the real `headers` kept (unsubscribe/screener/consent/
-- away all read stored headers; declining them would silently break organizing on exactly the
-- mail the cap touches) — because the account was at its cap when the message arrived.
--
-- A marker column and not "no row", three times over:
--  · no-row is indistinguishable from "not yet mirrored", so the sidecar's gap query would
--    re-ask the ids forever;
--  · the DTO must be able to say WHY the text is empty — an empty body the client reports as
--    complete is the dishonesty this column ends;
--  · a future ratified restore (after an upgrade frees headroom) is then an UPDATE in place,
--    in `redacted-restore.ts`'s exact worker shape, predicated on this column.
-- The repair passes that re-fetch bodies from IMAP skip non-NULL rows: they repair damage,
-- and a withheld row is policy, not damage.
--
-- The CHECK closes the value set the way `plan`/`status` CHECKs do: a reader can never
-- mis-classify a row, and a second reason is a deliberate migration rather than a typo.
ALTER TABLE "message_bodies" ADD COLUMN IF NOT EXISTS "withheld_reason" text;
--> statement-breakpoint
ALTER TABLE "message_bodies" DROP CONSTRAINT IF EXISTS "message_bodies_withheld_reason";
--> statement-breakpoint
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_withheld_reason"
  CHECK ("withheld_reason" IS NULL OR "withheld_reason" IN ('storage_cap'));
--> statement-breakpoint

-- ══ THE BACKFILL, RE-RUNNABLE BY DESIGN ══════════════════════════════════════════════════════
--
-- `ON CONFLICT … DO UPDATE SET bytes = excluded.bytes` rather than DO NOTHING, deliberately:
-- between this migration running on prod (BEFORE the api alias, per the runbook) and the new
-- worker going live, the OLD worker keeps ingesting uncounted bodies — so the deploy runbook
-- re-runs exactly this statement once after the worker deploy, and the re-run RECOMPUTES
-- instead of preserving the drifted value. Idempotent at any moment: the sum is derived from
-- the tables themselves.
--
-- The join goes through `messages` because `message_bodies` carries no `account_id` — the same
-- ownership path every body read proves. O(message_bodies), once, at today's hosted scale a
-- few tens of thousands of rows; local stores are smaller still.
INSERT INTO "account_storage" ("account_id", "bytes")
SELECT m."account_id",
       COALESCE(SUM(octet_length(b."text") + COALESCE(octet_length(b."html"), 0)), 0)
  FROM "message_bodies" b
  JOIN "messages" m ON m."id" = b."message_id"
 GROUP BY m."account_id"
ON CONFLICT ("account_id") DO UPDATE SET "bytes" = excluded."bytes", "updated_at" = now();
