/**
 * WORKFLOW AUTOMATION: the step, trigger and pattern shapes the rules engine validates, and the
 * records a client reads of a workflow, a proposal and a run.
 */
import type { ISODateTime } from "./base.js";

/** The three — and only three — tools a workflow step may declare. */
export type ToolName = "file_message" | "draft_reply" | "add_kb_entry";

/**
 * A recurring, redaction-safe routing pattern: METADATA ONLY. The fields below are the COMPLETE
 * allowed surface, enforced at the boundary that serializes one — deliberately no body, snippet
 * or subject field, so raw content cannot reach a model request even by mistake; the assembling
 * caller additionally excludes any pattern whose underlying messages are flagged sensitive.
 * Declared here rather than beside the proposer because the shape is also what the transport
 * layer serializes to a client, and that path is mail-half code; the allowlist that polices the
 * shape stays with the proposer, where the serialization happens.
 */
export interface WorkflowPattern {
  /** The pattern axis: 'sender' (a specific address) or 'domain' (a whole domain). */
  kind: string;
  senderDomain?: string;
  senderAddress?: string;
  destination?: string;
  /** How many times this pattern recurred (learning signals / rule hits / decisions). */
  count: number;
  /** Where the pattern was observed: 'learning' | 'rule' | 'routing'. */
  provenance: string;
}

/** One step of a workflow: a typed tool + its opaque args (validated per-tool by the workflow runner). */
export interface WorkflowStep {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** How a workflow fires. `manual` runs on `POST /run`; `time` carries `nextRunAt`; `event` matches ingested mail. */
export type TriggerKind = "manual" | "time" | "event";

export interface WorkflowTrigger {
  kind: TriggerKind;
  /** ISO timestamp the time-trigger scan compares against `now`. */
  nextRunAt?: string;
  /** Event-trigger predicate (sender/domain/…), matched by the event-trigger scan. */
  match?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow automation. Both DTOs are
// REST-only (no /sync entity growth): clients refetch via `GET /workflows` +
// `GET /workflow-runs`. `WorkflowDTO.steps` may only declare the three allowlisted
// tools (validated at create/update). `provenance` is 'user' for user-authored
// workflows; 'proposed' (AI, inert until enabled) / 'graduated' arrive later.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowProvenance = "proposed" | "user" | "graduated";

export interface WorkflowDTO {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  provenance: WorkflowProvenance;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// An AI-proposed automation. REST-only, INERT until
// `POST /workflows { fromProposalId }` materializes it into a disabled workflow.
export type WorkflowProposalStatus = "open" | "materialized" | "dismissed";

export interface WorkflowProposalDTO {
  id: string;
  name: string;
  rationale: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  sourcePattern: WorkflowPattern | null;   // redacted metadata the suggestion was derived from
  status: WorkflowProposalStatus;
  createdAt: ISODateTime;
}

export type WorkflowRunStatus =
  | "pending" | "running" | "awaiting_approval" | "succeeded" | "failed" | "undone";

export interface WorkflowRunDTO {
  id: string;
  workflowId: string | null;      // null once the source workflow is soft-deleted (retention)
  status: WorkflowRunStatus;
  trigger: WorkflowTrigger | Record<string, unknown>;
  log: unknown[];
  stepCursor: number;
  reason: string | null;
  createdAt: ISODateTime;
  finishedAt: ISODateTime | null;
  /**
   * HOW MANY OF THIS UNDO'S MOVES ARE WAITING ON ANOTHER INSTALL — `n` of the steps, not a
   * boolean. An undo on a mailbox this install only reads writes one `message.move` record per
   * filing step instead of moving the mail here, so `undone` is true of the DECISION and this is
   * what is still in flight. `undefined` means "not an undo answer", which is not zero.
   */
  pendingMoves?: number;
}
