-- 0183_outbound_sent_copies_staged_parts — a Cloud letter whose files are all uploads, owed to Sent without them.
--
-- `staged_parts` (piece 0, the row's only piece): `{"v":1,"sha256":…,"skeleton":…,"parts":[{"ticket":…,"at":…,"len":…}]}`,
-- the copy with each upload's encoded body cut out (base64), the whole delivered copy's sha256 and, for each upload,
-- where its body was cut. The late pass downloads the uploads again, splices them back and files the copy only when
-- the sha256 is the delivered one's. `files_until`: the uploads' earliest expiry; the row is deleted by then.
-- `files_next_attempt_at`: when the pass next tries it. Such a row's `raw_b64` is empty and its `next_attempt_at` is
-- 9999-12-31, so a build before this one, which reads neither new column, never takes it and deletes it once the
-- hold has passed. NULL on every existing row and on every row a letter without uploads writes: no default, no
-- backfill, no index.
--
-- Tables altered: outbound_sent_copies (three nullable columns). No other table is touched. No DML.
-- LOCK-WAIT: each ADD COLUMN takes a brief ACCESS EXCLUSIVE on outbound_sent_copies alone, no scan, no rewrite;
-- it waits for an open send's copy write or a late pass's claim, which hold it for one short transaction.
-- DEPLOY ORDER: migration, then API (the send door and the pass select the rows whole), then worker, then web.
-- The statements repeat safely.
-- ROLLBACK: revert the code (an older build leaves the rows this one kept alone and deletes them after the hold),
-- then, once no process of this build runs, delete the rows whose staged_parts is set and ALTER TABLE
-- "outbound_sent_copies" DROP COLUMN IF EXISTS "staged_parts", DROP COLUMN IF EXISTS "files_until",
-- DROP COLUMN IF EXISTS "files_next_attempt_at".

ALTER TABLE "outbound_sent_copies" ADD COLUMN IF NOT EXISTS "staged_parts" text;
--> statement-breakpoint
ALTER TABLE "outbound_sent_copies" ADD COLUMN IF NOT EXISTS "files_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbound_sent_copies" ADD COLUMN IF NOT EXISTS "files_next_attempt_at" timestamp with time zone;
