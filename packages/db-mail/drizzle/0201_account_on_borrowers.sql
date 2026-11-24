-- THE ACCOUNT ON THE TABLES THAT BORROWED IT. Six mail tables reached their account only through
-- a parent row: message_bodies, folder_state and flag_state through `messages`, mailbox_credentials
-- and mailbox_folders through `mailboxes`, pairing_tokens through `users`. Each gets the column,
-- its fill from the parent, NOT NULL, a composite key onto the parent's (id, account_id) in place
-- of the single-column key, and an index that leads with the account. A row can then never hang
-- under another account's parent, and a statement that names only the account finds its rows.
--
-- The parents' unique (id, account_id) exist since mail 0118; no index is built on a parent. Each
-- composite key replaces a single-column key that exists today, none is new: what a later
-- release pays for them is what it pays today.
--
-- With the column, the two trigger-kept copies of the account (`folder_state.outstanding_account_id`,
-- `flag_state.pending_account_id`) go, and the indexes built on them lead with `account_id`.
-- `folder_state.screener_floor_version`, which nothing reads, goes too.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). The fills and the validating keys take their tables
-- whole; that is what the closed window is for. A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.

-- ── message_bodies: the largest fill ──────────────────────────────────────────────────────────────────────
-- @bodies_add_column
ALTER TABLE "message_bodies" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
-- @bodies_fill
UPDATE "message_bodies" b SET "account_id" = m."account_id" FROM "messages" m WHERE m."id" = b."message_id";
--> statement-breakpoint
-- @bodies_set_not_null
ALTER TABLE "message_bodies" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
-- @bodies_composite_key
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_message_id_account_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "messages"("id","account_id");
--> statement-breakpoint
-- @bodies_drop_single_key
ALTER TABLE "message_bodies" DROP CONSTRAINT "message_bodies_message_id_messages_id_fk";
--> statement-breakpoint
-- The index that leads with the account. A body is reached by message_id today; a statement that names only
-- the account (the erasure, the recount, any read the policy has to bound) would scan the largest table
-- without it: measured at 100,000 letters, 24 ms without and 1.3 ms with, 50 bytes a row.
-- @bodies_account_index
CREATE INDEX "message_bodies_account_idx" ON "message_bodies" USING btree ("account_id","message_id");
--> statement-breakpoint

-- ── folder_state: the trigger-kept copy goes with its triggers ─────────────────────────────────
-- The copy must agree with the real account wherever it is set, or this entry stops.
-- @folder_state_copy_agrees
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM "folder_state" f JOIN "messages" m ON m."id" = f."message_id"
   WHERE f."outstanding_account_id" IS NOT NULL AND f."outstanding_account_id" <> m."account_id";
  IF bad > 0 THEN RAISE EXCEPTION 'folder_state.outstanding_account_id disagrees with messages.account_id on % rows', bad; END IF;
END $$;
--> statement-breakpoint
-- @folder_state_drop_triggers
DROP TRIGGER "folder_state_outstanding_account_tg" ON "folder_state";
--> statement-breakpoint
DROP TRIGGER "folder_state_pending_account_tg" ON "folder_state";
--> statement-breakpoint
DROP FUNCTION "folder_state_outstanding_account"();
--> statement-breakpoint
-- @folder_state_add_column
ALTER TABLE "folder_state" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
-- @folder_state_fill
UPDATE "folder_state" f SET "account_id" = m."account_id" FROM "messages" m WHERE m."id" = f."message_id";
--> statement-breakpoint
-- @folder_state_set_not_null
ALTER TABLE "folder_state" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
-- @folder_state_composite_key
ALTER TABLE "folder_state" ADD CONSTRAINT "folder_state_message_id_account_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "messages"("id","account_id");
--> statement-breakpoint
ALTER TABLE "folder_state" DROP CONSTRAINT "folder_state_message_id_messages_id_fk";
--> statement-breakpoint
-- @folder_state_rebuild_partial_indexes
DROP INDEX "folder_state_outstanding_idx";
--> statement-breakpoint
DROP INDEX "folder_state_pending_queue_idx";
--> statement-breakpoint
CREATE INDEX "folder_state_outstanding_idx" ON "folder_state" USING btree ("account_id","message_id") WHERE ("reconcile_status" = 'pending' AND "last_set_by" = 'us' AND "desired_folder" <> "observed_folder");
--> statement-breakpoint
CREATE INDEX "folder_state_pending_queue_idx" ON "folder_state" USING btree ("account_id","updated_at","message_id") WHERE ("reconcile_status" = 'pending');
--> statement-breakpoint
-- @folder_state_account_index
CREATE INDEX "folder_state_account_idx" ON "folder_state" USING btree ("account_id","message_id");
--> statement-breakpoint
-- @folder_state_drop_columns
ALTER TABLE "folder_state" DROP COLUMN "outstanding_account_id", DROP COLUMN "screener_floor_version";
--> statement-breakpoint

-- ── flag_state ────────────────────────────────────────────────────────────────────────────────────────────
-- @flag_state_copy_agrees
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM "flag_state" f JOIN "messages" m ON m."id" = f."message_id"
   WHERE f."pending_account_id" IS NOT NULL AND f."pending_account_id" <> m."account_id";
  IF bad > 0 THEN RAISE EXCEPTION 'flag_state.pending_account_id disagrees with messages.account_id on % rows', bad; END IF;
