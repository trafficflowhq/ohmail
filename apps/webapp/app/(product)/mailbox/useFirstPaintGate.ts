"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { account, type AccessRefusedFacts } from "../../api-client";
import { refusedFactsOf } from "../../access-verdict";
import { FIRST_PAINT_VERDICT_MS, readStoredVerdict } from "../../shell/wall-lift";
import { readOwner } from "../../shell/owner-cookie";
import { webLane } from "../../shell/resume-lane";

/**
 * THE WALL BEFORE MAIL. A browser whose last word for this owner was `open` paints its mirror
 * at once; any other asks `GET /account/access` first, so a closed account's first frame is the
 * wall and never an empty Ohbox. Bounded: past {@link FIRST_PAINT_VERDICT_MS} the mirror paints
 * anyway (fail-open) and a later refusal still raises the wall through the 402 sink.
 */

/** `hydrating` is the server's frame and the client's first; nothing is decided in it. */
export type FirstPaint = "hydrating" | "asking" | "open";

const useAfterHydration = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useFirstPaintGate(demo: boolean, onRefused: (facts: AccessRefusedFacts) => void): FirstPaint {
  // The demo's shell is prerendered and asks nobody, so it never waits.
  const [phase, setPhase] = useState<FirstPaint>(demo ? "open" : "hydrating");
  useAfterHydration(() => {
    if (demo) {
      setPhase("open");
      return;
    }
    /*
     * THE PAGE LOAD CONFIRMS FIRST (`resume-lane.ts`). The earliest effect of the shell, so before any
     * read: a cold lane's lead is kept for the session confirm, which gates the delta, and the reads
     * that come first wait for its answer. The access read below is never held by it. Released when
     * the confirm settles, at the lane's bound, and here when this load will confirm nothing.
     */
    const release = webLane.confirming();
    if (readStoredVerdict(readOwner()) === "open") {
      setPhase("open");
      return release;
    }
    setPhase("asking");
    let live = true;
    const open = (): void => { if (live) setPhase("open"); };
    const bound = setTimeout(open, FIRST_PAINT_VERDICT_MS);
    void account.access({ fresh: true })
      .then((a) => {
        const facts = refusedFactsOf(a);
        if (live && facts !== null) {
          release();   // the wall, not the mail: no confirm comes
          onRefused(facts);
        }
      })
      .catch(() => { /* no verdict: the mirror paints, the sink stays armed */ })
      .finally(() => { clearTimeout(bound); open(); });
    return () => { live = false; clearTimeout(bound); release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onRefused` is a state setter
  }, [demo]);
  return phase;
}
