import { and, eq, gte, lt, sql } from "drizzle-orm";
import { aiUsageDaily, creditLedger } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * WHAT THE TOKENS COST, WRITTEN DOWN — the recorder behind `ai_usage_daily` (cloud 0029).
 *
 * ## The state this replaces, measured rather than assumed
 *
 * `AnthropicCallReport` has carried the model, four token counts and an estimated cost after
 * every metered call since the client was written, and the three composition roots printed it as
 * an `ai_call` JSON line. A log drain is not a table: it cannot be joined against a customer's
 * spend, it is retained for weeks rather than years, and — the part that made this urgent —
 * **the WORKER was passing no logger at all**. `loadAiPorts(env)` is called from `loadConfig`
 * with one argument, so the client's `log?.info("ai_call", …)` default resolved to `undefined?.`
 * and did nothing. The worker is the metered arm for three of the four priced reasons
 * (classification, the proposer, workflow steps), so the majority of the product's token cost
 * was never written down anywhere at all, while a comment two files away said it was.
 *
 * ## The shape, and why it is two shapes
 *
 * One upsert per call on the API host; a time-bounded BUFFER everywhere else. That is not a
 * micro-optimisation, it is the difference between the two runtimes:
 *
 *  · The **API host** is serverless. Its process can be frozen the instant a response is
 *    written, so anything not durable by then may never be — a buffer there is a bucket with no
 *    bottom. Its calls are also user-initiated and rare (a drafting request, a priced Screener
 *    suggest), so one extra indexed upsert per call is invisible beside a 2–25 second model call.
 *  · The **worker** classifies once per message, in a serial cycle. One upsert per call would be
 *    a write per message forever, and the process is long-lived, so a buffer is both affordable
 *    and safe: it flushes on its own clock and on shutdown.
 *
 * ## It NEVER throws, and it never delays a model call it cannot record
 *
 * The recorder is wired to `onUsage`, which the client already invokes inside a try/catch on the
 * stated rule that "a reporter that throws is not allowed to become the outcome of a model call".
 * This module holds itself to the stronger half of that: a database failure is swallowed HERE and
 * counted, so the model call's result is never in doubt and the loss is visible in
 * {@link AiUsageRecorder.dropped} rather than in silence.
 */

/** The three processes that can make a metered model call. `ai_usage_daily.host`'s CHECK. */
export type AiUsageHost = "api" | "worker" | "server";

/**
 * The slice of `AnthropicCallReport` this module reads.
 *
 * Structurally narrower than the report on purpose: `packages/core`'s AI client may not import
 * this file (it is desktop payload and knows nothing about a database), so the dependency runs
 * one way only — a host composes the two. Declaring the narrow shape here is what lets that
 * composition typecheck without either module naming the other.
 */
export interface AiUsageReport {
  model: string;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicroUsd: number | null;
}

export interface AiUsageRecorder {
  /**
   * Record one call. The `onUsage` sink itself.
   *
   * On the API host this RETURNS THE WRITE, and the client awaits it — see the module header for
   * why a serverless process may not buffer. Everywhere else it returns nothing and the row is
   * flushed later.
   */
  record(report: AiUsageReport): void | Promise<void>;
  /** Write anything buffered. Idempotent, never throws, and safe to call on shutdown. */
  flush(): Promise<void>;
  /** Calls whose write FAILED. Non-zero means the cost table under-reports by that many calls. */
  readonly dropped: number;
}

/** How long the worker holds a bucket before writing it. */
export const AI_USAGE_BUFFER_MS = 30_000;

/** `YYYY-MM-DD` in UTC — the `day` column's own convention, matching `credit_usage_daily`. */
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

interface Bucket {
  day: string;
  model: string;
  calls: number;
  okCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
}

const n = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Build the recorder for one host.
 *
 * `host` is a LITERAL at each composition root and never derived from the environment: it is in
 * the primary key, and three processes writing under one name would make "which arm stopped
 * recording" — the only question worth asking when the figure looks wrong — unanswerable.
 */
