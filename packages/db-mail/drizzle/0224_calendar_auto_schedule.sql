ALTER TABLE "cal_calendars" ADD COLUMN IF NOT EXISTS "auto_schedule" boolean DEFAULT false NOT NULL;
