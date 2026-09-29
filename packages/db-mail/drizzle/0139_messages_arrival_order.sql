-- 0139_messages_arrival_order — the index every store order of mail walks: the arrival key.
--
-- The view lists, History, its month rail and the snapshot window page by `Dialect.arrivalKey`
-- (the header within 48 h of a known arrival, else the arrival; an undated row at the epoch), the
-- order every client sorts by. Non-null, so a deep page is one btree range. The expression is
-- IMMUTABLE and byte-equal to the dialect's own text. `db:setup:prod` builds it CONCURRENTLY on its
-- pre-migration session (ARRIVAL_ORDER_PREBUILD_SPEC), so on an install past mail 0119 this
-- statement finds it and no-ops. A store below 0119 has no `arrived_at` when the prebuild looks, and
-- takes the build here, blocking writes to `messages` while it runs. ROLLBACK: `DROP INDEX IF EXISTS`.

create index if not exists "messages_account_arrival_order_idx"
      on public.messages using btree ("account_id",(case when "arrived_at" is null then coalesce("date", 'epoch'::timestamptz) when "date" is null then "arrived_at" when "date" - "arrived_at" <= interval '48 hours' and "arrived_at" - "date" <= interval '48 hours' then "date" else "arrived_at" end) desc,"id" desc)
      where "deleted_at" is null;
