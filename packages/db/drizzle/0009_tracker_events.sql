CREATE TABLE IF NOT EXISTS "tracker_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"tracker_host" text,
	"url" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracker_events" ADD CONSTRAINT "tracker_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_events_account_message_idx" ON "tracker_events" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracker_events_account_detected_idx" ON "tracker_events" USING btree ("account_id","detected_at");