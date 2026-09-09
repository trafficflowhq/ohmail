import { awayReplyFlagRedeliverPass } from "./away-reply-flag-redeliver.js";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * ═══ THE AWAY-REPLY SWEEP — THE PRODUCER OF `awayReplyFlagRedeliverPass` ═════════════════════
 *
 * The pass walks one account; this decides WHEN, for WHICH accounts, and WHERE EACH ONE STOPPED.
 * They are two concerns and they now live in two files, which is not tidiness: while the sweep sat
 * beside the pass, the only caller of the pass was in the pass's own file, and
 * `test/every-pass-has-a-producer.test.ts` reported it as `entry-only` — a pass with no producer.
 *
 * That census exists because `bubbleUpPass` shipped with seven green tests and nothing in
 * production calling it, while the Ohbox promised users a dated resurface no deployed code could
 * keep. It asks the question one level up: who calls this, and is that caller reached? A caller
 * inside the pass's own file cannot answer it, and the honest fix is the split rather than a
 * manifest entry — the manifest is for CLI backstops and scheduled crons, and this pass is neither.
 * It is run by the always-on worker, and now a production file outside it says so by calling it.
 */
/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PER-PROCESS SWEEP — the gate, extracted so it can be control-tested
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export interface AwayReplySweepRun {
  /** Accounts walked in this attempt. Zero once the gate has closed. */
  accounts: number;
  /** `change_log` rows written across every account in this attempt. */
  redelivered: number;
  /** Accounts whose walk threw. Their cursor is kept and the gate stays open. */
  failed: number;
  /** TRUE ⇒ every account is exhausted and this process will not sweep again. */
  done: boolean;
}

export interface AwayReplySweep {
  /** Has the gate closed for this process. */
  readonly done: boolean;
  /** One attempt over the given accounts. A no-op once {@link done}. */
  runOnce(
    db: Tx, accountIds: readonly string[],
    opts?: { log?: Logger; batch?: number; maxPages?: number;
             onError?: (accountId: string, err: unknown) => void },
  ): Promise<AwayReplySweepRun>;
}

/**
 * THE SWEEP'S STATE, AND WHY IT IS A VALUE RATHER THAN TWO VARIABLES IN THE CYCLE.
 *
 * It holds exactly two things: whether the gate has closed, and where each account's walk stopped.
 * Both used to be locals in `index.ts`, which made the one behaviour under review — "once per
 * process, and re-swept by the next process" — reachable only by booting a worker. Review filed
 * that as a GUARD row and it was the right call: the first version of the gate closed BEFORE the
 * account loop, so a single account's failure retired the whole fleet's sweep, and no test could
 * see it.
 *
 * As a value it is directly testable: `runOnce` twice on one instance is the once-per-process
 * claim, and a SECOND instance is a restart. `away-reply-warm-mirror.test.ts` asserts both, and
 * that an unexhausted account keeps the gate open and resumes from its cursor.
 *
 * ── WHAT "DONE" MEANS, EXACTLY ─────────────────────────────────────────────────────────────
 *
 * Every account walked to exhaustion in ONE attempt. Not "we tried": an account that threw, and an
 * account whose walk hit the safety bound, both leave the gate open so the next attempt continues
 * from that account's cursor. A sweep is therefore never abandoned half-done, which is the shape
 * the page budget shipped with.
 *
 * ── AND WHY THE PROCESS IS THE RIGHT GRANULARITY ───────────────────────────────────────────
 *
 * The deploy order is API → worker → web — verified in the train's own script
 * (`deploy-0150-apiworker.sh` runs `deploy-api.sh`, sets the aliases, reads `/health` twice, and
 * only then runs `deploy-worker.sh`; the web is a separate script run later). So the worker that
 * carries this pass starts AFTER the API that knows the flag, and the first sweep's change rows
 * are re-materialized by an API that sets it.
 *
 * The residual is narrow and worth naming rather than hiding: that script has `set -u` and no
 * abort between the two halves, so a FAILED API deploy still proceeds to the worker, and a sweep
 * spent against the old API delivers rows without the flag. Nothing is corrupted — the rows are
 * re-sent as they were — but that sweep is wasted. It is redone at the NEXT worker start, which is
 * every subsequent deploy, and the deploy step carries the operational half: do not proceed to the
 * worker unless the API deploy returned 0 and both health reads show the new version.
 *
 * A periodic re-sweep (a daily belt) was considered and REJECTED, with its cost: the candidate set
 * is only the responder's own replies — tens of rows per mailbox — so a daily belt would re-deliver
 * those same rows to every client every day, for ever, to cover a window that a worker restart
 * already closes. It has no natural end either, since ending it needs the hardcoded date this
 * design exists to avoid. This is a REPAIR: it should be deleted once the release carrying the flag
 * has rolled out, not put on a timer.
 */
export function makeAwayReplySweep(): AwayReplySweep {
  let done = false;
  /** accountId → resume point, for accounts whose last walk did not reach the end. */
  const cursors = new Map<string, string>();

  return {
    get done() { return done; },

    async runOnce(db, accountIds, opts = {}) {
      if (done) return { accounts: 0, redelivered: 0, failed: 0, done: true };

      let redelivered = 0;
      let failed = 0;
      let allExhausted = true;

      for (const accountId of accountIds) {
        // ONE ACCOUNT'S FAILURE MUST NOT SKIP THE REST, and must not close the gate either.
        try {
          const r = await awayReplyFlagRedeliverPass(db, {
            accountId,
            afterId: cursors.get(accountId) ?? null,
            ...(opts.log === undefined ? {} : { log: opts.log }),
            ...(opts.batch === undefined ? {} : { batch: opts.batch }),
            ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
          });
          redelivered += r.redelivered;
          if (r.exhausted) {
            cursors.delete(accountId);
          } else {
            // Keep the resume point. `cursor` is null only when nothing was walked at all, in
            // which case starting over is the only option available.
            if (r.cursor !== null) cursors.set(accountId, r.cursor);
            allExhausted = false;
          }
        } catch (err) {
          failed += 1;
          allExhausted = false;
          opts.onError?.(accountId, err);
        }
      }

      // THE GATE CLOSES HERE AND NOWHERE ELSE — after the loop, and only on a clean full sweep.
      if (allExhausted) done = true;
      return { accounts: accountIds.length, redelivered, failed, done };
    },
  };
}
