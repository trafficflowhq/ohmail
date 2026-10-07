-- THE OPEN READ — when this message was read in ohmail while its conversation was the row open in
-- the reader. Earlier places a row by max(arrival, open_read_at), so a message opened, read and left
-- takes the top of Earlier; every other read (bulk, another mail app, the Screener) writes nothing
-- here and keeps arrival. One writer: `MessageService.markSeen` with `openRead`. Every unread clears
-- it. No backfill: NULL means arrival, and nothing is derived from `last_read_at`. No index, no
-- default. Additive, `IF NOT EXISTS`. ROLLBACK: ALTER TABLE messages DROP COLUMN open_read_at.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "open_read_at" timestamp with time zone;
