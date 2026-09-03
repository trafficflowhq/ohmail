-- REVENUE IN, COST OUT — the two halves of the money board that no table holds today.
--
-- 0028 made READING the credit ledger cheap. This one makes the two figures either side of it
-- EXIST: what customers actually paid us (`billing_invoices`), and what serving them actually
-- costs (`ai_usage_daily` for tokens, `platform_costs` for infrastructure).
--
-- ══ WHY THREE TABLES AND NOT A REPORT ══════════════════════════════════════════════════════
--
-- Every figure the board needs is computable today from somewhere — and every one of those
-- somewheres is a place the console must not read:
--
--   · **cash received** lives only inside `billing_events.payload`, the raw Stripe event, which
--     carries the customer's NAME and POSTAL ADDRESS. That column is un-granted to the blind
--     staff role deliberately (`staff-grants.ts`, "minus `payload`") and widening it to reach an
--     integer would hand a console that must never see a customer's address exactly that. So the
--     amount is PROMOTED to a named column at apply time, where `InvoiceDTO.amountPaid` is
--     already in hand, and the payload stays un-granted for ever.
--   · **token cost** lives only in a log line. `AnthropicCallReport` carries the model, the four
--     token counts and an estimated cost after every metered call, and the three composition
--     roots print it as `ai_call` JSON. A log drain is not a table: it cannot be joined, it is
--     retained for weeks rather than years, and — measured while writing this migration — the
--     WORKER, which is the metered arm for three of the four priced reasons, was passing no
--     logger at all, so its share of the bill was never written down anywhere.
--   · **infrastructure cost** lives in three vendor dashboards and nowhere else.
--
-- ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════════════════════════
--
--   · **No invoice LINE ITEMS, no customer name, no address, no `payload` bag.** An invoice row
--     here is an id, an account, a status word, a currency, two integer cent amounts, a plan, a
--     period and three timestamps. There is nothing on it a person could be identified by that
--     `billing_subscriptions` does not already carry, which is what lets every column be granted.
--   · **No per-CALL AI row.** `ai_usage_daily` is aggregated at the write site — one row per
--     (day, host, model) — because the alternative is a table that grows with the product's
--     unit of work for a figure nobody ever reads per-call.
--   · **No `account_id` on `ai_usage_daily` or `platform_costs`.** Attributing a model call to an
--     account inside `packages/core/src/ai/*` was refused: that package is desktop payload and
--     knows nothing about accounts. Per-account AI cost is APPORTIONED from the credit ledger
--     instead, and the console labels it as apportioned.
--
-- ADDITIVE in every statement. Three new tables and two new columns with defaults; nothing is
-- altered, nothing is backfilled, and an API or worker at 0028 runs unchanged against this
-- database.

