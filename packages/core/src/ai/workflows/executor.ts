import { and, asc, eq, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  messages,
  folderState,
  drafts,
  kbEntries,
  auditLog,
  workflows as workflowsTbl,
  workflowRuns,
  type Tx,
} from "@trafficflow/db";
/**
 * The LEAF, not `/cloud` — and the split is load-bearing. This module is compiled into the
 * desktop engine, and `workflowAttemptKey` is a VALUE, so its edge survives bundling; named
 * through `@trafficflow/db/cloud` the barrel came with it — billing, the credit ledger, the staff
 * directory, the hosted schema and the postgres server driver, 26 extra workspace modules in an
 * artifact a stranger downloads. `ledger-source.ts` imports `node:crypto` and nothing else, which
 * is what makes it nameable from here. `SpendPort` comes from the root barrel as a TYPE ONLY —
 * erased at compile time, no edge — so the two imports must not be collapsed into one statement.
 */
import { workflowAttemptKey } from "@trafficflow/db/ledger-source";
import type { SpendPort } from "@trafficflow/db";
import { makeDrizzleRepo, type DrizzleRepo } from "../../adapters/drizzle-repo.js";
import type { NativeLocator } from "../../ports.js";
import type { DraftPort, DraftInput, DraftResult } from "../draft.js";
import { plainTextToOutboundBody } from "../../outbound-text.js";
import type { ToolName, WorkflowStep } from "../../workflow-shapes.js";

// The gated workflow EXECUTOR — drains a `pending` workflow_run and runs its steps. In CORE at
// the DB/repo level (the worker imports core+db only): `file_message` reuses the desired-state
// handoff (never IMAP), `draft_reply` calls the injected DraftPort and inserts a `drafts` row,
// `add_kb_entry` inserts a `kb_entries` row. Two invariants: (1) never act on sensitive mail — a
// whole-run pre-flight refuses if ANY targeted message is flagged, with a per-step structural
// re-check behind it; (2) never double-execute — each step commits in its own tx and advances a
// durable `stepCursor`; the (runId, stepIndex) audit row is the idempotency marker, and inserts
// carry a unique `workflow_dedup_key`. The canonical inverse home is `audit_log`;
// `workflow_runs.log` is a convenience index. This was the one call site making a paid model call
// inside a transaction; since the charge moved into `prepare`, it no longer does.

/* The undo payload is declared with the tool GRAMMAR, in `workflow-shapes.ts`, not here with the
 * runner that writes it: the service that replays an undo is mail-half code, and having the shape
 * live beside the runner made that service name this module — which calls a model — purely to
 * describe what it reads back out of the audit log. Re-exported so this file's own consumers are
 * unaffected by where it now lives. */
export type { WorkflowInverse } from "../../workflow-shapes.js";
import type { WorkflowInverse } from "../../workflow-shapes.js";
import { carryDialect } from "@trafficflow/db/dialect";

/** What a tool's `apply` returns: an audit-safe `effect` summary + the `inverse` (undo). */
export interface ToolApplyResult {
  effect: Record<string, unknown>;
  inverse: WorkflowInverse;
}

/**
 * Per-step context handed to a tool's `apply`, all bound to the step's OWN transaction. There is
 * deliberately no `drafter` and no `credits` here, and their ABSENCE is the enforcement of the
 * rule — no network, no ledger write inside the step transaction. Both fields once existed:
 * `draft_reply` charged on `ctx.tx` and made the paid call on that same transaction, so any of
 * the three writes after the call rolled the CHARGE back while Anthropic had already been paid —
 * one unpaid model call per post-call failure. A comment cannot hold a rule like this, so it is a
 * type: money and network live in {@link ToolPrepareContext}, strictly between transactions, and
 * reaching for either from `apply` is a compile error.
 */
export interface ToolApplyContext {
  repo: DrizzleRepo;   // desired-state write + recordChange + recordAudit (the repo seam)
  tx: Tx;              // raw tx handle for the drafts/kb_entries inserts
  accountId: string;
  runId: string;
  stepIndex: number;
  now: Date;
}

