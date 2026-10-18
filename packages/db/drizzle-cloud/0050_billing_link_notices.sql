-- THE BILLING LINK JOINS THE NOTICE LEDGER (cloud 0050). Staff may mail an account's owner a link to
-- the app's billing page (`POST /admin/accounts/:id/billing-link`), at most three per account in any
-- 24 hours; each claimed send is one `account_lifecycle_notices` row of kind `billing_link`, anchored
-- at the press, and the cap is a count of those rows. The kind CHECK admits the fifth word; the other four
-- are 0040's, unchanged. No column and no grant changes: the staff role already reads all four.
--
-- NOT VALID, on 0044's precedent: every stored row passed 0040's four-word CHECK, a subset of this
-- one, so nothing is re-read under the lock.
-- DEPLOY ORDER: migration, then API (a claim written ahead of it is refused by the old CHECK, and the
-- route answers 503 with nothing sent). ROLLBACK is 0040's definition, after the API.

ALTER TABLE "account_lifecycle_notices" DROP CONSTRAINT IF EXISTS "account_lifecycle_notices_kind_closed";
--> statement-breakpoint

ALTER TABLE "account_lifecycle_notices" ADD CONSTRAINT "account_lifecycle_notices_kind_closed"
  CHECK ("kind" IN ('trial_two_days', 'closed', 'erasure_week', 'reopened', 'billing_link')) NOT VALID;
