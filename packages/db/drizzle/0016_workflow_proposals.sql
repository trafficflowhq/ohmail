-- Phase 4b (migration 0016, the proposal surface) — AI workflow PROPOSALS. The Opus proposer reads
-- NON-SENSITIVE pattern METADATA only and stores suggested automations here. A
-- proposal is INERT: it is never a workflow until the user explicitly materializes it
-- (`POST /workflows { fromProposalId }` → a `provenance='proposed', enabled=false`
-- row). REST-only (kb_entries/tracker precedent, the workflow slice) — no change_log / EntityType.
--
-- NOTE: the drafts/kb_entries `workflow_dedup_key` columns were already added by 0015
-- (hand-written); drizzle-kit re-emitted them here because that migration's snapshot
-- lagged. They are intentionally OMITTED from this migration so it never double-adds.
CREATE TABLE IF NOT EXISTS "workflow_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"trigger" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_pattern" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_proposals_account_status_idx" ON "workflow_proposals" USING btree ("account_id","status");
