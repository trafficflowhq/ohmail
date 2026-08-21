/**
 * THE SAMPLE WORLD, ABSENT — what `packages/client-engine/src/adapters/fixtures-adapter.ts`
 * resolves to in BOTH desktop artifacts (`vite.config.ts` aliases it here for the window bundle
 * and the served host client alike).
 *
 * The shared shell keeps a demo arm because the landing page's demo is built from it — that is
 * the one sanctioned home of invented mail — and `engine-config.ts` names `FixturesAdapter` in a
 * branch the desktop can never take (`DesktopGate` passes `demo={false}` structurally). A branch
 * that is never taken still puts its imports in the bundle, and the import is the whole fixtures
 * corpus: invented people, invented brands, thousands of lines of sample mail inside an app whose
 * rule is that it opens EMPTY and shows nothing but your own mailbox. So the module is replaced,
 * not merely unreached: grep either desktop dist for the sample senders and there is nothing to
 * find — `scan-artifact.mjs` does exactly that, in both directions.
 *
 * The THREE value exports below are the ones the client-engine barrel re-exports; the class
 * throws in its constructor so that a future arm that somehow reaches the demo branch fails
 * loudly on its first frame instead of quietly showing invented mail as somebody's own.
 */

/** The demo world's frozen clock. Never read here — `demo` is structurally false — but a date,
 *  so an accidental read misbehaves as a stale clock rather than a crash in a time formatter. */
export const DEMO_NOW = new Date("2026-07-29T12:00:00.000Z");

/** The fixture timestamp reader. Nothing in a desktop artifact holds a fixture to read. */
export function parseFixtureTime(_time: string, _index: number, _base: Date): string {
  throw new Error("ohmail Desktop carries no sample mail; the demo lives on ohmail.app alone.");
}

/** The demo engine's adapter, constructor-refused: this app has no demo surface. */
export class FixturesAdapter {
  constructor() {
    throw new Error("ohmail Desktop carries no sample mail; the demo lives on ohmail.app alone.");
  }
}
