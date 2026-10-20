-- 0157_messages_sender_date — the Screener cutline probe's index: a held sender's mail by the
-- instant the cutline dates it by (`cutlineInstant`, `coalesce(date, created_at)`), within one
-- account and one lowered sender. With a baseline the probe states its window as a range of this
-- key, so it reads the sender's mail inside the window instead of dating every message from the
-- heap. The key is byte-equal to the cutline's own rendering (a test). `db:setup:prod` builds it
-- CONCURRENTLY ahead of the migrator (SENDER_DATE_PREBUILD_SPEC), so on a live server this
-- statement finds it and no-ops; a desktop store builds it here, once.
-- DEPLOY ORDER: migration, then API. The statement repeats safely.
-- ROLLBACK: DROP INDEX IF EXISTS "messages_account_sender_date_idx";

create index if not exists "messages_account_sender_date_idx" on public.messages using btree ("account_id",lower("from_address"),(coalesce("date", "created_at")));