/**
 * The PREPARE context — the only place in the step machinery where a paid model call or ledger
 * write may happen. `db` is the top-level handle and `prepare` runs with no transaction frame
 * open, which is what makes the credit gate safe: the gate opens its own short transaction, and
 * the original self-deadlock was an inner `BEGIN` on the handle whose connection the outer
 * transaction held — blocking for ever on PGlite's single connection. A structural absence of
 * nesting fixes it in the strictest harness. The order is `DraftingService`'s: fallible reads,
 * the charge, the model, then the storing transaction on its own.
 */
export interface ToolPrepareContext {
  db: Tx;              // TOP-LEVEL handle — never a transaction. See `runOne`.
  accountId: string;
  runId: string;
  stepIndex: number;
  drafter: DraftPort;  // INJECTED (mocked in tests) — no live model client in core
  /** The AI spend gate. Absent ⇒ unmetered. Charged and released HERE, never in `apply`. */
  credits?: SpendPort;
}

/**
 * What a tool's `prepare` hands to its `apply` — the model's answer, plus the target columns the
 * insert needs, read before the call.
 *
 * `chargedAttempt` is the ledger source THIS attempt actually paid for, or `null` when the step
 * is unmetered or was a free retry of an attempt still open. `runOne` reports it on the failure
 * record when the step dies after the charge committed, so an abandoned charge is discoverable
 * rather than silently kept.
 */
export type StepPrepared =
  | {
      tool: "draft_reply";
      result: DraftResult;
      mailboxId: string;
      threadId: string | null;
      chargedAttempt: string | null;
    };

/**
 * A typed, gated workflow tool. `resolveTargets` feeds the sensitivity pre-flight + re-check.
 *
 * `prepare` is OPTIONAL and only `draft_reply` has one: `file_message` and `add_kb_entry` are
 * deterministic database work with nothing to pay for and nobody to call.
 */
interface Tool {
  name: ToolName;
  resolveTargets(args: Record<string, unknown>): string[];
  prepare?(ctx: ToolPrepareContext, args: Record<string, unknown>): Promise<StepPrepared>;
  apply(
    ctx: ToolApplyContext, args: Record<string, unknown>, prepared: StepPrepared | null,
  ): Promise<ToolApplyResult>;
}

/** A step failure that carries the terminal `workflow_runs.reason`. */
export class WorkflowStepError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "WorkflowStepError";
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new WorkflowStepError(`invalid_args:${field}`);
  return v;
}

/** The deterministic per-step dedup key: `${runId}:${stepIndex}`. */
function stepDedupKey(runId: string, stepIndex: number): string {
  return `${runId}:${stepIndex}`;
}

/** The observed folder truth: folder_state first, else the message's native locator, else INBOX. */
async function observedFromMessage(tx: Tx, messageId: string): Promise<string> {
  const [m] = await tx.select({ nativeLocator: messages.nativeLocator }).from(messages)
    .where(eq(messages.id, messageId)).limit(1);
  const loc = (m?.nativeLocator as NativeLocator | null) ?? null;
  return loc?.folder ?? "INBOX";
}

// ── file_message: desired-state move (naturally idempotent, NEVER IMAP) ──
const fileMessageTool: Tool = {
  name: "file_message",
  resolveTargets(args) {
    return typeof args.messageId === "string" ? [args.messageId] : [];
  },
  async apply(ctx, args) {
    const messageId = requireString(args.messageId, "file_message.messageId");
    const toFolder = requireString(args.toFolder, "file_message.toFolder");
    // Read the prior folder_state: preserve observedFolder (the worker's truth) and
    // capture the prior DESIRED as the inverse target (undo re-sets it).
    const prior = await ctx.repo.getFolderState(messageId);
    const observed = prior?.observedFolder ?? (await observedFromMessage(ctx.tx, messageId));
    const priorDesired = prior?.desiredFolder ?? observed;

    // Write DESIRED state only — the worker performs the physical IMAP move on its
    // next cycle. The API/executor NEVER opens IMAP. This upsert is keyed by messageId,
    // so a re-apply re-sets the SAME desired folder (naturally idempotent).
    await ctx.repo.upsertFolderState(messageId, {
      desiredFolder: toFolder, observedFolder: observed, lastSetBy: "us",
    });
    await ctx.repo.recordChange({
      accountId: ctx.accountId, entityType: "message", entityId: messageId,
      op: "move", meta: { from: observed, to: toFolder },
    });
    return {
      effect: { messageId, from: observed, to: toFolder },
      inverse: { tool: "file_message", messageId, toFolder: priorDesired },
    };
  },
};

