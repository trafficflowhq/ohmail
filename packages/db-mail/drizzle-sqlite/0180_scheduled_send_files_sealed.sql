-- 0180_scheduled_send_files_sealed — the pg twins: a sealed piece's wrapped key and its ring version.
-- A device's rows stay plain, so both stay NULL here.

ALTER TABLE "scheduled_send_files" ADD COLUMN "dek_enc" text;--> statement-breakpoint
ALTER TABLE "scheduled_send_files" ADD COLUMN "dek_key_version" integer;
