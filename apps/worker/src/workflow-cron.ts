import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  workflowRuns, workflows as workflowsTbl, UNMETERED, isSpendMetered,
  type SpendComposition, type Tx,
} from "@trafficflow/db";
import { makeOwnedDb, makeEntitlementsClient } from "@trafficflow/db/cloud";
import type { SpendPort } from "@trafficflow/db";
import { WorkflowExecutor, silentLogger, type DraftPort, type Logger, type WorkflowTrigger } from "@trafficflow/core";
import { selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import { loadServedAccounts } from "./mailboxes.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";

/**
 * The workflow DRAIN pass, in TWO phases. REAP requeues runs stranded in `running` by a dead worker; SCAN
 * reads `pending` `workflow_runs` (now including what reap requeued) and, per run, does a GUARDED
 * `pending → running` transition that RE-ASSERTS `status='pending'` in the UPDATE WHERE, like
 * `bubbleUpPass`, so a concurrent drain that loses matches 0 rows and never double-claims. The claimed run
 * goes to `WorkflowExecutor` (pre-flights sensitivity, runs each step in its own tx with a durable cursor +
 * `audit_log` inverse). Pure and hermetic (db/tx + injected DraftPort + clock). The PRIMARY caller is
 * `apps/worker/src/index.ts`'s `cycle()` (this + {@link workflowTimeScanPass} once per poll per account),
 * so a `POST /workflows/:id/run` 202 is honoured by the always-on worker; {@link runWorkflowCron} is the
 * dead-worker backstop, on no schedule. `test/every-pass-has-a-producer.test.ts` asserts which caller is which. */
export interface WorkflowDrainDeps {
  drafter: DraftPort;
  /**
   * The AI spend gate for this account, consulted by the `draft_reply` tool only
   * (`file_message` / `add_kb_entry` are deterministic and are not AI actions). Absent ⇒
   * unmetered. A refusal fails the STEP with `insufficient_credits` rather than degrading:
   * "write a reply" has no rules-only fallback, and marking a step done that never ran would
   * be a silent AI action — nothing may act on mail without the user having decided it.
   */
  credits?: SpendPort;
  /** Scope the drain to ONE account — the worker loops its served accounts. Omitted ⇒ all accounts. */
  accountId?: string;
  /**
   * The wall clock this pass may spend claiming runs, defaulting to {@link
   * WORKFLOW_DRAIN_PASS_DEADLINE_MS}. The caller passes its own `pollIntervalMs` where it has
   * one; a deployment that polls every ten seconds should not run a sixty-second drain.
   */
  passDeadlineMs?: number;
}

const executor = new WorkflowExecutor();

/**
 * How old a `running` claim must be before the reaper takes it back. It is RESUME LATENCY, not a liveness
 * contest, and that follows from the deployment: one shard has ONE draining process (the worker holds
 * `leaderLockKeyFor(shardIndex)` for life and `runWorkflowCron` takes the same lock), `cycle()` awaits each
 * drain, and reap runs BEFORE the drain in one call — so every `running` row a reaper sees belongs to a
 * process that is gone (no per-step heartbeat). The number buys margin against the non-structural case: a
 * claim written by a worker whose clock differs, a container paused between the two. Fifteen minutes is far
 * beyond both, and the cost runs one way (too LONG delays a stranded run; too SHORT puts a second executor
 * on a live one — survivable via the audit marker, unique dedup keys and the ledger's `duplicate`, but not
 * something that should happen). */
export const STALE_CLAIM_MS = 15 * 60_000;

/**
 * AT MOST THIS MANY RUNS PER PASS, OLDEST ENQUEUE FIRST — and the same ceiling on the reaper's
 * read beside it. Both reads selected EVERY matching row, no `LIMIT` and no order; `workflow_runs`
 * is append-only, so one account with a backlog handed the shared pass a list of whatever length
 * it had accumulated and pinned the pass every other account's runs wait behind. The number is the
 * worker's own "one batch per poll" (`DEFAULT_SYNC_BATCH_MAX_MESSAGES`, which the sibling drains
 * `REQUEST_DRAIN_MAX_PER_CYCLE` and `TOMBSTONE_MAX_PER_CYCLE` took for the same reason). Deferred,
 * never dropped: the rows keep their status, the order is `created_at` so the next pass takes the
 * next batch, and `pollIntervalMs` (60 s) brings it.
 */
export const WORKFLOW_DRAIN_MAX_PER_PASS = 200;

/**
 * THE PASS STOPS CLAIMING NEW RUNS ONCE THE POLL THAT SCHEDULED IT HAS ELAPSED. A count ceiling
 * bounds the LIST, not the WORK: a run is not a message — it executes up to `MAX_WORKFLOW_STEPS`
 * steps, a step can call a model, and 200 of those outlive any poll interval, so a drain that
 * outlives its poll delays every pass behind it. `pollIntervalMs` is the number this rests on
 * (default 60 s in `config.ts`; a deployment tunes it through `deps.passDeadlineMs`). Nothing in
 * flight is abandoned — the deadline is consulted BEFORE a claim, so a run was either never claimed
 * (still `pending`, taken next pass) or runs to completion. Interrupting a run mid-step is the
 * reaper's business, and needs a per-step budget nobody has measured yet.
 */
export const WORKFLOW_DRAIN_PASS_DEADLINE_MS = 60_000;

export async function workflowDrainPass(
  db: Tx, deps: WorkflowDrainDeps, now: Date = new Date(),
): Promise<{ drained: number; reaped: number }> {
  const reaped = await reapStaleClaims(db, deps, now);

  const pendingFilter = deps.accountId
    ? and(eq(workflowRuns.status, "pending"), eq(workflowRuns.accountId, deps.accountId))
    : eq(workflowRuns.status, "pending");
  /* BOUNDED AT THE READ, not after it: the ceiling is on the rows the driver transfers, and the
   * order is what makes deferral fair — an unordered `LIMIT` can hand back the same rows every
   * pass while the oldest never move. See {@link WORKFLOW_DRAIN_MAX_PER_PASS}. */
  const pending = await db.select({
    id: workflowRuns.id, accountId: workflowRuns.accountId,
    workflowId: workflowRuns.workflowId, stepCursor: workflowRuns.stepCursor,
  }).from(workflowRuns).where(pendingFilter)
    .orderBy(workflowRuns.createdAt, workflowRuns.id)
    .limit(WORKFLOW_DRAIN_MAX_PER_PASS);

  /* THE REAL CLOCK, not `now`. `now` is the pass's STAMP — injected, fixed for every row the pass
   * writes, and in a test a date years from today; a budget measured against it would be spent or
   * infinite depending on which. Elapsed time is the one thing here that may not be injected. */
  const endsAtMs = Date.now() + (deps.passDeadlineMs ?? WORKFLOW_DRAIN_PASS_DEADLINE_MS);
  let drained = 0;
  for (const row of pending) {
    /* CONSULTED BEFORE THE CLAIM, so a pass out of time leaves the row `pending` for the next one
     * rather than claiming work it will not finish. Nothing in flight is ever abandoned. */
    if (Date.now() >= endsAtMs) break;
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
 * THE REAPER. Requeue runs whose `running` claim went unrefreshed, rather than FAILING them (which throws
 * away everything a resumption needs, including a paid `prepare` charge). Resumption is safe by
 * CONSTRUCTION: nothing in the step registry sends (`file_message`, `draft_reply`, `add_kb_entry` in
 * `executor.ts`); a step's commit marker is its `audit_log` row keyed `(runId, stepIndex)`, checked by
 * `stepAlreadyApplied` before `prepare`; effects are keyed (`workflow_dedup_key = "<runId>:<stepIndex>"`,
 * `ON CONFLICT DO NOTHING`); and the money is keyed (`credit_ledger_source_uq` UNIQUE `(account_id,
 * source)`, source `workflow_run:<runId>:<stepIndex>`, no `retryWindowMs`, so a resumed step answers
 * `duplicate` charged NOTHING). Two accepted residuals (a duplicate model call on a crash between prepare
 * and commit; a resumed `prepare`'s failed refund being a no-op). `failed` is untouched (terminal). The GUARD re-asserts `status='running'` AND the observed `claimed_at` (like `workflowTimeScanPass`'s `nextRunAt`); `claimed_at` is a JS `Date` (microseconds break the equality — migration `0033`), NULL falls back to `created_at`. */
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

  /* The drain's ceiling, on the reaper's read for the drain's reason: `running` rows a dead
   * worker left behind accumulate exactly as `pending` ones do, and requeueing is cheap but not
   * free. Oldest claim first, so a deferred row is taken by the next pass and not re-deferred. */
  const stale = await db.select({ id: workflowRuns.id, claimedAt: workflowRuns.claimedAt })
    .from(workflowRuns).where(and(...filters))
    .orderBy(workflowRuns.createdAt, workflowRuns.id)
    .limit(WORKFLOW_DRAIN_MAX_PER_PASS);

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
 * The time-trigger scan, sibling of `bubbleUpPass`. For each enabled `time`
 * workflow with `nextRunAt <= now` it enqueues one `pending` workflow_run and
 * advances or clears `nextRunAt`, both in one tx under a guarded update that
 * re-asserts the observed `nextRunAt`. A concurrent scan that already advanced
 * the trigger matches 0 rows and enqueues nothing, so a double scan cannot
 * double-enqueue. The run's `trigger` snapshots the firing trigger; the drain
 * executes it under the sensitivity gates. Pure: db executor + clock.
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
 * MANUAL BACKSTOP (correctness), not a scheduled job. Guarded by the SAME session-level leader lock the
 * always-on worker + reconcile/bubble-up crons use: if the live worker holds it, this exits without
 * touching the DB; otherwise one drain pass and release. Nothing invokes it on a timer, and nothing can
 * while a worker is up. `index.ts`'s `cycle()` is the producer of record; this is what an operator runs
 * when the worker is not (recorded `MANUAL_BACKSTOP` in `SCHEDULE_MANIFEST`,
 * `test/every-pass-has-a-producer.test.ts`). It loops the SERVED accounts (its shard, dev-filter narrowed,
 * each isolated in its own try/catch). `log` defaults to `silentLogger` — see `cron-log.ts`.
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
    // ONE port for this invocation — it answers on its own handle, per the local adapter.
    /* ONE ENTITLEMENTS PORT FOR THIS INVOCATION, or a named unmetered state — the composition
     * `index.ts` makes, for its reason: `ENTITLEMENTS_URL` set ⇒ the HTTP client, unset ⇒ nothing
     * meters and the spend call sites are handed nothing. */
    const entitlements: SpendComposition = config.entitlements
      ? makeEntitlementsClient({ baseUrl: config.entitlements.url, secret: config.entitlements.secret })
      : UNMETERED;
    const spend = isSpendMetered(entitlements) ? entitlements : undefined;
    for (const accountId of await loadServedAccounts(db, selectionOf(config))) {
      try {
        // Enqueue any due time-triggered runs FIRST, then drain them this same pass.
        await workflowTimeScanPass(db as unknown as Tx, { accountId }, now);
        const res = await workflowDrainPass(
          db as unknown as Tx,
          {
            drafter: config.drafter ?? unconfiguredDrafter,
            // ONE port for the pass, not a gate per account: the account is an argument to the
            // spend, and the step's terms come from `SPEND_ACTIONS.workflow`.
            ...(spend ? { credits: spend } : {}),
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
