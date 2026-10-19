-- 0154_messages_recipient_keys — the device store's twin of the pg entry's recipient index.
--
-- This store has no expression GIN, so the keys live in a side table kept by triggers on
-- `messages`, the full-text tables' pattern: one row per (message, lowercased To or Cc address),
-- an address over 254 characters or an entry that is not an object with an address skipped. No
-- foreign key: the delete trigger owns removal. The last two statements fill it from the rows
-- already stored (the whole store at open, 0138's accepted class). Replay-safe: IF NOT EXISTS and
-- INSERT OR IGNORE throughout.

CREATE TABLE IF NOT EXISTS "message_recipients" (
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "address" text NOT NULL,
  PRIMARY KEY ("message_id", "address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_recipients_account_address_idx" ON "message_recipients" ("account_id", "address", "message_id");
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_recipients_after_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
    SELECT new.account_id, new.id, lower(je.value ->> '$.address')
      FROM json_each(CASE WHEN json_valid(new.to_addresses) THEN new.to_addresses ELSE '[]' END) je
     WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
  INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
    SELECT new.account_id, new.id, lower(je.value ->> '$.address')
      FROM json_each(CASE WHEN json_valid(new.cc_addresses) THEN new.cc_addresses ELSE '[]' END) je
     WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_recipients_after_update AFTER UPDATE OF to_addresses, cc_addresses, account_id ON messages BEGIN
  DELETE FROM message_recipients WHERE message_id = old.id;
  INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
    SELECT new.account_id, new.id, lower(je.value ->> '$.address')
      FROM json_each(CASE WHEN json_valid(new.to_addresses) THEN new.to_addresses ELSE '[]' END) je
     WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
  INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
    SELECT new.account_id, new.id, lower(je.value ->> '$.address')
      FROM json_each(CASE WHEN json_valid(new.cc_addresses) THEN new.cc_addresses ELSE '[]' END) je
     WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_recipients_after_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_recipients WHERE message_id = old.id;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
  SELECT m.account_id, m.id, lower(je.value ->> '$.address')
    FROM messages m, json_each(CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END) je
   WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
--> statement-breakpoint
INSERT OR IGNORE INTO message_recipients (account_id, message_id, address)
  SELECT m.account_id, m.id, lower(je.value ->> '$.address')
    FROM messages m, json_each(CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END) je
   WHERE je.type = 'object' AND coalesce(je.value ->> '$.address', '') <> '' AND length(je.value ->> '$.address') <= 254;
