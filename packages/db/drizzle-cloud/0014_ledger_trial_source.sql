-- THE TRIAL BOUNTY'S SOURCE BECOMES THE ACCOUNT'S OWN — the half of the once-per-account bound
-- that cloud 0013 did not close, and the one the product's stated rules make a database fact.
--
-- The trial exception to "no API cost without revenue behind it" rests on four bounds, and
-- the first is stated as a property of this table: "500 actions, once per account, for the life of the account … written under the
-- ledger source `trial:<account_id>` against `UNIQUE (account_id, source)`, so a second bounty
-- for an account is unrepresentable rather than merely unlikely."
--
-- ══ WHAT 0013 CLOSED, AND WHAT IT LEFT ════════════════════════════════════════════════════
--
-- 0013 made the COUNT a fact: `credit_ledger_one_trial_grant_idx` is UNIQUE on `(account_id)`
-- over un-voided `trial_grant` rows, so an account cannot hold two bounties whatever the source
-- strings say. That closed the second-pot hole and it is not re-opened here.
--
-- It left the IDENTITY. `credit_ledger_source_reason_check` still pins `trial_grant` to the
-- `trial:%` NAMESPACE and to nothing else, so this INSERT passes every layer in the schema:
--
--     grantCredits(tx, A, 500, 'trial_grant', 'trial:' || <anything at all>)
--
--   · the sign CHECK  — positive delta, `trial_grant` is in the positive list  ⇒ passes;
--   · the source CHECK — `trial:%`, any suffix, no relation to `account_id`    ⇒ passes;
--   · UNIQUE (account_id, source) — `(A, 'trial:sub_9')` is a new pair          ⇒ passes;
--   · 0013's partial unique index — A holds no other un-voided bounty          ⇒ passes;
--   · 0013's born-voided guard — no `meta.voided_at`                           ⇒ passes.
--
-- The row lands, and account A now holds its one bounty under an identity that is not A's. The
-- damage is not a second pot; it is worse in a quieter way:
--
--   1. `grantTrialCredits` — the live webhook path — asks the ACCOUNT-keyed question 0013 gave
--      it, sees the foreign-source row and answers `duplicate` FOR EVER. Account A can never
--      receive its real `trial:<A>` bounty, and nothing reports that it did not;
--   2. the ledger's own audit trail names the wrong subject for a real economic event, which is
--      exactly what `source` exists to prevent — every other namespace here identifies the
--      producing system's retry unit, and this one is supposed to identify the ACCOUNT;
--   3. the stated bound stays literally false, so a reader auditing it against the schema
--      finds a namespace where the document promises an account.
--
-- ══ WHY A TRIGGER AND NOT THE CHECK THE FINDING NAMED ═════════════════════════════════════
--
-- The finding's fix reads "tighten the CHECK to `source = 'trial:' || account_id::text`". The
-- predicate is exactly that; the CARRIER is deliberately different, for two reasons already on
-- record in this repository:
--
--   · **The VALIDATE lock.** `ALTER TABLE … ADD CONSTRAINT … CHECK` VALIDATES every existing row, holding
--     `ACCESS EXCLUSIVE` on `credit_ledger` for the whole scan — and the cloud journal applies
--     all its pending entries in ONE transaction (`src/migrate.ts`) with `lock_timeout` reset to
--     0 for exactly that stretch, so the lock is held until the pass commits and every ledger
--     reader and writer queues behind it. That is the recorded lock finding verbatim, on the money
--     table. `NOT VALID` + `VALIDATE CONSTRAINT` does not buy it back either: inside one
--     transaction the ACCESS EXCLUSIVE taken by the ADD is held to commit regardless, so the
--     split relieves nothing until the VALIDATE moves to a LATER pass. A `CREATE OR REPLACE
--     FUNCTION` takes no lock on the table at all and scans no rows.
--   · **0013's ruling, which this file follows rather than re-litigates.** A CHECK keeps firing
--     on UPDATE, and the rows this predicate names are precisely the ones the dedup runner
--     (`apps/worker/src/run-trial-grant-dedup.ts`) must be able to void in place — so a CHECK would
--     refuse the repair for the databases that need it.
--
-- BEFORE INSERT is COMPLETE coverage here and not a compromise: `credit_ledger_append_only`
-- makes INSERT the only way a row can come into existence, so a guard on INSERT is a guard on
-- every row this table will ever hold. What it does not cover is a writer that DISABLEs the
-- trigger — and that writer is met by 0013's index, which is a real constraint and cannot be
-- stepped over the same way. The two layers are tested as two layers
-- (`ledger-integrity.pg.test.ts` drops the guard and watches the index refuse the same row).
--
-- ══ THE AMOUNT IS NOT PINNED HERE, AND THAT IS DELIBERATE ═════════════════════════════════
--
-- `grantCredits(tx, A, 5_000_000, 'trial_grant', 'trial:' || A)` still satisfies everything
-- below. The bounty's SIZE is `TRIAL_GRANT_CREDITS`, a policy constant that gets edited, and
-- `src/credits.ts` sets out at length why it must not become part of a row's identity (lower it
-- and every account already holding a row at the old figure turns into a throw from inside the
-- webhook's transaction). A CHECK on the magnitude would owe a migration every time pricing
-- moves. The size is bounded one layer up instead, in the same commit: `trial_grant` leaves the
-- exported `GrantReason`, so `grantTrialCredits` — which supplies the constant itself — is the
-- only way to name the reason at all.
--
-- ══ /health ═══════════════════════════════════════════════════════════════════════════════
--
-- This migration's ONLY artifact is a replaced function body, which is invisible to every
-- catalog probe `/health` had: not `information_schema.columns`, not `pg_indexes`, and not the
-- constraint-definition probe (a function is `pg_proc`, not `pg_constraint`). 0013 named that
-- gap and rode its index past it; this file has no index to ride, so it adds the missing marker
-- class instead — `CLOUD_FUNCTION_MARKERS` in `packages/api/src/routes/health-cloud.ts`, which
-- reads `pg_proc.prosrc` and looks for the predicate below. The same class retro-covers 0013's
-- refund cap, which until now was vouched for only indirectly by the index beside it.
CREATE OR REPLACE FUNCTION credit_ledger_check_trial_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.reason = 'trial_grant' THEN
    -- 0013's guard, unchanged: voiding is a break-glass annotation of EXISTING history (owner
    -- role, append-only trigger lifted, audit row beside it), never a property a new economic
    -- event may carry. A row born voided never enters the partial index's predicate.
    IF (NEW.meta ->> 'voided_at') IS NOT NULL THEN
      RAISE EXCEPTION
        'credit_ledger: a trial_grant row cannot be INSERTED already voided (account %) — voiding '
        'is a break-glass annotation of existing history, never a property of a new grant',
        NEW.account_id;
    END IF;
    -- NEW in 0014: the bounty's source names ITS OWN ACCOUNT. `trial:<account_id>` is what
    -- `ledgerSources.trialGrant` builds and what the stated bound requires; anything else is a real grant
    -- filed under somebody else's identity.
    IF NEW.source <> 'trial:' || NEW.account_id::text THEN
      RAISE EXCEPTION
        'credit_ledger: a trial_grant for account % must be sourced trial:% (got %) — the '
        'bounty is one event in an account''s whole life and the source is what says whose',
        NEW.account_id, NEW.account_id, NEW.source;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
