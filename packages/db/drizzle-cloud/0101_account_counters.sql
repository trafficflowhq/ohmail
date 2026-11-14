-- THE COUNTERS THAT NAME A ROW GET THEIR ACCOUNT (cloud 0101). `auth_throttle` held two kinds of
-- key: a keyed hash, a fixed word or a number, which names nobody, and an id in the clear, which
-- names a user, a mailbox or an account. The second kind moves to `account_counters`, which
-- carries the account: such a counter is isolated like every other row of an account and goes with
-- it at an erasure, by one predicate. What stays in `auth_throttle` names no row.
--
-- The families are one registry, `packages/db/src/counter-keys.ts`, and its test holds these
-- statements to it. A move takes the keys that fit a family's whole shape, under the account of
-- the row the key names (its last 36 characters, in every family that moves). A counter whose
-- user, mailbox or account is gone is not moved and goes with the delete after it.
-- `live-body:` is a keyed hash of an account, an admission slot of minutes that nothing holds
-- while this runs: deleted. A key that carries an `@` is the form from before the keys were
-- hashed; no family can carry one: deleted.
--
-- Servers only. Part of the 2.0 transition's window: applied once, by one transaction, on a store
-- nothing else writes to (`packages/db/src/transition/`). A store made from empty takes it as an
-- ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @account_counters_create
CREATE TABLE "account_counters" (
  "account_id" uuid NOT NULL,
  "key" text NOT NULL,
  "failures" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  "window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_counters_pk" PRIMARY KEY ("account_id","key"),
  CONSTRAINT "account_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
-- @account_counters_move_user_keys
INSERT INTO "account_counters" ("account_id","key","failures","locked_until","window_started_at","updated_at")
SELECT u."account_id", t."key", t."failures", t."locked_until", t."window_started_at", t."updated_at"
  FROM "auth_throttle" t JOIN "users" u ON u."id"::text = right(t."key", 36)
 WHERE t."key" ~ '^(user|factor-day|notice:factor):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
-- @account_counters_move_mailbox_keys
INSERT INTO "account_counters" ("account_id","key","failures","locked_until","window_started_at","updated_at")
SELECT b."account_id", t."key", t."failures", t."locked_until", t."window_started_at", t."updated_at"
  FROM "auth_throttle" t JOIN "mailboxes" b ON b."id"::text = right(t."key", 36)
 WHERE t."key" ~ '^imap:mailbox:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
-- @account_counters_move_account_keys
INSERT INTO "account_counters" ("account_id","key","failures","locked_until","window_started_at","updated_at")
SELECT a."id", t."key", t."failures", t."locked_until", t."window_started_at", t."updated_at"
  FROM "auth_throttle" t JOIN "accounts" a ON a."id"::text = right(t."key", 36)
 WHERE t."key" ~ '^imap:mailbox:probe:[0-9a-f]{32}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR t."key" ~ '^probe-rate:(t:[0-9a-f]{32}:[0-9]+|a:[0-9]+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
-- @auth_throttle_delete_what_left
DELETE FROM "auth_throttle"
 WHERE "key" LIKE 'user:%' OR "key" LIKE 'factor-day:%' OR "key" LIKE 'notice:factor:%'
    OR "key" LIKE 'imap:mailbox:%' OR "key" LIKE 'probe-rate:%' OR "key" LIKE 'live-body:%';
--> statement-breakpoint
-- @auth_throttle_delete_keys_with_an_address
DELETE FROM "auth_throttle" WHERE "key" LIKE '%@%';
