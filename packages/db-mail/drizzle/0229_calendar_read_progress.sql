ALTER TABLE "cal_calendars" ADD COLUMN IF NOT EXISTS "read_checkpoint" text;
--> statement-breakpoint
ALTER TABLE "cal_events" ADD COLUMN IF NOT EXISTS "seen_in_reading" uuid;
