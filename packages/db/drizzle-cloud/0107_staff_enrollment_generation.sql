ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "enrollment_generation" uuid NOT NULL DEFAULT gen_random_uuid();
