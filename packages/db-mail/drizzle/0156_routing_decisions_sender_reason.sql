-- 0156_routing_decisions_sender_reason — WHICH FACT CAPPED A STORED SUGGESTION.
--
-- `routing_decisions.sender_reason`: on a stored Screener suggestion (provenance 'screener_suggestion'),
-- the sender check's code that capped it (`impersonation`, `campaign`, `auth_fail`, `brand_mismatch`,
-- `correspondent`), or `none` where no fact did; written by the two suggestion writers. The act on
-- suggestions reads it before it writes a standing deny rule: a crowd's cap (one subject from other
-- first-time senders) is no fact about the address, so such advice files its letter alone. NULL means
-- stored before this column (and every row that is not a suggestion); the reader fails closed on NULL
-- and on any value it does not know, so there is no CHECK (the set grows) and no default, no backfill.
-- Metadata-only on Postgres 11 and later. Not granted to staff. DEPLOY ORDER: migration, then API, then
-- worker. ROLLBACK: drop the column.

ALTER TABLE "routing_decisions" ADD COLUMN IF NOT EXISTS "sender_reason" text;
