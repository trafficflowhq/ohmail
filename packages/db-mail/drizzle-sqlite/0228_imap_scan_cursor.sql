ALTER TABLE "mailbox_folders" ADD COLUMN "scan_next_uid" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "scan_reset_after" text;