/**
 * Assemble the sensitivity-safe DraftInput for a `draft_reply` step (mirrors
 * DraftingService's redaction rules). KB grounding = the account's recent entries; thread
 * context = the target thread's OTHER messages as REDACTED snippets, with the
 * sensitivity exclusion STRUCTURAL in the WHERE (`no_kb`/`no_ai`/sensitive siblings
 * can never reach the DraftPort). The whole-run pre-flight already refused a
 * sensitive TARGET; this is the sibling-leak second layer.
 */
async function buildDraftInput(
  tx: Tx, accountId: string, target: DraftTarget,
): Promise<DraftInput> {
  const kb = await tx.select({ title: kbEntries.title, content: kbEntries.content })
    .from(kbEntries).where(eq(kbEntries.accountId, accountId))
    .orderBy(asc(kbEntries.updatedAt)).limit(5);
  const siblings = target.threadId
    ? await tx.select({ from: messages.fromAddress, snippet: messages.snippet }).from(messages)
        .where(and(
          eq(messages.accountId, accountId),
          eq(messages.threadId, target.threadId),
          ne(messages.id, target.id),
          eq(messages.noKb, false),
          eq(messages.noAi, false),
          isNull(messages.sensitivityCategory),
        ))
        .orderBy(asc(messages.date)).limit(20)
    : [];
  return {
    incoming: { subject: target.subject, from: target.fromAddress, snippet: target.snippet },
    context: {
      kbEntries: kb.map((e) => ({ title: e.title, content: e.content })),
      threadMessages: siblings.map((s) => ({ from: s.from, snippet: s.snippet })),
    },
  };
}

interface DraftTarget {
  id: string;
  mailboxId: string;
  threadId: string | null;
  subject: string;
  fromAddress: string;
  snippet: string;
}

async function loadDraftTarget(tx: Tx, accountId: string, messageId: string): Promise<DraftTarget> {
  const [t] = await tx.select({
    id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId,
    subject: messages.subject, fromAddress: messages.fromAddress, snippet: messages.snippet,
  }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId))).limit(1);
  if (!t) throw new WorkflowStepError("target_missing");
  return { ...t, threadId: t.threadId ?? null };
}

