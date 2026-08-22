-- ADD-ONS AND BILLING INTERVAL on the subscription mirror.
--
-- Two paid add-ons exist as separate recurring Stripe line items on the SAME subscription:
-- +10 GB of stored-body room and +1 mailbox. The billing plane labels those items on the
-- `EntitlementEvent` DTO (`addon: "storage" | "mailbox"`), and the mirror denormalizes their
-- QUANTITIES here. Unlike the three sold-at plan allowances beside them, these two columns
-- move on EVERY admitted subscription event — an add-on change arrives as
-- `customer.subscription.updated` with the plan price unchanged, so the price-moves-only CASE
-- guard must not apply to them; the `stripe_event_ts` fence still orders the writes.
--
-- `entitlementsFor` composes the effective allowance: `mailbox_limit + addon_mailboxes`
-- mailboxes, `storage_bytes_limit + addon_storage_units × 10 GB` bytes.
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "addon_storage_units" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "addon_mailboxes" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_sub_addons_nonneg";
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_sub_addons_nonneg"
  CHECK ("addon_storage_units" >= 0 AND "addon_mailboxes" >= 0);
--> statement-breakpoint
-- The plan's billing cadence — a property of the PRICE, so it moves under the same
-- price-moves-only CASE as the three allowances. An annual subscription's cycle invoice grants
-- twelve months of credits at once (`entitlements-service.ts#monthlyCreditsFor` multiplies by
-- this), which is what keeps "1 000 credits a month" a true sentence for a customer who paid
-- for a year of them up front.
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "billing_interval" text NOT NULL DEFAULT 'month';
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_sub_interval_check";
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_sub_interval_check"
  CHECK ("billing_interval" IN ('month', 'year'));
