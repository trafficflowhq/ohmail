-- WHERE A SIGNED-OUT MAILBOX LIVES — one nullable column beside mail 0108's `signed_out_at`.
--
-- A sign-out removes every credential row, and a mailbox's server, port, TLS mode and login lived
-- only in those rows' `meta`, so the pass-only "Sign in again" press was refused "imap host is
-- required". The sign-out copies the NON-SECRET half here in the same transaction — host, port,
-- secure and user per transport, never a password or a key — and a credential write on a mailbox
-- with no row merges over it. `MailboxService.delete` clears it. Nullable, no default, no
-- backfill; idempotent, because a desktop engine replays this journal at every launch.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "signed_out_meta" jsonb;
