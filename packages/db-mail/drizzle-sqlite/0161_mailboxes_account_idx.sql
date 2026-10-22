-- 0161_mailboxes_account_idx — the pg entry's twin: the mailbox list read by account. Replay-safe.

CREATE INDEX IF NOT EXISTS "mailboxes_account_idx" ON "mailboxes" ("account_id", "id");
