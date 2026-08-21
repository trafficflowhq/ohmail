-- STORAGE_BYTES_LIMIT — the third sold-at entitlement on the subscription row: the
-- managed stored-body cap in bytes, beside `mailbox_limit` and `monthly_credits` and on their
-- exact argument. Denormalized at sale time so a later plan-card change cannot retro-rewrite
-- what a live customer bought; the mirror upsert grandfathers it with the same price-moves-only
-- CASE as its two siblings (`entitlements-service.ts#mirrorSubscription`).
--
-- The card values at this migration's writing (DECIMAL gigabytes, so the shown number is the
-- enforced number): solo 5 GB, plus 15 GB, pro 50 GB. `bigint` because the smallest already
-- outruns int4.
--
-- ══ THE BACKFILL SEEDS EXISTING ROWS FROM TODAY'S CARD ═══════════════════════════════════════
--
-- Ordinarily a sold-at column may never be rewritten from PLAN_LIMITS — but these rows were
-- sold before the column existed, so today's card is the only honest value there is, and every
-- existing customer GAINS an entitlement at today's number (nothing they had shrinks: the cap
-- did not exist). From this row forward the CASE guard owns it.
--
-- Three statements so the NOT NULL lands on a fully populated column; each is idempotent
-- (IF NOT EXISTS / WHERE IS NULL / SET NOT NULL re-run is a no-op on a NOT NULL column).
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "storage_bytes_limit" bigint;
--> statement-breakpoint
UPDATE "billing_subscriptions"
   SET "storage_bytes_limit" = CASE "plan"
                                 WHEN 'solo' THEN 5000000000
                                 WHEN 'plus' THEN 15000000000
                                 WHEN 'pro'  THEN 50000000000
                               END
 WHERE "storage_bytes_limit" IS NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "storage_bytes_limit" SET NOT NULL;
--> statement-breakpoint
-- The floor of last resort, like `mailbox_limit >= 0` beside it.
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_sub_storage_limit_nonneg";
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_sub_storage_limit_nonneg"
  CHECK ("storage_bytes_limit" >= 0);
