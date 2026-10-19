-- 0154_messages_recipient_keys — the archive searched by recipient. An IMMUTABLE function turns a
-- message's To and Cc into `<account>:<lowercased address>` keys, and a GIN index over it serves the
-- address search's `to` and `any` directions. No column and no UPDATE: the index is over the
-- columns that already hold the recipients, so an old row is found once the index exists. The key
-- carries the account, so the index itself is account-scoped (an address is attacker-choosable).
-- An address over 254 characters (MAX_STORED_ADDRESS_CHARS) is not indexed, never cut. The pending
-- list is bounded as 0152 bounds the others. `db:setup:prod` creates the function and builds the
-- index CONCURRENTLY ahead of the migrator (RECIPIENT_KEYS_PREBUILD_SPEC), so on a live server both
-- statements here no-op. The function body is frozen once shipped: another meaning is a new
-- function and a new index, never a CREATE OR REPLACE with a different body.
-- DEPLOY ORDER: migration, then API. Every statement repeats safely.
-- ROLLBACK: DROP INDEX IF EXISTS "messages_recipient_keys_idx"; DROP FUNCTION IF EXISTS messages_recipient_keys(uuid,jsonb,jsonb);

CREATE OR REPLACE FUNCTION messages_recipient_keys(account_id uuid, to_addresses jsonb, cc_addresses jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  select coalesce(array_agg(distinct account_id::text || ':' || lower(e.addr)), '{}'::text[])
    from (select v ->> 'address' as addr from jsonb_array_elements(case when jsonb_typeof(to_addresses) = 'array' then to_addresses else '[]'::jsonb end) v
          union all
          select v ->> 'address' from jsonb_array_elements(case when jsonb_typeof(cc_addresses) = 'array' then cc_addresses else '[]'::jsonb end) v) e
   where e.addr is not null and e.addr <> '' and length(e.addr) <= 254
$$;
--> statement-breakpoint
create index if not exists "messages_recipient_keys_idx" on public.messages using gin (messages_recipient_keys("account_id","to_addresses","cc_addresses")) with (gin_pending_list_limit = 256);
