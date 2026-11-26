ALTER TABLE "mailbox_folders" ADD COLUMN IF NOT EXISTS "scan_next_uid" bigint,
  ADD COLUMN IF NOT EXISTS "scan_reset_after" text;
