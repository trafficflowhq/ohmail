-- 0038_account_isolation — the Cloud half of the composite account keys (mail 0118 is the other).
--
-- `push_subscriptions.device_id` and `auth_events.user_id` carried a parent id with no key at all,
-- so the parent was not even guaranteed to exist. Both get the composite key, which proves the
-- parent exists AND that it is this account's. `auth_events` keeps both columns nullable: an event
-- can precede an account, and an attempt can name an address no user has. MATCH SIMPLE bites only
-- when both are present, which is the only state in which they can disagree.
--
-- The four UPDATEs come first and are idempotent: an erasure leaves audit rows pointing at a
-- parent that no longer exists, and a key cannot be added over one. The row survives with its ids
-- nulled — an audit trail is worth keeping, a dangling pointer is not.
--
-- `push_subscriptions` is repaired the same way and for its own reason: `device_id` is whatever
-- the registering request sent when the session named no device, so it can name no device at all
-- or one of another account. Such a row is ALREADY unreachable by every device-scoped prune, so
-- nulling costs no handle that existed, and nothing on the wake path reads the column — while the
-- row itself is a live endpoint a person's device owns, which a DELETE would silence for nothing.

UPDATE "auth_events" SET "user_id" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "auth_events"."user_id");--> statement-breakpoint
UPDATE "auth_events" SET "account_id" = NULL WHERE "account_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "accounts" a WHERE a."id" = "auth_events"."account_id");--> statement-breakpoint
UPDATE "webauthn_challenges" SET "user_id" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "webauthn_challenges"."user_id");--> statement-breakpoint
UPDATE "push_subscriptions" SET "device_id" = NULL WHERE "device_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "devices" d WHERE d."id" = "push_subscriptions"."device_id" AND d."account_id" = "push_subscriptions"."account_id");--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id");--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_account_fk" FOREIGN KEY ("device_id", "account_id") REFERENCES "devices" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFERENCES "users" ("id", "account_id");
