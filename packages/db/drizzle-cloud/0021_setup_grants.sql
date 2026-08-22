-- SETUP GRANTS — a bounded, screening-only, expiring credit pool granted once per connected
-- mailbox (1 500 credits, 90 days), SEPARATE from the main credit ledger on purpose.
--
-- Why a second pool instead of a `setup_grant` ledger reason: the main balance is one number,
-- and two of this grant's three properties are not expressible on one number. "Screening-only"
-- needs the spender to know WHICH pool it is drawing (the ledger's debit path cannot tell a
-- Screener classification's credit from a draft's), and "expires in 90 days" needs a remainder
-- to expire — a commingled balance has no attributable remainder, and the monthly renewal's
-- `period_expiry` would eat the grant at the first cycle boundary regardless (the
-- renewal-boundary hazard the architecture review flagged). A separate pool has neither problem:
-- the monthly expiry never sees it, and its own expiry is a WHERE clause.
--
-- The pool is drawn by the Screener suggestion gates only (`setup-grant.ts#withSetupPool`),
-- BEFORE the main balance, and the main ledger is untouched by a setup-funded suggestion — so
-- every invariant on `credit_ledger`/`credit_balances` (coupling, sign checks, source
-- namespaces) keeps meaning exactly what it meant.
-- `ON DELETE CASCADE` on the account, and NO foreign key on the mailbox, both deliberate:
-- account erasure must take the pool with it (this is per-account state, not the append-only
-- money audit — that is `credit_ledger`, untouched here), and a mailbox FK would couple mailbox
-- lifecycle to a grant that must survive a disconnect exactly so it cannot be re-armed by one.
CREATE TABLE IF NOT EXISTS "setup_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "mailbox_id" uuid NOT NULL,
  "granted" integer NOT NULL,
  "remaining" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- ONE grant per mailbox, EVER — a fact about the table, exactly like the trial bounty's
  -- partial unique index. Reconnecting, disabling or re-enabling a mailbox cannot re-arm it.
  CONSTRAINT "setup_grants_mailbox_uq" UNIQUE ("mailbox_id"),
  -- The floor and the ceiling of last resort: a draw can never overdraw the grant, and a refund
  -- can never inflate it past what was granted.
  CONSTRAINT "setup_grants_remaining_bounds" CHECK ("remaining" >= 0 AND "remaining" <= "granted"),
  CONSTRAINT "setup_grants_granted_positive" CHECK ("granted" > 0)
);
--> statement-breakpoint
-- The draw path's whole predicate: unexpired grants of one account with something left.
CREATE INDEX IF NOT EXISTS "setup_grants_account_expiry_idx"
  ON "setup_grants" ("account_id", "expires_at");
--> statement-breakpoint
-- THE DRAW RECORD — the pool's own idempotency ledger, mirroring `credit_ledger`'s
-- UNIQUE (account_id, source) so a crash-retried suggestion is a free retry here exactly as it
-- is on the main ledger. `refunded_at` is the exactly-once refund marker (a failed model call
-- gives the credit back once, never twice).
CREATE TABLE IF NOT EXISTS "setup_grant_spends" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "setup_grants"("id") ON DELETE CASCADE,
  "amount" integer NOT NULL,
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "setup_grant_spends_pk" PRIMARY KEY ("account_id", "source"),
  CONSTRAINT "setup_grant_spends_amount_positive" CHECK ("amount" > 0),
  -- The same bound the main ledger puts on its partly-caller-controlled index key.
  CONSTRAINT "setup_grant_spends_source_len" CHECK (char_length("source") <= 200)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "setup_grant_spends_grant_idx" ON "setup_grant_spends" ("grant_id");
