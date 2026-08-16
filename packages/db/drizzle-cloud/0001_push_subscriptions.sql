-- SPLIT FROM `0006_swift_skrulls` (single-journal era, migration 0006) — the CLOUD half.
--
-- Web Push and APNs registrations. `transport` selects which identity column is live
-- (endpoint for webpush, device_token for apns); the coalesced UNIQUE is an expression index
-- the schema DSL cannot express, so it is written by hand here. Payloads are wake-signals
-- only. Always-on push is Cloud's, which is why this is not in the mail journal.
--
-- `idempotency_keys`, the other half of the original file, is the mail journal's
-- `0006_idempotency_keys`.


CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"transport" text NOT NULL,
	"endpoint" text,
	"p256dh" text,
	"auth" text,
	"device_token" text,
	"bundle_id" text,
	"environment" text,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_identity_uq" ON "push_subscriptions" ("account_id","transport",COALESCE("endpoint","device_token"));
