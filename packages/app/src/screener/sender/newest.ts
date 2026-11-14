/**
 * THE NEWEST LETTER FIRST: a sender's letters stand oldest first, so the reading column opens on the newest (the
 * decision is taken on what the sender sends now, not on the least current thing they sent) and keeps it there while
 * the letters grow, their bodies landing or a frame sizing, until the person scrolls: the column remembers where it
 * last put itself, and one that moved from there is the person's (1.0.11's rule, `heldAnchored`). A sender of one
 * letter opens at the column's top.
 *
 * The reading sheet reserves room for its stationary head above the scrollport. The newest letter lands at the
 * scrollport's top, with the same breathing room it has when its body grows.
 */
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cssRect } from "@ohmail/app-logic/geometry";
import { heldAnchored, heldAnchorTop, useHeldWindow } from "@ohmail/app-logic/lists/held-window";
import { afterPaint } from "@ohmail/app-logic/lists/visit";
import { heldMark } from "../held/HeldLetter.js";

/**
 * `opened` names the open sender (its section and id): a new one is put on its newest letter. `newest` is that
 * letter's id, null where the sender holds one letter or none. The ref is the reading sheet's scroller.
 */
export function useNewestFirst(
  opened: string,
  newest: string | null,
  count: number,
  openingAt?: number,
  keepBrowserOffset = false,
) {
  const scroller = useRef<HTMLDivElement | null>(null);
  /* Where the column last put itself; null while it holds no letter. */
  const at = useRef<number | null>(null);
  const [painted, setPainted] = useState<string | null>(null);
  const ready = painted === opened;
  useEffect(() => {
    if (ready) return;
    return afterPaint(scroller.current, () => startTransition(() => setPainted(opened)));
  }, [opened, ready]);
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
    if (!keepBrowserOffset) place();
  }, [opened, place, keepBrowserOffset]);
  useLayoutEffect(() => {
    if (ready && scroller.current && heldAnchored(at.current, scroller.current.scrollTop)) place();
  }, [ready, place]);
  const window = useHeldWindow({
    count,
    resetKey: opened,
    read: () => scroller.current,
    anchoredAt: at,
    reanchor: place,
    cardSelector: ".sc-held-letters > article",
    openingAt,
    ready,
  });
  return { scroller, ready, ...window };
}
