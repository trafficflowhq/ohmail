-- 0211_cal_calendars_default_leaves — which calendar new events go to is kept in one place.
--
-- `cal_calendars.is_default` (0205) was a second store for what the account's calendar settings
-- say with `cal_settings.new_events_calendar_id`. Nothing ever wrote it: every row holds the
-- column's own default, false, so no row loses a word by its going. The settings' column is the
-- one store for that fact, and a calendar's record, the account export and a desktop's copy stop
-- carrying the member with it.
-- Idempotent (IF EXISTS): a desktop engine replays this journal at launch.
-- ROLLBACK is `ALTER TABLE "cal_calendars" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL`,
-- which restores every row as it read; put the reading code back first.

ALTER TABLE "cal_calendars" DROP COLUMN IF EXISTS "is_default";
