-- 0171_messages_arrival_key — the arrival index on the key that no longer lets a header after its
-- arrival decide (`Dialect.arrivalKey`): the header while it lies at most 48 h before a known
-- arrival, else the arrival; an undated row at the epoch. A letter dated two days ahead sat above
-- every newer arrival under 0139's key. The expression is IMMUTABLE and byte-equal to the dialect's
-- own text. `db:setup:prod` builds it CONCURRENTLY on its pre-migration session
-- (ARRIVAL_ORDER_PREBUILD_SPEC), so on a live server this statement finds it and no-ops.
-- 0139's `messages_account_arrival_order_idx` stays for the API and worker still running until the
-- deploy finishes; a later migration drops it.
-- DEPLOY ORDER: setup, migration, API, worker. The statement repeats safely.
-- ROLLBACK: DROP INDEX IF EXISTS "messages_account_arrival_key_idx";

create index if not exists "messages_account_arrival_key_idx"
      on public.messages using btree ("account_id",(case when "arrived_at" is null then coalesce("date", 'epoch'::timestamptz) when "date" is null then "arrived_at" when "date" <= "arrived_at" and "arrived_at" - "date" <= interval '48 hours' then "date" else "arrived_at" end) desc,"id" desc)
      where "deleted_at" is null;
