/**
 * THE NEWEST LETTER FIRST: a sender's letters stand oldest first, so the reading column opens on the newest (the
 * decision is taken on what the sender sends now, not on the least current thing they sent) and keeps it there while
 * the letters grow, their bodies landing or a frame sizing, until the person scrolls: the column remembers where it
 * last put itself, and one that moved from there is the person's (1.0.11's rule, `heldAnchored`). A sender of one
 * letter opens at the column's top.
 *
 * The line the letter lands on is the column's top: the sentence over the letters scrolls with them. Once the kit's
 * reading head that takes a sentence stays over the column (ask KS10), the letter lands under it, as 1.0.11's under
 * its bar.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cssRect } from "@ohmail/app-logic/geometry";
import { heldAnchored, heldAnchorTop } from "@ohmail/app-logic/lists/held-window";
import { heldMark } from "../held/HeldLetter.js";

/**
 * `opened` names the open sender (its section and id): a new one is put on its newest letter. `newest` is that
 * letter's id, null where the sender holds one letter or none. The ref is the reading sheet's scroller.
 */
export function useNewestFirst(opened: string, newest: string | null) {
  const scroller = useRef<HTMLDivElement | null>(null);
  /* Where the column last put itself; null while it holds no letter. */
  const at = useRef<number | null>(null);
  const target = useRef(newest);
  target.current = newest;
  const place = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    const id = target.current;
    const letter = id === null ? null : el.ownerDocument.getElementById(heldMark(id));
    el.scrollTop = letter === null ? 0 : heldAnchorTop(cssRect(el).top, cssRect(letter).top, el.scrollTop);
    /* What the column reads back, not what was asked: a browser keeps the offset inside what can scroll. */
    at.current = letter === null ? null : el.scrollTop;
  }, []);
  useLayoutEffect(() => {
    at.current = null;
    place();
  }, [opened, place]);
  useEffect(() => {
    const el = scroller.current;
    if (el === null || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(() => {
      if (heldAnchored(at.current, el.scrollTop)) place();
    });
    watch.observe(el);
    for (const part of el.children) watch.observe(part);
    return () => watch.disconnect();
  }, [opened, place]);
  return scroller;
}
