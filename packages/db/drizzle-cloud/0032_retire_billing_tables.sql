-- Retire the metering tables from this schema.
--
-- Subscription billing and credit accounting are no longer part of this server. Sixteen tables
-- are left over on a deployment that once ran them, and this drops them — but ONLY where they
-- are empty, and never as a blanket DROP.
--
-- WHY THE EMPTINESS GUARD IS THE WHOLE MIGRATION. A self-hosted install never wrote a row to any
-- of them, so dropping them there loses nothing. An install that DID meter holds the only copy of
-- somebody's money trail in `credit_ledger`, and a migration that removed it would be a data loss
-- this file cannot ask anybody to accept. So a non-empty table is LEFT WHERE IT IS and named in a
-- warning: the operator moves or archives it deliberately, and re-running this migration then
-- finishes the job.
--
-- Children before parents, so the one foreign key between them (`setup_grant_spends` →
-- `setup_grants`) never needs a CASCADE. Idempotent: `IF EXISTS` throughout, and a second run
-- over a schema that already has none of them does nothing and says nothing.
DO $$
DECLARE
  t text;
  n bigint;
  remaining int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'setup_grant_spends', 'setup_grants',
    'credit_usage_daily', 'credit_usage_totals', 'credit_rollup_runs',
    'credit_ledger', 'credit_balances',
    'ai_attempt_claims', 'ai_usage_daily',
    'platform_costs',
    'billing_invoices', 'billing_reconciliation_runs', 'billing_events',
    'billing_subscriptions', 'billing_customers',
    'account_suspensions'
  ]
  LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n = 0 THEN
      EXECUTE format('DROP TABLE public.%I', t);
    ELSE
      remaining := remaining + 1;
      RAISE WARNING 'retire_billing_tables: public.% holds % row(s) and was LEFT IN PLACE; move or archive it, then re-run this migration', t, n;
    END IF;
  END LOOP;

  -- The ledger's own trigger FUNCTIONS. A `DROP TABLE` takes its triggers and leaves these
  -- behind, so they would outlive every table they were written for. Dropped only when nothing
  -- was left standing: a surviving table still has triggers that reference them.
  IF remaining = 0 THEN
    DROP FUNCTION IF EXISTS public.credit_assert_coupled();
    DROP FUNCTION IF EXISTS public.credit_ledger_block_mutation();
    DROP FUNCTION IF EXISTS public.credit_ledger_check_refund_origin();
    DROP FUNCTION IF EXISTS public.credit_ledger_check_trial_guard();
  ELSE
    RAISE WARNING 'retire_billing_tables: % table(s) left in place, so the ledger trigger functions stay with them', remaining;
  END IF;
END
$$;
