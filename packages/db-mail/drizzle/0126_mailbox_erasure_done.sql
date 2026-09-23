-- WHEN A MAILBOX'S ERASURE FINISHED — one nullable column beside mail 0111's `erased_at`.
--
-- Erasing ohmail's copy of a mailbox's mail no longer fits in the request that asks for it: one
-- transaction over a large mailbox measured past the request's own ceiling. So the request stamps
-- `erased_at` and answers, and the worker's `mailbox_erasure` pass sweeps the rows in bounded
-- steps. `erased_at` set with this column NULL is an erasure still owed; the pass resumes from that
-- pair alone and sets this column in the same transaction as the sweep's last step.
--
-- BACKFILLED for every existing stamp: before this migration the stamp and the whole sweep were
-- one transaction, so a stamped row is a finished erasure. Additive and `IF NOT EXISTS`, so a
-- desktop engine replaying this journal at every launch applies it repeatedly without effect.
-- ROLLBACK is `DROP INDEX mailboxes_erasure_owed_idx; ALTER TABLE mailboxes DROP COLUMN
-- erasure_done_at`, after which no erasure may be requested until the code is rolled back too.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "erasure_done_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "mailboxes" SET "erasure_done_at" = "erased_at"
  WHERE "erased_at" IS NOT NULL AND "erasure_done_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailboxes_erasure_owed_idx" ON "mailboxes" ("erased_at")
  WHERE "erased_at" IS NOT NULL AND "erasure_done_at" IS NULL;