export function makeAiUsageRecorder(
  db: Tx,
  host: AiUsageHost,
  opts: { bufferMs?: number; now?: () => Date } = {},
): AiUsageRecorder {
  const now = opts.now ?? ((): Date => new Date());
  const bufferMs = opts.bufferMs ?? (host === "api" ? 0 : AI_USAGE_BUFFER_MS);
  const pending = new Map<string, Bucket>();
  /** The buffered hosts' flush timer — see `record` below for why it exists. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = now().getTime();
  let dropped = 0;

  const add = (report: AiUsageReport, at: Date): Bucket => {
    const day = dayOf(at);
    const key = `${day} ${report.model}`;
    const b = pending.get(key) ?? {
      day, model: report.model, calls: 0, okCalls: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0,
    };
    b.calls += 1;
    if (report.ok) b.okCalls += 1;
    b.inputTokens += n(report.inputTokens);
    b.outputTokens += n(report.outputTokens);
    b.cacheReadTokens += n(report.cacheReadTokens);
    b.cacheWriteTokens += n(report.cacheWriteTokens);
    b.costMicroUsd += n(report.costMicroUsd);
    pending.set(key, b);
    return b;
  };

  /**
   * The upsert. ADDITIVE on every counter, so a bucket written twice is impossible to distinguish
   * from two separate calls — which is what makes a SUCCEEDED-then-crashed flush safe (the next
   * pass's numbers add rather than overwrite). A FAILED write is the opposite case and is handled
   * by the caller, not by retrying: see {@link drain}, which drops the buckets and counts them
   * rather than holding them for a second attempt.
   */
  const write = async (buckets: Bucket[]): Promise<void> => {
    if (buckets.length === 0) return;
    await db.insert(aiUsageDaily).values(buckets.map((b) => ({
      day: b.day,
      host,
      model: b.model,
      calls: b.calls,
      okCalls: b.okCalls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheReadTokens: b.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens,
      costMicroUsd: b.costMicroUsd,
    }))).onConflictDoUpdate({
      target: [aiUsageDaily.day, aiUsageDaily.host, aiUsageDaily.model],
      set: {
        calls: sql`${aiUsageDaily.calls} + excluded.calls`,
        okCalls: sql`${aiUsageDaily.okCalls} + excluded.ok_calls`,
        inputTokens: sql`${aiUsageDaily.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${aiUsageDaily.outputTokens} + excluded.output_tokens`,
        cacheReadTokens: sql`${aiUsageDaily.cacheReadTokens} + excluded.cache_read_tokens`,
        cacheWriteTokens: sql`${aiUsageDaily.cacheWriteTokens} + excluded.cache_write_tokens`,
        costMicroUsd: sql`${aiUsageDaily.costMicroUsd} + excluded.cost_micro_usd`,
        updatedAt: sql`now()`,
      },
    });
  };

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return;
    const buckets = [...pending.values()];
    // CLEARED BEFORE THE AWAIT, and NOT restored on failure. Clearing after would let a call
    // arriving mid-flush join a bucket already in flight and be written twice; clearing before
    // means a failure loses exactly these buckets, which is the trade this module makes
    // deliberately — see {@link AiUsageRecorder.dropped}. A retry-on-failure design would need to
    // re-merge a failed bucket back into `pending` without racing calls that arrived during the
    // failed write, which is more state than the honest alternative: count the loss and move on.
    pending.clear();
    if (timer !== null) { clearTimeout(timer); timer = null; }
    lastFlushAt = now().getTime();
    try {
      await write(buckets);
    } catch {
      // DROPPED, not retried. `dropped` is the reader's signal that the table under-reports by
      // this many calls — a silent retry queue would hide exactly the failure this field exists
      // to surface.
      dropped += buckets.reduce((sum, b) => sum + b.calls, 0);
    }
  };

  return {
    record(report) {
      const at = now();
      const bucket = add(report, at);
      if (bufferMs === 0) {
        // THE API HOST. The promise is returned so the client can await it: a serverless process
        // may be frozen the moment its response is written, and a floating write is a write that
        // may never land. One indexed upsert beside a 2–25 second model call is not a cost.
        pending.delete(`${bucket.day} ${bucket.model}`);
        return write([bucket]).catch(() => { dropped += 1; });
      }
      // THE BUFFERED HOSTS. Flushed on the next call past the window — AND on a timer, which
      // this deliberately did not have.
      //
      // "The next call lands the last one" is true only on a busy deployment. A host that makes
      // its first metered call and then goes quiet held that call in memory indefinitely: no
      // later call to trigger the check, no timer, and the only other flush is shutdown. The
      // debit was on the ledger and the usage row was not, which is precisely the shape
      // `ai_usage_unrecorded` fires on — so the alert reported a broken recorder for hours while
      // the recorder was working exactly as written. A quiet deployment is the one most likely
      // to hit it and the least likely to have anyone watching.
      //
      // The timer is unref'd, so it still holds no handle a process must remember to release: it
      // will not keep an event loop alive on its own, and `flush()` on shutdown remains the tail.
      if (now().getTime() - lastFlushAt >= bufferMs) { void drain(); return undefined; }
      if (timer === null && pending.size > 0) {
        timer = setTimeout(() => { timer = null; void drain(); }, bufferMs);
        (timer as { unref?: () => void }).unref?.();
      }
      return undefined;
    },
    flush: drain,
    get dropped() { return dropped; },
  };
}

