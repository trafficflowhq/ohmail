-- 0161_mailboxes_account_idx — the mailbox list read by account. `GET /mailboxes` reads the caller's
-- mailboxes in id order on every poll, and with no index led by `account_id` it walked every
-- mailbox of the store. `db:setup:prod` builds it CONCURRENTLY ahead of the migrator
-- (MAILBOXES_ACCOUNT_PREBUILD_SPEC), so on a live server this statement finds it and no-ops.
-- DEPLOY ORDER: migration, then API. The statement repeats safely.
-- ROLLBACK: DROP INDEX IF EXISTS "mailboxes_account_idx";

create index if not exists "mailboxes_account_idx" on public.mailboxes using btree ("account_id","id");
