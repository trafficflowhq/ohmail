/**
 * THE SAMPLE WORLD, ABSENT — what `packages/client-engine/src/adapters/fixtures-adapter.ts`
 * resolves to in BOTH desktop artifacts (`vite.config.ts` aliases it here for the window
 * bundle and the served host client alike). The shell's demo arm exists for the landing page;
 * a branch never taken (`DesktopGate` passes `demo={false}` structurally) still puts its
 * imports — the whole fixtures corpus of invented mail — into the bundle of an app that opens
 * EMPTY, so the module is replaced, not merely unreached (`scan-artifact.mjs` greps both dists
 * for the sample senders). The three value exports below are what the client-engine barrel
 * re-exports; the class throws in its constructor so a reached demo branch fails loudly.
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
