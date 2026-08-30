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
import { ledgerSources, type AiCreditGate } from "@trafficflow/db/cloud";
import { makeDrizzleRepo, type DrizzleRepo } from "../../adapters/drizzle-repo.js";
import type { NativeLocator } from "../../ports.js";
import type { DraftPort, DraftInput, DraftResult } from "../draft.js";
import { plainTextToOutboundBody } from "../../outbound-text.js";
import type { ToolName, WorkflowStep } from "../../workflow-shapes.js";

// ─────────────────────────────────────────────────────────────────────────────
// The gated workflow EXECUTOR.
//
// This is the security-critical layer that DRAINS a `pending` workflow_run and
// runs its steps. It lives in CORE and operates at the DB/repo level (the
// worker imports core+db only, never services), so `file_message` reuses the
// desired-state handoff (`upsertFolderState` + a `message` move change — NEVER
// IMAP), `draft_reply` calls the INJECTED DraftPort (mocked in tests) and
// inserts a `drafts` row, `add_kb_entry` inserts a `kb_entries` row.
//
// The two invariants a workflow must NEVER violate:
//   1. NEVER act on sensitive mail — a WHOLE-RUN pre-flight refuses the entire
//      run if ANY targeted message is no_ai/no_forward/no_kb/sensitivity-flagged/
//      priority, and a per-step structural re-check is the second layer.
//   2. NEVER double-execute — each step commits in its OWN tx and advances a durable
//      `stepCursor`; the (runId, stepIndex) audit row is the idempotency marker a
//      re-drain checks BEFORE re-applying, and draft/kb inserts carry a unique
//      `workflow_dedup_key` as defense in depth.
//
// The canonical inverse home is `audit_log`: one row per applied step with its
// undo. `workflow_runs.log` is only a convenience index for the run DTO.
//
// This was the ONE call site in the product that made a paid model call inside a transaction —
// the reason a "charge on the caller's own transaction" gate method had to exist at all, and,
// since the charge moved into `prepare`, the reason it no longer does. Every other metered path
// (`pipeline.ts`,
// `DraftingService`, `proposal-cron.ts`, `ScreenerService`) already charged outside the
// transaction that stores its result; the step machinery now does too, in `prepare`.
// ─────────────────────────────────────────────────────────────────────────────

/* The undo payload is declared with the tool GRAMMAR, in `workflow-shapes.ts`, not here with the
 * runner that writes it: the service that replays an undo is mail-half code, and having the shape
 * live beside the runner made that service name this module — which calls a model — purely to
 * describe what it reads back out of the audit log. Re-exported so this file's own consumers are
 * unaffected by where it now lives. */
export type { WorkflowInverse } from "../../workflow-shapes.js";
import type { WorkflowInverse } from "../../workflow-shapes.js";

/** What a tool's `apply` returns: an audit-safe `effect` summary + the `inverse` (undo). */
export interface ToolApplyResult {
  effect: Record<string, unknown>;
  inverse: WorkflowInverse;
}

/**
 * Per-step context handed to a tool's `apply`, all bound to the step's OWN transaction.
 *
 * **There is deliberately no `drafter` and no `credits` here, and their ABSENCE is the
 * enforcement of the rule** — "no network, no ledger write inside the step transaction". Both
 * fields once existed: `draft_reply` charged through a gate method that ran on `ctx.tx`, then made
 * the paid Anthropic call on that same transaction, so any of the three writes that follow the
 * call — the `drafts` insert, the dedup re-read, `recordChange` — rolled the CHARGE back along
 * with itself while Anthropic had already been paid. One unpaid model call per post-call failure.
 *
 * The old comment argued the opposite in detail ("the charge and the effect become ONE fact, so
 * there is nothing to refund"), and it was true of the database effect and false of the money —
 * which is the only effect the charge-for-real-cost rule is about. A comment cannot hold a rule like this, so the
 * rule is now a type: money and network live in {@link ToolPrepareContext}, which runs strictly
 * between transactions, and reaching for either from `apply` is a compile error.
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
 * The PREPARE context — the ONLY place in the step machinery where a paid model call or a ledger
 * write may happen, and the reason it is a separate type from {@link ToolApplyContext}.
 *
 * `db` is the TOP-LEVEL handle and `prepare` is invoked with **no `db.transaction` frame open**.
 * That is what makes the AI credit gate safe to call from here: the gate opens its own short
 * transaction, and the original self-deadlock (three cases at once, before that method existed)
 * was never a lock-graph deadlock — at the step gate the transaction holds no row locks at all.
 * It was an inner `BEGIN` issued on the handle whose connection the outer transaction was
 * holding, which blocks forever on PGlite's single connection and wedges a real pool only when
 * it is exhausted. A structural absence of nesting fixes it in the strictest harness, not an
 * argument about locks.
 *
 * This is the order `DraftingService` already proves: fallible reads, then the charge, then the
 * model, and the storing transaction afterwards on its own.
 */