-- ══ 1. THE INVOICE MIRROR ══════════════════════════════════════════════════════════════════
--
-- One row per Stripe invoice, written by the webhook apply and healed by a daily reconcile.
--
-- `stripe_invoice_id` IS the primary key — not a surrogate — because that is the identity both
-- writers agree on and the only one that makes the reconcile's upsert a fact about the table
-- rather than an arithmetic the pass performs. A redelivered webhook, a reconcile pass over the
-- same invoice, and a webhook racing a reconcile all land on the same row by construction.
--
-- `stripe_event_ts` IS THE LAST-WRITE-WINS FENCE, and it is the same fence
-- `billing_subscriptions` carries for the same measured reason: Stripe fans deliveries out in
-- parallel and retries them independently, so `invoice.payment_failed` from T+5 can arrive after
-- `invoice.paid` from T+10. An application-level read-then-write cannot fix that — two
-- deliveries both read the old row and both write it — so the defence is in the statement:
-- `DO UPDATE … WHERE existing.stripe_event_ts <= excluded.stripe_event_ts`. An older event
-- updates ZERO rows and is a SUCCESSFUL apply, because "Stripe told us something we already know
-- to be stale" is a correct outcome and not a failure to retry.
--
-- `amount_paid_cents` and `amount_refunded_cents` are held APART rather than netted. Cash
-- received and cash given back are two facts about two moments, and a single net figure cannot
-- answer "how much did we refund this month" — which is the figure that says whether a support
-- problem is getting worse. The board subtracts them; the table does not.
--
-- `source` records WHICH WRITER put the row here. It is the only way to tell a mirror that is
-- keeping up from one that is being carried by the nightly heal — a webhook path that has been
-- silently failing for a week looks identical, row for row, to a healthy one, except that every
-- row says `reconcile`.
CREATE TABLE IF NOT EXISTS "billing_invoices" (
  "stripe_invoice_id" text PRIMARY KEY,
  /* The account this invoice belongs to. Resolved by `resolveAccount` — subscription metadata
     first, the `billing_customers` link as the fallback — exactly as every other apply arm
     resolves it, so an invoice row can never be attributed differently from the money it
     describes. NOT NULL: an invoice we cannot attribute is one the apply refuses outright
     (`account_unresolved`), so there is no state in which a row here has no owner. */
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "stripe_subscription_id" text,
  "stripe_customer_id" text,
  /* Stripe's own `billing_reason` verbatim — `subscription_cycle`, `subscription_create`,
     `subscription_update`, `manual`, … The grant policy branches on it, so the board can say
     which invoices were renewals and which were one-offs. */
  "billing_reason" text,
  "status" text NOT NULL,
  /* ISO-4217, lower-case as Stripe reports it. Held rather than assumed: a board that sums
     cents across currencies without saying so is reporting a number that does not exist. */
  "currency" text NOT NULL,
  "amount_paid_cents" integer NOT NULL,
  "amount_refunded_cents" integer NOT NULL DEFAULT 0,
  /* The plan this invoice's PLAN line was for, per the plane's price→plan verdict. NULL for an
     invoice with no plan line (an add-on-only cycle) or one the price map does not know. */
  "plan" text,
  "billing_interval" text,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  /* When Stripe says the money arrived. The board's month buckets are keyed on THIS, never on
     `created_at`: a row healed by a reconcile pass six weeks later must land in the month it was
     paid, not the month we noticed. */
  "paid_at" timestamp with time zone,
  "stripe_event_ts" timestamp with time zone NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  /* A CLOSED vocabulary, because every one of these six words changes an arithmetic on the
     board and a seventh must be a decision rather than a string a writer invented.
     `refunded`/`disputed` are set by the reversal arm; `void`/`uncollectible` are reachable only
     by the reconcile, which reads Stripe's own status. */
  CONSTRAINT "billing_invoices_status_check" CHECK ("status" IN
    ('paid','payment_failed','void','uncollectible','refunded','disputed')),
  CONSTRAINT "billing_invoices_source_check" CHECK ("source" IN ('webhook','reconcile')),
  CONSTRAINT "billing_invoices_plan_check" CHECK ("plan" IS NULL OR "plan" IN ('solo','plus','pro')),
  CONSTRAINT "billing_invoices_interval_check"
    CHECK ("billing_interval" IS NULL OR "billing_interval" IN ('month','year')),
  /* Cents are never negative on either side. A negative amount is a sign convention somebody
     invented mid-flight, and the board subtracts these two — so one sign error is a revenue
     figure that is too HIGH, which is the direction nobody checks. */
  CONSTRAINT "billing_invoices_paid_nonneg_check" CHECK ("amount_paid_cents" >= 0),
  CONSTRAINT "billing_invoices_refunded_nonneg_check" CHECK ("amount_refunded_cents" >= 0)
);
--> statement-breakpoint
-- The account page's read: this account's invoices, newest paid first.
CREATE INDEX IF NOT EXISTS "billing_invoices_account_paid_idx"
  ON "billing_invoices" ("account_id", "paid_at" DESC);
--> statement-breakpoint
-- The board's read: six months of cash, across every account.
CREATE INDEX IF NOT EXISTS "billing_invoices_paid_at_idx" ON "billing_invoices" ("paid_at");
--> statement-breakpoint

