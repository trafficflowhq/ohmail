-- THE SEARCH DOCUMENT — one row per message, written at ingest from the parsed message and by a
-- store-only backfill for rows ingested before this entry. Two word vectors, each its own GIN, so
-- a broad word never ranks every body: `head_tsv` (subject A, senders/recipients/attachment names
-- B — small, ranked) and `text_tsv` (the body text, walked newest first). `terms` is the lower-cased
-- header corpus the substring arm reads through its trigram index (`search-setup.ts`). `source`
-- says where the body words came from — stored text, text derived from the stored html, or none.
-- Indexes built HERE:
-- the table is new and empty, so the build costs nothing and a PGlite store replays it. The
-- History index is 0071's pattern — the setup command prebuilds it CONCURRENTLY ahead of the
-- migrator (`search-setup.ts`), so this statement no-ops wherever mail already lives.
-- ROLLBACK: DROP TABLE message_search; ALTER TABLE account_settings DROP COLUMN search_index_built_at.

CREATE TABLE IF NOT EXISTS "message_search" (
  "message_id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "head_tsv" tsvector NOT NULL,
  "text_tsv" tsvector NOT NULL,
  "terms" text DEFAULT '' NOT NULL,
  "source" text NOT NULL,
  "built_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_search_source_closed" CHECK ("source" IN ('text', 'html', 'headers_only')),
  CONSTRAINT "message_search_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_search_head_tsv_idx" ON "message_search" USING gin ("head_tsv");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_search_text_tsv_idx" ON "message_search" USING gin ("text_tsv");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_search_account_idx" ON "message_search" USING btree ("account_id","message_id");
--> statement-breakpoint
create index if not exists "messages_account_msg_order_idx"
      on public.messages using btree ("account_id","date" desc nulls last,"id" desc)
      where "deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "search_index_built_at" timestamp with time zone;
