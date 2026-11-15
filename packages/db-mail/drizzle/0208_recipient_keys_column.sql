-- 0208_recipient_keys_column — the recipients' key, stored: a column the database writes from mail 0154's function.
--
-- A search by recipient (To, either side) reads each letter's key, `<account>:<lower(address)>` for every To
-- and Cc address. Mail 0154 kept it in an expression index only, so wherever a plan asked a letter its key
-- instead of reading that index (an address on every letter, a word beside a recipient) each letter cost a
-- call of the function, which cannot be inlined there. The column holds the same key in the row.
--
-- WHO WRITES IT: the database, on every insert and on every change of To or Cc. It is generated from mail
-- 0154's function, which stays as it is and stays frozen: the column is made of it. No writer names the
-- column, and one that tries is refused. Its GIN replaces the expression index under a new name, with the
-- pending-list limit that one had (every search reads the pending list whole).
--
-- The expression index goes FIRST, so the rewrite the column's add makes does not build it again.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else writes to
-- (`packages/db/src/transition/`). Adding a stored column rewrites `messages` whole and builds every index on
-- it again, under the transaction's lock on the table; the transition's check holds the column to the
-- function's expression. A store made from empty takes it as an ordinary entry. A device's store has no
-- such index and keeps its side table (`drizzle-sqlite/0208.noop`).
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from its copy.
-- @drop_recipient_keys_expression_index
DROP INDEX "messages_recipient_keys_idx";
--> statement-breakpoint
-- @add_recipient_keys_column
ALTER TABLE "messages" ADD COLUMN "recipient_keys" text[] GENERATED ALWAYS AS (messages_recipient_keys("account_id", "to_addresses", "cc_addresses")) STORED;
--> statement-breakpoint
-- @build_recipient_keys_index
CREATE INDEX "messages_recipient_keys_column_idx" ON "messages" USING gin ("recipient_keys") WITH (gin_pending_list_limit = 256);
