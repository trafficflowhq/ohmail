-- 0204_message_invitations — the shared entry's twin: the identity of an invitation, kept at
-- ingest (a device's ingest is the shared one). The row goes with its letter; the key is its
-- single-column form, since one account owns a device's store. No CHECK.

CREATE TABLE "message_invitations" (
  "account_id" text NOT NULL,
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "mailbox_id" text NOT NULL,
  "uid" text NOT NULL,
  "recurrence_id" text NOT NULL DEFAULT '',
  "sequence" integer NOT NULL DEFAULT 0,
  "method" text NOT NULL,
  "start_raw" text,
  "starts_at" integer,
  "organizer" text,
  "invited_address" text,
  "created_at" integer NOT NULL DEFAULT (cast(unixepoch('subsec') * 1000 as integer)),
  PRIMARY KEY ("account_id", "message_id")
);
--> statement-breakpoint
CREATE INDEX "message_invitations_account_uid_idx" ON "message_invitations" ("account_id", "uid", "recurrence_id");
