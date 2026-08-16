CREATE TABLE IF NOT EXISTS "learning_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"triggering_action_id" text NOT NULL,
	"kind" text NOT NULL,
	"sender_address" text,
	"sender_domain" text,
	"destination" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_signals_account_id_triggering_action_id_unique" UNIQUE("account_id","triggering_action_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_signals_account_idx" ON "learning_signals" USING btree ("account_id");