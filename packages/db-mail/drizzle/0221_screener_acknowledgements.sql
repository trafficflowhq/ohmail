-- Account-wide acknowledgements for the Screener's one-time confirmations.
-- Tables altered: account_settings (one column). No DML.
-- LOCK: brief ACCESS EXCLUSIVE. The constant default avoids a table rewrite.
-- DEPLOY ORDER: migration before any process using the new settings schema.
-- ROLLBACK: drop this column after reverting the processes that use it.
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "screener_acknowledgements" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
