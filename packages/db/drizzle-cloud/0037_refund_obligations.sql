-- A SPEND THAT BOUGHT NOTHING LEAVES A ROW THAT REFUNDS IT.
--
-- Until this table the refund was a call and nothing else. AI drafting charged, the drafter
-- failed, the reversal was attempted, the entitlements program was unreachable, and the debt
-- existed nowhere: the person had paid for a draft they never got and no part of this system
-- remembered. The row is written by the transaction that OBSERVES the failure, BEFORE any
-- reversal is tried, so a crash between the two leaves the obligation standing rather than
-- nothing; a worker pass drains it.
--
-- `credit_refund_obligations_attempt_unique` IS THE IDEMPOTENCY. One charged attempt owes at most
-- one reversal, so recording the same failure twice is one row, and a drain that replays after a
-- crash cannot pay twice. The far side holds the other half — the entitlements program's own
-- `refund:<attempt>` uniqueness — which is what makes it safe to re-send a release whose answer
-- was lost rather than having to know whether it arrived.
--
-- WHAT IS NOT HERE, deliberately: no balance, no price, no credit count, no ledger row id. This
-- server does not hold the ledger and does not know what a credit is worth; the columns are
-- exactly the release it would make (`action`, the bare attempt key, the attempt id the program
-- itself returned, and the spend's own `meta`). `last_fault` is one of this repository's own
-- words, never a driver's message — `api_faults.error_class`' rule, for its reason.
--
-- ON DELETE CASCADE on `account_id`: an erased account's money is stopped by
-- `/v1/account/release`, and an obligation naming an account that no longer exists is a row
-- nothing can ever settle and a personal identifier nobody needs.
--
-- DEPLOY ORDER: migration, then API + worker. The reverse leaves the drafting path trying to
-- record an obligation into a table that does not exist — which is refused loudly rather than
-- swallowed, because a lost obligation is the defect this file closes.
--
-- ROLLBACK is `DROP TABLE credit_refund_obligations`, after reverting the writers. Nothing else
-- is touched.

CREATE TABLE IF NOT EXISTS "credit_refund_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  -- The `SpendAction` the charge was taken under. Not CHECK-constrained against a list: the
  -- action vocabulary is the terms table's (`SPEND_ACTIONS`), and a sixth action added there
  -- must not need a migration before its failures can be refunded.
  "action" text NOT NULL,
  -- The BARE attempt key. The port composes the ledger source on the way out, so storing a
  -- composed one here would double-prefix it on the drain's release — the exact defect
  -- `assertAttemptKey` exists to refuse.
  "attempt_key" text NOT NULL,
  -- What `spend` answered as `attempt` for a `charged: true` verdict. A reversal must NAME the
  -- attempt it reverses; a refund with no attempt reverses a neighbour's charge.
  "attempt" text NOT NULL,
  -- The spend's own provenance, carried through unchanged: ids we minted and counts.
  "meta" jsonb,
  "reason" text NOT NULL,
  "owed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- NULL IS THE DEBT. One nullable timestamp, not a status word beside it: two columns that can
  -- disagree about whether money is owed is how a settled row keeps being paid.
  "settled_at" timestamp with time zone,
  "tries" integer DEFAULT 0 NOT NULL,
  -- A drain's lease. NULL or in the past means claimable, so two workers cannot dial for one row
  -- and a worker that died mid-drain releases its rows by the clock rather than by anybody's
  -- cleanup.
  "claimed_until" timestamp with time zone,
  "last_fault" text
);
--> statement-breakpoint
-- THE IDEMPOTENCY KEY. Per ACCOUNT as well as per attempt: an attempt id is the program's, and
-- nothing in this server's contract says two accounts cannot be handed the same string.
ALTER TABLE "credit_refund_obligations"
  DROP CONSTRAINT IF EXISTS "credit_refund_obligations_attempt_unique";
--> statement-breakpoint
ALTER TABLE "credit_refund_obligations"
  ADD CONSTRAINT "credit_refund_obligations_attempt_unique" UNIQUE ("account_id", "attempt");
--> statement-breakpoint
-- The closed set of reasons. A third is a deliberate change here and in whatever reads it,
-- because a reason nobody renders is a debt nobody can explain to the person who is owed it.
ALTER TABLE "credit_refund_obligations"
  DROP CONSTRAINT IF EXISTS "credit_refund_obligations_reason_check";
--> statement-breakpoint
ALTER TABLE "credit_refund_obligations"
  ADD CONSTRAINT "credit_refund_obligations_reason_check"
  CHECK ("reason" IN ('drafter_failed', 'no_organizer'));
--> statement-breakpoint
-- Length ceilings on the four text columns, `api_faults_len_check`'s rule: the values are ours,
-- so this is not validation — it is the bound that stops one looping caller growing the table by
-- row SIZE rather than row count.
ALTER TABLE "credit_refund_obligations"
  DROP CONSTRAINT IF EXISTS "credit_refund_obligations_len_check";
--> statement-breakpoint
ALTER TABLE "credit_refund_obligations"
  ADD CONSTRAINT "credit_refund_obligations_len_check"
  CHECK (char_length("action") <= 40 AND char_length("attempt_key") <= 400
    AND char_length("attempt") <= 200 AND char_length("last_fault") <= 200);
--> statement-breakpoint
-- TRIES MAY NOT GO BACKWARDS OR NEGATIVE. The drain orders the oldest debt first and a stuck row
-- falls behind by its own count; a negative one would put it permanently in front of everybody
-- else's money.
ALTER TABLE "credit_refund_obligations"
  DROP CONSTRAINT IF EXISTS "credit_refund_obligations_tries_check";
--> statement-breakpoint
ALTER TABLE "credit_refund_obligations"
  ADD CONSTRAINT "credit_refund_obligations_tries_check" CHECK ("tries" >= 0);
--> statement-breakpoint
-- The drain's own read: pending first (`settled_at IS NULL`), oldest debt first. `last_fault` is
-- the table's LAST column and carries this migration's schema marker — the rule cloud 0030 and
-- 0033 state: only the last column's presence implies every object above it, so a statement
-- appended after this one means moving the `CLOUD_SCHEMA_MARKERS` entry with it.
CREATE INDEX IF NOT EXISTS "credit_refund_obligations_pending_idx"
  ON "credit_refund_obligations" ("settled_at", "owed_at");