END $$;
--> statement-breakpoint
-- @flag_state_drop_trigger
DROP TRIGGER "flag_state_pending_account_tg" ON "flag_state";
--> statement-breakpoint
DROP FUNCTION "flag_state_pending_account"();
--> statement-breakpoint
-- @flag_state_add_column
ALTER TABLE "flag_state" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
-- @flag_state_fill
UPDATE "flag_state" f SET "account_id" = m."account_id" FROM "messages" m WHERE m."id" = f."message_id";
--> statement-breakpoint
-- @flag_state_set_not_null
ALTER TABLE "flag_state" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
-- @flag_state_composite_key
ALTER TABLE "flag_state" ADD CONSTRAINT "flag_state_message_id_account_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "messages"("id","account_id");
--> statement-breakpoint
ALTER TABLE "flag_state" DROP CONSTRAINT "flag_state_message_id_messages_id_fk";
--> statement-breakpoint
-- @flag_state_rebuild_partial_index
DROP INDEX "flag_state_pending_queue_idx";
--> statement-breakpoint
CREATE INDEX "flag_state_pending_queue_idx" ON "flag_state" USING btree ("account_id","updated_at","message_id") WHERE ("reconcile_status" = 'pending');
--> statement-breakpoint
-- @flag_state_account_index
CREATE INDEX "flag_state_account_idx" ON "flag_state" USING btree ("account_id","message_id");
--> statement-breakpoint
-- @flag_state_drop_column
ALTER TABLE "flag_state" DROP COLUMN "pending_account_id";
--> statement-breakpoint

-- ── the planner's view of the two queues ──────────────────────────────────────────────────────────────────
-- The copies dropped above were NULL on every settled row, so "this account's pending rows" was estimated
-- from the one column. `account_id` stands on every row: an account's share of the table and the share of
-- rows that are pending are estimated apart and multiplied, which says thousands where there are a handful,
-- and a read planned for thousands walks the account's letters instead of its queue (measured: the mailbox
-- list's filing facts read 74,200 letters for 18 filings). Statistics on the pair say how many of an
-- account's rows are pending; ANALYZE fills them here, before the first poll after the entry.
-- @queue_statistics
CREATE STATISTICS "folder_state_account_status_stat" (mcv) ON "account_id", "reconcile_status" FROM "folder_state";
--> statement-breakpoint
CREATE STATISTICS "flag_state_account_status_stat" (mcv) ON "account_id", "reconcile_status" FROM "flag_state";
--> statement-breakpoint
ANALYZE "folder_state";
--> statement-breakpoint
ANALYZE "flag_state";
--> statement-breakpoint

-- ── mailbox_credentials, mailbox_folders: small, by the mailbox ───────────────────────────────────────────
-- @mailbox_credentials_account
ALTER TABLE "mailbox_credentials" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "mailbox_credentials" c SET "account_id" = b."account_id" FROM "mailboxes" b WHERE b."id" = c."mailbox_id";
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id","account_id") REFERENCES "mailboxes"("id","account_id");
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" DROP CONSTRAINT "mailbox_credentials_mailbox_id_mailboxes_id_fk";
--> statement-breakpoint
CREATE INDEX "mailbox_credentials_account_idx" ON "mailbox_credentials" USING btree ("account_id","mailbox_id");
--> statement-breakpoint
-- @mailbox_folders_account
ALTER TABLE "mailbox_folders" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "mailbox_folders" f SET "account_id" = b."account_id" FROM "mailboxes" b WHERE b."id" = f."mailbox_id";
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id","account_id") REFERENCES "mailboxes"("id","account_id");
--> statement-breakpoint
ALTER TABLE "mailbox_folders" DROP CONSTRAINT "mailbox_folders_mailbox_id_mailboxes_id_fk";
--> statement-breakpoint
CREATE INDEX "mailbox_folders_account_idx" ON "mailbox_folders" USING btree ("account_id","mailbox_id");
--> statement-breakpoint

-- ── pairing_tokens: the first setup token has no creator and so no account ────────────────────────────────
-- @pairing_tokens_account
ALTER TABLE "pairing_tokens" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
UPDATE "pairing_tokens" p SET "account_id" = u."account_id" FROM "users" u WHERE u."id" = p."created_by_user_id";
--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_account_iff_creator" CHECK (("created_by_user_id" IS NULL) = ("account_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_created_by_user_id_account_fk" FOREIGN KEY ("created_by_user_id","account_id") REFERENCES "users"("id","account_id");
--> statement-breakpoint
ALTER TABLE "pairing_tokens" DROP CONSTRAINT "pairing_tokens_created_by_user_id_users_id_fk";
--> statement-breakpoint
CREATE INDEX "pairing_tokens_account_idx" ON "pairing_tokens" USING btree ("account_id") WHERE ("account_id" IS NOT NULL);
--> statement-breakpoint

-- ── three keys that did not pin the account although both sides carry it ───────────────────────────
-- @composite_keys_where_both_sides_carried_the_account
CREATE UNIQUE INDEX "unsubscribe_records_id_account_uq" ON "unsubscribe_records" USING btree ("id","account_id");
--> statement-breakpoint
ALTER TABLE "junk_rescues" ADD CONSTRAINT "junk_rescues_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id","account_id") REFERENCES "mailboxes"("id","account_id");
--> statement-breakpoint
ALTER TABLE "junk_rescues" DROP CONSTRAINT "junk_rescues_mailbox_id_fkey";
--> statement-breakpoint
ALTER TABLE "unsubscribe_examined" ADD CONSTRAINT "unsubscribe_examined_message_id_account_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "messages"("id","account_id");
--> statement-breakpoint
ALTER TABLE "unsubscribe_examined" DROP CONSTRAINT "unsubscribe_examined_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "unsubscribe_examined" ADD CONSTRAINT "unsubscribe_examined_record_id_account_fk" FOREIGN KEY ("record_id","account_id") REFERENCES "unsubscribe_records"("id","account_id");
--> statement-breakpoint
ALTER TABLE "unsubscribe_examined" DROP CONSTRAINT "unsubscribe_examined_record_id_unsubscribe_records_id_fk";
