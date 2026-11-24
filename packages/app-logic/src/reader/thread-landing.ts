import { useCallback, useRef } from "react";
import { cssRect } from "../geometry/index.js";
import { letterBodyIsReady, viewOf, type ThreadDomNames } from "../reading/reader-seen.js";
import { scrollProgrammatically } from "../session/programmatic-scroll.js";

export const LANDING_ROOM = "--oh-thread-landing-room";
/** How far under the column's top (under its head, where one stays there) an open puts the message's top. */
export const OPEN_GAP_PX = 14;
/** Far enough above the last letter to show the shortcut to it. */
export const END_FAR_PX = 240;

export function measureLanding(
  scroller: HTMLElement,
  landing: { top: number; letter: HTMLElement } | undefined,
  heldTop: number | null,
  {
    keepLanding,
    newestFirst,
    bodyChanged,
    line,
  }: {
    keepLanding: boolean;
    newestFirst: boolean;
    bodyChanged: boolean;
    line: number;
  },
): { max: number; top: number | null } {
  const firstTop = keepLanding ? heldTop : null;
  let max = scrollMax(scroller);
  if (keepLanding && firstTop === null && scroller.style.getPropertyValue(LANDING_ROOM) !== "") {
    // The person may still be standing in the padded part of the scroll range.
    max = keepLandingRoom(scroller, scroller.scrollTop, max);
  }
  if (!landing || !Number.isFinite(landing.top)) return { max, top: firstTop };

  const { letter, top } = landing;
  const clearance = firstTop ?? line;
  const wanted = firstTop === null && newestFirst && keepLanding ? 0 : Math.max(0, top - clearance);
  // The room is kept while the opening still aims too: the letters above stand at their floor
  // until their frames load, and a range cut that short would draw the letter low, then snap.
  if (keepLanding) max = keepLandingRoom(scroller, wanted, max);
  const next = Math.min(max, wanted);
  // A body shrink can already have clamped scrollTop before we read it. Stamp that scroll too.
  if (bodyChanged || Math.abs(next - scroller.scrollTop) > 0.5) scrollProgrammatically(scroller, next);
  // Keep aiming at the reading line until the body arrives, then hold the visible landing.
  const ready = keepLanding && firstTop === null && letterBodyIsReady(letter);
  return { max, top: ready ? top - scroller.scrollTop : firstTop };
}

function scrollMax(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

/** A shorter final letter can reduce the scroll range below the held reading position. */
function keepLandingRoom(scroller: HTMLElement, wanted: number, max: number): number {
  const current = Number.parseFloat(scroller.style.getPropertyValue(LANDING_ROOM)) || 0;
  const needed = Math.max(0, Math.ceil(wanted - max + current));
  if (needed === current) return max;
  if (needed === 0) scroller.style.removeProperty(LANDING_ROOM);
  else scroller.style.setProperty(LANDING_ROOM, `${needed}px`);
  return scrollMax(scroller);
}

/** The gap below the scroller’s sticky heading, or below its top on a phone. */
function openingClearance(scroller: HTMLElement, names: ThreadDomNames, scrollerTop: number): number {
  const head = names.head === undefined ? null : scroller.querySelector<HTMLElement>(names.head);
  const win = scroller.ownerDocument.defaultView;
  if (head === null || win === null) return OPEN_GAP_PX;
  return win.getComputedStyle(head).position === "sticky"
    ? Math.max(0, cssRect(head).bottom - scrollerTop) + OPEN_GAP_PX
    : OPEN_GAP_PX;
}

export function threadLayout(scroller: HTMLElement, scope: HTMLElement, names: ThreadDomNames) {
  const top0 = cssRect(scroller).top;
  const v = viewOf(scroller, names);
  return {
    line: openingClearance(scroller, names, top0),
    at: conversationTops(scope, top0, scroller.scrollTop),
    view: Math.max(0, v.bottom - v.top),
    farEdge: Math.max(END_FAR_PX, scroller.clientHeight / 2),
  };
}

function conversationTops(scope: HTMLElement, top0: number, scrollTop: number) {
  const at = new Map<string, { top: number; bottom: number; letter: HTMLElement }>();
  const offset = scrollTop - top0;
  for (const letter of scope.querySelectorAll<HTMLElement>("[data-conv-id]")) {
    const rect = cssRect(letter);
    at.set(letter.dataset.convId ?? "", { top: rect.top + offset, bottom: rect.bottom + offset, letter });
  }
  return at;
}

export function useThreadPosition(
  scroller: HTMLElement | null,
  manual: boolean,
  releaseOpening: () => void,
  pin: { current: string | null },
) {
  const layout = useRef<ReturnType<typeof threadLayout> | null>(null);
  const readingAnchor = useRef<ReadingAnchor | null>(null);
  const rememberReadingAnchor = useCallback(
    (preferred?: string) => {
      if (!manual || !scroller || !layout.current) return;
      const { at, line, view } = layout.current;
      readingAnchor.current = readingAnchorAt(at, line, view, scroller.scrollTop, preferred);
    },
    [scroller, manual],
  );
  const wasClamped = useCallback((): boolean => {
    const previous = readingAnchor.current?.scroll;
    if (!manual || !scroller || previous === undefined) return false;
    const max = scrollMax(scroller);
    return previous > max && Math.abs(scroller.scrollTop - max) <= 1;
  }, [scroller, manual]);
  const moved = useCallback(
    (hand: boolean): boolean => {
      if (!scroller) return false;
      if (hand) {
        releaseOpening();
        pin.current = null;
      }
      if (!manual || (!hand && readingAnchor.current?.scroll === scroller.scrollTop)) return false;
      rememberReadingAnchor();
      return true;
    },
    [scroller, manual, releaseOpening, pin, rememberReadingAnchor],
  );
  return { layout, readingAnchor, rememberReadingAnchor, wasClamped, moved };
}

interface ReadingAnchor {
  readonly id: string;
  readonly offset: number;
  readonly scroll: number;
}

/** Keep the letter on the reading line, or the one just below it when the line falls between letters. */
function readingAnchorAt(
  letters: ReturnType<typeof conversationTops>,
  line: number,
  view: number,
  scroll: number,
  preferred?: string,
): ReadingAnchor | null {
  if (preferred !== undefined) {
    const letter = letters.get(preferred);
    if (letter && letter.bottom > scroll + line && letter.top < scroll + view) {
      return { id: preferred, offset: letter.top - scroll, scroll };
    }
  }
  for (const [id, { top, bottom }] of letters) {
    if (bottom > scroll + line && top < scroll + view) return { id, offset: top - scroll, scroll };
  }
  return null;
}
