-- Availability identities stay consistent as individual occurrences arrive, move, or disappear.
-- The random default also gives each existing calendar its own private key.
-- Rollback after restoring the previous reader: ALTER TABLE "cal_calendars" DROP COLUMN "availability_key".
ALTER TABLE "cal_calendars" ADD COLUMN IF NOT EXISTS "availability_key" uuid DEFAULT gen_random_uuid() NOT NULL;
