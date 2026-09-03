-- CREDIT USAGE ROLL-UP + THE ACCOUNT-KEYED SETUP POOL.
--
-- Two independent changes ride one migration because they are one decision about the same money:
-- the console stops reading the ledger row by row (it reads day-grained aggregates instead), and
-- the screening pool it displays stops being minted per mailbox and is minted once per account.
--
-- ══ WHAT IS NOT HERE, AND WHY THAT IS THE POINT ════════════════════════════════════════════
--
-- **There is no DDL on `credit_ledger` beyond two INDEXES, and no prune of it anywhere.** The
-- aggregate tables below exist so that reading the money is cheap; they are NOT a reason to
-- shorten the money trail, and four separate mechanisms would break if the trail were shortened:
--
--   · the append-only trigger (`credit_ledger_append_only`, 0002) raises on any DELETE, UPDATE
--     or TRUNCATE — a prune does not "mostly work", it aborts the transaction that attempts it;
--   · the DEFERRED coupling triggers (`credit_ledger_coupled` / `credit_balances_coupled`, 0002)
--     assert at COMMIT that the newest row's `balance_after` equals `credit_balances.balance`.
--     Deleting the newest rows of an account makes the two tables disagree permanently;
--   · `debitCredits` reads the `UNIQUE (account_id, source)` row BEFORE it checks sufficiency, so
--     a deleted debit row turns a replayed charge from a reported `duplicate` into a second real
--     charge — the customer pays twice for one piece of work;
--   · `refundCredits` reads the ORIGIN debit to bound the reversal, and `latestInvoiceGrantSource`
--     reads back through grants to build the next expiry's source. Both answer wrongly, and
--     silently, over a truncated history.
--
-- So the aggregates are a READ PATH and nothing else. Every number in them is derivable from
-- rows that are still there, which is also what makes a full-day recompute safe (below).
--
-- ══ 1. THE DAILY AGGREGATE ═════════════════════════════════════════════════════════════════
--
-- One row per (day, account, pool, reason). `pool` distinguishes the two places a credit can be
-- spent — `ledger` is `credit_ledger`, `setup` is `setup_grant_spends` — because they are
-- genuinely separate money with separate expiries, and a reader that added them would be
-- reporting a number no single balance ever held.
--
-- `credits` is SIGNED and carries the ledger's own convention verbatim (+ grant, − debit), so a
-- day's rows sum to that day's net movement and a range of days sums to the range's. `rows` is
-- the population behind it, kept because "12 credits" and "12 credits over 12 messages" are
-- different operator facts and a count cannot be recovered from a sum.
--
-- `computed_at` is stamped by the pass, not by the row's default: the freshness a console panel
-- prints must be the moment the number was COMPUTED, and `now()` on an UPDATE that changed
-- nothing would be a fresher-looking stamp over an unchanged number, which is the exact
-- reassurance a freshness stamp exists to refuse.
--
-- No jsonb, no address, no subject, no source string: ids, a day, a closed reason vocabulary,
-- a count and a signed integer. That is what makes it grantable to the blind staff role.
CREATE TABLE IF NOT EXISTS "credit_usage_daily" (
  "day" date NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  -- Which pool the movement happened in. CHECK-constrained because the roll-up writes it as a
  -- literal and a third pool must be a decision, not a typo that reports as a new category.
  "pool" text NOT NULL,
  "reason" text NOT NULL,
  "credits" integer NOT NULL,
  "rows" integer NOT NULL,
  "computed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "credit_usage_daily_pk" PRIMARY KEY ("day", "account_id", "pool", "reason"),
  CONSTRAINT "credit_usage_daily_pool_check" CHECK ("pool" IN ('ledger','setup')),
  CONSTRAINT "credit_usage_daily_rows_check" CHECK ("rows" >= 0)
);
--> statement-breakpoint
-- The account page's whole read: this account, newest days first, thirty of them.
CREATE INDEX IF NOT EXISTS "credit_usage_daily_account_day_idx"
  ON "credit_usage_daily" ("account_id", "day" DESC);
