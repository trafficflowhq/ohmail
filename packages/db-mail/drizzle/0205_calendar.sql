-- THE CALENDAR'S TABLES. Ten tables, and nothing writes them yet: the calendar's store is built on
-- them, and until the 2.0 journal is frozen their columns may still change in place, because no
-- store holds a row of them before then. Servers only. A desktop's engine runs this journal and
-- holds them too; the device journal carries a `.noop` in this place, since a phone that
-- organizes on its own has no calendar in 2.0.
--
-- EVERY TABLE IS BORN WITH account_id NOT NULL. Keys run inside the family only, composite
-- `(x, account_id)` onto the parent's `(id, account_id)`; the two roots key to `accounts`. A
-- mailbox or a letter is named by a plain column: no key into the busy mail tables.
-- Closed lists (provider, status, kinds, states) carry no CHECK: they grow, and the write doors
-- hold them.
--
-- The staff role, where it exists, is granted six columns of `cal_connections` and nothing else
-- of the family (the last statement).
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @cal_connections
CREATE TABLE "cal_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "error_code" text,
  "mailbox_id" uuid,
  "server_url" text,
  "principal" text,
  "consented_at" timestamp with time zone,
  "list_token" text,
  "last_synced_at" timestamp with time zone,
  "next_poll_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_connections_id_account_uq" ON "cal_connections" USING btree ("id","account_id");
--> statement-breakpoint
CREATE INDEX "cal_connections_account_idx" ON "cal_connections" USING btree ("account_id","id");
--> statement-breakpoint
-- @cal_credentials
CREATE TABLE "cal_credentials" (
  "account_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "secret_enc" text NOT NULL,
  "key_version" integer NOT NULL,
  "meta" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_credentials_pk" PRIMARY KEY ("account_id","connection_id","kind"),
  CONSTRAINT "cal_credentials_connection_id_account_fk" FOREIGN KEY ("connection_id","account_id") REFERENCES "cal_connections"("id","account_id")
);
--> statement-breakpoint
-- @cal_calendars
CREATE TABLE "cal_calendars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "color" text,
  "access" text DEFAULT 'reader' NOT NULL,
  "shown" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "time_zone" text,
  "sync_token" text,
  "fetch_etag" text,
  "window_start" date,
  "window_end" date,
  "last_synced_at" timestamp with time zone,
  "next_poll_at" timestamp with time zone,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_calendars_connection_id_account_fk" FOREIGN KEY ("connection_id","account_id") REFERENCES "cal_connections"("id","account_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_calendars_id_account_uq" ON "cal_calendars" USING btree ("id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_calendars_provider_uq" ON "cal_calendars" USING btree ("account_id","connection_id","provider_id");
--> statement-breakpoint
-- @cal_events
CREATE TABLE "cal_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "calendar_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "version_tag" text,
  "uid" text NOT NULL,
  "recurrence_id" text DEFAULT '' NOT NULL,
  "sequence" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "notes" text,
  "place" text,
  "call_link" text,
  "start_kind" text NOT NULL,
  "start_local" text NOT NULL,
  "start_zone" text,
  "end_local" text,
  "end_zone" text,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "repeat_rule" text,
  "excluded_dates" jsonb,
  "added_dates" jsonb,
  "busy" boolean DEFAULT true NOT NULL,
  "private" boolean DEFAULT false NOT NULL,
  "organizer" text,
  "my_answer" text,
  "held_back" boolean DEFAULT false NOT NULL,
  "original" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_events_calendar_id_account_fk" FOREIGN KEY ("calendar_id","account_id") REFERENCES "cal_calendars"("id","account_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_events_id_account_uq" ON "cal_events" USING btree ("id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_events_provider_uq" ON "cal_events" USING btree ("account_id","calendar_id","provider_id");
