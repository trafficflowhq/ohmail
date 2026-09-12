import { runSyncCycle, type SyncDeps } from "./sync.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  NO PRODUCTION CALLER SINCE ATTACH STOPPED DRAINING. DO NOT RE-WIRE IT INTO `attach()`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What it does is unchanged and still correct: a full sync cycle first pulls `changesSince` — which
 * adopts any move that completed on the server before the crash (updating the locator +
 * folder_state) — and then runs the reconciler for anything still genuinely pending. A
 * second pass guarantees convergence even if the first pass only adopted, leaving a now-satisfied
 * pending row to be marked reconciled.
 *
 * WHERE THAT WORK HAPPENS NOW: `cycle()` in `index.ts`. Not because two passes were wrong, but
 * because `attach()` awaited them, per mailbox, on the single serialize queue. Measured twice
 * in production: about six minutes each time between `mailbox_attach_started` and
 * `mailbox_attached` for one real mailbox, with the NEXT mailbox's
 * `attach_started` 88 ms after the previous `attached` — so no attach overlapped any other, and at
 * `maxMailboxes=64` the last mailbox would not be dialled for hours after a deploy. Worse, because
 * `last_sync_at` is stamped by `cycle()` and by nothing else, every deploy fired a `sync_lag` alert
 * reading "their owners are not receiving mail" about mailboxes that were visibly ingesting.
 *
 * The cycle loop is a STRICTLY STRONGER convergence guarantee than this function's two passes: it
 * re-verifies the organizer lease, runs the same `runSyncCycle`, re-kicks itself while the adapter
 * reports `hasBacklog`, and repeats every `pollIntervalMs` for ever — where this ran
 * exactly twice and then stopped. Two passes were only ever a bound on how long an attach could
 * take; once the drain is not on the attach path, the bound is not needed.
 *
 * It survives as `test/restart.e2e.test.ts`'s subject: that file is the direct proof
 * that adopt-then-reconcile converges in two passes against a real server, which is a property of
 * `runSyncCycle` worth asserting on its own. Deleting the pair is a reasonable follow-up and is
 * recorded as such; what is NOT reasonable is calling this from `attach()` again.
 * `test/attach-nonblocking.e2e.test.ts` goes red if anything does.
 */
export async function reconcileOnRestart(deps: SyncDeps): Promise<void> {
  await runSyncCycle(deps);
  await runSyncCycle(deps);
}
