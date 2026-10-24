-- THE CONNECT REMINDER JOINS THE NOTICE LEDGER (cloud 0053). The lifecycle pass mails a trial that has
-- connected no mailbox a day after it began, once per trial: one `account_lifecycle_notices` row of kind
-- `connect_reminder`, anchored at the trial's start as the entitlements program states it, claimed
-- before the send and handed back if the send fails. The kind CHECK admits the sixth word; the other
-- five are 0050's, unchanged. No column and no grant changes.
--
-- NOT VALID, on 0050's precedent: every stored row passed 0050's five-word CHECK, a subset of this one,
-- so nothing is re-read under the lock. DROP ... IF EXISTS, then ADD: the migration runs twice safely.
-- DEPLOY ORDER: migration, then API (a claim written ahead of it is refused by the old CHECK inside the
-- pass's own catch, and nothing is sent). ROLLBACK is 0050's definition, after the API.

ALTER TABLE "account_lifecycle_notices" DROP CONSTRAINT IF EXISTS "account_lifecycle_notices_kind_closed";
--> statement-breakpoint

ALTER TABLE "account_lifecycle_notices" ADD CONSTRAINT "account_lifecycle_notices_kind_closed"
  CHECK ("kind" IN ('trial_two_days', 'closed', 'erasure_week', 'reopened', 'billing_link', 'connect_reminder')) NOT VALID;
