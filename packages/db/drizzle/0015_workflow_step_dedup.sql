-- Phase 4a-2 — workflow steps — per-step crash-resume dedup key on the two NON-idempotent
-- workflow effects. `file_message` is naturally idempotent (a desired-state upsert
-- keyed by message), but a `draft_reply` INSERT and an `add_kb_entry` INSERT are
-- not — so each stamps a deterministic `${runId}:${stepIndex}` here and the executor
-- inserts with ON CONFLICT DO NOTHING. The column is NULLABLE and a UNIQUE constraint
-- treats every NULL as distinct, so all pre-existing (user/AI) rows stay valid.
ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "workflow_dedup_key" text;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN IF NOT EXISTS "workflow_dedup_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workflow_dedup_key_unique" UNIQUE("workflow_dedup_key");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_workflow_dedup_key_unique" UNIQUE("workflow_dedup_key");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
