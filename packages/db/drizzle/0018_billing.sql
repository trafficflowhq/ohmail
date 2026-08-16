-- BILLING + the CREDIT LEDGER (migration 0018).
--
-- Purely additive: five new tables, zero changes to existing ones. Rollback is five
-- DROP TABLEs and the only state lost is Stripe-mirrored data Stripe can replay.
--
-- The slice exists to make "revenue precedes token spend" true BY CONSTRUCTION. Six
-- guards carry that, and each is stated where it lives so a reviewer never has to
-- reverse-engineer intent:
--
--   • `credit_balances` as a SEPARATE table from `credit_ledger` — deriving the balance
--     from SUM(delta) or from the newest balance_after hands two CONCURRENT debits the
--     same starting read and both "succeed". One row per account means every balance
--     change contends on ONE row lock, so debits serialize in Postgres (risk 6).
--   • `CHECK (balance >= 0)` — the revenue-precedes-spend invariant AS SCHEMA. Every
--     app-side guard can be bought off by a future refactor; this one cannot.
--   • `UNIQUE (account_id, source)` on the ledger — economic events happen at most once;
--     a replayed invoice or a reprocessed message becomes a reported `duplicate`, never a
--     second row.
--   • `credit_ledger_source_reason_check` — the `source` NAMESPACE is tied to the `reason`,
--     so a debit can never collide with an invoice grant's dedup identity and be reported
--     as a harmless `duplicate`. The registry in `credits.ts` is now schema, not convention.
--   • the DEFERRED COUPLING triggers (`*_coupled`) — the ledger and the balance are ONE
--     fact in two tables, and at COMMIT they must agree. This is what closes the two holes
--     an audit-trail-plus-counter design otherwise leaves wide open: a ledger row with no
--     balance movement, and a balance movement with no ledger row. It is also what makes
--     calling the primitives OUTSIDE a transaction fail loudly instead of silently
--     diverging.
--   • the append-only trigger — the money trail cannot be quietly rewritten.
--
-- Core Postgres only (no CREATE EXTENSION, RC8) so the whole migration replays into
-- PGlite; PGlite ships plpgsql, so the trigger is fine there too.

