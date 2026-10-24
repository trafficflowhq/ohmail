-- 0169_mailboxes_organized_through — the pg columns' twins (epoch ms).

ALTER TABLE "mailboxes" ADD COLUMN "organized_through" integer;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "held_elsewhere_until" integer;
