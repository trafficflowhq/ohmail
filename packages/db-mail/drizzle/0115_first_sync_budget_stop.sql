-- WHERE THE FIRST SYNC STOPPED — two columns on `mailbox_folders`, so a budgeted pass that ran
-- out mid-mailbox resumes where it was instead of returning to INBOX.
--
-- A sync pass carries one byte budget for the whole mailbox and reports the folder it did not
-- reach (`ChangeBatch.budgetStop`). The adapter remembered that in memory, so it survived every
-- cycle of one attachment and nothing else: a restart or a re-attach after a connection error
-- began again at INBOX, and a mailbox whose first folders each hold a large message could spend
-- every pass on them while the tail waited. Nothing was ever lost — every folder past the stop
-- kept its stored cursor — only the lead.
--
-- TWO columns and not one: the stopped folder's cursor is deliberately NOT advanced, so this
-- row's own `uidvalidity` is last pass's epoch or NULL, never the one the server stated at the
-- stop — a uid under the wrong epoch names a different message. The pair travels together.
-- At most one row per mailbox carries it: the writer clears the mailbox's rows and sets one.
-- NULL is "this folder is not where the last pass stopped", which is every existing row.
--
-- Additive, `IF NOT EXISTS`, no default and no backfill, so a desktop engine replaying this
-- journal at every launch applies it repeatedly without effect. ROLLBACK is two DROP COLUMNs:
-- every mailbox goes back to leading with INBOX after a restart.

ALTER TABLE "mailbox_folders" ADD COLUMN IF NOT EXISTS "budget_stop_uid" bigint;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN IF NOT EXISTS "budget_stop_uidvalidity" bigint;