// ── draft_reply: injected DraftPort → a STORED draft (status 'draft', never sent) ──
const draftReplyTool: Tool = {
  name: "draft_reply",
  resolveTargets(args) {
    return typeof args.messageId === "string" ? [args.messageId] : [];
  },
  /**
   * Everything that costs money or makes a network call, OUTSIDE any transaction, in
   * `DraftingService`'s order: a missing target costs nothing, asked first; the fallible reads
   * sit BEFORE the charge, or a request with zero model calls gets billed; the CHARGE precedes
   * the model, so revenue precedes token spend; the model is refunded on a throw. The charge is
   * per step (`workflow_run:<runId>:<stepIndex>`); a re-drained run answers `duplicate` →
   * proceed, charged nothing — crash-resume: when the crash landed between charge and commit, we
   * pay for the repeated model call. `spend`, not `tryDebit`: a database fault must not read as
   * an empty balance. Reached only after both sensitivity checks; a refusal FAILS the step.
   */
  async prepare(ctx, args) {
    const messageId = requireString(args.messageId, "draft_reply.messageId");
    const target = await loadDraftTarget(ctx.db, ctx.accountId, messageId);
    const input = await buildDraftInput(ctx.db, ctx.accountId, target);

    // The BARE key: the run and the step, which is the unit a crash-resume re-executes. The
    // ledger source is composed by whoever answers, through the one composer.
    const attemptKey = workflowAttemptKey(ctx.runId, ctx.stepIndex);
    const meta = { runId: ctx.runId, stepIndex: ctx.stepIndex, messageId };
    let chargedAttempt: string | null = null;
    if (ctx.credits) {
      const outcome = await ctx.credits.spend(ctx.accountId, "workflow", attemptKey, meta);
      if (outcome.verdict !== "ok" && outcome.verdict !== "duplicate") {
        // A FAULT is our outage, not the customer's balance — never `insufficient_credits`.
        if (outcome.verdict === "fault") throw new WorkflowStepError("ai_unavailable");
        // AN OVERLAP is not a fault and not a balance either: another caller holds the exclusive
        // claim on this exact step and is running the model for it. Unreachable
        // today — the workflow gate does not set `exclusive`, because the loser path here is a
        // terminal `failed` run rather than a retry and that decision has not been made — and
        // written out anyway, so that switching it on is a one-line change and not a silent fall
        // through to the `outcome.reason` branch below, which would read `undefined` on this
        // variant and report a refusal the subscription never made. `ai_unavailable` is the
        // retryable answer, which is the honest one for a condition that clears by itself.
        if (outcome.verdict === "inflight") throw new WorkflowStepError("ai_unavailable");
        if (outcome.verdict === "insufficient") throw new WorkflowStepError("insufficient_credits");
        // A STATE refusal reports the subscription's OWN word (`ai_disabled` for the account's
        // own off switch, else `canceled` / `paused` / `past_due` / `unpaid` / `no_subscription` /
        // `suspended`), because "buy more credits" is the wrong sentence for every one of them.
        throw new WorkflowStepError(outcome.reason);
      }
      // KEPT ONLY WHEN THIS CALL CHARGED. The port's `attempt` IS the refund memory — there is
      // no in-process marker across a network hop — and a `duplicate`'s attempt belongs to an
      // earlier call whose work may well have been delivered. Reversing that one because this
      // step later failed would hand back a charge for work the customer received.
      chargedAttempt = outcome.verdict === "ok" ? outcome.attempt : null;
    }

    // The paid call. Outside every transaction, which is the whole point of `prepare`. This path
    // REFUNDS: a `failed` run is terminal — the stale-claim reaper requeues stranded `running`
    // claims and deliberately never touches `failed` — so there is no future free retry to honour
    // the charge. `refund(source)` is a no-op unless THIS gate charged THIS attempt: the marker
    // is cleared on every non-charging decision, so a free retry of an earlier open attempt
    // cannot reverse a charge whose work may already have been delivered. The refund also CLOSES
    // the attempt, so a later re-queue is charged afresh — which is what stops refund-plus-retry
    // composing into an unlimited free draft.
    let result: DraftResult;
    try {
      result = await ctx.drafter.draft(input);
    } catch (err) {
      // `refund: true` only for an attempt THIS call charged; otherwise the claim goes back and
      // the charge stands, which is what keeps a free retry free.
      if (ctx.credits) {
        await ctx.credits.release(ctx.accountId, chargedAttempt === null
          ? { action: "workflow", attemptKey, refund: false, meta }
          : { action: "workflow", attemptKey, refund: true, attempt: chargedAttempt, meta });
      }
      throw err;
    }
    return {
      tool: "draft_reply", result,
      mailboxId: target.mailboxId, threadId: target.threadId, chargedAttempt,
    };
  },
  async apply(ctx, args, prepared) {
    const messageId = requireString(args.messageId, "draft_reply.messageId");
    const dedupKey = stepDedupKey(ctx.runId, ctx.stepIndex);
    // `prepare` above is the only producer, and `runOne` always calls it before `apply`. The
    // guard is a total function rather than a non-null assertion: a future tool wired into the
    // registry without a `prepare` must fail loudly here, not insert a draft with no body.
    if (prepared?.tool !== "draft_reply") throw new WorkflowStepError("not_prepared");
    const { result } = prepared;

    // Both halves, promoted together. The model answers in prose; a stored draft carries a text
    // part and a markup part, and the send path only produces `multipart/alternative` when the
    // second is there — this step used to write the words alone, so a workflow-drafted reply went
    // out `text/plain` while the same reply composed by hand went out as both. The pair comes
    // from ONE call, which stops the two parts being sourced independently; the request path
    // stores the same pair through `DraftsService`, which this inserter cannot use (core never
    // imports services) — a test asserts the two routes agree by rendering the markup back to
    // text. The 256 KiB html ceiling is not checked here: `drafts_html_cap` is the only gate, and
    // a drafter capped at a thousand output tokens cannot reach it.
    const promoted = plainTextToOutboundBody(result.body);

    // Unique workflow_dedup_key + ON CONFLICT DO NOTHING → a re-drain never stores a
    // second draft. status 'draft' — NEVER auto-sent (only SendService sends).
    const inserted = await ctx.tx.insert(drafts).values({
      accountId: ctx.accountId,
      mailboxId: prepared.mailboxId,
      threadId: prepared.threadId,
      inReplyToMessageId: messageId,
      subject: result.subject,
      body: promoted.html ? promoted.text : result.body,
      html: promoted.html || null,
      rationale: result.rationale,
      status: "draft", workflowDedupKey: dedupKey,
      createdAt: ctx.now, updatedAt: ctx.now,
    }).onConflictDoNothing({ target: drafts.workflowDedupKey }).returning({ id: drafts.id });

    const draftId = inserted[0]?.id ?? (await existingByDedup(ctx.tx, drafts, dedupKey));
    // The ENVELOPE is REST-only, but the draft EFFECT still syncs — emit the `draft`
    // create change (only on a genuinely-new insert; a conflict already emitted it).
    if (inserted[0]) {
      await ctx.repo.recordChange({
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "create", meta: null,
      });
    }
    return { effect: { draftId, messageId }, inverse: { tool: "draft_reply", draftId } };
  },
};

