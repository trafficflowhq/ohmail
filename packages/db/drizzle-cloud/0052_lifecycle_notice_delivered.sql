-- WHEN A LIFECYCLE NOTICE WAS DELIVERED (cloud 0052). Until now a notice row was written as the pass's
-- claim, before the send, and kept whatever the mailer answered: a send every recipient skipped read as
-- sent, and a pass that died between the claim and the send left a row that was never sent. `delivered_at`
-- is stamped only once the provider accepted the mail for at least one of the account's users and no
-- send failed. The erasure door reads it: a retention erasure runs only after the erasure-week warning
-- for its date was delivered, and it keeps that one row, so the warning stays on record after the
-- erasure under the account's random id alone. `sent_at` keeps its meaning (the claim, and for a
-- `reopened` row the told time); `reopened` and `billing_link` rows never carry a delivery.
--
-- Rows from before this migration count as delivered: nothing can tell otherwise now.
--
-- LOCK-WAIT: a brief ACCESS EXCLUSIVE on account_lifecycle_notices for the nullable column (no rewrite), then
-- one UPDATE over its rows; the lifecycle pass's claims wait until the pass commits. No other table.
-- DEPLOY ORDER: migration, then API. An API ahead of it fails every claim (42703) inside the pass's own
-- catch and its erasure door answers 503, so nothing is sent or erased; an old API's pass between the two
-- writes rows the new one reads as undelivered claims and sends once more.
-- ROLLBACK is `ALTER TABLE "account_lifecycle_notices" DROP COLUMN "delivered_at"`, after the API is
-- rolled back.

ALTER TABLE "account_lifecycle_notices" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
--> statement-breakpoint

UPDATE "account_lifecycle_notices" SET "delivered_at" = "sent_at"
  WHERE "delivered_at" IS NULL AND "kind" IN ('trial_two_days', 'closed', 'erasure_week');
