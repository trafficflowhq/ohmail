import { runSyncCycle, type SyncDeps } from "./sync.js";

/**
 * NO PRODUCTION CALLER SINCE ATTACH STOPPED DRAINING. DO NOT RE-WIRE IT INTO `attach()`. What it does is
 * unchanged and correct: a full cycle pulls `changesSince` (adopting any move that completed before the
 * crash) then reconciles what is still pending, a second pass guaranteeing convergence. That work now
 * happens in `cycle()` (`index.ts`) — not because two passes were wrong, but because `attach()` awaited them
 * per mailbox on the serialize queue: measured ~six minutes each for one real mailbox, so at
 * `maxMailboxes=64` the last would not dial for hours, and every deploy fired a `sync_lag` alert (only
 * `cycle()` stamps `last_sync_at`). The cycle loop is a STRICTLY STRONGER guarantee (re-verifies the lease,
 * re-kicks while `hasBacklog`, repeats every `pollIntervalMs`) where this ran twice and stopped. It
 * survives as `test/restart.e2e.test.ts`'s subject; `test/attach-nonblocking.e2e.test.ts` goes red if anything calls it from `attach()`. */
export async function reconcileOnRestart(deps: SyncDeps): Promise<void> {
  await runSyncCycle(deps);
  await runSyncCycle(deps);
}
