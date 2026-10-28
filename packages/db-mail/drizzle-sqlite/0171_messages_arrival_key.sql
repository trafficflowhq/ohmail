-- 0171_messages_arrival_key — the pg entry's arrival index, on this store's epoch milliseconds.
--
-- The key no longer lets a header after its arrival decide; byte-equal to the dialect's own text.
-- The device's code and store move together, so 0139's index goes in the same entry. Replay-safe.

DROP INDEX IF EXISTS "messages_account_arrival_order_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_account_arrival_key_idx" ON "messages" ("account_id", (case when "arrived_at" is null then coalesce("date", 0) when "date" is null then "arrived_at" when "date" <= "arrived_at" and "arrived_at" - "date" <= 172800000 then "date" else "arrived_at" end) DESC, "id" DESC) WHERE "deleted_at" IS NULL;
