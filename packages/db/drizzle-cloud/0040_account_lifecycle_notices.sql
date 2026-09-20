-- WHICH LIFECYCLE NOTICE AN ACCOUNT HAS ALREADY BEEN SENT — the wall's idempotency, DERIVED
-- (cloud 0040). The nightly account-lifecycle pass reads the plane's /v1/access per account and
-- owes at most one mail per fact: the trial ending (anchor = trialEndsAt), the closure
-- (anchor = closedAt), the erasure week (anchor = erasureAt), and the reopening banner's row
-- (anchor = the closedAt it reopens). The PRIMARY KEY (account_id, kind, anchor) IS the
-- idempotency: a re-run inserts nothing, a NEW closure is a new anchor and earns its own notice,
-- and no state machine or closure table exists to advance or repair. `anchor` is the plane's ISO
-- fact the notice is about, never a clock read here.
--
-- CLOUD, not mail: only the managed deployment has a plane to read or a subscription to end.
-- ON DELETE CASCADE: a notice naming an erased account is a row nothing will ever read.
--
-- DEPLOY ORDER: migration, then API. The reverse costs a 42P01 inside the pass's own catch —
-- the run reports the fault and no mail is sent twice.
--
-- ROLLBACK is `DROP TABLE account_lifecycle_notices`, after unscheduling the pass. Notices
-- already sent stay sent; a recreated table re-sends at most one mail per standing fact.

CREATE TABLE IF NOT EXISTS "account_lifecycle_notices" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "anchor" timestamp with time zone NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_lifecycle_notices_pk" PRIMARY KEY ("account_id", "kind", "anchor"),
  CONSTRAINT "account_lifecycle_notices_kind_closed"
    CHECK ("kind" IN ('trial_two_days', 'closed', 'erasure_week', 'reopened'))
);
