/**
 * THE PILES' KEY while the list has the keyboard: `f` starts the Reply Run on Answer Later, as the head's button does,
 * where the button stands. Never in a field, never with a modifier.
 */
import { useEffect, useRef } from "react";
import { isTypingTarget } from "@ohmail/app-logic/keys";

export function useRunKey(on: boolean, root: Element | null, start: (() => void) | null): void {
  const latest = useRef(start);
  latest.current = start;
  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!on || !win) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const go = latest.current;
      if (e.key !== "f" || go === null) return;
      e.preventDefault();
      go();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [on, root]);
}
