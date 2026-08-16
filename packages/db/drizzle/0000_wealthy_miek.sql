CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb,
	"inverse" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "folder_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"desired_folder" text NOT NULL,
	"observed_folder" text NOT NULL,
	"last_set_by" text NOT NULL,
	"reconcile_status" text DEFAULT 'pending' NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" bigint,
	"uidnext" bigint,
	"highestmodseq" bigint,
	"delta_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_folders_mailbox_id_folder_unique" UNIQUE("mailbox_id","folder")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id_header" text,
	"body_hash" text NOT NULL,
	"dedup_key" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_address" text DEFAULT '' NOT NULL,
	"date" timestamp with time zone,
	"native_locator" jsonb,
	"no_ai" boolean DEFAULT false NOT NULL,
	"no_forward" boolean DEFAULT false NOT NULL,
	"no_kb" boolean DEFAULT false NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_mailbox_id_dedup_key_unique" UNIQUE("mailbox_id","dedup_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "folder_state" ADD CONSTRAINT "folder_state_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
