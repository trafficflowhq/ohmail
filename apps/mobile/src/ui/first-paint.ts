/**
 * THE WALL BEFORE MAIL. A paired Cloud phone whose last word for this pairing was `open` paints its
 * mirror at once; any other asks `GET /account/access` first, and that read raises or lifts the
 * wall itself (`net/account.ts`), so a closed account's first frame is the wall and never an empty
 * Ohbox. Bounded: past {@link FIRST_PAINT_VERDICT_MS} the mirror paints anyway (fail-open) and a
 * later 402 still raises the wall. Only a managed door can refuse an account; every other paints.
 */
import type { CadenceTimers } from "../net/drain-cadence";
import type { StoredVerdict } from "../state/access-verdict";

/** How long the first paint waits for the verdict — the keystore read included — before it paints. */
export const FIRST_PAINT_VERDICT_MS = 3_000;

export interface FirstPaintInputs {
  /** Can this door refuse the account at all: a paired managed server. */
  refusable: boolean;
  /** Has the stored-verdict row been read (`state/access-verdict.ts`)? */
  ready: () => boolean;
  settled: () => Promise<void>;
  stored: () => StoredVerdict | null;
  /** The fresh read. Its answer is acted on where it lands; this only waits for it. */
  ask: () => Promise<unknown>;
  timers?: CadenceTimers;
  boundMs?: number;
}

const realTimers: CadenceTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** May the mirror paint now, asking nothing? Decided in the render, so no mail frame precedes it. */
export function paintsAtOnce(i: Pick<FirstPaintInputs, "refusable" | "ready" | "stored">): boolean {
  return !i.refusable || (i.ready() && i.stored() === "open");
}

/**
 * Wait for the verdict, bounded. `open` fires exactly once — when the read answers (whatever it
 * said), when the row turns out to hold `open`, or at the bound. Answers the cancel.
 */
export function awaitFirstPaint(i: FirstPaintInputs, open: () => void): () => void {
  const timers = i.timers ?? realTimers;
  let done = false;
  let bound: unknown = null;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (bound !== null) timers.clear(bound);
    open();
  };
  bound = timers.set(finish, i.boundMs ?? FIRST_PAINT_VERDICT_MS);
  void i.settled().then(() => {
    if (done) return undefined;
    if (i.stored() === "open") { finish(); return undefined; }
    return i.ask().catch(() => undefined).then(finish);
  });
  return () => {
    done = true;
    if (bound !== null) timers.clear(bound);
  };
}
