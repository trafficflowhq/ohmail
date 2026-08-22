-- BILLING RECONCILIATION RUNS — one row per pass of the scheduled mirror-vs-Stripe comparison.
--
-- The failure this closes (owner decision 2026-08-22): a lost Stripe webhook leaves the
-- entitlement mirror wrong FOREVER with every test green — the founding case is a no-card
-- trial whose `customer.subscription.deleted` never landed, mirrored `trialing` with full
-- features for good. The reconciler (packages/services/src/entitlements/reconcile.ts) walks
-- the plane's `status:"all"` subscription list, compares each against `billing_subscriptions`,
-- and re-emits the missed event through the SAME claim+apply path the webhook uses — never a
-- second write path into the mirror.
--
-- This table exists for the two alerts built on it, both about ABSENCE:
--   · `billing_reconciliation_divergence` — the latest pass emitted or flagged something: a
--     webhook was lost (or a row cannot be reconciled), and a human should hear it even though
--     the heal already happened;
--   · `billing_reconciliation_stale` — no completed apply-mode pass inside the threshold: the
--     reconciler itself has silently stopped, which is the same darkness it exists to remove.
--
-- Content rules (ohmail_admin is granted SELECT on most columns — see
-- scripts/harden-staff-role.sql §14b): `flagged` holds a CLOSED code→count vocabulary
-- (ReconcileCode), `error` is class:code scrubbed like `billing_events.error`, and
-- `divergences` (ids) is deliberately NOT granted to the staff role.
CREATE TABLE IF NOT EXISTS "billing_reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ran_at" timestamptz NOT NULL DEFAULT now(),
  "mode" text NOT NULL,
  "stripe_subscriptions" integer NOT NULL,
  "mirror_rows" integer NOT NULL,
  "emitted" integer NOT NULL,
  "apply_failed" integer NOT NULL,
  "flagged" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "divergences" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pages" integer NOT NULL,
  "truncated" boolean NOT NULL DEFAULT false,
  "error" text
);
--> statement-breakpoint
ALTER TABLE "billing_reconciliation_runs" DROP CONSTRAINT IF EXISTS "billing_recon_runs_mode_check";
--> statement-breakpoint
-- 'dry-run' printed what it WOULD emit and applied nothing; 'apply' is the armed pass. The
-- staleness alert reads apply-mode rows only, so a month of dry-runs cannot masquerade as a
-- running reconciler.
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_recon_runs_mode_check"
  CHECK ("mode" IN ('dry-run', 'apply'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_recon_runs_ran_at_idx" ON "billing_reconciliation_runs" ("ran_at");
