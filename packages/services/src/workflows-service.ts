import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  workflows, workflowRuns, workflowProposals, claimIdempotencyKey,
  folderState, drafts, kbEntries, auditLog, messages, recordChange, type LedgerTx, type Tx,
} from "@trafficflow/db";
import {
  validateSteps, validateTrigger,
  type WorkflowStep, type WorkflowTrigger, type NativeLocator,
} from "@trafficflow/core/mail";
// TYPE-ONLY. `WorkflowInverse` is declared with the workflow execution module in
// `ai/workflows/`, which calls the drafter; a type import is erased at emit, so naming it here
// does not put that module — or any prompt — into an artifact built from this file.
import type { WorkflowInverse } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Page, WorkflowDTO, WorkflowRunDTO } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

export interface CreateWorkflowBody {
  name?: unknown;
  trigger?: unknown;
  steps?: unknown;
  enabled?: unknown;
  /** Materialize an AI proposal into a disabled workflow instead of
   *  authoring one inline. When present, name/trigger/steps come from the proposal. */
  fromProposalId?: unknown;
}
export type PatchWorkflowBody = CreateWorkflowBody;

/** Idempotency handle the `/run` route threads in when an `Idempotency-Key` is present. */
export interface RunIdempotency {
  key: string;
  requestHash: string;
}

export interface ListRunsOptions {
  cursor?: string;
  limit?: number;
  status?: string;
  workflowId?: string;
}

