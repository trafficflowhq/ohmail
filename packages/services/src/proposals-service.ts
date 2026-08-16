import { and, asc, eq } from "drizzle-orm";
import { workflowProposals, type Tx } from "@trafficflow/db";
import {
  assembleWorkflowPatterns, generateProposals,
  type WorkflowPort, type WorkflowPattern, type WorkflowTrigger, type WorkflowStep, type StoredProposal,
} from "@trafficflow/core";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import type { WorkflowProposalDTO } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * ProposalsService. A THIN account-scoped wrapper over
 * the core proposal engine (`assembleWorkflowPatterns` / `generateProposals` live in
 * core so the worker cron can call them WITHOUT importing services). The AI
 * `WorkflowPort` is INJECTED into `generate` — mocked in tests, a live
 * `makeOpusProposer(new Anthropic())` in deployment.
 *
 * `assemblePatterns` returns NON-SENSITIVE metadata only and structurally EXCLUDES any
 * pattern derived from sensitivity-flagged mail. `generate` stores INERT
 * proposals — never a workflow; the user must explicitly materialize one
 * (`POST /workflows { fromProposalId }`) before it becomes a disabled workflow. REST-only:
 * no change_log / EntityType growth; clients read via `GET /workflows/proposals`.
 */
export class ProposalsService {
  /** The redacted, sensitive-excluded recurring patterns — delegates to core. */
  async assemblePatterns(ctx: ServiceContext, opts: { threshold?: number } = {}): Promise<WorkflowPattern[]> {
    return assembleWorkflowPatterns(asTx(ctx), ctx.accountId, opts);
  }

  /**
   * Generate + store proposals. Assemble redacted patterns → injected port →
   * validate/store. Re-running replaces the OPEN set (dedup, no pile-up). Returns the
   * freshly-stored open proposals.
   */
  async generate(
    ctx: ServiceContext, deps: { port: WorkflowPort; threshold?: number },
  ): Promise<WorkflowProposalDTO[]> {
    const stored = await generateProposals(asTx(ctx), ctx.accountId, {
      port: deps.port, now: ctx.now, threshold: deps.threshold,
    });
    return stored.map(toDTO);
  }

  /** GET /workflows/proposals — the account's OPEN proposals, oldest-first. */
  async list(ctx: ServiceContext): Promise<WorkflowProposalDTO[]> {
    const rows = await ctx.db.select().from(workflowProposals)
      .where(and(eq(workflowProposals.accountId, ctx.accountId), eq(workflowProposals.status, "open")))
      .orderBy(asc(workflowProposals.createdAt), asc(workflowProposals.id));
    return rows.map(rowToDTO);
  }

  /** Dismiss a proposal (mark 'dismissed'). Cross-account / unknown → 404. */
  async dismiss(ctx: ServiceContext, id: string): Promise<void> {
    const updated = await asTx(ctx).update(workflowProposals)
      .set({ status: "dismissed" })
      .where(and(
        eq(workflowProposals.id, id),
        eq(workflowProposals.accountId, ctx.accountId),
        eq(workflowProposals.status, "open"),
      ))
      .returning({ id: workflowProposals.id });
    if (updated.length === 0) throw new ServiceError("not_found", 404, "proposal not found");
  }
}

function toDTO(p: StoredProposal): WorkflowProposalDTO {
  return {
    id: p.id,
    name: p.name,
    rationale: p.rationale,
    trigger: p.trigger,
    steps: p.steps,
    sourcePattern: p.sourcePattern,
    status: p.status as WorkflowProposalDTO["status"],
    createdAt: p.createdAt.toISOString(),
  };
}

function rowToDTO(row: typeof workflowProposals.$inferSelect): WorkflowProposalDTO {
  return {
    id: row.id,
    name: row.name,
    rationale: row.rationale,
    trigger: row.trigger as WorkflowTrigger,
    steps: row.steps as WorkflowStep[],
    sourcePattern: (row.sourcePattern as WorkflowPattern | null) ?? null,
    status: row.status as WorkflowProposalDTO["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

export const proposalsService = new ProposalsService();