export interface ToolPrepareContext {
  db: Tx;              // TOP-LEVEL handle — never a transaction. See `runOne`.
  accountId: string;
  runId: string;
  stepIndex: number;
  drafter: DraftPort;  // INJECTED (mocked in tests) — no live model client in core
  /** The AI spend gate. Absent ⇒ unmetered. Charged and refunded HERE, never in `apply`. */
  credits?: AiCreditGate;
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
   * Everything that costs money or makes a network call, OUTSIDE any transaction.
   *
   * The order is `DraftingService`'s (`drafting-service.ts:100-208`), and each position is a fix
   * rather than a preference:
   *
   *  1. `loadDraftTarget` — a missing target costs nothing, so it is asked first;
   *  2. `buildDraftInput` — two fallible database round-trips that spend no tokens, so they sit
   *     BEFORE the charge; charging first billed an AI action for a request in which zero model
   *     calls occurred, which is the bill the ledger could never explain;
   *  3. the CHARGE — after both, and before the model, so "revenue precedes token spend" is
   *     structural: an empty balance stops the step before it costs us a token;
   *  4. the MODEL, with a refund if it throws.
   *
   * The charge is per STEP (`workflow_run:<runId>:<stepIndex>`), one row per step per run. A
   * re-drained run re-executes its steps idempotently, so a retry of an attempt still open
   * answers `duplicate` → proceed, charged nothing.
   *
   * **That free re-run is now reachable, and it is crash-resume.** `workflowDrainPass`
   * requeues a run whose `running` claim has gone unrefreshed past `STALE_CLAIM_MS`, and the
   * executor resumes it from `stepCursor`. The gate is built for exactly that retry: the
   * workflow gate declares no `retryWindowMs`, so an un-refunded attempt never ages out and the
   * resumed step is served free however long the worker was down. The cost that IS repeated is
   * the model call itself, when the crash landed between the charge and the step's commit — we
   * pay for it, the customer does not. `apps/worker/src/workflow-cron.ts` states the whole trade.
   *
   * This paragraph used to read "nothing deployed re-queues a run … do not read this as
   * crash-resume: it is not". That was true when it was written and is the defect the
   * stale-claim reaper closed.
   *
   * `spend`, not `tryDebit`: the refusal has to be MAPPED, not collapsed into one boolean. A
   * database FAULT used to propagate out of the deleted gate method and land as reason `error`;
   * collapsing it into the same answer as an empty balance would tell a fully funded customer
   * they are out of credits because our ledger connection dropped. `workflow_runs.reason` is
   * free text carried raw into the DTO, so the three distinct words cost no copy.
   *
   * The gate is reached only AFTER the whole-run sensitivity pre-flight and the per-step
   * structural re-check have both passed, so a sensitive target cannot produce a ledger row here
   * (no AI spend on sensitive mail: zero rows, asserted against `credit_ledger`). A refusal
   * FAILS the step
   * rather than degrading: there is no deterministic fallback for "write a reply", and silently
   * marking a step done that never ran would be a silent AI action, which this product forbids.
   */
  async prepare(ctx, args) {
    const messageId = requireString(args.messageId, "draft_reply.messageId");
    const target = await loadDraftTarget(ctx.db, ctx.accountId, messageId);
    const input = await buildDraftInput(ctx.db, ctx.accountId, target);

    const source = ledgerSources.workflowStep(ctx.runId, ctx.stepIndex);
    const meta = { runId: ctx.runId, stepIndex: ctx.stepIndex, messageId };
    let chargedAttempt: string | null = null;
    if (ctx.credits) {
      const outcome = await ctx.credits.spend(source, meta);
      if (!outcome.permitted) {
        // A FAULT is our outage, not the customer's balance — never `insufficient_credits`.
        if (outcome.refusal === "fault") throw new WorkflowStepError("ai_unavailable");
        // AN OVERLAP is not a fault and not a balance either: another caller holds the exclusive
        // claim on this exact step and is running the model for it. Unreachable
        // today — the workflow gate does not set `exclusive`, because the loser path here is a
        // terminal `failed` run rather than a retry and that decision has not been made — and
        // written out anyway, so that switching it on is a one-line change and not a silent fall
        // through to the `outcome.reason` branch below, which would read `undefined` on this
        // variant and report a refusal the subscription never made. `ai_unavailable` is the
        // retryable answer, which is the honest one for a condition that clears by itself.
        if (outcome.refusal === "inflight") throw new WorkflowStepError("ai_unavailable");
        if (outcome.refusal === "quantity") throw new WorkflowStepError("insufficient_credits");
        // A STATE refusal reports the subscription's OWN word (`ai_disabled` for the account's
        // own off switch, else `canceled` / `paused` / `past_due` / `unpaid` / `no_subscription` /
        // `suspended`), because "buy more credits" is the wrong sentence for every one of them.
        throw new WorkflowStepError(outcome.reason);
      }
      chargedAttempt = outcome.charged ? outcome.attempt : null;
    }

    // THE PAID CALL. Outside every transaction, which is the whole point of `prepare`.
    //
    // This path REFUNDS, and the workflow path did not before. The reason is DraftingService's:
    // a refund is worth making when the retry might never come, and a `failed` run is terminal —
    // the stale-claim reaper requeues a stranded `running` claim and DELIBERATELY does not touch `failed`,
    // so there is still no future free retry to honour this charge. `refund(source)` is a no-op
    // unless THIS gate charged THIS attempt: the marker is
    // cleared on every non-charging decision, so a free retry of an earlier open attempt cannot
    // reverse a charge whose work may already have been delivered. The refund also CLOSES the
    // attempt, so a later re-queue is charged afresh rather than served free — which is what
    // stops refund-plus-retry composing into an unlimited free draft.
    let result: DraftResult;
    try {
      result = await ctx.drafter.draft(input);
    } catch (err) {
      await ctx.credits?.refund(source, meta);
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

    // BOTH HALVES, PROMOTED TOGETHER. The model answers in prose; a stored draft carries a text
    // part and a markup part, and the send path only produces a `multipart/alternative` when the
    // second one is there. This step used to write the words alone, so a reply a workflow drafted
    // went out as `text/plain` while the same reply composed by hand went out as both.
    //
    // The pair comes from ONE call, which is what stops the two parts from being sourced
    // independently — the request path stores the same pair by handing the markup to
    // `DraftsService`, which derives the words back out of it. This inserter cannot use that
    // service (core never imports services), so it takes the halves directly; a test asserts the
    // two routes agree by rendering the markup back to text and comparing.
    //
    // The 256 KiB html ceiling is NOT checked here, unlike the request path: this is a direct
    // insert, so `drafts_html_cap` is the only gate and it would surface as a failed run rather
    // than as a `413`. A drafter capped at a thousand output tokens cannot reach it.
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
 * Do ALL of `messageIds` belong to `accountId`?
 *
 * ── WHY THIS IS SEPARATE FROM {@link anySensitive}, WHICH ALREADY TAKES AN ACCOUNT ───────────
 *
 * Because {@link anySensitive} FAILS OPEN on a foreign id, and must. Its question is "is any of
 * these flagged?", asked with `eq(messages.accountId, accountId)` in the predicate — so a message
 * belonging to somebody else matches no row, the answer is "none are flagged", and the run
 * proceeds. That is the correct answer to the question it asks and the wrong answer to the
 * question nobody was asking: "may this account act on these at all?"
 *
 * Nothing else asked it either. `validateSteps` checks the tool ALLOWLIST and the shape of
 * `args`; a step is `{tool, args}` with `args.messageId` a free string. `fileMessageTool.apply`
 * reads the prior folder state, writes the desired one and records the change — and
 * `upsertFolderState` is keyed on `message_id` alone, with no account column to disagree with.
 * So an authenticated, verified account could author a workflow naming ANOTHER account's message
 * id, run it, and set that message's desired folder; the worker then performs the physical IMAP
 * move on a mailbox the caller has no relationship with. The mailbox is the master, so that write
 * is not one this product can take back.
 *
 * IT IS CHECKED HERE, AT `resolveTargets`, AND NOT INSIDE EACH TOOL. Every tool already declares
 * the message ids it will touch so the sensitivity layers can see them; that declaration is
 * exactly the ownership question's input too. One check at each of the two places the executor
 * already resolves targets covers every tool that exists and every tool anybody adds later — a
 * per-tool check would be a rule each new tool has to remember, which is the shape of enforcement
 * account isolation is specifically not allowed to have.
 *
 * IT ASKS "DOES ANY TARGET BELONG TO SOMEBODY ELSE?", NOT "DOES EVERY TARGET BELONG TO ME?", and
 * the difference is a behaviour this executor already guarantees. An id matching NO message is not
 * foreign, it is missing — and a missing target is supposed to reach its tool and throw
 * `target_missing` at its own step, leaving the steps before it committed. That is the documented
 * no-auto-rollback property, with its own test. The `every-target-is-mine` form refused those runs
 * at the pre-flight instead, took the guarantee away as a side effect, and would have been a
 * second change smuggled in under a security fix.
 *
 * The cost is a weak oracle: a foreign id fails the run at the pre-flight and an unknown id fails
 * it at a step, so the two are distinguishable from the run row. It is worth nothing — the ids are
 * v4 UUIDs, so distinguishing "exists elsewhere" from "does not exist" requires already holding
 * the id that the check exists to refuse.
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
  credits?: AiCreditGate;
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
          const tx = txRaw as unknown as Tx;
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
