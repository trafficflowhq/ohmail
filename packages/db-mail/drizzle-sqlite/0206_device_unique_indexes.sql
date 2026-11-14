-- 0206_device_unique_indexes — thirteen unique indexes this store carries for nothing.
-- device-only: on a server each of them is the target of composite keys onto `(id, account_id)`; this store has no such keys but one, so the server keeps them all.
--
-- Mail 0118 gave every parent a unique index on `(id, account_id)`, and the folders one on
-- `(id, mailbox_id)`, "so the two schemas stay one schema". On a server composite foreign keys
-- point at them. On this store a key is its single-column form (a composite key here is a table
-- rebuild, and one account owns the store), so nothing names these thirteen, and no query can
-- prefer one to its table's primary key: each begins with the primary key's own column. Every
-- insert and every update of an indexed column paid for them all the same.
--
-- `outbound_sends_id_account_uq` STAYS: `outbound_sent_copies` (mail 0170) keys onto
-- `outbound_sends (id, account_id)` on this store too, and without the index SQLite refuses the
-- child's writes with "foreign key mismatch".
DROP INDEX "mailboxes_id_account_uq";
--> statement-breakpoint
DROP INDEX "messages_id_account_uq";
--> statement-breakpoint
DROP INDEX "threads_id_account_uq";
--> statement-breakpoint
DROP INDEX "contacts_id_account_uq";
--> statement-breakpoint
DROP INDEX "tags_id_account_uq";
--> statement-breakpoint
DROP INDEX "drafts_id_account_uq";
--> statement-breakpoint
DROP INDEX "routing_decisions_id_account_uq";
--> statement-breakpoint
DROP INDEX "rules_id_account_uq";
--> statement-breakpoint
DROP INDEX "workflows_id_account_uq";
--> statement-breakpoint
DROP INDEX "users_id_account_uq";
--> statement-breakpoint
DROP INDEX "devices_id_account_uq";
--> statement-breakpoint
DROP INDEX "sessions_id_account_uq";
--> statement-breakpoint
DROP INDEX "mailbox_folders_id_mailbox_uq";
