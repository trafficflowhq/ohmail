-- 0200_search_one_generation — the shared entry's twin. This store has no word-vector columns
-- and neither of the two indexes the entry drops; what is left of it here is the read flag
-- leaving its index on `messages`. Indexes only, no rebuild.

CREATE INDEX "messages_account_mailbox_idx" ON "messages" ("account_id", "mailbox_id");
--> statement-breakpoint
DROP INDEX "messages_account_mailbox_unread_idx";
