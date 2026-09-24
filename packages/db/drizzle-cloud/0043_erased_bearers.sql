-- THE TOKENS OF AN ERASED ACCOUNT, KEPT BY HASH (cloud 0043). The erasure deletes every session
-- and refresh token in the transaction that stamps `accounts.erased_at`, so an installed app
-- still holding one was answered as a stranger (401) and renewed for ever. The erasure now copies
-- each LIVE token's hash here first, and the session door tells a client that asks for it
-- `410 account_erased` instead. A SHA-256 of a random secret and the pseudonymous account id:
-- nothing that names a person. A row is inert past `expires_at`; the worker prunes it.
--
-- DEPLOY ORDER: migration, then API (an erasure ahead of it 42P01s; the marker names it first).
-- ROLLBACK is `DROP TABLE erased_bearers` after the API; an erased app then hears 401 again.

CREATE TABLE IF NOT EXISTS "erased_bearers" (
  "token_hash" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL
);
