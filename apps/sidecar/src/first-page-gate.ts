/**
 * THE READER'S FIRST PAGE GOES IN FRONT OF THE FIRST DRAIN.
 *
 * `store-lanes.ts` shares the one local connection between the mail coming in and the windows
 * asking for it, but a TRANSACTION IS ONE ADMISSION: the weights choose between statements and
 * cannot preempt inside a transaction body, so an ingest cycle holds the connection for the
 * whole of each of its own — which put the boot drain in front of the first list row. So the
 * first drain waits for the window's bootstrap page, bounded: a start nobody watches must not
 * become a new way to not get mail.
 */

/**
 * How long the first drain waits for a first page that may never be asked for.
 *
 * The page it waits for costs 189 ms on the largest mirror measured, so this is an order of
 * magnitude of headroom over the thing it is waiting for and still far below the ~3 s drain it is
 * reordering. It bounds a WAIT, not a page: a slower page still serves, and the drain simply stops
 * holding the door for it.
 */
export const FIRST_PAGE_GRACE_MS = 1_500;

/** Why the wait ended — a reading, so a test and a log line can tell the three apart. */
export type FirstPageOutcome = "served" | "timed-out" | "already";

let released = false;
let waiters: Array<(outcome: FirstPageOutcome) => void> = [];
/** When the grace started — see {@link armFirstPageGate}. `null` until the door is open. */
let armedAtMs: number | null = null;

/**
 * Start the grace, at the moment a first page could first be ASKED for.
 *
 * The bound belongs here rather than at the wait, or a slow store open would be spent twice: once
 * opening and again waiting. It is armed beside the `serving` line, which the measured boot puts
 * 2 ms after the store open and which is the honest anchor — before the door serves, no window can
 * ask, so a grace running then would be counting a window nobody could use.
 */
export function armFirstPageGate(nowMs: number = Date.now()): void {
  armedAtMs = nowMs;
}

/**
 * The bootstrap's first page has been answered. Idempotent and once per process: later pages, and
 * every later drain, are not what this gate is about.
 */
export function noteFirstPageServed(): void {
  if (released) return;
  released = true;
  const waiting = waiters;
  waiters = [];
  for (const resolve of waiting) resolve("served");
}

/**
 * Wait for that page, or for the grace to run out.
 *
 * `already` and `served` are kept apart on purpose: a drain that never waited and a drain that
 * waited and was released are different facts about a start, and one log line reading "served"
 * for both would be unable to say whether the gate did anything.
 */
export function awaitFirstPage(
  graceMs: number = FIRST_PAGE_GRACE_MS,
  nowMs: number = Date.now(),
): Promise<FirstPageOutcome> {
  if (released) return Promise.resolve<FirstPageOutcome>("already");
  // WHAT IS LEFT OF THE GRACE, not the whole of it. An unarmed gate (no door, so no `serving`
  // line) gets the full bound rather than none: the failure to arm must not become a drain that
  // waits for ever, and it must not become one that never waits either.
  const left = armedAtMs === null ? graceMs : Math.max(0, graceMs - (nowMs - armedAtMs));
  if (left === 0) return Promise.resolve<FirstPageOutcome>("timed-out");
  return new Promise<FirstPageOutcome>((resolve) => {
    const timer = setTimeout(() => {
      // The waiter is dropped rather than left to be resolved twice: `noteFirstPageServed` walks
      // the list and a stale entry would resolve a promise that already settled.
      waiters = waiters.filter((w) => w !== onServed);
      resolve("timed-out");
    }, left);
    const onServed = (outcome: FirstPageOutcome): void => {
      clearTimeout(timer);
      resolve(outcome);
    };
    waiters.push(onServed);
  });
}

/** Back to a process that has served no page — for tests, which need more than one start. */
export function resetFirstPageGate(): void {
  released = false;
  waiters = [];
  armedAtMs = null;
}
