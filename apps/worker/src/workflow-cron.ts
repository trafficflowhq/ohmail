import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { workflowRuns, workflows as workflowsTbl, type Tx } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { makeAiCreditGate, type AiCreditGate } from "@trafficflow/db/cloud";
import { WorkflowExecutor, silentLogger, type DraftPort, type Logger, type WorkflowTrigger } from "@trafficflow/core";
import { selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import { loadServedAccounts } from "./mailboxes.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";

/**
 * The workflow DRAIN pass. It runs in TWO phases.
 *
 * Phase 0 REAPS: it requeues runs stranded in `running` by a worker that died holding them
 * (below). Phase 1 scans `pending` workflow_runs — which now includes anything phase 0
 * just requeued — and, for each, performs a GUARDED status transition `pending → running` that
 * RE-ASSERTS `status='pending'` in the UPDATE WHERE, exactly like `bubbleUpPass`. A concurrent
 * drain (the worker cycle + this cron backstop) that loses the race matches 0 rows and
 * skips, so a run can NEVER be double-claimed. The claimed run is then handed to the
 * `WorkflowExecutor`, which pre-flights sensitivity, runs each step in its own tx
 * with a durable cursor + `audit_log` inverse, and marks succeeded/failed.
 *
 * Pure and hermetic: takes a db/tx executor + the injected DraftPort + a clock, so a
 * test drives it against PGlite with a MOCK drafter and no leader lock or network.
 *
 * ── WHO CALLS IT: `index.ts` FIRST, THIS FILE'S WRAPPER SECOND ────────────────────────────
 *
 * The PRIMARY caller is `apps/worker/src/index.ts`'s `cycle()`, which runs this and
 * {@link workflowTimeScanPass} once per poll interval per account of its shard — so the 202
 * from `POST /workflows/:id/run` is honoured by the always-on worker, not by a cron.
 * {@link runWorkflowCron} at the bottom of this file is the manual backstop for a dead worker
 * and is on no schedule: it takes the lock the live worker holds. Stated here because an
 * earlier reading took this file's cron wrapper as the only producer and concluded the
 * drain never ran — it does, and `test/every-pass-has-a-producer.test.ts` asserts which
 * caller is which rather than leaving it to a grep.
 */
export interface WorkflowDrainDeps {
  drafter: DraftPort;
  /**
   * The AI spend gate for this account, consulted by the `draft_reply` tool only
   * (`file_message` / `add_kb_entry` are deterministic and are not AI actions). Absent ⇒
   * unmetered. A refusal fails the STEP with `insufficient_credits` rather than degrading:
   * "write a reply" has no rules-only fallback, and marking a step done that never ran would
   * be a silent AI action — nothing may act on mail without the user having decided it.
   */
  credits?: AiCreditGate;
  /** Scope the drain to ONE account — the worker loops its served accounts. Omitted ⇒ all accounts. */
  accountId?: string;
}

const executor = new WorkflowExecutor();

/**
 * How old a `running` claim must be before the reaper takes it back.
 *
 * It is RESUME LATENCY, not a liveness contest, and that is a consequence of the deployment
 * rather than of this number: one shard has ONE draining process (the worker holds
 * `leaderLockKeyFor(shardIndex)` for its whole life and `runWorkflowCron` takes the same lock),
 * `cycle()` awaits each drain, and the reap phase runs BEFORE the drain inside one call. So no
 * executor can be running while a reaper looks at its row — every `running` row a reaper sees
 * belongs to a process that is gone. There is deliberately no per-step heartbeat; the executor
 * says why at its cursor advance.
 *
 * What the number buys is margin against the one thing that is not structural: a claim written
 * by a worker whose clock differs from the reaper's, and a container paused between the two.
 * Fifteen minutes is far beyond both, and the cost runs one way — too LONG only delays a
 * stranded run, too SHORT puts a second executor on a live one. That is survivable (the audit
 * row is each step's commit marker, the dedup keys are unique, the ledger answers `duplicate`)
 * but "survivable" is not "should happen".
 */
export const STALE_CLAIM_MS = 15 * 60_000;

export async function workflowDrainPass(
  db: Tx, deps: WorkflowDrainDeps, now: Date = new Date(),
): Promise<{ drained: number; reaped: number }> {
  const reaped = await reapStaleClaims(db, deps, now);

  const pendingFilter = deps.accountId
    ? and(eq(workflowRuns.status, "pending"), eq(workflowRuns.accountId, deps.accountId))
    : eq(workflowRuns.status, "pending");
  const pending = await db.select({
    id: workflowRuns.id, accountId: workflowRuns.accountId,
    workflowId: workflowRuns.workflowId, stepCursor: workflowRuns.stepCursor,
  }).from(workflowRuns).where(pendingFilter);

  let drained = 0;
  for (const row of pending) {
    // Guarded claim: re-assert status='pending' in the UPDATE — a concurrent drain that
    // already flipped it to 'running' makes this match 0 rows, so the loser skips. The
    // `claimedAt` stamp written here is the ONLY write of that column, and it is what makes the
    // claim findable if this process dies holding it (the reaper's input). It is a JS `Date` and must stay one
    // — see the column's own comment for what a microsecond-precision value silently breaks.
    const claimed = await db.transaction(async (tx) => {
      const upd = await tx.update(workflowRuns).set({ status: "running", claimedAt: now })
        .where(and(eq(workflowRuns.id, row.id), eq(workflowRuns.status, "pending")))
        .returning({ id: workflowRuns.id });
      return upd.length > 0;
    });
    if (!claimed) continue;

    await executor.runOne(
      { db, drafter: deps.drafter, credits: deps.credits, now: () => now },
      { id: row.id, accountId: row.accountId, workflowId: row.workflowId, stepCursor: row.stepCursor, status: "running" },
    );
    drained++;
  }
  return { drained, reaped };
}

/**
 * THE REAPER. Requeue runs whose `running` claim has gone unrefreshed, so a worker that
 * died holding one does not strand it for ever.
 *
 * ── WHY IT REQUEUES AND RESUMES RATHER THAN FAILING THE RUN ───────────────────────────────
 *
 * Failing outright is the safer-sounding option and it is the wrong one, because the row already
 * carries everything a correct resumption needs and failing throws it away — including, when the
 * crash landed after a `prepare`, an AI charge the customer has paid and would then never
 * receive the work for.
 *
 * Resumption is safe here by CONSTRUCTION, not by argument, and the construction is worth naming
 * because it is what a future step tool must not break:
 *
 *  1. **Nothing in the step registry sends.** It is exactly `file_message`, `draft_reply` and
 *     `add_kb_entry` (`packages/core/src/ai/workflows/executor.ts`). A draft is stored
 *     `status='draft'` and only the send path sends it, on explicit user action — nothing is
 *     ever sent without the user saying so. So
 *     no repeated step can put anything in front of a third party.
 *  2. **A step's commit marker is its `audit_log` row**, keyed `(runId, stepIndex)` and written
 *     in the SAME transaction as the effect. `stepAlreadyApplied` is asked BEFORE
 *     `prepare`, so a step that committed costs the resumed run neither a model call nor a
 *     charge — it only advances the cursor.
 *  3. **The effects are keyed, not appended.** `file_message` is a desired-state upsert keyed by
 *     messageId; `draft_reply` and `add_kb_entry` insert under a unique
 *     `workflow_dedup_key = "<runId>:<stepIndex>"` with `ON CONFLICT DO NOTHING`.
 *  4. **The money is keyed too.** `credit_ledger_source_uq` is `UNIQUE (account_id, source)` and
 *     the source is `workflow_run:<runId>:<stepIndex>`. The workflow gate declares no
 *     `retryWindowMs`, so an un-refunded attempt never ages out: a resumed step answers
 *     `duplicate` → proceed, charged NOTHING. This is the retry the ledger design already
 *     provided for — *"a crash between debit and refund is no longer a loss: the attempt stays
 *     OPEN, so the retry is free and delivers the work the charge paid for"* — which until now
 *     nothing deployed could actually perform.
 *
 * TWO RESIDUALS, stated rather than hidden. Both are accepted, and neither is created by this
 * pass — they are the shape the money machinery already had, now that a retry finally exists:
 *
 *  · A crash in the window between `prepare` committing its charge + making the paid model call,
 *    and the step transaction committing, makes the resumed run call the model a SECOND time. We
 *    pay for that call; the customer does not (4), and no user-visible action is repeated (1).
 *    One extra model call per crashed run is the price of not abandoning a paid charge, and it
 *    is the cheaper side of the trade. Eliminating it needs a durable "prepare committed" marker
 *    and two-phase bookkeeping, to close a seconds-wide window at deploy frequency.
 *  · If the RESUMED `prepare`'s model call fails, its `refund` is a no-op — the gate's marker
 *    doctrine says a refund may only reverse a charge THIS gate instance made, and this one was
 *    a free retry of an open attempt. So the first attempt's charge stands on a run that then
 *    fails terminally. That is the marker doctrine working as designed (it is what stops
 *    refund-plus-retry composing into unlimited free drafts), not a regression.
 *
 * `failed` is NOT touched. It is terminal by design — the refund doctrine in `executor.ts`
 * depends on it — and requeueing it would turn every permanent failure into an infinite loop.
 *
 * ── THE GUARD, WHICH IS THE HALF THAT CAN GO WRONG QUIETLY ────────────────────────────────
 *
 * The deployment already makes a same-shard race hard (one leader lock, one draining process,
 * reap before drain inside one call), so the guard is defence against the case the lock does not
 * cover: an operator running the backstop against a shard whose worker is mid-restart, and any
 * future caller. The UPDATE re-asserts `status='running'` AND the OBSERVED `claimed_at`, which
 * is strictly stronger than status alone and mirrors how `workflowTimeScanPass` re-asserts the
 * observed `nextRunAt`: the winner sets `pending` and NULLs the stamp, so the loser matches 0
 * rows. Proven on real Postgres across two pools, because a single-connection harness cannot
 * decide it — two `drainPass` calls there would simply serialize and a broken guard would
 * still look green.
 *
 * That equality is also the reason `claimed_at` may only ever be written from a JS `Date`. A
 * value carrying microseconds — which is what `now()` or a copy of `created_at` stores — cannot
 * survive the round trip through a millisecond-precision `Date`, so the re-assertion matches
 * nothing and the row is selected here on every pass and requeued on none of them. Migration
 * `0033` has the measurement, and is the reason it ships no backfill.
 *
 * A NULL `claimed_at` on a `running` row means the claim was made by code that predates the
 * column — the rows already stranded when this shipped, plus anything claimed in the deploy
 * window — so the predicate falls back to `created_at`. That arm, and not a backfill, is what
 * rescues the existing backlog.
 */
async function reapStaleClaims(db: Tx, deps: WorkflowDrainDeps, now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const filters = [
    eq(workflowRuns.status, "running"),
    // `COALESCE(claimed_at, created_at) < staleBefore`, spelled as two drizzle predicates rather
    // than one raw-SQL expression. Not a style choice: a raw-SQL left side gives drizzle no
    // column type to infer from, so the JS `Date` binds UNTYPED and postgres.js throws
    // `ERR_INVALID_ARG_TYPE` — which PGlite accepts happily and real Postgres does not. That is
    // the regression `workflowTimeScanPass` documents thirty lines below, and it killed the drain
    // that followed it. Both comparisons here have a real column on the left.
    or(
      lt(workflowRuns.claimedAt, staleBefore),
      and(isNull(workflowRuns.claimedAt), lt(workflowRuns.createdAt, staleBefore)),
    )!,
  ];
  // Scoped exactly like the drain below. An unscoped pass under a shard-specific leader lock
  // would let shard 0 requeue shard 1's runs — and hand them to shard 0's executor.
  if (deps.accountId) filters.push(eq(workflowRuns.accountId, deps.accountId));

  const stale = await db.select({ id: workflowRuns.id, claimedAt: workflowRuns.claimedAt })
    .from(workflowRuns).where(and(...filters));

  let reaped = 0;
  for (const row of stale) {
    const requeued = await db.update(workflowRuns)
      .set({ status: "pending", claimedAt: null })
      .where(and(
        eq(workflowRuns.id, row.id),
        eq(workflowRuns.status, "running"),
        // The observed stamp, re-asserted. `isNull` and `eq` are kept apart rather than folded
        // into one `IS NOT DISTINCT FROM`: drizzle's `eq` binds a JS Date through the column's
        // own type, whereas a raw-SQL comparison has no column to infer from and binds it
        // untyped — the exact failure `workflowTimeScanPass` documents, which PGlite accepts and
        // real Postgres throws on.
        row.claimedAt === null ? isNull(workflowRuns.claimedAt) : eq(workflowRuns.claimedAt, row.claimedAt),
      ))
      .returning({ id: workflowRuns.id });
    if (requeued.length > 0) reaped++;
  }
  return reaped;
}

/** A `time` trigger carries an optional recurrence interval (ms) alongside `nextRunAt`. */
type TimeTrigger = WorkflowTrigger & { intervalMs?: number };

/**
 * Compute a `time` trigger's next state after it fires. With a positive
 * `intervalMs` it advances `nextRunAt` to the next occurrence STRICTLY after `now`
 * (catch-up loop so a long-overdue trigger doesn't refire every scan); without one it
 * is a ONE-SHOT and `nextRunAt` is CLEARED so it never fires again.
 */
function advanceTimeTrigger(trigger: TimeTrigger, now: Date): WorkflowTrigger {
  const intervalMs = typeof trigger.intervalMs === "number" && trigger.intervalMs > 0 ? trigger.intervalMs : 0;
  if (intervalMs > 0 && trigger.nextRunAt) {
    let next = new Date(trigger.nextRunAt).getTime() + intervalMs;
    const nowMs = now.getTime();
    while (next <= nowMs) next += intervalMs;
    return { ...trigger, nextRunAt: new Date(next).toISOString() };
  }
  const { nextRunAt: _drop, ...rest } = trigger;   // one-shot: drop nextRunAt
  return rest as WorkflowTrigger;
}

/**
 * The TIME-TRIGGER scan — the `bubbleUpPass` sibling. It finds enabled,
 * non-deleted `time` workflows whose `nextRunAt <= now` and, for each, enqueues ONE
 * `pending` workflow_run AND advances/clears `nextRunAt` — both in ONE tx under a
 * GUARDED UPDATE that RE-ASSERTS the observed `nextRunAt` (exactly like `bubbleUpPass`
 * re-asserts `state='bubbled_up'`). A concurrent scan (worker cycle + this cron backstop)
 * that already advanced the trigger matches 0 rows and enqueues nothing, so a double
 * scan can NEVER double-enqueue. The enqueued run's `trigger` snapshots the FIRING
 * trigger; the drain then executes it under the sensitivity gates. A future
 * `nextRunAt` is not due and is left untouched.
 *
 * Pure and hermetic: db/tx executor + clock, so a test drives it against PGlite.
 */
export async function workflowTimeScanPass(
  db: Tx, deps: { accountId?: string }, now: Date = new Date(),
): Promise<{ enqueued: number }> {
  const filters = [
    eq(workflowsTbl.enabled, true),
    isNull(workflowsTbl.deletedAt),
    sql`${workflowsTbl.trigger}->>'kind' = 'time'`,
    // The comparison is written out rather than built with drizzle's `lte(sql\`…\`, now)`:
    // with a raw-SQL left side drizzle has no column type to infer from, so a JS `Date` is
    // bound UNTYPED and postgres.js throws `ERR_INVALID_ARG_TYPE: The "string" argument …
    // Received an instance of Date`. Under PGlite that never surfaced; against real
    // Postgres it threw on EVERY worker cycle, which the cycle's try/catch swallowed —
    // killing the time scan AND the drain that follows it in the same block. Bind the
    // ISO string and cast it explicitly on both sides.
    sql`(${workflowsTbl.trigger}->>'nextRunAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
  ];
  if (deps.accountId) filters.push(eq(workflowsTbl.accountId, deps.accountId));

  const due = await db.select({
    id: workflowsTbl.id, accountId: workflowsTbl.accountId, trigger: workflowsTbl.trigger,
  }).from(workflowsTbl).where(and(...filters));

  let enqueued = 0;
  for (const row of due) {
    const trigger = (row.trigger ?? {}) as TimeTrigger;
    const oldNextRunAt = trigger.nextRunAt;
    if (!oldNextRunAt) continue;                            // defensive: no due timestamp
    const nextTrigger = advanceTimeTrigger(trigger, now);

    const didEnqueue = await db.transaction(async (tx) => {
      // Guarded advance: re-assert the SAME nextRunAt string — a concurrent scan that
      // already advanced it matches 0 rows, so the loser enqueues nothing.
      const advanced = await tx.update(workflowsTbl)
        .set({ trigger: nextTrigger, updatedAt: now })
        .where(and(
          eq(workflowsTbl.id, row.id),
          eq(workflowsTbl.enabled, true),
          isNull(workflowsTbl.deletedAt),
          sql`${workflowsTbl.trigger}->>'nextRunAt' = ${oldNextRunAt}`,
        ))
        .returning({ id: workflowsTbl.id });
      if (advanced.length === 0) return false;
      await tx.insert(workflowRuns).values({
        accountId: row.accountId, workflowId: row.id, status: "pending", trigger,
      });
      return true;
    });
    if (didEnqueue) enqueued++;
  }
  return { enqueued };
}

/**
 * A DraftPort stub for when no live model is configured (the 4a default). A
 * `draft_reply` step then fails cleanly with `draft_reply_unconfigured` (reversible
 * steps still drain); a real `makeSonnetDrafter(new Anthropic())` is deployment config.
 */
export const unconfiguredDrafter: DraftPort = {
  async draft() {
    throw new Error("draft_reply_unconfigured: no DraftPort is wired (set a deployment drafter)");
  },
};

/**
 * MANUAL BACKSTOP (correctness), not a scheduled job. Guarded by the SAME session-level leader
 * lock the always-on worker + reconcile/bubble-up crons use: if the live worker holds it, this
 * exits without touching the DB. Otherwise it performs one drain pass and releases. Nothing
 * invokes it on a timer, and nothing can while a worker is up — it would only fail to take the
 * lock. `index.ts`'s `cycle()` is the producer of record; this is what an operator runs when
 * the worker is not. Recorded as `MANUAL_BACKSTOP` in `SCHEDULE_MANIFEST`
 * (`test/every-pass-has-a-producer.test.ts`).
 *
 * It loops the SERVED accounts (its shard, narrowed by the optional dev account
 * filter) exactly like the worker cycle, so a sharded deployment's cron never touches
 * another shard's accounts, and each account is isolated in its own try/catch.
 *
 * `log` defaults to `silentLogger` — see `cron-log.ts` for why the process that deploys is
 * the only one that turns it on.
 */
export async function runWorkflowCron(
  config: WorkerConfig, log: Logger = silentLogger,
): Promise<{ ran: boolean; drained: number }> {
  const lock = await acquireLeaderLock(config.databaseUrl, leaderLockKeyFor(config.shardIndex ?? 0));
  if (!lock) return { ran: false, drained: 0 };

  const owned = makeOwnedDb(config.databaseUrl);
  const db = owned.db;
  try {
    const now = new Date();
    let drained = 0;
    for (const accountId of await loadServedAccounts(db, selectionOf(config))) {
      try {
        // Enqueue any due time-triggered runs FIRST, then drain them this same pass.
        await workflowTimeScanPass(db as unknown as Tx, { accountId }, now);
        const res = await workflowDrainPass(
          db as unknown as Tx,
          {
            drafter: config.drafter ?? unconfiguredDrafter,
            // One gate per account, built from the account this pass is scoped to.
            credits: makeAiCreditGate(db as unknown as Tx, accountId, { reason: "debit_workflow" }),
            accountId,
          },
          now,
        );
        drained += res.drained;
      } catch (err) {
        log.error(cronEvent("workflow", "account_failed"), { accountId, err });
      }
    }
    return { ran: true, drained };
  } finally {
    try { await owned.close(); } catch (err) { log.error(cronEvent("workflow", "pool_close_failed"), { err }); }
    await lock.release();
  }
}

if (isCliEntry(import.meta.url)) {
  void runCronCli("workflow", runWorkflowCron, (r) => ({ ran: r.ran, fields: { drained: r.drained } }));
}