/**
 * THE SIGNAL: a day on which credits were SPENT and the HOST that spent them recorded nothing.
 *
 * ## Why it exists, in one sentence
 *
 * `onUsage` has a default — the client logs and moves on — so a composition root that simply
 * forgets to wire the recorder produces a deployment where every metered action works, every
 * test is green, every credit is debited, and `ai_usage_daily` is empty. That is not a
 * hypothetical: it is the state the worker was in before this slice, for the arm that spends the
 * most. A cost table nobody notices is empty is worse than no cost table, because a margin gets
 * computed from it.
 *
 * ## WHY THIS IS HOST-AWARE, AND NOT A WHOLE-TABLE EMPTINESS CHECK
 *
 * The founding case is exactly the failure a table-wide check cannot see: the WORKER recorded
 * nothing while the API HOST recorded normally. A check that only asks "does any row exist for
 * this day" answers `false` — healthy — the moment any one host's calls happen to be logged,
 * which is the state production was actually in. `host` is in `ai_usage_daily`'s primary key
 * for exactly this reason, and a signal that does not read it is not exercising the reason the
 * column exists.
 *
 * ## What it compares, and the mapping it uses
 *
 * Debits are the one independent witness that a model call happened, written at a gate that
 * immediately precedes a provider call, on a table this recorder never touches. Three of the
 * four metered reasons localize to a host with certainty and one does not:
 *
 *  · `debit_propose` and `debit_workflow` are WORKER-EXCLUSIVE — the proposal cron and workflow
 *    steps run nowhere else. Either one, with no `worker` usage row that day, is unrecorded.
 *  · `debit_draft` runs on the API host or the self-host server, never the worker — the drafting
 *    route is `packages/api`/`apps/server` composition only. With no `api` AND no `server` usage
 *    row that day, it is unrecorded (reported against `api`, the multi-tenant default; a
 *    self-host operator reading this signal should also check their own `server` row).
 *  · `debit_classify` is DELIBERATELY NOT localized. The routing pipeline classifies on the
 *    worker, the Screener's priced suggest classifies on the API host, and the self-host server
 *    classifies too — the same reason can legitimately come from any of the three, and pinning
 *    it to one would produce a false alarm on a day the OTHER two hosts happened to be quiet. It
 *    still counts toward the "some debit happened" gate below, so a day with classify debits and
 *    NO usage anywhere is still caught by the total-silence case.
 *
 * A day with no debits and no usage is healthy (a quiet day). A day with usage and no debits is
 * legitimate too — the self-host tier is unmetered by design, and a failed call costs tokens and
 * refunds its credit. Only the localized direction is a fault.
 *
 * @returns `unrecorded: true` when a host-localizable reason was debited and that host's row is
 * absent, or every host's row is absent while any reason was debited at all. `missingHosts`
 * names which — empty when `unrecorded` is `false`.
 */
export async function aiUsageUnrecorded(
  db: Tx, opts: { day: Date; lookbackDays?: number },
): Promise<{ unrecorded: boolean; missingHosts: AiUsageHost[]; day: string | null }> {
  // ── THE CALENDAR MUST NOT RESOLVE AN INCIDENT ────────────────────────────────────────
  //
  // This asked about ONE UTC day, so a debit at 23:59 whose usage row never arrived stopped
  // being visible at 00:00 — not because anything was recorded, but because the question moved
  // on. The gap is permanent (that day's cost table stays wrong for ever) and the board went
  // green within minutes of it appearing, which is the worst possible combination: a real,
  // unrepaired hole rendering as health.
  //
  // Each day is still judged AGAINST ITS OWN usage rows — a host recording today says nothing
  // about yesterday's silence, and unioning the two would let today's traffic mask yesterday's
  // hole. What changes is how many of those per-day verdicts the pass looks at.
  // ── AND THE ANSWER KEEPS ITS DAY ─────────────────────────────────────────────────────
  //
  // The first version of this unioned the missing hosts across the days it looked at and threw
  // the days away. Two things went wrong with that, both of which send an operator to the wrong
  // place: a gap from 23:59 kept firing after midnight under a sentence that said it was debited
  // "today", and hosts missing on DIFFERENT days were reported as one list, which is a state
  // that never existed — nobody can go and look at a ledger day where those hosts were
  // simultaneously silent, because there is none.
  //
  // So the days are walked OLDEST FIRST and the first gap found is the one reported, whole: its
  // hosts, its date. The oldest is the right one to name because it is the one that will not
  // repair itself — a newer day may still be waiting on a buffer that has not flushed.
  const days = Math.max(1, opts.lookbackDays ?? AI_USAGE_LOOKBACK_DAYS);
  for (let back = days - 1; back >= 0; back--) {
    const at = new Date(opts.day.getTime() - back * 24 * 60 * 60 * 1000);
    const one = await unrecordedOnDay(db, at);
    if (one.unrecorded) {
      return { unrecorded: true, missingHosts: one.missingHosts, day: dayOf(at) };
    }
  }
  return { unrecorded: false, missingHosts: [], day: null };
}

