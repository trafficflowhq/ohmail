-- THE UNSUBSCRIBE DRAIN GETS A MEMORY — two tables and one index.
--
-- `unsubscribe_examined`: the per-message half of a key that was only ever per LIST. A record row
-- is `(mailbox, list)`, so the second message of a list already left had no row of its own, and
-- every tick re-read it, re-wrote its author verdict and re-attempted its claim — five statements
-- a message an hour, for ever, and counted as still owed. Judged against a record, so it carries
-- the record it was judged against.
--
-- `unsubscribe_drain_state`: where the window walk stopped. The walk restarted at the head of the
-- window at every tick, so a candidate the pass cannot act on held the head and the rows behind it
-- were never reached. A NULL pair means "start at the head", which is what a lap that reached the
-- end of the window leaves behind and what every deployment starts from.
--
-- The index is the drain's own window: `desired_folder IN (…)`, `updated_at >= since`, ordered by
-- the cursor pair.
--
-- Idempotent, because a desktop engine replays this journal at every launch.

CREATE TABLE IF NOT EXISTS "unsubscribe_examined" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "unsubscribe_examined_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id"),
	CONSTRAINT "unsubscribe_examined_record_id_unsubscribe_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "unsubscribe_records"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unsubscribe_examined_record_idx" ON "unsubscribe_examined" ("record_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unsubscribe_drain_state" (
	"pass" text PRIMARY KEY NOT NULL,
	"cursor_at" timestamptz,
	"cursor_message_id" uuid,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "unsubscribe_drain_state_cursor_pair" CHECK (("cursor_at" IS NULL) = ("cursor_message_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_state_desired_updated_idx" ON "folder_state" ("desired_folder","updated_at","message_id");
