-- 0179_scheduled_send_files — a scheduled letter keeps its files until it is sent (desktop store).
--
-- `drafts.send_files`: how many files the appointment carries. Written by every schedule (0 for a
-- letter without files); while the appointment stands the pass sends only when it reads back exactly
-- that many files, and after an ending without delivery it stays as the mark that the files were not
-- kept. Every existing row reads 0, which is what it was.
-- `scheduled_send_files`: the files' bytes as base64 text, one row per 4 MiB piece (`seq` from 0),
-- each written once, keyed by the appointment's `send_key`, with each file's name, type, size and
-- sha-256. Only the local engine writes rows (the desktop's own store); a server answers the schedule
-- with files 404 and keeps none. No foreign key (0170's lock argument), no index beyond the primary
-- key (rows live only while an appointment stands); rows whose draft no longer carries their key are
-- swept by the local drain. Nothing granted to staff; MAIL content; erased with the mailbox and the
-- account.
-- LOCK-WAIT: the ALTER takes a brief ACCESS EXCLUSIVE on drafts, no scan (a constant default). The new
-- table has no foreign key and locks no live table. The only drafts/mailboxes/rules ALTER of its
-- release: beside another, the pass deadlocks (0170).
-- DEPLOY ORDER: migration, then API, then worker, then web (API and worker select drafts whole).
-- ROLLBACK: close every `scheduled` row with send_files > 0 first (none exist off the desktop), revert
-- the code, then DROP TABLE IF EXISTS "scheduled_send_files" and
-- ALTER TABLE "drafts" DROP COLUMN IF EXISTS "send_files", each in its own transaction.

ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "send_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_send_files" (
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "draft_id" uuid NOT NULL,
  "send_key" text NOT NULL,
  "file_no" integer NOT NULL,
  "seq" integer DEFAULT 0 NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_sha256" text NOT NULL,
  "raw_b64" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_send_files_account_id_draft_id_file_no_seq_pk" PRIMARY KEY ("account_id", "draft_id", "file_no", "seq"),
  CONSTRAINT "scheduled_send_files_sha256_hex" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$')
);
