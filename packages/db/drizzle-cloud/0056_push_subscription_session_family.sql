-- A WAKE REGISTRATION NAMES THE SESSION FAMILY THAT MADE IT (cloud 0056). A browser's row carried no
-- device, so no revoke reached it: a browser signed out from Devices, by "Sign out everywhere", by a
-- password change or by another sign-in over its jar kept receiving wakes. The column is stamped from
-- the registering session (`push-service.ts`), and every revoke deletes the rows of the families it ends.
--
-- Nullable, no default, no foreign key: `sessions.family_id` is not unique, and a key to `sessions` would
-- lock the busiest table of the deploy. No staff grant.
--
-- EXISTING ROWS: a row with a device keeps it, so every device prune still reaches it, and takes a family
-- at its next registration. A row with neither can be tied to no session and is deleted: a signed-in
-- browser registers again on its next visit, bound.
--
-- LOCK-WAIT: the ALTER holds ACCESS EXCLUSIVE on `push_subscriptions` until the cloud pass commits; a
-- small table, and the column is metadata only. The only cloud migration of its release: the old API's
-- sign-outs take other auth tables before this one, so a second cloud ALTER in the pass can deadlock.
-- DEPLOY ORDER: migration, then the API straight after. Rows the old API writes in between stay unbound
-- until that browser's next visit. An API ahead of the migration answers /health 503 schema_incomplete.
-- ROLLBACK: the API, then `DROP INDEX "push_subscriptions_session_family_idx"` and
-- `ALTER TABLE "push_subscriptions" DROP COLUMN "session_family_id"`.

ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "session_family_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_session_family_idx" ON "push_subscriptions" ("session_family_id");--> statement-breakpoint
DELETE FROM "push_subscriptions" WHERE "session_family_id" IS NULL AND "device_id" IS NULL;