CREATE TABLE IF NOT EXISTS "billing_customers" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"stripe_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"account_id" uuid,
	"payload" jsonb NOT NULL,
	"event_ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"status" text DEFAULT 'applied' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"mailbox_limit" integer NOT NULL,
	"monthly_credits" integer NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_until" timestamp with time zone,
	"stripe_event_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_balances" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_account_idx" ON "billing_events" USING btree ("account_id","event_ts" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_sub_account_idx" ON "billing_subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_source_uq" ON "credit_ledger" USING btree ("account_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_account_id_desc_idx" ON "credit_ledger" USING btree ("account_id","id" desc);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────
-- HAND-WRITTEN below this line: the constraints, the partial index and the trigger that
-- drizzle-kit 0.28 / drizzle-orm 0.36 cannot serialize. They are not decoration — they
-- ARE the slice. The `DO $$ … EXCEPTION WHEN duplicate_object` wrapper is the house idiom
-- (0015/0017) that keeps the migration re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────────────

-- `plan` and `status` are exhaustive value sets. An unknown value cannot be persisted, so
-- reader code can never mis-classify a subscription into entitlements it should not have
-- (the `sessions.scope` precedent from 0017).
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_check" CHECK ("plan" IN ('solo','plus','pro'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_status_check" CHECK ("status" IN
   ('trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_mailbox_limit_check" CHECK ("mailbox_limit" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_monthly_credits_check" CHECK ("monthly_credits" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- At most ONE live subscription per account, enforced by the DATABASE — two racing
-- checkouts cannot both land (risk 15's kin). 'incomplete'/'incomplete_expired' are
-- EXCLUDED on purpose: an abandoned Checkout parks a subscription in 'incomplete' for
-- ~23 h and it must not block the user's retry. 'canceled' is excluded so resubscribe
-- history accumulates freely. NOTE the live set includes 'unpaid' and 'paused': those are
-- still THE account's subscription (dunning / pause states) — a second concurrent one
-- would be a state corruption, not a resubscribe (a resubscribe happens after 'canceled').
-- This predicate MUST equal `LIVE_SUBSCRIPTION_STATUSES` in `src/billing.ts`; a pg test
-- reads pg_indexes.indexdef and asserts it, so the two cannot drift silently.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_sub_one_live_idx" ON "billing_subscriptions" USING btree ("account_id")
  WHERE "status" IN ('trialing','active','past_due','unpaid','paused');--> statement-breakpoint

-- THE revenue-precedes-spend invariant, as schema. Last line of defence: even a bug that
-- bypasses the row lock and the app-side sufficiency check cannot COMMIT a negative balance.
-- Measured by mutation, three variants: overage survives the removal of the row
-- lock, the app-side check AND both non-negativity CHECKs, because `debitCredits`' guarded
-- `UPDATE … WHERE balance >= amount` is a fourth independent layer that throws rather than
-- commit a lie. Producing a negative balance requires deleting all four.
DO $$ BEGIN
 ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_balance_check" CHECK ("balance" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A ledger row's own claim about its direction must be true. This is STRICTER than a bare
-- `delta <> 0` (which it implies): a row whose reason says "grant" can never carry a
-- negative delta, and a debit reason can never carry a positive one. An audit trail whose
-- rows can lie about their own direction is not an audit trail. It also forbids delta = 0
-- outright, which is why `expireCredits` on a zero balance writes NO row at all — an empty
-- expiry is not an event, it is the absence of one.
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_sign_reason_check" CHECK (
   ("delta" > 0 AND "reason" IN ('invoice_grant','refund','adjustment_credit'))
   OR
   ("delta" < 0 AND "reason" IN ('period_expiry','debit_classify','debit_draft',
                                 'debit_propose','debit_workflow','adjustment_debit'))
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_balance_after_check" CHECK ("balance_after" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The `source` NAMESPACE, as schema. `UNIQUE (account_id, source)` alone answers "has this
-- key been used" but not "did it mean the same thing" — and `source` is a bare `text`
-- parameter, so a debit that reuses an invoice or an admin source string would collide,
-- be reported as a clean `duplicate`, and (per the spend gate's mapping) be treated as ALREADY PAID.
-- Real AI work would then be done for free, silently. Tying each reason to its namespace
-- prefix makes that collision impossible rather than unlikely: a `debit_classify` row can
-- only ever carry a `classify:` source, so it can never conflict with an `invoice:` one.
-- The prefixes are exactly the `ledgerSources` builders in `src/credits.ts`.
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_source_reason_check" CHECK (
   ("reason" = 'invoice_grant'      AND "source" LIKE 'invoice:%')
   OR ("reason" = 'period_expiry'   AND "source" LIKE 'expiry:%')
   OR ("reason" = 'debit_classify'  AND "source" LIKE 'classify:%')
   OR ("reason" = 'debit_draft'     AND "source" LIKE 'draft:%')
   OR ("reason" = 'debit_propose'   AND "source" LIKE 'propose:%')
   OR ("reason" = 'debit_workflow'  AND "source" LIKE 'workflow_run:%')
   OR ("reason" = 'refund'          AND "source" LIKE 'refund:%')
   OR ("reason" IN ('adjustment_credit','adjustment_debit') AND "source" LIKE 'admin:%')
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- `source` is an index KEY, and part of it is client-controlled: `ledgerSources.draft` takes
-- the request's `Idempotency-Key`. An oversized key would blow the btree entry limit
-- (~2704 bytes) and raise a raw index error from inside the CALLER's transaction — a
-- database exception where the contract promises a typed outcome. The builder hashes the
-- client's half to fixed width; this bound is the floor under that, so no future builder can
-- reintroduce the problem.
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_source_len_check"
   CHECK (length("source") BETWEEN 1 AND 200);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A refund must reverse a real charge. `refund:<original_source>` is unique, so a refund can
-- happen at most once — but nothing said the thing it names ever existed, nor that it was a
-- DEBIT, so `refund:refund:x` (refunding a refund) and refunds of nothing at all were both
-- expressible. Row-level and BEFORE, because this is a precondition on the row itself; it is
-- one indexed lookup through `credit_ledger_source_uq`, on the refund path only.
CREATE OR REPLACE FUNCTION credit_ledger_check_refund_origin() RETURNS trigger AS $$
BEGIN
  IF NEW.reason = 'refund' AND NOT EXISTS (
    SELECT 1 FROM credit_ledger o
    WHERE o.account_id = NEW.account_id
      AND o.source = substring(NEW.source from 8)      -- strip 'refund:'
      AND o.delta < 0
  ) THEN
    RAISE EXCEPTION 'credit_ledger: refund % has no original DEBIT to reverse on account %',
      NEW.source, NEW.account_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "credit_ledger_refund_origin" ON "credit_ledger";--> statement-breakpoint
CREATE TRIGGER "credit_ledger_refund_origin"
  BEFORE INSERT ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_check_refund_origin();--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────
-- THE COUPLING. `credit_ledger` is the money RECORD and `credit_balances` is the money
-- ITSELF, and until this trigger they were two independent tables held together only by
-- the politeness of `credits.ts`. Ordinary application code holding the runtime credential
-- could INSERT a ledger row with no balance change, or move the balance with no ledger row,
-- and both would commit — leaving the audit trail and the authoritative balance disagreeing
-- about a customer's money with nothing to say which one is right.
--
-- DEFERRABLE INITIALLY DEFERRED is the whole trick: the primitives deliberately write the
-- ledger row BEFORE the balance UPDATE (that ordering is what makes every failure outcome a
-- zero-write, so the union is honest on a caller-owned transaction), so an immediate check
-- would fire between the two halves and reject correct code. Deferring it to COMMIT asks the
-- only question that matters — "when this transaction became durable, did the record and the
-- money agree?" — and leaves the intra-transaction ordering free.
--
-- Two invariants, both O(1) through `credit_ledger_account_id_desc_idx`:
--   1. every INSERTED ledger row continues the chain: balance_after = (previous row's
--      balance_after, or 0) + delta. Induction then gives SUM(delta) = balance for free,
--      without an O(rows) scan on the hot path.
--   2. at commit, `credit_balances.balance` equals the NEWEST ledger row's `balance_after`
--      (and an account with no ledger history has no balance).
--
-- A consequence worth naming, because it closes the sharpest hole in the slice: the
-- primitives are only correct inside a transaction (on an autocommit handle the `FOR UPDATE`
-- lock is released at the end of its own statement and the ledger INSERT commits before the
-- balance UPDATE). That used to be a doc comment nobody had to obey. Now the ledger INSERT's
-- own implicit transaction fails this check, so a call outside a transaction cannot corrupt
-- anything — it simply cannot commit. Type-level and runtime guards in `credits.ts` say the
-- same thing earlier and more kindly; THIS is the one that cannot be refactored away.
CREATE OR REPLACE FUNCTION credit_assert_coupled() RETURNS trigger AS $$
DECLARE
  acct       uuid    := NEW.account_id;
  bal        integer;
  bal_found  boolean;
  last_id    bigint;
  last_after integer;
  prev_after integer;
BEGIN
  IF TG_TABLE_NAME = 'credit_ledger' THEN
    -- (1) the chain, for THIS row — checked per row so a multi-row transaction cannot hide
    -- a break in the middle of it.
    SELECT COALESCE(
      (SELECT p.balance_after FROM credit_ledger p
        WHERE p.account_id = acct AND p.id < NEW.id ORDER BY p.id DESC LIMIT 1), 0)
    INTO prev_after;
    IF NEW.balance_after <> prev_after + NEW.delta THEN
      RAISE EXCEPTION
        'credit invariant: ledger row % on account % claims balance_after % but % + % = %',
        NEW.id, acct, NEW.balance_after, prev_after, NEW.delta, prev_after + NEW.delta;
    END IF;
  END IF;

  -- (2) the record and the money agree, as of this commit.
  SELECT b.balance INTO bal FROM credit_balances b WHERE b.account_id = acct;
  bal_found := FOUND;

  SELECT l.id, l.balance_after INTO last_id, last_after
  FROM credit_ledger l WHERE l.account_id = acct ORDER BY l.id DESC LIMIT 1;

  IF NOT FOUND THEN
    -- No ledger history at all. A missing balance row and a zero balance are the same state
    -- everywhere in this design, so both are fine — anything else is money from nowhere.
    IF bal_found AND bal <> 0 THEN
      RAISE EXCEPTION 'credit invariant: account % holds balance % with an EMPTY ledger', acct, bal;
    END IF;
    RETURN NULL;
  END IF;

  IF NOT bal_found THEN
    RAISE EXCEPTION 'credit invariant: account % has ledger history but no credit_balances row', acct;
  END IF;
  IF bal <> last_after THEN
    RAISE EXCEPTION
      'credit invariant: account % balance is % but ledger row % says balance_after % — '
      'the money record and the balance disagree', acct, bal, last_id, last_after;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "credit_ledger_coupled" ON "credit_ledger";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "credit_ledger_coupled"
  AFTER INSERT ON "credit_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_assert_coupled();--> statement-breakpoint
DROP TRIGGER IF EXISTS "credit_balances_coupled" ON "credit_balances";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "credit_balances_coupled"
  AFTER INSERT OR UPDATE ON "credit_balances"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_assert_coupled();--> statement-breakpoint

-- The webhook DEDUP gate needs a state, not just a row. The rule: the dedup record commits in
-- the SAME transaction as the effect and that zero rows back from `ON CONFLICT DO NOTHING`
-- means "already applied ⇒ 200". But a FAILED apply rolls that transaction back, so the error
-- can only be recorded outside it — and the moment that separate transaction writes the row,
-- a bare `DO NOTHING` gate reads it as "already applied" and acknowledges every Stripe retry
-- 200 WITHOUT ever applying the effect. A failed `invoice.paid` would then never grant the
-- credits the customer paid for, and never be retried. Only rows in state 'applied' may
-- suppress a retry; 'failed' rows are CLAIMABLE (see `claimBillingEvent` in src/billing.ts).
DO $$ BEGIN
 ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_status_check"
   CHECK ("status" IN ('applied','failed'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The append-only trigger. STATEMENT-level rather than row-level on purpose: it fires even
-- for an UPDATE that matches ZERO rows, so "the tool ran and quietly did nothing" is not a
-- possible outcome, and it covers TRUNCATE, which a row-level trigger cannot see at all.
--
-- BE PRECISE ABOUT WHAT THIS BUYS, because the earlier wording overclaimed. A trigger stops
-- a wrong admin tool, a stray migration and a future "cleanup" job. It does NOT stop the
-- table's OWNER, who can `ALTER TABLE … DISABLE TRIGGER` or drop it outright — and today's
-- recorded production identity IS the table's owner role (no separate restricted runtime
-- role exists yet), so against application code holding the credential it actually runs with
-- this is a seatbelt, not a lock. `scripts/harden-billing-roles.sql` splits migration-owner
-- from runtime and is a HARD PREREQUISITE before billing goes live; until it has
-- been run, read every "cannot be rewritten" claim in this slice as "cannot be rewritten by
-- accident".
--
-- `billing_events` deliberately gets NO such trigger: its `error`/`status` columns are
-- written in a SEPARATE transaction after a failed apply (the apply tx rolled back, so the
-- error can only be recorded outside it). That is safe because billing_events is evidence
-- about webhook delivery; credit_ledger is the money record.
--
-- DELETION, and why `credit_ledger.account_id` is `ON DELETE no action`. An account that has
-- ever been charged cannot be DELETEd: the FK blocks it and this trigger blocks clearing the
-- ledger first. That is the intended, recorded policy and not an oversight.
-- Erasure of personal data is performed by ANONYMISING the account — every user, mailbox,
-- message, credential and body row is deleted and `accounts` is left as a pseudonymous
-- billing subject (a random uuid and a blank name) — because financial records carry a
-- statutory retention obligation that GDPR Art. 17(3)(b) explicitly preserves, and because a
-- money trail that can be deleted on request is not a money trail. Deleting the `accounts`
-- row is NOT the erasure mechanism, and nothing in this schema should ever make it one.
CREATE OR REPLACE FUNCTION credit_ledger_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (attempted %)', TG_OP;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "credit_ledger_append_only" ON "credit_ledger";--> statement-breakpoint
CREATE TRIGGER "credit_ledger_append_only"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "credit_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_block_mutation();