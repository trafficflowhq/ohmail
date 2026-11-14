-- THE ACCOUNT ON THE SEVEN SIGN-IN TABLES THAT BORROWED THE USER'S (cloud 0100). `credentials`,
-- `webauthn_credentials`, `totp_secrets`, `recovery_codes`, `oauth_auth_codes`, `login_tokens` and
-- `webauthn_challenges` named a user and no account, so "whose row is this" was a join through
-- `users`. Each carries `account_id` now, under a key onto `users (id, account_id)`
-- (`users_id_account_uq`, mail 0118), which replaces the single-column key it subsumes: a row can
-- no longer stand under a user of another account.
--
-- Where a unique or an index led with `user_id` it leads with the account. `login_tokens` and
-- `webauthn_challenges` may name no user (a desktop approval nobody confirmed yet; an assertion
-- ceremony that names a login token): there the account is known exactly when the user is, and a
-- CHECK holds the pair.
--
-- Servers only. Part of the 2.0 transition's window: applied once, by one transaction, on a store
-- nothing else writes to (`packages/db/src/transition/`). A store made from empty takes it as an
-- ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- Five tables: user_id is NOT NULL, so account_id is NOT NULL. Each: add, fill from the user, require,
-- the key onto (id, account_id), and the single-column key it subsumes goes.
-- @cloud_five_columns
ALTER TABLE "credentials" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "credentials" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "webauthn_credentials" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" DROP CONSTRAINT "webauthn_credentials_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "totp_secrets" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "totp_secrets" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "totp_secrets" DROP CONSTRAINT "totp_secrets_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "recovery_codes" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "recovery_codes" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "recovery_codes" DROP CONSTRAINT "recovery_codes_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "oauth_auth_codes" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" DROP CONSTRAINT "oauth_auth_codes_user_id_users_id_fk";
--> statement-breakpoint
-- The index that leads with the account. Where a unique on user_id exists it becomes (account_id, user_id).
-- @cloud_five_indexes
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_user_id_unique", ADD CONSTRAINT "credentials_account_user_unique" UNIQUE ("account_id","user_id");
--> statement-breakpoint
ALTER TABLE "totp_secrets" DROP CONSTRAINT "totp_secrets_user_id_unique", ADD CONSTRAINT "totp_secrets_account_user_unique" UNIQUE ("account_id","user_id");
--> statement-breakpoint
DROP INDEX "recovery_codes_user_idx";
--> statement-breakpoint
CREATE INDEX "recovery_codes_account_user_idx" ON "recovery_codes" USING btree ("account_id","user_id");
--> statement-breakpoint
DROP INDEX "webauthn_credentials_user_idx";
--> statement-breakpoint
CREATE INDEX "webauthn_credentials_account_user_idx" ON "webauthn_credentials" USING btree ("account_id","user_id");
--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_account_idx" ON "oauth_auth_codes" USING btree ("account_id");
--> statement-breakpoint
-- Two tables: user_id is NULLABLE by design (a desktop approval nobody confirmed yet; an assertion ceremony
-- that names a login token). The account is known exactly when the user is.
-- @login_tokens_account
ALTER TABLE "login_tokens" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "login_tokens" t SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = t."user_id";
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_account_iff_user" CHECK (("user_id" IS NULL) = ("account_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "login_tokens" DROP CONSTRAINT "login_tokens_user_id_users_id_fk";
--> statement-breakpoint
CREATE INDEX "login_tokens_account_idx" ON "login_tokens" USING btree ("account_id") WHERE ("account_id" IS NOT NULL);
--> statement-breakpoint
-- @webauthn_challenges_account
ALTER TABLE "webauthn_challenges" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "webauthn_challenges" c SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = c."user_id";
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_account_iff_user" CHECK (("user_id" IS NULL) = ("account_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "users" ("id","account_id");
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "webauthn_challenges_open_user_idx";
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_open_user_idx" ON "webauthn_challenges" USING btree ("account_id","user_id","type","created_at") WHERE ("consumed_at" IS NULL AND "user_id" IS NOT NULL);
--> statement-breakpoint
-- auth_events: a row that names a user and no account gets the user's. Rows with neither stay.
-- @auth_events_fill_from_user
UPDATE "auth_events" e SET "account_id" = u."account_id" FROM "users" u WHERE e."account_id" IS NULL AND u."id" = e."user_id";
--> statement-breakpoint
-- `refresh_tokens` holds its two keys twice wherever this journal ran after the mail journal: the
-- composite pair (mail 0118), and the single-column pair this journal's first entry adds again on
-- a store made from empty. The superseded pair goes here, in the journal that re-adds it, so a
-- store made from empty and a store that was migrated end with the same keys. A store that never
-- held them (one from before the journals were split) drops nothing.
-- @refresh_tokens_single_keys
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_session_id_sessions_id_fk", DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_users_id_fk";
--> statement-breakpoint
-- The Cloud journal's three constraints that were added NOT VALID and never validated.
-- @validate_cloud_three
ALTER TABLE "login_tokens" VALIDATE CONSTRAINT "login_tokens_unbound_is_approval";
--> statement-breakpoint
ALTER TABLE "platform_signals" VALIDATE CONSTRAINT "platform_signals_sample_cause_check";
--> statement-breakpoint
ALTER TABLE "account_lifecycle_notices" VALIDATE CONSTRAINT "account_lifecycle_notices_kind_closed";
