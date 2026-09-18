-- THE HONEST ARRIVAL — when the IMAP server received this message (INTERNALDATE), NULL where the
-- adapter could not say. `created_at` is when THIS mirror ingested the row, which for a backfilled
-- mailbox is the import day, months after the truth — so nothing may clamp a sender-written
-- `date` against `created_at`, and the Ohbox sorted by the raw header — a header months
-- from arrival took a position months from where the reader watched the row. No backfill: NULL
-- means "arrival not recorded" and every old row keeps its header-keyed position unchanged.
-- Additive, `IF NOT EXISTS`, no default. ROLLBACK: ALTER TABLE messages DROP COLUMN arrived_at.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "arrived_at" timestamp with time zone;
