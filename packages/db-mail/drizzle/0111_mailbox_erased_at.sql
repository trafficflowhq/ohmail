-- THE MAILBOX ERASURE FENCE — one nullable column on `mailboxes`, the twin of `accounts.erased_at`.
--
-- A mailbox removal writes a TOMBSTONE: `MailboxService.remove` sets `status = 'disabled'` and
-- deletes the credentials, and `sweepMailboxData` empties every table keyed on the mailbox — but
-- the `mailboxes` ROW SURVIVES. So a NOT NULL foreign key to `mailboxes` refuses nothing after a
-- mailbox erasure, and a write already past its eligibility read lands afterwards and recreates
-- the person's correspondents, drafts and decisions under a mailbox they removed.
--
-- NULL for every live mailbox and for every mailbox removed WITHOUT erasure; the instant of the
-- erasure otherwise, stamped inside the same transaction as the sweep with `coalesce`, so a
-- retried erasure keeps the first stamp. It is its own column and not a reading of `status`
-- because `status = 'disabled'` is also what a stand-down and a hand-disable write: those are
-- mailboxes somebody may still use, and a fence on them would refuse ordinary work.
--
-- Additive, `IF NOT EXISTS`, no default and no backfill, so a desktop engine replaying this
-- journal at every launch applies it repeatedly without effect. ROLLBACK is
-- `ALTER TABLE mailboxes DROP COLUMN erased_at`: the fence falls back to the account's scope.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "erased_at" timestamp with time zone;
