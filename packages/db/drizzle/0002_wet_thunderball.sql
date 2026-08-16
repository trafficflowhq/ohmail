CREATE TABLE IF NOT EXISTS "account_sync_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"next_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_id" uuid,
	"routing_decision_id" uuid,
	"action" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"confidence" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_log" (
	"account_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"op" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_log_account_id_seq_pk" PRIMARY KEY("account_id","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_bodies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"html" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"loaded_remote_content" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_bodies_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"state" text DEFAULT 'none' NOT NULL,
	"bubble_up_at" timestamp with time zone,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_states_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"input_provenance" text NOT NULL,
	"matched_rule_id" uuid,
	"destination" text NOT NULL,
	"confidence" real,
	"rationale" text,
	"spam" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone,
	"muted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "unread" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "snippet" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "has_attachments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sensitivity_category" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "hits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "last_hit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "demotions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_states" ADD CONSTRAINT "message_states_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_account_status_idx" ON "approvals" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_states_account_state_idx" ON "message_states" USING btree ("account_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routing_decisions_account_message_idx" ON "routing_decisions" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_account_last_message_idx" ON "threads" USING btree ("account_id","last_message_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_account_thread_idx" ON "messages" USING btree ("account_id","thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_account_mailbox_unread_idx" ON "messages" USING btree ("account_id","mailbox_id","unread");