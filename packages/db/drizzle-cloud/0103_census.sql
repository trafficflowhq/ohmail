-- FIVE SMALL THINGS THE CLOSED WINDOW MAKES FREE (cloud 0103). Each would take a lock a running
-- service waits behind, or a validation over a table in use; here nothing else is running.
--
-- 1. `platform_signals.provider` was closed to one host's name. It keeps a shape and loses its
--    member list: a deployment on another platform records its own traffic under its own word,
--    and a new platform alters no table. Its members are the reader's (`platform-signals.ts`).
-- 2. Two indexes another index repeats go: `api_faults_at_idx` (the leading column of
--    `api_faults_at_route_idx`) and `staff_sessions_live_idx` (the token hash, which
--    `staff_sessions_token_hash_unique` already keys).
-- 3. A secret's look-up key is unique, as it is on `refresh_tokens`, `staff_sessions` and
--    `invites`: `login_tokens.token_hash` and `oauth_auth_codes.code_hash`. Two rows under one hash
--    would let one code answer for another; a random 256-bit value never collides, so this states
--    what was always true and refuses the day it is not.
-- 4. `push_subscriptions.account_id` gets the key onto `accounts` it never had.
--
-- Servers only. Part of the 2.0 transition's window: applied once, by one transaction, on a store
-- nothing else writes to (`packages/db/src/transition/`). A store made from empty takes it as an
-- ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @platform_signals_provider_shape
ALTER TABLE "platform_signals" DROP CONSTRAINT "platform_signals_provider_check";
--> statement-breakpoint
ALTER TABLE "platform_signals" ADD CONSTRAINT "platform_signals_provider_shape" CHECK ("provider" ~ '^[a-z][a-z0-9_-]{0,31}$');
--> statement-breakpoint
-- @drop_repeated_indexes
DROP INDEX "api_faults_at_idx";
--> statement-breakpoint
DROP INDEX "staff_sessions_live_idx";
--> statement-breakpoint
-- @unique_secret_keys
DROP INDEX "login_tokens_token_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "login_tokens_token_hash_uq" ON "login_tokens" USING btree ("token_hash");
--> statement-breakpoint
DROP INDEX "oauth_auth_codes_code_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_auth_codes_code_hash_uq" ON "oauth_auth_codes" USING btree ("code_hash");
--> statement-breakpoint
-- @push_subscriptions_account_key
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id");