--> statement-breakpoint

-- ══ 2. THE LIFETIME TOTALS ═════════════════════════════════════════════════════════════════
--
-- The Billing board's three uncapped ledger scans read this instead. Each pool is aggregated from
-- the source that is COMPLETE for it, which is a different table for each:
--
--   · `ledger` from `credit_ledger` WHOLE. Not from `credit_usage_daily` — that table holds only
--     the days some pass recomputed, so totals summed from it would be the recompute WINDOW's
--     totals wearing the word "lifetime", and the board compares them against a live
--     `sum(balance)` over the account's entire history. It would report a permanent drift of the
--     deployment's whole lifetime on a healthy database, and the only fix would be a back-fill
--     step somebody has to remember to run. Aggregated whole, it is right on the first pass.
--   · `setup` from `credit_usage_daily`, for the opposite reason: `setup_grant_spends` IS swept,
--     so aggregating it directly would give a lifetime that SHRINKS as retention bites. The daily
--     rows survive the sweep, so they are the only complete record once a draw row is gone.
--
-- Written by the NIGHTLY pass only — a whole-table `GROUP BY` is a nightly cost, and it runs
-- beside the divergence pass that already walks the same table in the same run.
CREATE TABLE IF NOT EXISTS "credit_usage_totals" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "pool" text NOT NULL,
  "reason" text NOT NULL,
  "credits" integer NOT NULL,
  "rows" integer NOT NULL,
  "computed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "credit_usage_totals_pk" PRIMARY KEY ("account_id", "pool", "reason"),
  CONSTRAINT "credit_usage_totals_pool_check" CHECK ("pool" IN ('ledger','setup')),
  CONSTRAINT "credit_usage_totals_rows_check" CHECK ("rows" >= 0)
);
--> statement-breakpoint

-- ══ 3. THE RUN LEDGER ══════════════════════════════════════════════════════════════════════
--
-- One row per pass, for the reason `billing_reconciliation_runs` has one: both facts an operator
-- needs are about ABSENCE. "The roll-up last ran at X" and "it has not run for 26 hours" are not
-- answerable by a log line from a process that has stopped writing log lines, and a console panel
-- that renders a stale aggregate with no way to tell is the failure the freshness stamp exists
-- for. `divergent_accounts` rides here rather than on its own table because it is measured by the
-- same pass and read by the same panel.
--
-- `error` is class:code SCRUBBED, never message text — the same rule as `billing_events.error`
-- and `billing_reconciliation_runs.error`, and for the same reason: this column is granted to the
-- blind staff role, and a driver's message can carry a parameter value.
CREATE TABLE IF NOT EXISTS "credit_rollup_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  /* How many whole days this run recomputed — 2 hourly, 3 nightly, N for a back-fill. */
  "days_recomputed" integer NOT NULL,
  "rows_written" integer NOT NULL,
  /* `findCreditDivergence`'s count. NULL means this run did not measure it (the hourly pass
     does not — it is a full pass over the ledger and the balances, which is a nightly cost). */
  "divergent_accounts" integer,
  /* `setup_grant_spends` rows the retention sweep removed. NULL means this run did not sweep. */
  "pruned_setup_spends" integer,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_rollup_runs_ran_at_idx" ON "credit_rollup_runs" ("ran_at");
--> statement-breakpoint

