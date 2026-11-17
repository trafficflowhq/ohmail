import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * THE KEYS FOLLOW THE LIST's ONE STOP, so that a walk by the keys never leaves them on the row the cursor left
 * (Enter would press a letter the person has visibly moved away from). The row that becomes the stop takes the
 * keys along where they stood on a row that lost it (a list has one stop, also where it is set in groups), or,
 * when the stop moved to it after it stood, on a box around the list. Keys that stand elsewhere (a field beside
 * the list, the reading column) or nowhere are never taken. Returns the ref the row's own node carries.
 */
export function useKeysFollowStop(at: boolean | undefined): RefObject<HTMLDivElement | null> {
  const row = useRef<HTMLDivElement>(null);
  const was = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    const moved = was.current === false && at === true;
    was.current = at;
    const el = row.current;
    const held = el?.ownerDocument.activeElement;
    if (!el || at !== true || !held || held === el || held === el.ownerDocument.body) return;
    /* A row of the list that is no longer its stop: a row, never another part's option (a palette's command). */
    const leftBehind = held.classList.contains("oh-row") && held.getAttribute("tabindex") === "-1";
    if (leftBehind || (moved && held.contains(el))) el.focus({ preventScroll: true });
  }, [at]);
  return row;
}
