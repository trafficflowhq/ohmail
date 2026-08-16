-- THE TRIAL BOUNTY — a new ledger `reason` (`trial_grant`) and the `trial:` source namespace it
-- is pinned to.
--
-- ══ WHAT CHANGES, AND WHY IT IS TWO CONSTRAINT REPLACEMENTS AND NOTHING ELSE ══════════════
--
-- The trial used to grant no credits at all, so `aiEnabled = balance > 0` turned managed AI off
-- for a trial account through the ordinary rule. That is being reversed: a trial account is now
-- granted a fixed allowance once, so it can actually see the feature the plan cards advertise.
--
-- The grant itself needs no schema. `credit_ledger` already holds positive deltas with a reason
-- and a source, and `UNIQUE (account_id, source)` already means "this economic event happened at
-- most once for this account". What the schema DOES have to learn is the vocabulary, because two
-- CHECK constraints enumerate it and both would otherwise refuse the row:
--
--   · `credit_ledger_sign_reason_check` — a reason not in either list is unwritable, whatever
--     its sign. `trial_grant` joins the POSITIVE list.
--   · `credit_ledger_source_reason_check` — each reason is pinned to its source prefix, which is
--     what stops a debit from colliding with an invoice's dedup identity and being reported back
--     as a harmless duplicate. `trial_grant` is pinned to `trial:%`.
--
-- Postgres cannot amend a CHECK in place, so each is dropped and re-added under the SAME NAME.
-- The names are asserted by a real-Postgres test that reads `pg_constraint`, so a rename here
-- would be caught, and keeping them stable is also what lets this file be re-run: `DROP … IF
-- EXISTS` followed by `ADD` is idempotent where the earlier `DO $$ … EXCEPTION WHEN
-- duplicate_object` form was merely non-fatal.
--
-- ══ WHY `trial_grant` IS ITS OWN REASON RATHER THAN AN `adjustment_credit` ═════════════════
--
-- An `adjustment_credit` is pinned to `admin:%`, and that namespace is a fresh uuid per
-- adjustment — one economic event per CALL. The trial bounty is one economic event per ACCOUNT,
-- for the whole life of the account, and it has two independent callers that cannot see each
-- other: the subscription-event handler (which runs again on every redelivery and every later
-- update) and a one-shot backfill for accounts that were already trialing when the policy
-- changed. Under an `admin:<uuid>` source each of those calls would be a new event and the
-- account would be granted repeatedly. Under `trial:<account_id>` the second write of any number
-- of them answers `duplicate` and moves no money.
--
-- The second reason is legibility of the audit trail. `adjustment_credit` means a human decided
-- something; a query for "who has staff compensated" must not return every trial account in the
-- product.
--
-- ══ NO BACKFILL IN THIS FILE, AND THAT IS DELIBERATE ══════════════════════════════════════
--
-- Accounts already sitting in `trialing` when this lands are granted by a separate one-shot
-- runner (dry-run by default), not by a statement here. A migration that moves money is a
-- migration that cannot be inspected before it runs, cannot be run against a copy first, and
-- cannot report what it did — and it would run inside the deploy, where a partial answer is
-- least recoverable. The runner uses the same `trial:<account_id>` source as the live path, so
-- running it before, after or twice around a deploy makes no difference to the result.
--
-- ══ THIS FILE WAS AUTHORED AS `0010` AND RENUMBERED ═══════════════════════════════════════
--
-- `0010_desktop_link_pkce` was written concurrently and landed on the default branch first, so
-- this one collided twice: on the TAG, and — worse — on the ORDER. Its original `when` sat BELOW
-- that entry's, and the migrator applies an entry only while the greatest `created_at` already in
-- its table is below that entry's `when`. Left as it was, this migration would have been skipped
-- SILENTLY AND PERMANENTLY on every database that took the other one first, and the first symptom
-- would have been a constraint violation from inside a caller's transaction with nothing naming a
-- migration.
--
-- The SQL below did not change. Only the number, and the `when` in the journal, which now clears
-- the highest value either journal or the shared test database has ever held.

ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_sign_reason_check";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_sign_reason_check" CHECK (
  ("delta" > 0 AND "reason" IN ('invoice_grant','refund','adjustment_credit','trial_grant'))
  OR
  ("delta" < 0 AND "reason" IN ('period_expiry','debit_classify','debit_draft',
                                'debit_propose','debit_workflow','adjustment_debit'))
);--> statement-breakpoint

ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_source_reason_check";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_source_reason_check" CHECK (
  ("reason" = 'invoice_grant'      AND "source" LIKE 'invoice:%')
  OR ("reason" = 'period_expiry'   AND "source" LIKE 'expiry:%')
  OR ("reason" = 'debit_classify'  AND "source" LIKE 'classify:%')
  OR ("reason" = 'debit_draft'     AND "source" LIKE 'draft:%')
  OR ("reason" = 'debit_propose'   AND "source" LIKE 'propose:%')
  OR ("reason" = 'debit_workflow'  AND "source" LIKE 'workflow_run:%')
  OR ("reason" = 'refund'          AND "source" LIKE 'refund:%')
  OR ("reason" = 'trial_grant'     AND "source" LIKE 'trial:%')
  OR ("reason" IN ('adjustment_credit','adjustment_debit') AND "source" LIKE 'admin:%')
);
