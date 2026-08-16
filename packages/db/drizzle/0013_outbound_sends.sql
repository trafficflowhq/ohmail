CREATE TABLE IF NOT EXISTS "outbound_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"minted_message_id" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_sends_account_id_idempotency_key_unique" UNIQUE("account_id","idempotency_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
