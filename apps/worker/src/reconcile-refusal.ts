/**
 * THE RECONCILE REFUSAL VOCABULARY — the backoff ladder, the transport/mutation question and the
 * four-word class. ONE HOME, because three passes now ask it: the folder reconciler and the flag
 * reconciler in `sync.ts`, and the junk rescue in `junk-rescue.ts`. `sync.ts` imports the passes
 * it runs, so a pass importing these back out of `sync.ts` would be a cycle; a copy in the pass
 * would be a second opinion about the same throw, which is the shape that lets two queues disagree
 * about what a server said.
 */
import type { FilingRefusalClass } from "@trafficflow/db";
import { classifyIngestFault } from "./dead-letter.js";

/**
 * The bounded retry for a mutation the server refuses — minutes, then hours, then for ever. Per-item
 * isolation stops one refused mutation abandoning the pass; it does NOT stop that item being attempted
 * again every cycle, which is what the reconciler did for every stuck row for its whole life. Two
 * costs, the second the one that hurts uninvolved users: one IMAP round trip per stuck row per cycle,
 * and — because `listPendingFolderStates` is ordered OLDEST FIRST under a fixed allowance — a
 * permanently refused row sits at the head of the budget every cycle, so 500 of them eat the whole
 * budget while fresh mail never reaches the server (head-of-line blocking by BUDGET, unreachable from
 * any `try`/`catch`). So a refusal buys widening silence with a six-hour FLOOR, never an end: there is no give-up, because this records the USER's instruction, not our failure to read mail. `attempts` rides the audit row, so "failed 40 times" is a value somebody can select.
 */
export const RECONCILE_BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 360];

/**
 * When a mutation refused for the `attempts`-th time may be attempted again.
 *
 * `attempts` is the count INCLUDING the refusal being recorded now, so the first failure takes the
 * first step. Beyond the last step the schedule stays on it — {@link RECONCILE_BACKOFF_MINUTES}
 * for why the tail is a floor and not a cliff.
 */
export function nextReconcileAttemptAfter(attempts: number, now: Date): Date {
  const step = Math.min(Math.max(1, attempts), RECONCILE_BACKOFF_MINUTES.length) - 1;
  return new Date(now.getTime() + RECONCILE_BACKOFF_MINUTES[step]! * 60_000);
}

/**
 * Is this throw evidence about THIS MUTATION, or about the pipes? The distinction decides whether a
 * failure earns a deferral, and getting it backwards is expensive both ways (it reuses
 * `classifyIngestFault` rather than growing a second opinion): call a HOST OUTAGE per-message and a
 * mailbox unreachable for ten minutes comes back with its whole filing queue deferred for an hour;
 * call a PER-MESSAGE refusal infrastructure and nothing is ever deferred, back to one round trip per
 * stuck row per cycle and the budget starvation. The infrastructure domain covers both sockets in play
 * (the customer's IMAP host and our own database), because neither is the message's fault, and leaves
 * the row EXACTLY as it was (due now, attempts unchanged, no audit row) — the pass continues, and the backlog drains the moment the host is back (`reconcile-resume.pg.test.ts`).
 */
export function isTransportFailure(err: unknown): boolean {
  return classifyIngestFault(err).domain === "infrastructure";
}

/**
 * What the server refused, as a class somebody can act on (mail 0097). The deferral above records the
 * SCHEDULE; what it could not record is WHY, so the client had a number and a retry time and nothing
 * else — and the honest sentence cannot be written from those ("1 message waits · retrying at 14:20"
 * tells a person nothing to do, where "the folder is not there" names the one screen that fixes it).
 * The output is FOUR WORDS, the whole safety argument: `folder_state`'s schema forbids an error column
 * ("what went wrong is free text from someone else's mail server"), and this MAY read the error and may
 * never store it — the server's wording goes only to the `reconcile.move.failed` audit row. STRUCTURED
 * evidence only (`serverResponseCode`), no message probe; `refused` is a real member (a bare `NO` to a `UID MOVE` is a refusal). Nothing for a transport failure — `isTransportFailure` returns first.
 */
export function classifyMoveRefusal(err: unknown): FilingRefusalClass {
  const code = typeof (err as { serverResponseCode?: unknown } | null)?.serverResponseCode === "string"
    ? String((err as { serverResponseCode: string }).serverResponseCode).toUpperCase()
    : "";
  // `[TRYCREATE]` is the server saying the destination does not exist and it would accept a
  // CREATE — the same fact as `[NONEXISTENT]` from a person's point of view, and the same remedy.
  if (code === "NONEXISTENT" || code === "TRYCREATE") return "no_such_folder";
  if (code === "OVERQUOTA") return "over_quota";
  // `[NOPERM]` is "you may not write here" and `[READ-ONLY]` is "this mailbox is not writable
  // right now": one is a permission and the other a mode, and both are the same sentence to
  // whoever filed the mail — the folder will not take it. A provider's own maintenance window
  // produces the second one, which is why the ladder's early rungs are minutes.
  if (code === "NOPERM" || code === "READ-ONLY") return "read_only";
  return "refused";
}