function toWorkflowDTO(row: typeof workflows.$inferSelect): WorkflowDTO {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as WorkflowTrigger,
    steps: row.steps as WorkflowStep[],
    enabled: row.enabled,
    provenance: row.provenance as WorkflowDTO["provenance"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunDTO(row: typeof workflowRuns.$inferSelect): WorkflowRunDTO {
  return {
    id: row.id,
    workflowId: row.workflowId ?? null,
    status: row.status as WorkflowRunDTO["status"],
    trigger: row.trigger as WorkflowRunDTO["trigger"],
    log: row.log as unknown[],
    stepCursor: row.stepCursor,
    reason: row.reason ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/**
 * WorkflowsService — account-scoped CRUD over `workflows` plus the
 * single-tx run ENQUEUE. REST-only: NO `recordChange`,
 * NO `EntityType` growth — clients refetch via `GET /workflows` + `GET /workflow-runs`.
 *
 * The security gate lives in `create`/`update`: `validateSteps` refuses any
 * step outside the file_message/draft_reply/add_kb_entry allowlist, so a workflow
 * declaring `send`/`forward` can never be persisted. `softDelete` marks
 * `deletedAt` instead of hard-deleting so `workflow_runs` history survives; every
 * read excludes soft-deleted rows. `enqueueRun` mirrors `MessageService.move`:
 * the `workflow_runs` row + the verbatim `idempotency_keys` response commit in ONE
 * tx, so a retried Idempotency-Key replays the same runId and never double-enqueues.
 * The worker that DRAINS `pending` runs is separate — here runs just sit pending.
 */
export class WorkflowsService {
  async list(ctx: ServiceContext): Promise<WorkflowDTO[]> {
    const rows = await ctx.db.select().from(workflows)
      .where(and(eq(workflows.accountId, ctx.accountId), isNull(workflows.deletedAt)))
      .orderBy(asc(workflows.createdAt), asc(workflows.id));
    return rows.map(toWorkflowDTO);
  }

  async get(ctx: ServiceContext, id: string): Promise<WorkflowDTO> {
    const row = await this.load(ctx.db as unknown as Tx, ctx.accountId, id);
    if (!row) throw new ServiceError("not_found", 404, "workflow not found");
    return toWorkflowDTO(row);
  }

  async create(ctx: ServiceContext, body: CreateWorkflowBody): Promise<WorkflowDTO> {
    // A proposal id routes to the materialize path — the workflow is
    // built from the (account-scoped) proposal, provenance 'proposed', enabled=false.
    if (body.fromProposalId !== undefined && body.fromProposalId !== null) {
      return this.materialize(ctx, body.fromProposalId);
    }
    const name = this.validName(body.name);
    const trigger = this.validTrigger(body.trigger);
    const steps = this.validSteps(body.steps);
    const enabled = this.validEnabled(body.enabled);
    const now = ctx.now();
    const [row] = await ctx.db.insert(workflows).values({
      accountId: ctx.accountId,
      name, trigger, steps, enabled,
      provenance: "user",   // AI-proposed workflows (provenance 'proposed', fromProposalId) arrive later
      createdAt: now, updatedAt: now,
    }).returning();
    return toWorkflowDTO(row!);
  }

  /**
   * Materialize an AI proposal into a workflow. ONE tx: read the OPEN proposal
   * (account-scoped — a cross-account/unknown/already-materialized id → 404), create a
   * workflow from its name/trigger/steps with `provenance='proposed'` and — critically —
   * `enabled=false` (INERT: never auto-enabled; enabling is a separate explicit
   * PATCH by the user), and flip the proposal to 'materialized'. `validateSteps`
   * still runs so a proposal that somehow carries a bad tool cannot be persisted.
   */
  private async materialize(ctx: ServiceContext, proposalIdRaw: unknown): Promise<WorkflowDTO> {
    if (typeof proposalIdRaw !== "string" || proposalIdRaw.length === 0) {
      throw new ServiceError("validation_failed", 400, "fromProposalId must be a string");
    }
    const proposalId = proposalIdRaw;
    return asTx(ctx).transaction(async (tx) => {
      const [proposal] = await tx.select().from(workflowProposals)
        .where(and(
          eq(workflowProposals.id, proposalId),
          eq(workflowProposals.accountId, ctx.accountId),
          eq(workflowProposals.status, "open"),
        )).limit(1);
      if (!proposal) throw new ServiceError("not_found", 404, "proposal not found");

      const name = this.validName(proposal.name);
      const trigger = this.validTrigger(proposal.trigger);
      const steps = this.validSteps(proposal.steps);   // allowlist re-check
      const now = ctx.now();
      const [row] = await tx.insert(workflows).values({
        accountId: ctx.accountId,
        name, trigger, steps,
        enabled: false,          // INERT — never auto-enabled
        provenance: "proposed",  // AI-proposed provenance
        createdAt: now, updatedAt: now,
      }).returning();

      // Mark the proposal consumed (a second materialize → 404, the row is no longer open).
      await tx.update(workflowProposals).set({ status: "materialized" })
        .where(eq(workflowProposals.id, proposalId));

      return toWorkflowDTO(row!);
    });
  }

  async update(ctx: ServiceContext, id: string, patch: PatchWorkflowBody): Promise<WorkflowDTO> {
    const set: Record<string, unknown> = { updatedAt: ctx.now() };
    if (patch.name !== undefined) set.name = this.validName(patch.name);
    if (patch.trigger !== undefined) set.trigger = this.validTrigger(patch.trigger);
    if (patch.steps !== undefined) set.steps = this.validSteps(patch.steps);   // re-validate the allowlist
    if (patch.enabled !== undefined) set.enabled = this.validEnabled(patch.enabled);

    // Scope to the account AND exclude soft-deleted — a cross-account/deleted id matches 0 rows.
    const updated = await ctx.db.update(workflows).set(set)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, ctx.accountId), isNull(workflows.deletedAt)))
      .returning();
    if (updated.length === 0) throw new ServiceError("not_found", 404, "workflow not found");
    return toWorkflowDTO(updated[0]!);
  }

  /** Soft-delete: mark `deletedAt` + disable — NEVER hard-delete (preserves `workflow_runs` history). */
  async softDelete(ctx: ServiceContext, id: string): Promise<void> {
    const deleted = await ctx.db.update(workflows)
      .set({ deletedAt: ctx.now(), enabled: false, updatedAt: ctx.now() })
      .where(and(eq(workflows.id, id), eq(workflows.accountId, ctx.accountId), isNull(workflows.deletedAt)))
      .returning();
    if (deleted.length === 0) throw new ServiceError("not_found", 404, "workflow not found");
  }

  /**
   * Enqueue a run. ONE tx: verify the workflow is owned + not-deleted (404) and
   * enabled (409), REFUSE it if it needs a drafter this deployment has not got (503),
   * INSERT a `pending` `workflow_runs` row, and — when an Idempotency-Key is
   * present — INSERT the verbatim `idempotency_keys` response in the SAME tx (mirroring
   * `MessageService.move`) so a retried key replays the same runId and never enqueues a
   * second run. The worker drains `pending` runs separately.
   */
  async enqueueRun(
    ctx: ServiceContext, workflowId: string,
    opts: { idempotency?: RunIdempotency | null; drafterConfigured?: boolean } = {},
  ): Promise<{ runId: string }> {
    return asTx(ctx).transaction(async (tx) => {
      const wf = await this.load(tx, ctx.accountId, workflowId);
      if (!wf) throw new ServiceError("not_found", 404, "workflow not found");
      if (!wf.enabled) throw new ServiceError("conflict", 409, "workflow is disabled");
      this.assertRunnable(wf.steps, opts.drafterConfigured);

      const [run] = await tx.insert(workflowRuns).values({
        accountId: ctx.accountId,
        workflowId: wf.id,
        status: "pending",
        trigger: wf.trigger,   // snapshot the trigger at enqueue
      }).returning({ id: workflowRuns.id });
      const runId = run!.id;

      // Store the verbatim 202 {runId} IN this tx so a commit-then-crash retry
      // replays the same run id (never enqueuing a second run). seq is null — REST-only,
      // no change_log. Copied from MessageService.move (services can't import packages/api).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 202,
          responseJson: { runId },
          seq: null,
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return { runId };
    });
  }

  /** GET /workflow-runs — account-scoped, newest-first, keyset-paginated; optional status/workflowId filters. */
  async listRuns(ctx: ServiceContext, opts: ListRunsOptions = {}): Promise<Page<WorkflowRunDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(workflowRuns.accountId, ctx.accountId)];
    if (opts.status) filters.push(eq(workflowRuns.status, opts.status));
    if (opts.workflowId) filters.push(eq(workflowRuns.workflowId, opts.workflowId));
    if (opts.cursor) {
      const c = decodeRunCursor(opts.cursor);
      // Keyset for `created_at desc, id desc`: strictly "older" rows than the cursor tuple.
      filters.push(or(lt(workflowRuns.createdAt, c.createdAt),
        and(eq(workflowRuns.createdAt, c.createdAt), lt(workflowRuns.id, c.id)))!);
    }
    const rows = await ctx.db.select().from(workflowRuns)
      .where(and(...filters))
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > limit && last ? encodeRunCursor(last.createdAt, last.id) : null;
    return { items: pageRows.map(toRunDTO), nextCursor };
  }

  /**
   * Undo a run. Reads THIS run's `audit_log` inverse rows (account-scoped) and
   * replays them in REVERSE step order inside ONE tx, each GUARDED on current state:
   *   - file_message → re-set desired to the recorded PRIOR folder (emits a `message` move);
   *   - draft_reply → delete the draft ONLY IF still status='draft' (can't unsend — if the send
   *     path moved it to sending/sent it is skipped; emits a `draft` delete when it deletes);
   *   - add_kb_entry → delete the entry (REST-only, no change_log).
   * Then marks the run `undone`. A cross-account/unknown run → 404. Idempotent: a second
   * undo replays the same guarded (now mostly no-op) inverses.
   */
  async undoRun(ctx: ServiceContext, runId: string): Promise<WorkflowRunDTO> {
    return asTx(ctx).transaction(async (tx) => {
      const [run] = await tx.select().from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.accountId, ctx.accountId))).limit(1);
      if (!run) throw new ServiceError("not_found", 404, "workflow run not found");

      // The canonical inverse home: this run's per-step audit rows, newest step first.
      const rows = await tx.select({ inverse: auditLog.inverse }).from(auditLog)
        .where(and(
          eq(auditLog.accountId, ctx.accountId),
          eq(auditLog.action, "workflow_step"),
          sql`${auditLog.payload}->>'runId' = ${runId}`,
        ))
        .orderBy(sql`(${auditLog.payload}->>'stepIndex')::int desc`);

      for (const r of rows) {
        if (r.inverse) await this.applyInverse(tx, ctx, r.inverse as WorkflowInverse);
      }

      const [updated] = await tx.update(workflowRuns)
        .set({ status: "undone", reason: "undone", finishedAt: ctx.now() })
        .where(eq(workflowRuns.id, runId))
        .returning();
      return toRunDTO(updated!);
    });
  }

  /**
   * Apply one recorded inverse, guarded on current state. Emits effect changes in-tx.
   *
   * `LedgerTx`, not `Tx`: it calls `recordChange`, whose seq allocation only serializes while the
   * row lock outlives its own statement. The only caller is inside `undoRun`'s
   * `transaction(...)`, so this narrows a parameter rather than changing behaviour — and now the
   * compiler says so instead of the reader having to check.
   */
  private async applyInverse(tx: LedgerTx, ctx: ServiceContext, inv: WorkflowInverse): Promise<void> {
    if (inv.tool === "file_message") {
      const observed = await this.observedFolder(tx, inv.messageId);
      const reconcileStatus = observed === inv.toFolder ? "reconciled" : "pending";
      // Re-set DESIRED to the prior folder — the worker reconciles the physical move.
      await tx.insert(folderState).values({
        messageId: inv.messageId, desiredFolder: inv.toFolder, observedFolder: observed,
        lastSetBy: "us", reconcileStatus, conflict: false,
      }).onConflictDoUpdate({
        target: folderState.messageId,
        set: { desiredFolder: inv.toFolder, lastSetBy: "us", reconcileStatus, conflict: false, updatedAt: ctx.now() },
      });
      await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: inv.messageId,
        op: "move", meta: { from: observed, to: inv.toFolder },
      });
    } else if (inv.tool === "draft_reply") {
      // Guard: delete ONLY a still-'draft' row — a sending/sent draft can't be unsent.
      const deleted = await tx.delete(drafts)
        .where(and(eq(drafts.id, inv.draftId), eq(drafts.accountId, ctx.accountId), eq(drafts.status, "draft")))
        .returning({ id: drafts.id });
      if (deleted.length > 0) {
        await recordChange(tx, {
          accountId: ctx.accountId, entityType: "draft", entityId: inv.draftId, op: "delete", meta: null,
        });
      }
    } else if (inv.tool === "add_kb_entry") {
      // REST-only (kb has no change_log): a plain account-scoped delete.
      await tx.delete(kbEntries)
        .where(and(eq(kbEntries.id, inv.kbEntryId), eq(kbEntries.accountId, ctx.accountId)));
    }
  }

  /** The observed folder: folder_state truth, else the message's native locator, else INBOX. */
  private async observedFolder(tx: Tx, messageId: string): Promise<string> {
    const [fs] = await tx.select({ observedFolder: folderState.observedFolder }).from(folderState)
      .where(eq(folderState.messageId, messageId)).limit(1);
    if (fs) return fs.observedFolder;
    const [m] = await tx.select({ nativeLocator: messages.nativeLocator }).from(messages)
      .where(eq(messages.id, messageId)).limit(1);
    const loc = (m?.nativeLocator as NativeLocator | null) ?? null;
    return loc?.folder ?? "INBOX";
  }

  // ── helpers ──

  /** Load a live (non-soft-deleted) account-owned workflow row, or undefined (→ 404). */
  /**
   * REFUSE AT ENQUEUE what the drain provably cannot execute.
   *
   * A `202 {runId}` is a promise, and the honest place to break a promise you cannot keep is
   * BEFORE making it. Until this existed, `POST /workflows/:id/run` answered 202 and durably
   * recorded a `workflow_runs` row for a workflow whose `draft_reply` step the worker could
   * only ever fail — because a production worker has no `config.drafter`, substitutes
   * `unconfiguredDrafter`, and every such step throws. The user got a receipt for work the
   * platform had already decided it would not do, and the failure then surfaced as a step
   * that went wrong rather than as configuration that is missing.
   *
   * ── WHY REFUSING THE WHOLE RUN IS NOT OVER-BROAD ────────────────────────────────────────
   *
   * Because a workflow has no branches. `WorkflowStep` is `{tool, args}` — there is no
   * condition, predicate or guard field (`packages/core/src/workflow-shapes.ts`) — and the
   * runner runs a FLAT array straight through, `for (i = stepCursor; i < steps.length; i++)`
   * with no conditional skip (`packages/core/src/ai/workflows/`). So a `draft_reply`
   * step present in `steps` is a step this run WILL reach unless an earlier one fails first.
   * There is no "branch that never executes" to be wrong about. If workflows ever gain
   * conditional steps, this check becomes over-broad in exactly that moment and must move to
   * the step boundary — that is the one change that invalidates it.
   *
   * ── WHAT `drafterConfigured` ACTUALLY KNOWS, WHICH IS LESS THAN IT SOUNDS ────────────────
   *
   * It reflects the **API** deployment's `ANTHROPIC_API_KEY`, which is a PROXY for
   * the **worker's** — two separate deployments that each read their own env. The
   * two divergent states both fail safe, but neither is silent:
   *   - API keyed / worker bare  → 202 as before, then a run that fails. Today that failure is
   *     recorded with the generic reason `"error"`, NOT `draft_reply_unconfigured`, because
   *     `unconfiguredDrafter` throws a plain `Error` and the runner's catch only preserves a
   *     `WorkflowStepError`'s reason. That residual is the remaining half and is fixed in the
   *     worker, not here.
   *   - API bare / worker keyed → refusals a worker could in fact have served.
   * The operational rule that keeps both away: the key is set or unset on BOTH deployments in
   * the same change.
   *
   * OMITTED (`undefined`) is deliberately permissive — "this caller does not know", not "no
   * drafter". Only an explicit `false` refuses, so no existing caller changes behaviour.
   */
  private assertRunnable(steps: unknown, drafterConfigured?: boolean): void {
    if (drafterConfigured !== false) return;
    // The `validateSteps` gate guarantees the stored shape, so no re-validation is needed here.
    const declared = (steps as WorkflowStep[] | null) ?? [];
    if (!declared.some((s) => s?.tool === "draft_reply")) return;
    // 503, not a 4xx: nothing about the REQUEST is wrong. The identical call succeeds on a
    // configured host, and on this host the moment the key is wired, with no change by the
    // client — the unprocessability is a property of the DEPLOYMENT. (Its exact complement is
    // `sensitive_no_ai` 422 in DraftingService: a property of the message that no server change
    // fixes.) `retryable: false` is explicit because the status heuristic would get it wrong:
    // `HttpAdapter.rejectionOf` reads `wire.error.retryable ?? (status >= 500 || status === 429)`,
    // so an unannotated 503 tells a client to retry forever something only an operator can fix.
    throw new ServiceError(
      "drafter_unconfigured", 503,
      "this deployment has no AI drafter connected, so a workflow with a draft_reply step cannot run",
      undefined, false,
    );
  }

  private async load(tx: Tx, accountId: string, id: string): Promise<typeof workflows.$inferSelect | undefined> {
    const [row] = await tx.select().from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId), isNull(workflows.deletedAt)))
      .limit(1);
    return row;
  }

  private validName(v: unknown): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, "name is required");
    }
    return v;
  }

  private validTrigger(v: unknown): WorkflowTrigger {
    const trigger = v === undefined ? { kind: "manual" } : v;
    const res = validateTrigger(trigger);
    if (!res.ok) throw new ServiceError("validation_failed", 400, res.error);
    return trigger as WorkflowTrigger;
  }

  /** The security gate: reject any step outside the file_message/draft_reply/add_kb_entry allowlist. */
  private validSteps(v: unknown): WorkflowStep[] {
    const steps = v === undefined ? [] : v;
    const res = validateSteps(steps);
    if (!res.ok) throw new ServiceError("validation_failed", 400, res.error);
    return steps as WorkflowStep[];
  }

  private validEnabled(v: unknown): boolean {
    if (v === undefined) return false;   // enabling is the explicit consent — defaults off
    if (typeof v !== "boolean") throw new ServiceError("validation_failed", 400, "enabled must be a boolean");
    return v;
  }
}

// ── (createdAt, id) keyset cursor for the run list (`created_at desc, id desc`). ──
function encodeRunCursor(createdAt: Date, id: string): string {
  return encodeListCursor(`${createdAt.getTime()}:${id}`);
}
function decodeRunCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = decodeListCursor(cursor);
  const i = raw.indexOf(":");
  return { createdAt: new Date(Number(raw.slice(0, i))), id: raw.slice(i + 1) };
}

export const workflowsService = new WorkflowsService();