--> statement-breakpoint
CREATE INDEX "cal_events_account_range_idx" ON "cal_events" USING btree ("account_id","starts_at","ends_at");
--> statement-breakpoint
CREATE INDEX "cal_events_account_uid_idx" ON "cal_events" USING btree ("account_id","uid","recurrence_id");
--> statement-breakpoint
-- @cal_attendees
CREATE TABLE "cal_attendees" (
  "account_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "address" text NOT NULL,
  "name" text,
  "role" text DEFAULT 'required' NOT NULL,
  "answer" text DEFAULT 'none' NOT NULL,
  CONSTRAINT "cal_attendees_pk" PRIMARY KEY ("account_id","event_id","address"),
  CONSTRAINT "cal_attendees_event_id_account_fk" FOREIGN KEY ("event_id","account_id") REFERENCES "cal_events"("id","account_id")
);
--> statement-breakpoint
CREATE INDEX "cal_attendees_account_address_idx" ON "cal_attendees" USING btree ("account_id","address");
--> statement-breakpoint
-- @cal_alarms
CREATE TABLE "cal_alarms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "event_id" uuid,
  "calendar_id" uuid,
  "minutes_before" integer NOT NULL,
  "method" text DEFAULT 'notice' NOT NULL,
  CONSTRAINT "cal_alarms_one_owner" CHECK (("event_id" IS NULL) <> ("calendar_id" IS NULL)),
  CONSTRAINT "cal_alarms_event_id_account_fk" FOREIGN KEY ("event_id","account_id") REFERENCES "cal_events"("id","account_id"),
  CONSTRAINT "cal_alarms_calendar_id_account_fk" FOREIGN KEY ("calendar_id","account_id") REFERENCES "cal_calendars"("id","account_id")
);
--> statement-breakpoint
CREATE INDEX "cal_alarms_account_event_idx" ON "cal_alarms" USING btree ("account_id","event_id");
--> statement-breakpoint
-- @cal_writes
CREATE TABLE "cal_writes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "calendar_id" uuid NOT NULL,
  "event_id" uuid,
  "op" text NOT NULL,
  "payload" jsonb NOT NULL,
  "base_version_tag" text,
  "idempotency_key" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "refusal" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_writes_calendar_id_account_fk" FOREIGN KEY ("calendar_id","account_id") REFERENCES "cal_calendars"("id","account_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cal_writes_idempotency_uq" ON "cal_writes" USING btree ("account_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "cal_writes_pending_idx" ON "cal_writes" USING btree ("account_id","next_attempt_at","id") WHERE ("state" = 'pending');
--> statement-breakpoint
-- @cal_links
CREATE TABLE "cal_links" (
  "account_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "uid" text NOT NULL,
  "recurrence_id" text DEFAULT '' NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_links_pk" PRIMARY KEY ("account_id","message_id","uid","recurrence_id")
);
--> statement-breakpoint
CREATE INDEX "cal_links_account_uid_idx" ON "cal_links" USING btree ("account_id","uid","recurrence_id");
--> statement-breakpoint
-- @cal_suggestions
CREATE TABLE "cal_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "evidence" text NOT NULL,
  "proposed" jsonb NOT NULL,
  "source_words" text,
  "state" text DEFAULT 'open' NOT NULL,
  "event_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "cal_suggestions_account_open_idx" ON "cal_suggestions" USING btree ("account_id","created_at","id") WHERE ("state" = 'open');
--> statement-breakpoint
CREATE INDEX "cal_suggestions_account_message_idx" ON "cal_suggestions" USING btree ("account_id","message_id");
--> statement-breakpoint
-- @cal_settings
CREATE TABLE "cal_settings" (
  "account_id" uuid PRIMARY KEY NOT NULL,
  "enabled_at" timestamp with time zone,
  "second_zone" text,
  "week_numbers" boolean DEFAULT false NOT NULL,
  "day_from_minute" integer,
  "day_to_minute" integer,
  "new_events_calendar_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cal_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
-- The staff role, where it exists, reads which provider a connection is and how its sync stands:
-- ids, a provider and a status from lists the product writes, an error code and a timestamp.
-- Never `label`, `server_url` or `principal` (the person's words and their calendar's address),
-- never `list_token`, and no column of any other calendar table.
-- @cal_connections_staff_grant
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "cal_connections" FROM ohmail_admin;
    GRANT SELECT ("id", "account_id", "provider", "status", "error_code", "last_synced_at") ON TABLE "cal_connections" TO ohmail_admin;
  END IF;
END $$;
