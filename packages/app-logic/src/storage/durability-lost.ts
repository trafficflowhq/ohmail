"use client";

/**
 * "This browser is not keeping your decisions", as its reader follows it: whether the once-per-session notice is
 * owed now. Moved from the web shell (`DurabilityNotice.tsx`), so that the one notice slot of the mail ground can say
 * it on every host; `durable.ts` holds the latch, so a dismissal is not undone by the next refused write.
 */
import { useEffect, useState } from "react";
import { durabilityLost, onDurabilityLost } from "./durable.js";

/**
 * Adopt what the module already knows at mount, then listen. Not the current value as the
 * initial state: a server render has none, and reading one during render would be a hydration
 * mismatch — `useUpdateOffer`'s own reason.
 */
export function useDurabilityLost(): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const read = () => {
      setLost(durabilityLost());
    };
    read();
    return onDurabilityLost(read);
  }, []);
  return lost;
}
