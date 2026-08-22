-- REPLAN 2026-08-21 — move EVERY existing subscription row to the current plan card.
--
-- The 2026-08-21 re-pricing changed all three sold-at allowances (mailboxes 5/10/50 → 2/5/10,
-- credits 2 000/6 000/20 000 → 1 000/2 000/4 000, storage 5/15/50 GB → 2/5/10 GB) and — unlike
-- every earlier card change — was RATIFIED to apply to existing rows as well as new sales. The
-- sale-time CASE guard in `entitlements-service.ts#mirrorSubscription` is untouched and still
-- owns these columns from here forward: a routine subscription event cannot re-price a row, so
-- the values this file writes stick until a customer's PRICE genuinely moves.
--
-- What this deliberately does NOT do: touch any mailbox row. Accounts holding more enabled
-- mailboxes than the new limit keep every one of them working — the limit gates NEW connects
-- (and re-enables) only, in `mailbox-allowance.ts`. The retention disabler that once shrank
-- over-limit accounts on downgrade events is removed in the same change as this file.
--
-- Plan-keyed and value-idempotent: a re-run finds the values already written and updates zero
-- rows' worth of change (the WHERE guards keep `updated_at` honest on re-runs).
UPDATE "billing_subscriptions"
   SET "mailbox_limit" = 2, "monthly_credits" = 1000, "storage_bytes_limit" = 2000000000,
       "updated_at" = now()
 WHERE "plan" = 'solo'
   AND ("mailbox_limit" <> 2 OR "monthly_credits" <> 1000 OR "storage_bytes_limit" <> 2000000000);
--> statement-breakpoint
UPDATE "billing_subscriptions"
   SET "mailbox_limit" = 5, "monthly_credits" = 2000, "storage_bytes_limit" = 5000000000,
       "updated_at" = now()
 WHERE "plan" = 'plus'
   AND ("mailbox_limit" <> 5 OR "monthly_credits" <> 2000 OR "storage_bytes_limit" <> 5000000000);
--> statement-breakpoint
UPDATE "billing_subscriptions"
   SET "mailbox_limit" = 10, "monthly_credits" = 4000, "storage_bytes_limit" = 10000000000,
       "updated_at" = now()
 WHERE "plan" = 'pro'
   AND ("mailbox_limit" <> 10 OR "monthly_credits" <> 4000 OR "storage_bytes_limit" <> 10000000000);
