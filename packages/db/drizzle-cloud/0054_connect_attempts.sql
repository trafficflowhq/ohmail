-- HOW CONNECTING A MAILBOX ENDED, AND NOTHING THE PERSON TYPED (cloud 0054). One row per press of Test or
-- Connect and per start or finish of the Microsoft sign-in, on the managed deployment: the door, the
-- preset (a word from the server's own host table, `imap` for any other host), ok or refused, the
-- refusal as one word, and which leg refused. No address, host, port, user name, server text, IP or
-- user agent: every text column is a closed set or a lower-case word, by CHECK.
--
-- CLOUD, not mail: only the managed API writes it, through the erasure fence, at most 200 per account per
-- day, and only while TF_CONNECT_ATTEMPTS=record. The worker's retention pass deletes a row after 30 days
-- and `deleteAccount` deletes the account's rows: `accounts` survives erasure, so the CASCADE never fires.
--
-- THE STAFF ROLE'S GRANT, in the migration itself (0049's lesson): SELECT on seven columns (not `id`), no
-- write. Guarded on the role existing; the role name is unquoted for 0007's reason.
--
-- LOCK-WAIT: none on a populated table. The foreign key takes SHARE ROW EXCLUSIVE on `accounts` until the
-- cloud pass commits: a sign-up or an erasure stamp waits that long; the fence's FOR SHARE does not.
-- DEPLOY ORDER: migration, then the API and the worker straight after. Until the API is deployed, an old
-- API's cold start reads the new grant as an excess and refuses the staff handle (closed: the console and
-- the API's alert arm answer 503). An API ahead of the migration answers /health 503 schema_incomplete.
-- ROLLBACK is `DROP TABLE connect_attempts`, after the API is rolled back.

CREATE TABLE IF NOT EXISTS "connect_attempts" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "door" text NOT NULL,
  "preset" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "transport" text,
  CONSTRAINT "connect_attempts_pk" PRIMARY KEY ("account_id", "at", "id"),
  CONSTRAINT "connect_attempts_door_closed" CHECK ("door" IN ('test', 'connect', 'oauth_start', 'oauth_complete')),
  CONSTRAINT "connect_attempts_preset_word" CHECK ("preset" ~ '^[a-z]{1,16}$'),
  CONSTRAINT "connect_attempts_outcome_closed" CHECK ("outcome" IN ('ok', 'refused')),
  CONSTRAINT "connect_attempts_reason_word" CHECK ("reason" IS NULL OR "reason" ~ '^[a-z][a-z_]{0,31}$'),
  CONSTRAINT "connect_attempts_reason_iff_refused" CHECK (("outcome" = 'refused') = ("reason" IS NOT NULL)),
  CONSTRAINT "connect_attempts_transport_closed" CHECK ("transport" IS NULL OR "transport" IN ('imap', 'smtp'))
);
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "connect_attempts" FROM ohmail_admin;
    GRANT SELECT (account_id, at, door, preset, outcome, reason, transport)
      ON TABLE "connect_attempts" TO ohmail_admin;
  END IF;
END $$;
