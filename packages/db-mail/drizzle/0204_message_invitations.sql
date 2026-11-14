-- THE IDENTITY OF AN INVITATION, kept at ingest. A letter that carries a calendar invitation gets
-- one row here: which event it speaks of (`uid`, `recurrence_id`), which revision (`sequence`),
-- what it asks (`method`), when the event starts, who organizes it and which of the account's
-- addresses was invited. No calendar bytes are stored, as before. A side table: no mail table is
-- altered for it.
--
-- A CHILD OF ITS LETTER. `(message_id, account_id)` points onto `messages (id, account_id)` and
-- the row goes with its letter (ON DELETE CASCADE), as the rows of `message_states` and
-- `routing_decisions` belong to theirs: a card has no life without its letter. `mailbox_id` is a
-- plain column, with no key into `mailboxes`; the removals delete by it. The primary key
-- `(account_id, message_id)` serves the key's own look-up; no index is added for it.
--
-- `method` is iTIP's list, held at the write door; no CHECK on any store.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @message_invitations_create
CREATE TABLE "message_invitations" (
  "account_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "uid" text NOT NULL,
  "recurrence_id" text DEFAULT '' NOT NULL,
  "sequence" integer DEFAULT 0 NOT NULL,
  "method" text NOT NULL,
  "start_raw" text,
  "starts_at" timestamp with time zone,
  "organizer" text,
  "invited_address" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_invitations_pk" PRIMARY KEY ("account_id","message_id"),
  CONSTRAINT "message_invitations_message_id_account_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "messages"("id","account_id") ON DELETE CASCADE
);
--> statement-breakpoint
-- @message_invitations_uid_index
CREATE INDEX "message_invitations_account_uid_idx" ON "message_invitations" USING btree ("account_id","uid","recurrence_id");
