"use client";

/**
 * The quiet frame, and when it stops being honest. `engine.tsx` argues correctly that the session
 * gate carries no text ("two or three hundred milliseconds, and a sentence that flashes is worse
 * than a quiet frame"); over a slow link the same wait runs to several seconds, and a screen that
 * says nothing that long looks broken. Both are right about different connections, so the answer is
 * a function of TIME: nothing is said while the wait is the length a wait is supposed to be, and a
 * slow one is never left guessing. Not "a spinner after a delay": underneath, the panes would
 * otherwise state "Nothing in your Ohbox." as a settled fact ({@link MailState.settled}) — the
 * grace decides only WHEN the true sentence is spoken; the false one is gone at zero milliseconds.
 */

import { useEffect, useState } from "react";

/**
 * How long a wait may go unremarked. Six hundred milliseconds: above the 200–300 ms `engine.tsx`
 * measured for the ordinary session resolution — the ordinary case stays a silent frame with no
 * flash — and well below the "several seconds" that produced the report; also comfortably under
 * the 8 s `POLL_MS`, so a tab waiting out one poll interval has been talking for most of it.
 * Exported so a test can drive fake timers to either side rather than sleeping past a literal it
 * cannot see.
 */
export const LOADING_GRACE_MS = 600;

/**
 * Has this surface been waiting long enough to say so? `false` on the first render and on the
 * server, which is what makes the quiet frame quiet: reading a clock in the initializer would make
 * the server and client render different markup, and React resolves that by keeping the server's —
 * the hydration trap `persisted-ui.ts` documents. `active: false` disarms the timer AND resets, so
 * a surface that finishes and later waits again gets a fresh grace rather than announcing instantly
 * on the strength of an earlier wait.
 */
export function useLoadingGrace(active: boolean, ms: number = LOADING_GRACE_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const id = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(id);
  }, [active, ms]);
  return active && elapsed;
}
