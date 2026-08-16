CREATE TABLE IF NOT EXISTS "graduations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"pattern_key" text NOT NULL,
	"action" text DEFAULT 'route' NOT NULL,
	"positives" integer DEFAULT 0 NOT NULL,
	"negatives" integer DEFAULT 0 NOT NULL,
	"graduated" boolean DEFAULT false NOT NULL,
	"graduated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graduations_account_id_pattern_key_action_unique" UNIQUE("account_id","pattern_key","action")
);
