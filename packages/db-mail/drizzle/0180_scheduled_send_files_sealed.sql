-- 0180_scheduled_send_files_sealed — a server keeps a scheduled letter's files sealed.
--
-- `dek_enc` + `dek_key_version`: the piece's own AES-256-GCM key, wrapped by the key ring exactly as
-- a mailbox password is, and the ring version that wrapped it. Both NULL is a plain row (the
-- desktop's store, unchanged); both set is a sealed row, whose `raw_b64` is then
-- base64(12-byte IV, ciphertext, 16-byte tag) of one piece of at most 3 MiB, bound to its account,
-- draft, file and piece. A registered key site (`WRAPPED_SECRET_SITES`), so a rotation re-wraps the
-- piece keys and a retirement counts them. Written by Cloud and self-host
-- (`POST /drafts/:id/schedule-with-files`) at most seven days ahead; deleted when the appointment ends.
--
-- The pair is one fact, so a CHECK holds it together: a key without its version cannot be opened,
-- and the re-wrap census counts such a row as a defect rather than repairing it.
--
-- LOCK-WAIT: catalog-only ALTERs (nullable, no default) and a CHECK whose validation reads
-- `scheduled_send_files`, which holds no rows on a server before this. No drafts, mailboxes or rules
-- ALTER.
-- DEPLOY ORDER: migration, then API, then worker, then web.
-- ROLLBACK: revert the code (a server then answers the files route 404 and keeps no files), close every
-- `scheduled` draft with send_files > 0, then DROP CONSTRAINT IF EXISTS
-- "scheduled_send_files_dek_sealed_together", DROP COLUMN IF EXISTS "dek_key_version" and DROP COLUMN IF
-- EXISTS "dek_enc" on "scheduled_send_files", each in its own transaction.

ALTER TABLE "scheduled_send_files" ADD COLUMN IF NOT EXISTS "dek_enc" text;--> statement-breakpoint
ALTER TABLE "scheduled_send_files" ADD COLUMN IF NOT EXISTS "dek_key_version" integer;--> statement-breakpoint
ALTER TABLE "scheduled_send_files" DROP CONSTRAINT IF EXISTS "scheduled_send_files_dek_sealed_together";--> statement-breakpoint
ALTER TABLE "scheduled_send_files" ADD CONSTRAINT "scheduled_send_files_dek_sealed_together"
  CHECK (("dek_enc" IS NULL) = ("dek_key_version" IS NULL));