-- ══ 2. INFRASTRUCTURE COST ═════════════════════════════════════════════════════════════════
--
-- One row per (provider, metric, window, source). Written by a scheduled pass that asks each
-- vendor's billing API, and by hand when there is no API to ask.
--
-- ══ A ZERO IS ONLY EVER A ROW THAT SAYS ZERO ══
--
-- This is the whole design and it is a response to a measured risk rather than a preference.
-- NONE of the three provider keys exists in production today. So the overwhelmingly likely state
-- of this table for its first weeks is EMPTY, and the dangerous branch is the one an absent key
-- selects: an adapter that answers `0` when it cannot ask, a DTO that defaults `cents: 0`, and a
-- console that renders "$0.00 infrastructure cost this month" in exactly the same typeface it
-- would render a measured figure. That is not a missing feature, it is a margin the operator
-- believes.
--
-- The table's half of the answer is that there is NO ROW for an unmeasured window — no
-- placeholder, no zero, no `NULL` cost pretending to be a measurement. `cost_cents` is NOT NULL
-- precisely so that "we don't know" is unrepresentable HERE and has to be represented where it
-- belongs: in the DTO, as `cents: null` with `source: 'unconfigured'`.
--
-- ══ MANUAL ENTRY IS FIRST-CLASS, NOT A FALLBACK ══
--
-- `source` is part of the PRIMARY KEY, so an API row and a hand-entered row for the same window
-- COEXIST and the reader chooses. The reader chooses MANUAL: a person who typed a figure off an
-- invoice is better evidence than an API that reports usage-to-date, and two providers
-- (Railway, Resend) have no usable billing API at all. Keeping both rows is what makes the
-- override auditable — the API's own number is still there to disagree with.
CREATE TABLE IF NOT EXISTS "platform_costs" (
  "provider" text NOT NULL,
  /* What was measured — `functions`, `bandwidth`, `db_compute`, `egress`, `tokens`, … Free at
     the column level and closed by each adapter, because the vocabulary is the vendor's and a
     CHECK here would turn a new line on somebody's invoice into a failed pass. */
  "metric" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  /* The measured quantity in `unit` — 1 200 000 invocations, 43.7 GB. Kept beside the money
     because a cost that doubled is a different problem from a cost that doubled at the same
     unit price, and only these two columns together can tell them apart. */
  "value" numeric,
  "unit" text,
  "cost_cents" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "source" text NOT NULL,
  /* When the figure was OBTAINED, not when the window closed. This is what the console's
     staleness verdict is computed from, and the distinction is the point: a Vercel figure for
     last month fetched an hour ago is fresh, and the same figure fetched three weeks ago is
     not, though the window is identical. */
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now(),
  /* The operator who typed a manual row. `oauth_provider_config.updated_by`'s pattern and its
     reason verbatim: `audit_log.account_id` is NOT NULL and a payment to our own hosting
     provider belongs to no account, so forcing one in would be a lie in the column the audit
     trail is keyed by. The actor, the time and the note live on the row instead. NULL on an
     API row, which nobody entered. */
  "entered_by" uuid REFERENCES "staff_users"("id"),
  "note" text,
  CONSTRAINT "platform_costs_pk"
    PRIMARY KEY ("provider", "metric", "period_start", "period_end", "source"),
  /* CLOSED, unlike `metric`: a provider is a deployment decision and a sixth one needs an
     adapter, an env var and a review — never a typo that reports as a new cost centre. */
  CONSTRAINT "platform_costs_provider_check" CHECK ("provider" IN
    ('vercel','supabase','anthropic','railway','resend')),
  CONSTRAINT "platform_costs_source_check" CHECK ("source" IN ('api','manual')),
  /* A manual row without a note is an unattributable number on a money board. */
  CONSTRAINT "platform_costs_manual_note_check"
    CHECK ("source" <> 'manual' OR ("note" IS NOT NULL AND length(btrim("note")) >= 8)),
  CONSTRAINT "platform_costs_window_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "platform_costs_cost_nonneg_check" CHECK ("cost_cents" >= 0)
);
--> statement-breakpoint
-- The board's read: newest windows first, per provider.
CREATE INDEX IF NOT EXISTS "platform_costs_provider_period_idx"
  ON "platform_costs" ("provider", "period_start" DESC);
--> statement-breakpoint