// ── add_kb_entry: a KB write (REST-only, no change_log) ──
const addKbEntryTool: Tool = {
  name: "add_kb_entry",
  resolveTargets(args) {
    return typeof args.fromMessageId === "string" ? [args.fromMessageId] : [];
  },
  async apply(ctx, args) {
    const dedupKey = stepDedupKey(ctx.runId, ctx.stepIndex);
    let title: string;
    let content: string;
    if (typeof args.fromMessageId === "string") {
      // Sourced from a message: use only its subject + REDACTED snippet (never a raw body).
      const [m] = await ctx.tx.select({ subject: messages.subject, snippet: messages.snippet })
        .from(messages)
        .where(and(eq(messages.id, args.fromMessageId), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!m) throw new WorkflowStepError("target_missing");
      title = typeof args.title === "string" && args.title.length > 0 ? args.title : m.subject;
      content = m.snippet;
    } else {
      title = requireString(args.title, "add_kb_entry.title");
      content = requireString(args.content, "add_kb_entry.content");
    }
    const inserted = await ctx.tx.insert(kbEntries).values({
      accountId: ctx.accountId, title, content, workflowDedupKey: dedupKey,
      createdAt: ctx.now, updatedAt: ctx.now,
    }).onConflictDoNothing({ target: kbEntries.workflowDedupKey }).returning({ id: kbEntries.id });
    const kbEntryId = inserted[0]?.id ?? (await existingByDedup(ctx.tx, kbEntries, dedupKey));
    return { effect: { kbEntryId, title }, inverse: { tool: "add_kb_entry", kbEntryId } };
  },
};

/** Fetch the id of a row already written under `dedupKey` (the ON CONFLICT lost the race). */
async function existingByDedup(
  tx: Tx, table: typeof drafts | typeof kbEntries, dedupKey: string,
): Promise<string> {
  const [row] = await tx.select({ id: table.id }).from(table)
    .where(eq(table.workflowDedupKey, dedupKey)).limit(1);
  if (!row) throw new WorkflowStepError("dedup_row_vanished");
  return row.id;
}

const REGISTRY: Record<ToolName, Tool> = {
  file_message: fileMessageTool,
  draft_reply: draftReplyTool,
  add_kb_entry: addKbEntryTool,
};

function toolFor(name: string): Tool | undefined {
  return (REGISTRY as Record<string, Tool>)[name];
}

/**
 * The structural sensitivity check. Returns true if ANY of `messageIds` (in
 * `accountId`) is no_ai OR no_forward OR no_kb OR sensitivity-flagged OR priority.
 * Run as ONE SQL predicate (not a post-filter) so a flag can never be forgotten.
 */
/**
 * Do ALL of `messageIds` belong to `accountId`? Separate from {@link anySensitive}, which FAILS
 * OPEN on a foreign id and must: its predicate carries the account, so a stranger's message
 * matches no row and answers "none flagged" — wrong for "may this account act on these at all":
 * `upsertFolderState` is keyed on `message_id` alone, so naming another account's id could move
 * mail in a stranger's mailbox. Checked at `resolveTargets`: every tool declares its targets, so
 * one check covers every future tool. It asks "does any target belong to somebody else": a
 * missing id must still throw `target_missing` at its own step — the no-auto-rollback property.
 * The ids are v4 UUIDs, so the leaked oracle is worth nothing.
 */
async function anyForeign(tx: Tx, accountId: string, messageIds: string[]): Promise<boolean> {
  if (messageIds.length === 0) return false;
  const rows = await tx.select({ id: messages.id }).from(messages)
    .where(and(inArray(messages.id, uniq(messageIds)), ne(messages.accountId, accountId)))
    .limit(1);
  return rows.length > 0;
}

async function anySensitive(tx: Tx, accountId: string, messageIds: string[]): Promise<boolean> {
  if (messageIds.length === 0) return false;
  const rows = await tx.select({ id: messages.id }).from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      inArray(messages.id, messageIds),
      or(
        eq(messages.noAi, true), eq(messages.noForward, true), eq(messages.noKb, true),
        isNotNull(messages.sensitivityCategory), eq(messages.priority, true),
      ),
    )).limit(1);
  return rows.length > 0;
}

