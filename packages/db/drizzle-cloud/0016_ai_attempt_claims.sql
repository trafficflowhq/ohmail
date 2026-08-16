-- AI ATTEMPT CLAIMS — the row that says who is doing a piece of paid work RIGHT NOW.
--
-- ══ WHAT WAS WRONG ════════════════════════════════════════════════════════════════════════
--
-- The AI spend gate decided "may this account spend?" from `credit_ledger` alone. That table is
-- append-only with `UNIQUE (account_id, source)`, so it states that an economic event happened at
-- most once — a fact about the PAST. The gate needed a fact about the PRESENT.
--
-- A second caller arriving at the same source read the same row, got `duplicate`, and was told
-- "already paid for, proceed", which is exactly right for a free retry of an open attempt (a
-- worker restart re-planning the same mail must not be charged twice) and cannot be told apart
-- from a caller that is still inside its model call. So N simultaneous requests over one message
-- each reached the model while the ledger collapsed them to ONE debit: N paid calls, one credit.
--
-- Nothing upstream bounded N. `POST /screener/suggest` is `idempotent: true`, so DISTINCT
-- `Idempotency-Key`s do not collapse against each other, and this deployment has no edge rate
-- limit. It needs no attacker either: the worker's auto-suggest pass and a person pressing
-- Suggest select the same held sender by construction, and both reach the gate through the same
-- ledger source.
--
-- ══ WHAT A ROW IS ═════════════════════════════════════════════════════════════════════════
--
-- One caller's EXCLUSIVE claim on one unit of work. It is written in the same transaction as the
-- debit, before the model call, and deleted when that call ends — succeeded or failed. A second
-- arrival's `INSERT … ON CONFLICT` blocks on the tuple until the holder's transaction ends and
-- then reports that it wrote nothing, which is the caller's instruction not to proceed. Precisely
-- the mechanism `idempotency_keys` already uses; this table is that idea applied to the money.
--
-- ══ `expires_at` IS THE PRICE OF EXCLUSIVITY ══════════════════════════════════════════════
--
-- Anything that can be held can be held by something that died. An unbounded claim would let one
-- crashed serverless invocation wedge a sender for ever, with no retry able to clear it — a worse
-- failure than the one being fixed. So a claim expires and the next arrival TAKES OVER the
-- expired row rather than colliding with it, exactly as `claimIdempotencyKey` does.
--
-- Both the write and the takeover predicate read `now()` IN POSTGRES rather than a caller's
-- clock. The holders are separate processes on separate machines; a bound measured by each
-- caller's own wall clock is not a shared bound at all.
--
-- ══ THE KEY IS THE WORK, NOT THE ATTEMPT ══════════════════════════════════════════════════
--
-- `source` is the BASE ledger source (`classify:screener:<message_id>`), never the resolved
-- `<base>~<n>` attempt. Attempts 1 and 2 are two tries at ONE unit of work and exactly one caller
-- may be trying at a time; keying by attempt would let a caller charging `~2` run beside a caller
-- retrying `~1` for free, which is the same defect with an extra step.
--
-- ══ WHY THE CLOUD JOURNAL ═════════════════════════════════════════════════════════════════
--
-- It is a property of METERED work. A local install has no ledger, no subscription and no gate:
-- its auto-suggest pass declares itself unmetered and takes no claim, so the mail journal would
-- put a table nothing on that install can ever write into every desktop database. The FK runs
-- CLOUD → MAIL, the legal direction — mail migrates first, so `accounts` exists wherever this
-- half does.
--
-- ══ ON DELETE CASCADE, WHICH `attachment_staging` DOES NOT HAVE ═══════════════════════════
--
-- The rows here are ephemeral coordination, not a record of anything: a claim outlives its work
-- by at most its TTL and holds no history worth keeping. An account erasure must not be blocked
-- by, or have to enumerate, a table whose entire contents are "somebody is mid-call". The money
-- record it coordinates (`credit_ledger`) keeps its plain reference, exactly as before.

CREATE TABLE IF NOT EXISTS "ai_attempt_claims" (
  "account_id" uuid NOT NULL REFERENCES "public"."accounts"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "ai_attempt_claims_pk" PRIMARY KEY ("account_id","source")
);
--> statement-breakpoint
-- The maintenance sweep's whole predicate (`expires_at <= now()`). Rows normally leave by being
-- released, so this index is for the abandoned tail — the claims whose holder died and which
-- nobody ever came back to take over.
CREATE INDEX IF NOT EXISTS "ai_attempt_claims_expires_idx" ON "ai_attempt_claims" ("expires_at");