-- ══ 3. AI COST, MEASURED AT THE CALL ═══════════════════════════════════════════════════════
--
-- One row per (day, host, model), upserted by `makeAiUsageRecorder` from the same
-- `AnthropicCallReport` the `ai_call` log line carries. Both, not either: the log line is the
-- per-call forensic record an operator greps when one request behaved oddly, and this table is
-- the arithmetic. Dropping the log for the table would lose the request id that Anthropic's
-- support can act on; dropping the table for the log would leave the margin computable only by
-- a human with a log drain and an afternoon.
--
-- ══ `host` IS IN THE PRIMARY KEY, AND IT IS NOT DECORATION ══
--
-- Three processes make metered model calls — the API host (drafting, the Screener's priced
-- suggest), the worker (classification, the proposer, workflow steps) and the self-host server —
-- and they fail independently. A single deployment-wide total cannot answer the one question
-- that matters when the number is wrong, which is "which of the three stopped recording"; split
-- by host, an arm that goes to zero is visible on the board the day it happens. This is also
-- what makes the `ai_usage_unrecorded` signal expressible.
--
-- `ok_calls` beside `calls`: a failed call costs wall time and no tokens, so a day whose two
-- counts diverge is a provider incident, and it is the only place that fact is recorded at all.
--
-- `cost_micro_usd` is an ESTIMATE from the client's own published price table, and it is stored
-- as an INTEGER of micro-dollars rather than a float: a month is millions of these added
-- together, and binary floating point makes that sum depend on the order the rows arrive in.
CREATE TABLE IF NOT EXISTS "ai_usage_daily" (
  "day" date NOT NULL,
  "host" text NOT NULL,
  /* The model Anthropic BILLED (the response's `model`), which is not always the one requested —
     an alias resolves to a dated id. Free text at the column level on purpose: a CHECK here
     would turn the next model release into a failed upsert inside a customer's request. */
  "model" text NOT NULL,
  "calls" integer NOT NULL DEFAULT 0,
  "ok_calls" integer NOT NULL DEFAULT 0,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "cache_write_tokens" bigint NOT NULL DEFAULT 0,
  "cost_micro_usd" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ai_usage_daily_pk" PRIMARY KEY ("day", "host", "model"),
  CONSTRAINT "ai_usage_daily_host_check" CHECK ("host" IN ('api','worker','server')),
  CONSTRAINT "ai_usage_daily_calls_check" CHECK ("calls" >= 0 AND "ok_calls" >= 0)
);
--> statement-breakpoint
-- The board's read: the last N days, every host and model.
CREATE INDEX IF NOT EXISTS "ai_usage_daily_day_idx" ON "ai_usage_daily" ("day" DESC);
--> statement-breakpoint

-- ══ 4. THE INVOICE RECONCILE'S TWO COUNTERS ════════════════════════════════════════════════
--
-- The invoice pass records itself in `billing_reconciliation_runs`, beside the subscription
-- pass, because both facts an operator needs about either one are about ABSENCE — "it last ran
-- at X", "it has not run for a day" — and those are not answerable from a process that has
-- stopped writing log lines. One run ledger, one staleness question, one panel.
--
-- ══ AND `mode` GAINS A THIRD WORD RATHER THAN THE TABLE GAINING A DISCRIMINATOR ══
--
-- This is the load-bearing half of these four lines. `evaluateAlerts` reads the run ledger
-- twice, and the two reads have DIFFERENT filters: the staleness rule takes the newest completed
-- `mode = 'apply'` row, and the divergence rule takes the newest completed row of ANY mode. So
-- an invoice pass writing `mode = 'apply'` would satisfy the staleness rule for a subscription
-- reconciler that had been dead for a week — verbatim the "guard satisfied by the wrong pass"
-- defect the 0028 review found and fixed one migration ago.
--
-- `mode = 'invoices'` makes the two passes distinguishable in the column the alert rules already
-- read, at the cost of no new column and no new index. The staleness rule's existing
-- `mode = 'apply'` filter then excludes invoice runs for free; the divergence rule's read is
-- narrowed to the subscription modes in the same commit, which is the other half of the fix.
ALTER TABLE "billing_reconciliation_runs"
  DROP CONSTRAINT IF EXISTS "billing_recon_runs_mode_check";
--> statement-breakpoint
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_recon_runs_mode_check"
  CHECK ("mode" IN ('dry-run', 'apply', 'invoices'));
--> statement-breakpoint
-- Invoices Stripe LISTED on this pass, and invoices whose row this pass actually wrote. Two
-- numbers rather than one, because their RATIO is the signal: a healthy deployment lists a few
-- hundred and upserts zero (the webhooks got there first), and a pass that upserts most of what
-- it lists is a webhook path that has stopped working. Defaulted to 0 so every existing row and
-- every subscription-mode row reads as "this pass examined no invoices", which is true.
ALTER TABLE "billing_reconciliation_runs"
  ADD COLUMN IF NOT EXISTS "invoices_listed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "billing_reconciliation_runs"
  ADD COLUMN IF NOT EXISTS "invoices_upserted" integer NOT NULL DEFAULT 0;
