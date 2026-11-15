-- 0201_account_on_borrowers — the shared entry's twin. The six mail tables that borrow their
-- parent's account get the column here too, FILLED, with no key, no index of their own and no
-- NOT NULL: a constraint here is a table rebuild, and this store holds one account. One schema and
-- one insert shape then serve both stores, and a query that names the column finds every old row.
-- The trigger-kept copies of the account go with their triggers, as on the server.

ALTER TABLE "message_bodies" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "message_bodies" SET "account_id" = (SELECT m."account_id" FROM "messages" m WHERE m."id" = "message_bodies"."message_id");
--> statement-breakpoint
DROP TRIGGER "folder_state_outstanding_account_insert";
--> statement-breakpoint
DROP TRIGGER "folder_state_outstanding_account_update";
--> statement-breakpoint
DROP TRIGGER "folder_state_pending_account_insert";
--> statement-breakpoint
DROP TRIGGER "folder_state_pending_account_update";
--> statement-breakpoint
DROP TRIGGER "flag_state_pending_account_insert";
--> statement-breakpoint
DROP TRIGGER "flag_state_pending_account_update";
--> statement-breakpoint
ALTER TABLE "folder_state" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "folder_state" SET "account_id" = (SELECT m."account_id" FROM "messages" m WHERE m."id" = "folder_state"."message_id");
--> statement-breakpoint
DROP INDEX "folder_state_outstanding_idx";
--> statement-breakpoint
DROP INDEX "folder_state_pending_queue_idx";
--> statement-breakpoint
CREATE INDEX "folder_state_outstanding_idx" ON "folder_state" ("account_id", "message_id") WHERE "reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder";
--> statement-breakpoint
CREATE INDEX "folder_state_pending_queue_idx" ON "folder_state" ("account_id", "updated_at", "message_id") WHERE "reconcile_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "folder_state" DROP COLUMN "outstanding_account_id";
--> statement-breakpoint
ALTER TABLE "folder_state" DROP COLUMN "screener_floor_version";
--> statement-breakpoint
ALTER TABLE "flag_state" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "flag_state" SET "account_id" = (SELECT m."account_id" FROM "messages" m WHERE m."id" = "flag_state"."message_id");
--> statement-breakpoint
DROP INDEX "flag_state_pending_queue_idx";
--> statement-breakpoint
CREATE INDEX "flag_state_pending_queue_idx" ON "flag_state" ("account_id", "updated_at", "message_id") WHERE "reconcile_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "flag_state" DROP COLUMN "pending_account_id";
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "mailbox_credentials" SET "account_id" = (SELECT b."account_id" FROM "mailboxes" b WHERE b."id" = "mailbox_credentials"."mailbox_id");
--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "mailbox_folders" SET "account_id" = (SELECT b."account_id" FROM "mailboxes" b WHERE b."id" = "mailbox_folders"."mailbox_id");
--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD COLUMN "account_id" text;
--> statement-breakpoint
UPDATE "pairing_tokens" SET "account_id" = (SELECT u."account_id" FROM "users" u WHERE u."id" = "pairing_tokens"."created_by_user_id");
