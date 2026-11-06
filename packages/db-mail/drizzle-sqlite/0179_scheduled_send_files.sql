-- 0179_scheduled_send_files — the pg twins: a scheduled letter's file count on drafts (appended last)
-- and its files, one row per 4 MiB piece. Integer epoch ms for the instant; no foreign key.

ALTER TABLE "drafts" ADD COLUMN "send_files" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_send_files" (
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "draft_id" text NOT NULL,
  "send_key" text NOT NULL,
  "file_no" integer NOT NULL,
  "seq" integer NOT NULL DEFAULT 0,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_sha256" text NOT NULL,
  "raw_b64" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "scheduled_send_files_account_id_draft_id_file_no_seq_pk" PRIMARY KEY ("account_id", "draft_id", "file_no", "seq"),
  CONSTRAINT "scheduled_send_files_sha256_hex" CHECK (length("content_sha256") = 64 AND "content_sha256" NOT GLOB '*[^0-9a-f]*')
);
