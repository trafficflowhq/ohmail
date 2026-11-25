ALTER TABLE "cal_calendars" ADD COLUMN "local_color" text;
--> statement-breakpoint
ALTER TABLE "cal_connections" ADD COLUMN "organizer_addresses" jsonb;
