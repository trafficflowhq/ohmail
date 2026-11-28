ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_scope_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_scope_check"
  CHECK ("scope" IN ('full', 'enrollment', 'calendar')) NOT VALID;
