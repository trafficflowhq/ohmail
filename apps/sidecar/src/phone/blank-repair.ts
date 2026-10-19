/**
 * THE BLANK REPAIR, NOT IN THIS BUILD — substituted for `./blank-repair.js` where
 * `apps/worker/src/sync.ts` imports it.
 *
 * The repair (`apps/worker/src/blank-repair.ts`) gives back the places an older build's blank
 * messages took and moves a letter it filed away back to INBOX. It runs on the desktop engine, the
 * hosted worker and the self-host organizer. The phone's composition (`mobile.ts`) passes
 * `blankRepair: "off"`, so `runSyncCycle` never calls the pass there, and its code stays out of the
 * artifact, which has a size ceiling (`apps/mobile/test/engine-packaging.test.ts`); so does its one
 * store read (`./blank-rows.ts`). The phone keeps
 * the fix that stops new blanks; it is the repair alone it does not carry.
 *
 * Unreachable, so it refuses by name: a phone that reached it with a mode other than `off` would
 * otherwise run half a repair, and this way the cycle logs the refusal and writes nothing.
 */
export async function blankRepairPass(_deps: unknown): Promise<never> {
  throw new Error("this build does not repair blank messages; its composition passes blankRepair: \"off\"");
}
