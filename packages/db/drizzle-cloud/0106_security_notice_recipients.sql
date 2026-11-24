ALTER TABLE "auth_throttle" ADD COLUMN IF NOT EXISTS "notice_account_id" uuid, ADD COLUMN IF NOT EXISTS "notice_user_id" uuid;
