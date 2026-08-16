-- LEDGER INTEGRITY — two money invariants move from "true through the helpers" to "true at the
-- table": at most ONE trial bounty per account EVER, and a refund can never exceed the debit it
-- reverses. Both were app-level facts before this file; app-level checks are read-then-write and
-- therefore TOCTOU-racy, and the point of both invariants is precisely the racing/replaying
-- writer the check cannot see.
--
-- ══ 1. TRIAL-ONCE, keyed by the ACCOUNT and by nothing else ════════════════════════════════
--
-- `UNIQUE (account_id, source)` plus `trial:<account_id>` already made a second bounty
-- unrepresentable FOR CALLERS OF `grantTrialCredits`, which builds that source itself. What it
-- never made unrepresentable is the row a future caller hand-writes: the source-reason CHECK
-- pins `trial_grant` to the `trial:%` NAMESPACE, not to the account, so `trial:<subscription>`
-- passes every constraint and mints a second pot on resubscribe — exactly the giveaway shape the
-- bounty must not have (the stated bound: "500 actions, once per account, for the life of the account").
--
-- The partial unique index below keys the invariant on `(account_id)` alone, so the second
-- `trial_grant` row for an account — whatever its source says, whoever writes it, however
-- concurrent — violates the index instead of landing. A concurrent pair serializes on the index
-- entry: the loser blocks until the winner commits and then raises 23505.
--
-- The `voided_at` arm of the predicate is the DEDUP escape hatch, and it earns its place the
-- hard way: a unique index CANNOT BUILD over existing duplicates, and `credit_ledger` is
-- append-only (statement-level trigger; delete is not an option and would not be taken anyway —
-- the ledger is a money record). So a pre-existing duplicate is resolved by VOIDING it in place:
-- the operator runner (`apps/worker/src/run-trial-grant-dedup.ts`, dry-run by default) keeps the
-- EARLIEST grant and stamps `meta.voided_at` (+ audit rows) on the extras under a temporarily
-- disabled append-only trigger — the row keeps its delta, its balance_after and its place in the
-- chain (no money moves; history is annotated, never rewritten), and it stops participating in
-- the index. Reversible in principle: remove the key, the row counts again.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_one_trial_grant_idx"
  ON "credit_ledger" ("account_id")
  WHERE "reason" = 'trial_grant' AND ("meta" ->> 'voided_at') IS NULL;--> statement-breakpoint

-- ══ 1b. A ROW CANNOT BE BORN VOIDED ════════════════════════════════════════════════════════
--
-- The predicate above opens one hole the index cannot close by itself: an INSERT that arrives
-- with `meta.voided_at` already set never participates in the index, so a writer that stamps its
-- own row "voided" gets a second pot that still moved real money. No live caller does that — but
-- "no caller does" is the class of guarantee this whole file exists to retire. Voiding is a
-- break-glass annotation of EXISTING history (owner role, append-only trigger disabled, audit
-- row beside it); it is not a value a new economic event may carry.
--
-- A trigger rather than a CHECK, deliberately: a CHECK validates existing rows when added (the
-- voided duplicates the dedup runner just wrote would refuse it — the runner must be able to run
-- BEFORE this migration, since the index cannot build until it has) and keeps firing on UPDATE,
-- which would refuse the runner's own future re-run. BEFORE INSERT is exactly the surface with
-- the hole, and no more.
CREATE OR REPLACE FUNCTION credit_ledger_check_trial_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.reason = 'trial_grant' AND (NEW.meta ->> 'voided_at') IS NOT NULL THEN
    RAISE EXCEPTION
      'credit_ledger: a trial_grant row cannot be INSERTED already voided (account %) — voiding '
      'is a break-glass annotation of existing history, never a property of a new grant',
      NEW.account_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "credit_ledger_trial_guard" ON "credit_ledger";--> statement-breakpoint
CREATE TRIGGER "credit_ledger_trial_guard"
  BEFORE INSERT ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_check_trial_guard();--> statement-breakpoint

-- ══ 2. THE REFUND CAP: a refund is bounded by the debit it names ═══════════════════════════
--
-- 0002's refund-origin trigger required a refund to name a REAL debit on the same account, which
-- ended refunds of nothing and refunds of refunds — but it never read the original's AMOUNT, so
-- `refund:<original>` at any magnitude passed (the review's words: "requires the refund name a real debit but
-- does not cap its magnitude"). Both live callers pass the same constant they debited, so there
-- is no user route today; this makes the cap a property of the table instead of of the callers.
--
-- The cap composes with what is already here, and the SUM never needs computing:
-- `refund:<original_source>` under `UNIQUE (account_id, source)` admits exactly ONE refund row
-- per original debit, so "this row ≤ its debit" IS "everything refunded for this scope ≤ what
-- was charged for this scope". A caller wanting the over-cap case refused as a typed error
-- rather than a raise gets that from `refundCredits` in `src/credits.ts`, which decides under
-- the balance row lock; THIS is the layer a refactor cannot buy off.
--
-- CREATE OR REPLACE under the trigger's existing function name — the 0011 replacement shape, so
-- the file re-runs cleanly and the pg tests keep asserting stable names. The trigger itself is
-- unchanged and deliberately not re-issued. NOTE for `/health`: a replaced FUNCTION BODY is
-- invisible to every catalog-name probe AND to the constraint-definition probe (it is pg_proc,
-- not pg_constraint) — this migration is probed through the INDEX above
-- (`CLOUD_INDEX_MARKERS` in `packages/api/src/routes/health-cloud.ts`), which rides the same
-- journal entry and therefore vouches for the function replacements beside it.
CREATE OR REPLACE FUNCTION credit_ledger_check_refund_origin() RETURNS trigger AS $$
DECLARE
  orig_delta integer;
BEGIN
  IF NEW.reason = 'refund' THEN
    SELECT o.delta INTO orig_delta
      FROM credit_ledger o
     WHERE o.account_id = NEW.account_id
       AND o.source = substring(NEW.source from 8)      -- strip 'refund:'
       AND o.delta < 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_ledger: refund % has no original DEBIT to reverse on account %',
        NEW.source, NEW.account_id;
    END IF;
    IF NEW.delta > -orig_delta THEN
      RAISE EXCEPTION
        'credit_ledger: refund % on account % credits % but the original debit moved only % — '
        'a refund cannot exceed the charge it reverses',
        NEW.source, NEW.account_id, NEW.delta, -orig_delta;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
