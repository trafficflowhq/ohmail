-- 0157_messages_sender_date — the pg entry's sender-date index, on this store's epoch milliseconds.
--
-- The cutline probe's own key, byte-equal to `cutlineInstant`'s rendering, so the probe's window
-- range takes it. Replay-safe.

CREATE INDEX IF NOT EXISTS "messages_account_sender_date_idx" ON "messages" ("account_id", lower("from_address"), coalesce("date", "created_at"));
