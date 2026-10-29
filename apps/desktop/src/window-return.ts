/**
 * AN OPEN SETTINGS PANE FOLLOWS A CHANGE MADE ELSEWHERE. The account panes read their value once,
 * and a switch flipped on the web or the phone stood stale here until the pane was re-entered. So
 * `reread` runs when the window comes back (focus, or shown again) and every `everyMs` while shown.
 */
import { useEffect, useRef } from "react";

export const PANE_REREAD_MS = 30_000;

export function useWindowReturn(reread: () => void, everyMs: number = PANE_REREAD_MS): void {
  const latest = useRef(reread);
  useEffect(() => { latest.current = reread; }, [reread]);
  useEffect(() => {
    const again = (): void => { if (document.visibilityState !== "hidden") latest.current(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const timer = setInterval(again, everyMs);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
      clearInterval(timer);
    };
  }, [everyMs]);
}
