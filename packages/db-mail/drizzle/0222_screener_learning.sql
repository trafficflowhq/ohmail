-- Tables altered: routing_decisions, one nullable topic column with no backfill.
-- The note and bounded log start empty on every existing mailbox.
-- LOCK: creation takes a brief reference lock on mailboxes. No backfill.
-- DEPLOY ORDER: migration and runtime row-security setup before the app and worker.
-- ROLLBACK: older processes ignore this table. Dropping it discards learning history.
CREATE TABLE IF NOT EXISTS "screener_learning" (
  "mailbox_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "data" jsonb NOT NULL,
  CONSTRAINT "screener_learning_mailbox_account_fk"
    FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screener_learning_account_idx" ON "screener_learning" ("account_id");
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN IF NOT EXISTS "screener_topic" text;
--> statement-breakpoint
