import { awayReplyFlagRedeliverPass } from "./away-reply-flag-redeliver.js";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

/**
 * THE AWAY-REPLY SWEEP — THE PRODUCER OF `awayReplyFlagRedeliverPass`. The pass walks one account; this
 * decides WHEN, for WHICH accounts, and WHERE EACH stopped — two concerns in two files, not tidiness:
 * while the sweep sat beside the pass, the only caller was in the pass's own file and
 * `test/every-pass-has-a-producer.test.ts` reported it `entry-only` (a pass with no producer). That census
 * exists because `bubbleUpPass` shipped with seven green tests and nothing calling it while the Ohbox
 * promised a dated resurface. A caller inside the pass's own file cannot answer "who calls this" — the fix
 * is the split, since the manifest is for CLI backstops and crons and this pass is neither. It is run by
 * the always-on worker, and now a production file outside it says so by calling it.
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
 * THE SWEEP'S STATE, AND WHY IT IS A VALUE RATHER THAN TWO VARIABLES IN THE CYCLE. It holds whether the
 * gate has closed and where each account's walk stopped — once locals in `index.ts`, which made the
 * once-per-process behaviour reachable only by booting a worker (the first gate closed BEFORE the account
 * loop, so one account's failure retired the fleet's sweep). As a value it is testable: `runOnce` twice is
 * the once-per-process claim, a SECOND instance is a restart (`away-reply-warm-mirror.test.ts` asserts
 * both). "DONE" means every account walked to exhaustion in ONE attempt (a throw or the safety bound leaves
 * the gate open, resuming from that account's cursor). Process granularity follows the deploy order
 * (API → worker → web, verified in `deploy-0150-apiworker.sh`); the residual (that script's `set -u` with
 * no abort lets a failed API deploy waste one sweep, redone next start) is named. A periodic re-sweep was REJECTED (tens of rows per mailbox daily for ever); this is a REPAIR, deletable once rolled out. */
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
          // Counted and handed on — one account's failure must not stop the sweep.
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