-- ══ 4. TWO INDEXES ON `credit_ledger`, AND NOTHING ELSE ════════════════════════════════════
--
-- The roll-up's whole predicate is `created_at >= $1 AND created_at < $2`. Without this index
-- that is a sequential scan of the entire money trail once an hour, for ever — the exact cost
-- the aggregates exist to remove, reintroduced by the thing that computes them.
--
-- `created_at` and NOT `id`: `id` is a `bigserial`, and a bigserial is NOT commit-ordered. A
-- transaction can take id 100 and commit after the transaction that took id 101, so a watermark
-- over `id` skips the late committer permanently. The roll-up therefore recomputes whole days
-- from `created_at` and needs a `created_at` index to do it. (Within ONE account id order IS
-- commit order — every ledger write holds that account's balance row lock — which is what makes
-- `(account_id, id DESC)` a truthful statement view. Across accounts it says nothing, and the
-- roll-up reads across accounts.)
CREATE INDEX IF NOT EXISTS "credit_ledger_created_at_idx" ON "credit_ledger" ("created_at");
--> statement-breakpoint
-- The console's account statement is no longer "the last 50 ledger rows": debits are read from
-- the daily aggregate, and only the NON-DEBIT rows — grants, expiries, adjustments, refunds — are
-- still rendered raw, because each of those is a distinct economic event an operator reads one at
-- a time. On an account whose ledger is 99 % `debit_classify`, an unqualified `ORDER BY id DESC
-- LIMIT 50` returns fifty classifications and none of the five rows anybody wanted. A PARTIAL
-- index over exactly that predicate makes the qualified read as cheap as the unqualified one was.
--
-- The reason list is the complement of the four `debit_*` reasons, which are the metered actions
-- the daily aggregate covers. `adjustment_debit` is IN the list: a staff deduction is a decision
-- somebody made, not a metered action, and the whole point of this read is decisions.
CREATE INDEX IF NOT EXISTS "credit_ledger_events_idx"
  ON "credit_ledger" ("id" DESC)
  WHERE "reason" IN ('invoice_grant','trial_grant','period_expiry',
                     'adjustment_credit','adjustment_debit','refund');
--> statement-breakpoint

-- ══ 5. THE SETUP POOL BECOMES ACCOUNT-KEYED ════════════════════════════════════════════════
--
-- `setup_grants` was minted once per connected MAILBOX (1 500 screening credits, 90 days) with a
-- lifetime ceiling of `mailboxLimit` grants per account. It is now minted once per ACCOUNT, at
-- the first connection, sized at the subscription's own `monthly_credits`.
--
-- Why the key moves: the per-mailbox pool sized an acquisition cost by a number the customer
-- chooses (how many mailboxes they connect) rather than by the plan they bought, and it made the
-- ceiling a COUNT that had to be re-derived from the current mailbox limit on every grant — so a
-- plan change silently moved a lifetime bound. One row per account, enforced by a partial unique
-- index, replaces both: the size comes off the row that was sold, and "once, ever" is a fact
-- about the table rather than an arithmetic the granting code performs.
--
-- ADDITIVE. `kind` DEFAULTS to `'mailbox'`, so every existing row keeps meaning exactly what it
-- meant and every existing pool keeps its remainder and its expiry. No data moves, nothing is
-- re-granted, and an account already holding mailbox-kind rows gets NOTHING new — the granting
-- code refuses when ANY row exists for the account, which is what makes this migration safe to
-- deploy ahead of the code and safe to leave in place if the code is rolled back.
ALTER TABLE "setup_grants" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'mailbox';
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "setup_grants" ADD CONSTRAINT "setup_grants_kind_check"
   CHECK ("kind" IN ('mailbox','account'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ONCE PER ACCOUNT, EVER — the trial bounty's pattern and `setup_grants_mailbox_uq`'s, as a
-- PARTIAL unique index so the historical per-mailbox rows (several per account, legitimately)
-- are untouched by it.
--
-- This is what makes the race safe, and the race is real: two first connections arriving on two
-- connections at the same instant both read "no grant here" and both insert. The granting call
-- runs inside the mailbox-create transaction under the account's allowance lock, which serializes
-- the two on THIS deployment — but a lock is a property of the code path, and this index is a
-- property of the table. The second inserter gets a unique violation whatever code path it came
-- down, and the granting helper's `ON CONFLICT DO NOTHING` turns that into "already granted".
CREATE UNIQUE INDEX IF NOT EXISTS "setup_grants_account_once_uq"
  ON "setup_grants" ("account_id") WHERE "kind" = 'account';