/**
 * How many days back the check above looks. Two, which is the smallest number that stops a
 * midnight from clearing an unrepaired gap while keeping the answer about recent, actionable
 * days rather than about history nobody is going to reconcile.
 */
export const AI_USAGE_LOOKBACK_DAYS = 2;

/** One UTC day, judged against its own usage rows. */
async function unrecordedOnDay(
  db: Tx, day: Date,
): Promise<{ unrecorded: boolean; missingHosts: AiUsageHost[] }> {
  const opts = { day };
  const start = new Date(Date.UTC(
    opts.day.getUTCFullYear(), opts.day.getUTCMonth(), opts.day.getUTCDate(),
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const NONE: { unrecorded: false; missingHosts: [] } = { unrecorded: false, missingHosts: [] };

  const debitRows = await db
    .select({ reason: creditLedger.reason, n: sql<number>`count(*)::int` })
    .from(creditLedger)
    .where(and(
      gte(creditLedger.createdAt, start),
      lt(creditLedger.createdAt, end),
      sql`${creditLedger.reason} in ('debit_classify','debit_draft','debit_propose','debit_workflow')`,
    ))
    .groupBy(creditLedger.reason);
  const byReason = new Map(debitRows.map((r) => [r.reason, Number(r.n)]));
  const anyDebits = [...byReason.values()].some((n) => n > 0);
  if (!anyDebits) return NONE;

  const usageRows = await db
    .select({ host: aiUsageDaily.host })
    .from(aiUsageDaily)
    .where(eq(aiUsageDaily.day, dayOf(start)))
    .groupBy(aiUsageDaily.host);
  const present = new Set(usageRows.map((r) => r.host));

  // ── TOTAL SILENCE, NAMING ONLY THE HOSTS THAT COULD HAVE SPENT IT ───────────────────
  //
  // Nothing was recorded anywhere, and the question is who to send someone to look at. This
  // returned all three hosts unconditionally, so a day whose only debit was `debit_propose` or
  // `debit_workflow` — reasons only the WORKER can incur — produced a title saying API and
  // server usage went unrecorded too, and a count of three. Two of those three never made a
  // call, so two thirds of the remediation is spent proving a negative about hosts that were
  // never involved.
  //
  // The eligible set comes from the debit reasons actually present: worker-exclusive reasons
  // name the worker, `debit_draft` names the request-serving hosts, and the ambiguous
  // `debit_classify` is the one reason that genuinely cannot be attributed, so it — and only it
  // — widens the list to all three.
  if (present.size === 0) {
    const eligible = new Set<AiUsageHost>();
    if ((byReason.get("debit_propose") ?? 0) + (byReason.get("debit_workflow") ?? 0) > 0) {
      eligible.add("worker");
    }
    if ((byReason.get("debit_draft") ?? 0) > 0) { eligible.add("api"); eligible.add("server"); }
    if ((byReason.get("debit_classify") ?? 0) > 0) {
      eligible.add("api"); eligible.add("worker"); eligible.add("server");
    }
    return { unrecorded: true, missingHosts: [...eligible] };
  }

  const missing: AiUsageHost[] = [];
  const workerExclusive = (byReason.get("debit_propose") ?? 0) + (byReason.get("debit_workflow") ?? 0);
  if (workerExclusive > 0 && !present.has("worker")) missing.push("worker");
  const draftDebits = byReason.get("debit_draft") ?? 0;
  if (draftDebits > 0 && !present.has("api") && !present.has("server")) missing.push("api");

  return { unrecorded: missing.length > 0, missingHosts: missing };
}
