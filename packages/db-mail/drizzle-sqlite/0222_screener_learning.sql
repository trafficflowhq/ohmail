-- The learning note is scoped to the mailbox and its account on this store too.
CREATE UNIQUE INDEX "mailboxes_id_account_uq" ON "mailboxes" ("id", "account_id");
--> statement-breakpoint
CREATE TABLE "screener_learning" (
  "mailbox_id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "data" text NOT NULL,
  CONSTRAINT "screener_learning_mailbox_account_fk"
    FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "screener_learning_account_idx" ON "screener_learning" ("account_id");
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN "screener_topic" text;
--> statement-breakpoint
