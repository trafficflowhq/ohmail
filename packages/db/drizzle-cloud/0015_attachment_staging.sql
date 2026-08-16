-- ATTACHMENT STAGING — the row half of the hosted send's direct-upload transport.
--
-- ══ WHY THIS TABLE EXISTS ═════════════════════════════════════════════════════════════════
--
-- Attachment bytes used to ride the send request base64-encoded. That put the whole feature under
-- the hosted platform's ~4.5 MB request-body limit and forced the compose surface to promise 3 MB
-- of raw bytes whatever the sender's own submission server announced — so a mailbox that accepts
-- 25 MB was told 3, in the one place a user reads a promise. The bytes now go from the browser to
-- object storage on a signed URL and the send carries a REFERENCE.
--
-- A row here is that reference. It is what makes an upload ticket account-scoped, size-bounded and
-- expiring, none of which an opaque object path in a request body would be.
--
-- ══ WHY THE CLOUD JOURNAL AND NOT THE MAIL ONE ════════════════════════════════════════════
--
-- Staging is a property of the HOSTED transport, exactly as `account_suspensions` is a property of
-- the hosted operations surface. A local install runs its send handler in the same process as its
-- own SMTP dial: there is no request body between the compose form and the wire, so there is
-- nothing to stage around, and there is no object storage for it to stage into. Putting this in
-- the mail journal would create, in every desktop database, a table nothing on that install can
-- ever write a row into.
--
-- The FK to `accounts` runs CLOUD → MAIL, which is the legal direction (`schema-cloud.ts`'s
-- header: mail runs first, so `accounts` exists in every database that has this half). No
-- statement here performs DDL on a shared object.
--
-- ══ `object_path` IS UNIQUE BECAUSE IT IS THE DELETE KEY ══════════════════════════════════
--
-- The retention sweep removes the object and then the row, as a pair. Two rows naming one object
-- would leave a live row pointing at bytes another row's expiry already deleted — a send that
-- reads a ticket, finds nothing, and refuses a message whose file was there an hour ago. The
-- constraint makes that unrepresentable rather than unlikely.
--
-- ══ `size_bytes` IS A DECLARATION, NOT A MEASUREMENT ══════════════════════════════════════
--
-- It is the size the MINT was asked for and refused against — the client's own number. It is
-- stored because the send re-checks the declared TOTAL before it downloads anything: refusing 40 MB
-- of tickets costs one query, while discovering the same fact after the transfer costs the
-- transfer. The bytes are measured again after download, and an object larger than its ticket
-- declared ends the send; that second check is the one the cap is really enforced by, because the
-- first is enforced against a number the client chose.
--
-- ══ THERE IS NO `consumed_at`, AND THAT IS DELIBERATE ═════════════════════════════════════
--
-- A send does not consume a ticket. It reads the bytes and leaves the row to expire, because a
-- send that failed mid-flight and is retried under the same `Idempotency-Key` must find the same
-- bytes still there — `outbound_sends` replays an outcome, it does not re-ask the client for
-- files. Retention, not consumption, is what ends a staging row's life. That is also why the TTL
-- is 24 hours: the same window `idempotency_keys` already promises, because these are the bytes a
-- retry inside that window needs.
--
-- ══ WHAT THIS MIGRATION DOES NOT DO ═══════════════════════════════════════════════════════
--
-- It does not create the BUCKET. Object storage is not a database object and no SQL statement can
-- reach it. The bucket must exist, be PRIVATE (no public read, no anonymous or anon-key policy),
-- and be reachable only by the service-role credential the API and the worker hold, BEFORE the
-- API deploy that mints its first grant. See the deploy notes in the slice report: a mint against
-- a missing bucket answers 201 and the browser's upload then fails, which is a failure one step
-- removed from its cause.

CREATE TABLE IF NOT EXISTS "attachment_staging" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "public"."accounts"("id"),
  "object_path" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- The delete key. See the header: two rows naming one object is the state that turns one row's
-- expiry into another row's missing file.
CREATE UNIQUE INDEX IF NOT EXISTS "attachment_staging_object_path_unique" ON "attachment_staging" ("object_path");
--> statement-breakpoint
-- Every read is `WHERE account_id = $1 AND id = ANY($2)`. The PK alone would serve the second
-- half; this is what keeps the first half from being a filter applied after the fact.
CREATE INDEX IF NOT EXISTS "attachment_staging_account_idx" ON "attachment_staging" ("account_id");
--> statement-breakpoint
-- The sweep's whole predicate (`expires_at <= now()`, oldest first, bounded). Without it the
-- hourly maintenance pass seq-scans a table whose size is proportional to a day of sends.
CREATE INDEX IF NOT EXISTS "attachment_staging_expires_idx" ON "attachment_staging" ("expires_at");