/** Has (runId, stepIndex) already committed an audit row? Then the step is done. */
async function stepAlreadyApplied(tx: Tx, accountId: string, runId: string, stepIndex: number): Promise<boolean> {
  const rows = await tx.select({ id: auditLog.id }).from(auditLog)
    .where(and(
      eq(auditLog.accountId, accountId),
      eq(auditLog.action, "workflow_step"),
      sql`${auditLog.payload}->>'runId' = ${runId}`,
      sql`(${auditLog.payload}->>'stepIndex')::int = ${stepIndex}`,
    )).limit(1);
  return rows.length > 0;
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** The minimal `workflow_runs` row the executor drains — the drain hands this in. */
export interface WorkflowRunRow {
  id: string;
  accountId: string;
  workflowId: string | null;
  stepCursor: number;
  status: string;
}

export interface WorkflowExecutorDeps {
  db: Tx;              // top-level handle for the per-step db.transaction (crash-resume)
  drafter: DraftPort;  // INJECTED (mocked in tests)
  /** The AI spend gate, consulted by `draft_reply` only. Absent ⇒ unmetered. */
  credits?: SpendPort;
  now?: () => Date;
}

export type WorkflowRunResult =
  | { status: "succeeded"; stepsRun: number }
  | { status: "failed"; reason: string; stepIndex: number };

export class WorkflowExecutor {
  /**
   * Run ONE workflow_run to completion. The drain has already flipped
   * it `pending → running` under a guarded UPDATE; here we pre-flight sensitivity,
   * then execute steps from `stepCursor`, each in its own tx (durable resume), each
   * writing an `audit_log` inverse. A step failure marks the run `failed` WITHOUT
   * rolling back prior steps (they are individually reversible + already logged).
   */
  async runOne(deps: WorkflowExecutorDeps, run: WorkflowRunRow): Promise<WorkflowRunResult> {
    const now = deps.now?.() ?? new Date();

    // Load the (live, non-soft-deleted) workflow's steps. A gone/deleted workflow → fail.
    const wf = run.workflowId
      ? (await deps.db.select({ steps: workflowsTbl.steps }).from(workflowsTbl)
          .where(and(
            eq(workflowsTbl.id, run.workflowId),
            eq(workflowsTbl.accountId, run.accountId),
            isNull(workflowsTbl.deletedAt),
          )).limit(1))[0]
      : undefined;
    if (!wf) return this.fail(deps.db, run, now, "workflow_gone", -1);
    const steps = (wf.steps as WorkflowStep[]) ?? [];

    // WHOLE-RUN SENSITIVITY PRE-FLIGHT. Resolve EVERY step's targets and refuse the
    // ENTIRE run (act on NOTHING) if any is sensitivity-flagged. This runs before any step.
    const allTargets = uniq(steps.flatMap((s) => toolFor(s.tool)?.resolveTargets(s.args ?? {}) ?? []));
    // OWNERSHIP FIRST, because the sensitivity question presumes it. `anySensitive` scopes its
    // own query to the account and therefore answers "not flagged" about a message belonging to
    // somebody else — a correct answer that reads as permission. See {@link anyForeign}.
    if (await anyForeign(deps.db, run.accountId, allTargets)) {
      return this.fail(deps.db, run, now, "not_owned", -1);
    }
    if (await anySensitive(deps.db, run.accountId, allTargets)) {
      return this.fail(deps.db, run, now, "sensitive", -1);
    }

    // Execute from the durable cursor. Each step is FOUR phases, and the split between (iii)
    // and (iv) is the money boundary: money and network in (iii), OUTSIDE any transaction, so a
    // failure in the
    // step's writes can no longer roll back a charge for a model call we have already paid for.
    //
    // NO NETWORK INSIDE THE STEP TRANSACTION. That is enforced, not asserted: the only
    // `DraftPort` in scope inside (iv) is the one `ToolApplyContext` does NOT carry, and the same
    // goes for the credit gate. Reaching for either from a tool's `apply` does not compile.
    for (let i = run.stepCursor; i < steps.length; i++) {
      const step = steps[i]!;
      const tool = toolFor(step.tool);
      if (!tool) return this.fail(deps.db, run, now, `unknown_tool:${step.tool}`, i);
      const targets = tool.resolveTargets(step.args ?? {});
      let prepared: StepPrepared | null = null;
      try {
        // (i) Idempotency, asked BEFORE prepare. An already-applied step must cost neither a
        //     charge nor a model call, so the cheap audit-row read moves ahead of both; the
        //     cursor advance is its own tiny transaction.
        if (await stepAlreadyApplied(deps.db, run.accountId, run.id, i)) {
          await deps.db.transaction(async (txRaw) => {
            await (txRaw as unknown as Tx).update(workflowRuns)
              .set({ stepCursor: i + 1 }).where(eq(workflowRuns.id, run.id));
          });
          continue;
        }
        // (ii) Sensitivity, THIRD layer. The pre-flight refused the whole run and (iv) re-checks at write
        //      time; this one exists because prepare moved the model and the money EARLIER than
        //      the in-tx check, and a message flagged sensitive since the pre-flight must not
        //      reach a model or a ledger row on the strength of a check that runs after both.
        if (await anyForeign(deps.db, run.accountId, targets)) {
          throw new WorkflowStepError("not_owned");
        }
        if (await anySensitive(deps.db, run.accountId, targets)) {
          throw new WorkflowStepError("sensitive");
        }
        // (iii) PREPARE — strictly between transactions. The ONLY place a paid call or a ledger
        //       write happens. No `db.transaction` frame is open here, which is what makes the
        //       gate's own transaction safe on PGlite's single connection.
        prepared = (await tool.prepare?.(
          {
            db: deps.db, accountId: run.accountId, runId: run.id, stepIndex: i,
            drafter: deps.drafter, credits: deps.credits,
          },
          step.args ?? {},
        )) ?? null;

        // (iv) THE STEP TRANSACTION: database writes only. Both checks above are repeated here
        //      as the write-time layer — (i) and (ii) are about not paying, these are about not
        //      double-applying and not acting.
        await deps.db.transaction(async (txRaw) => {
          // The brand does not travel to a transaction object, and every locking statement below
          // needs it, so it is carried from the handle the transaction was opened on.
          const tx = carryDialect(deps.db, txRaw as object) as unknown as Tx;
          const repo = makeDrizzleRepo(tx);
          // Idempotency gate: an existing (runId, stepIndex) audit row ⇒ already applied.
          // Reaching this after (i) passed needs a concurrent drain of the SAME run, which the
          // drain's guarded `pending → running` claim already prevents. If it ever did, the
          // charge stands and is not lost twice: both drains name the same per-step ledger
          // source, so the second one answers `duplicate` and charges nothing.
          if (await stepAlreadyApplied(tx, run.accountId, run.id, i)) {
            await tx.update(workflowRuns).set({ stepCursor: i + 1 }).where(eq(workflowRuns.id, run.id));
            return;
          }
          // Sensitivity second layer: per-step structural RE-CHECK in its OWN query.
          if (await anyForeign(tx, run.accountId, targets)) throw new WorkflowStepError("not_owned");
          if (await anySensitive(tx, run.accountId, targets)) throw new WorkflowStepError("sensitive");

          const { effect, inverse } = await tool.apply(
            { repo, tx, accountId: run.accountId, runId: run.id, stepIndex: i, now },
            step.args ?? {},
            prepared,
          );
          // The canonical inverse home. One audit_log row per applied step.
          await repo.recordAudit(run.accountId, "workflow_step",
            { runId: run.id, stepIndex: i, tool: step.tool, effect }, inverse);
          // Advance the durable cursor + append the convenience log entry — SAME tx as the effect.
          //
          // It deliberately does NOT re-stamp `workflow_runs.claimed_at` as a heartbeat. Two
          // reasons, and the first is the one that would have made it a lie: `now` is frozen for
          // the whole run (line 480, and the worker passes `now: () => now`), so every step would
          // write the SAME pass-start instant and refresh nothing. The second is that it would
          // buy nothing if it worked — the shard's leader lock plus the sequential `cycle()` mean
          // no reaper can run while this executor does, so the reaper's threshold is resume LATENCY and
          // not a liveness contest. See `reapStaleClaims` in `apps/worker/src/workflow-cron.ts`.
          await tx.update(workflowRuns).set({
            stepCursor: i + 1,
            log: sql`${workflowRuns.log} || ${JSON.stringify([{ stepIndex: i, tool: step.tool, effect }])}::jsonb`,
          }).where(eq(workflowRuns.id, run.id));
        });
      } catch (err) {
        // Mark failed + failing stepIndex + reason; NO auto-rollback (prior steps stand).
        const reason = err instanceof WorkflowStepError ? err.reason : "error";
        // A charge that PREPARE committed and this failure cannot reverse. It is non-null only
        // when the step died in (iv), i.e. after the model was genuinely called and paid for —
        // the model-call failure refunds itself inside `prepare`. The charge correctly STANDS
        // — the cost was really incurred — and the concrete case is a mailbox or
        // thread deleted between prepare and the insert, where the user's own action caused the
        // race. It is recorded rather than silently kept so an abandoned charge is discoverable
        // from the run that abandoned it.
        return this.fail(deps.db, run, now, reason, i, prepared?.chargedAttempt ?? null);
      }
    }

    await deps.db.update(workflowRuns).set({ status: "succeeded", finishedAt: now })
      .where(eq(workflowRuns.id, run.id));
    return { status: "succeeded", stepsRun: steps.length - run.stepCursor };
  }

  /**
   * Mark the run failed + reason + failing stepIndex in the log. No effects touched here.
   *
   * `abandonedCharge` names a `credit_ledger` source that was paid for work this run did not
   * deliver and that nothing will reverse — see the catch block in {@link runOne}. It is written
   * into the run's own log rather than a new column because `log` is `jsonb` and a debit committed
   * before its paid call already IS a hold with `refund:<source>` as its release, so the split
   * needed no migration. Absent on every other failure, which is the common case.
   */
  private async fail(
    db: Tx, run: WorkflowRunRow, now: Date, reason: string, stepIndex: number,
    abandonedCharge: string | null = null,
  ): Promise<WorkflowRunResult> {
    const entry = abandonedCharge
      ? { failedAtStep: stepIndex, reason, abandonedCharge }
      : { failedAtStep: stepIndex, reason };
    await db.update(workflowRuns).set({
      status: "failed", reason, finishedAt: now,
      log: sql`${workflowRuns.log} || ${JSON.stringify([entry])}::jsonb`,
    }).where(eq(workflowRuns.id, run.id));
    return { status: "failed", reason, stepIndex };
  }
}

export const workflowExecutor = new WorkflowExecutor();
