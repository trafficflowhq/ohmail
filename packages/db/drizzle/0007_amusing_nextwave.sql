CREATE TABLE IF NOT EXISTS "mailbox_credentials" (
	"mailbox_id" uuid NOT NULL,
	"transport" text NOT NULL,
	"secret_enc" text NOT NULL,
	"key_version" integer NOT NULL,
	"meta" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_credentials_mailbox_id_transport_pk" PRIMARY KEY("mailbox_id","transport")
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "status" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "auth_kind" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_transport_check" CHECK ("transport" IN ('imap','smtp','graph'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
