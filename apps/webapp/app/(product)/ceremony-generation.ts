"use client";

/**
 * THE CEREMONY'S GENERATION — what makes Cancel and Back mean it.
 *
 * An outcome attached to a verify promise's RESOLUTION rather than to the ceremony's STATE acts
 * after the person has walked away: that is how a cancelled account-erase still erased. Each
 * factor path captures the counter `begin` returns before its first `await`; `end` — Cancel,
 * Back, a failure — bumps it before it clears anything; `claim` compares and spends it, at ONE
 * door per ceremony rather than one per caller, so a new factor path inherits the gate instead
 * of the defect. A refused claim calls nothing and raises `discarded`, which the surface must
 * SAY: a silent discard leaves somebody unable to tell what happened. Unmount is not the gate —
 * a pane need not go away for the ceremony to be over, and a ceremony can be over while it stays.
 */

import { useCallback, useMemo, useRef, useState } from "react";

export interface CeremonyGeneration {
  /** Capture this IMMEDIATELY before the ceremony's first `await`, and pass it to `claim`. */
  begin: () => number;
  /** The one door. True when `gen` is still the live ceremony — and spends it by saying so. */
  claim: (gen: number) => boolean;
  /** Cancel, Back or a failure: nothing already in flight may act. Call it BEFORE clearing. */
  end: () => void;
  /** A result landed after `end` and was discarded. Render it; never swallow it. */
  discarded: boolean;
  /** A fresh attempt starts: the last discard is no longer what the screen is about. */
  clear: () => void;
}

export function useCeremonyGeneration(): CeremonyGeneration {
  const gen = useRef(0);
  const [discarded, setDiscarded] = useState(false);

  const begin = useCallback((): number => {
    setDiscarded(false);
    return gen.current;
  }, []);

  const claim = useCallback((captured: number): boolean => {
    if (captured !== gen.current) {
      setDiscarded(true);
      return false;
    }
    // Spent the moment it authorises the act, so a late second response cannot act either.
    gen.current += 1;
    return true;
  }, []);

  const end = useCallback((): void => {
    gen.current += 1;
  }, []);

  const clear = useCallback((): void => setDiscarded(false), []);

  // Stable while `discarded` holds, so a consumer may put this in a hook's dependency list.
  return useMemo(
    () => ({ begin, claim, end, discarded, clear }),
    [begin, claim, end, discarded, clear],
  );
}
