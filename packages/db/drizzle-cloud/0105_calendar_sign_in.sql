-- THE CALENDAR'S SIGN-IN AND ITS NOTICE CHANNELS (cloud 0105). Nothing writes either yet.
--
-- 1. A calendar connects through the two ceremonies a mailbox connects through (the redirect and
--    the device code), which already carry the provider. `purpose` says what a ceremony is for;
--    every row that stands, and every row the mailbox flows write, is `mailbox`.
-- 2. `cal_push_channels`: a provider can tell the service that a calendar changed, on a channel
--    the service opened. A notice names its channel before any account is known, so the row is
--    found by `(provider, channel_id)`, which is unique; the shared word a notice must carry is
--    kept as a hash. The row carries its account and hangs off its connection under the
--    connection's `(id, account_id)`. Polling stays the floor everywhere; a channel only shortens
--    the wait.
--
-- Servers only: a desktop reads a calendar itself and is told nothing. Part of the 2.0
-- transition's window: applied once, by one transaction, on a store nothing else writes to
-- (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @ceremonies_purpose
ALTER TABLE "mailbox_oauth_ceremonies" ADD COLUMN "purpose" text DEFAULT 'mailbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_oauth_device_ceremonies" ADD COLUMN "purpose" text DEFAULT 'mailbox' NOT NULL;
--> statement-breakpoint
-- @cal_push_channels_create
CREATE TABLE "cal_push_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "calendar_id" uuid,
  "provider" text NOT NULL,
  "channel_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "resource_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_push_channels_connection_id_account_fk" FOREIGN KEY ("connection_id","account_id") REFERENCES "cal_connections"("id","account_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_push_channels_channel_uq" ON "cal_push_channels" USING btree ("provider","channel_id");
--> statement-breakpoint
CREATE INDEX "cal_push_channels_account_idx" ON "cal_push_channels" USING btree ("account_id","connection_id");
--> statement-breakpoint
CREATE INDEX "cal_push_channels_expires_idx" ON "cal_push_channels" USING btree ("expires_at");
