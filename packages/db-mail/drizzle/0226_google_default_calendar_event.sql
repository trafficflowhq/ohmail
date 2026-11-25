ALTER TABLE "cal_events" ADD COLUMN "google_default_event" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "cal_calendars" AS calendars
SET "sync_token" = NULL
FROM "cal_connections" AS connections
WHERE calendars."connection_id" = connections."id"
  AND calendars."account_id" = connections."account_id"
  AND connections."provider" = 'google'
  AND calendars."sync_token" IS NOT NULL;
