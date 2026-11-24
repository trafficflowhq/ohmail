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
  keepLanding: boolean,
  releaseOpening: () => void,
  pin: { current: string | null },
) {
  const layout = useRef<ReturnType<typeof threadLayout> | null>(null);
  const readingAnchor = useRef<ReadingAnchor | null>(null);
  const anchorPending = useRef(false);
  const rememberReadingAnchor = useCallback(
    (preferred?: string) => {
      anchorPending.current = false;
      if (!keepLanding || !scroller || !layout.current) return;
      const { at, line, view } = layout.current;
      readingAnchor.current = readingAnchorAt(at, line, view, scroller, preferred);
    },
    [scroller, keepLanding],
  );
  const captureMovedAnchor = useCallback(() => {
    if (anchorPending.current) rememberReadingAnchor();
  }, [rememberReadingAnchor]);
  const wasClamped = useCallback((): boolean => {
    const previous = readingAnchor.current?.scroll;
    if (!keepLanding || !scroller || anchorPending.current || previous === undefined) return false;
    const max = scrollMax(scroller);
    return previous > max && Math.abs(scroller.scrollTop - max) <= 1;
  }, [scroller, keepLanding]);
  const moved = useCallback(
    (hand: boolean): boolean => {
      if (!scroller) return false;
      if (hand) {
        releaseOpening();
        pin.current = null;
      }
      if (!keepLanding || (!hand && readingAnchor.current?.scroll === scroller.scrollTop)) return false;
      anchorPending.current = true;
      return true;
    },
    [scroller, keepLanding, releaseOpening, pin],
  );
  return {
    layout,
    readingAnchor,
    anchorPending,
    rememberReadingAnchor,
    captureMovedAnchor,
    wasClamped,
    moved,
  };
}

interface ReadingAnchor {
  readonly id: string;
  readonly offset: number;
  readonly scroll: number;
  readonly text: { range: Range; offset: number } | null;
}

function caretRangeAt(doc: Document, x: number, y: number): Range | null {
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position || position.offsetNode.nodeType !== Node.TEXT_NODE) return null;
  const range = doc.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/** Prefer the text at the reading line, or the first visible line below a picture. */
function frameTextAt(
  letter: HTMLElement,
  scroller: HTMLElement,
  line: number,
  view: number,
): ReadingAnchor["text"] {
  const frame = letter.querySelector<HTMLIFrameElement>("iframe.mb-frame");
  const doc = frame?.contentDocument;
  if (!frame || !doc || (!doc.caretRangeFromPoint && !doc.caretPositionFromPoint)) return null;
  // The frame document has its own viewport. Convert the outer boxes to the CSS pixels
  // used by the scroller and the frame document before finding the caret.
  const bounds = cssRect(frame);
  const offset = bounds.top - cssRect(scroller).top;
  const start = line - offset;
  if (start < 0 || start >= bounds.height) return null;
  const x = Math.min(bounds.width, doc.documentElement.clientWidth) / 2;
  const end = Math.min(bounds.height, view - offset);
  let y = start;
  for (let probes = 0; probes < 12 && y < end; probes++) {
    const range = caretRangeAt(doc, x, y);
    const element = doc.elementFromPoint(x, y);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      const rect = range.getBoundingClientRect();
      // At the top edge of a cell, the caret can already find its text below the cell's padding.
      const inElement = y < rect.top && rect.top < end && element?.contains(range.startContainer);
      if (rect.height > 0 && y <= rect.bottom + 1 && (y >= rect.top - 1 || inElement)) {
        return { range, offset: offset + rect.top };
      }
    }
    const bottom = element?.getBoundingClientRect().bottom;
    y = bottom !== undefined && bottom > y ? bottom + 1 : y + 6;
  }
  return null;
}

export function readingLanding(
  scroller: HTMLElement,
  letters: ReturnType<typeof conversationTops>,
  anchor: ReadingAnchor | null,
  manual: boolean,
) {
  if (!anchor) return;
  const visible = letters.get(anchor.id);
  if (!visible) return;
  const text = textLanding(scroller, visible.letter, anchor);
  if (text) return { letter: visible.letter, top: text.top, offset: text.offset };
  if (manual) return { letter: visible.letter, top: visible.top, offset: anchor.offset };
}

function textLanding(scroller: HTMLElement, letter: HTMLElement, anchor: ReadingAnchor) {
  const text = anchor.text;
  if (!text) return null;
  const frame = letter.querySelector<HTMLIFrameElement>("iframe.mb-frame");
  const doc = frame?.contentDocument;
  if (!frame || !doc) return null;
  const range = rangeInDocument(text.range, doc);
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0) return null;
  return {
    top: cssRect(frame).top + rect.top - cssRect(scroller).top + scroller.scrollTop,
    offset: text.offset,
  };
}

/** Embedded bytes can replace the frame document while the letter's text stays the same. */
function rangeInDocument(range: Range, doc: Document): Range | null {
  const source = range.startContainer;
  if (source.ownerDocument === doc) return source.isConnected ? range : null;
  const oldBody = source.ownerDocument?.body;
  if (!oldBody?.contains(source) || !doc.body) return null;
  const path: number[] = [];
  for (let node = source; node !== oldBody; node = node.parentNode!) {
    path.push(Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode));
  }
  let node: Node | undefined = doc.body;
  while (node && path.length) node = node.childNodes[path.pop()!];
  if (node?.nodeType !== Node.TEXT_NODE || node.nodeValue !== source.nodeValue) return null;
  const replacement = doc.createRange();
  replacement.setStart(node, range.startOffset);
  replacement.collapse(true);
  return replacement;
}

/** Keep the letter on the reading line, or the one just below it when the line falls between letters. */
function readingAnchorAt(
  letters: ReturnType<typeof conversationTops>,
  line: number,
  view: number,
  scroller: HTMLElement,
  preferred?: string,
): ReadingAnchor | null {
  const scroll = scroller.scrollTop;
  const inView = ({ top, bottom }: { top: number; bottom: number }) =>
    bottom > scroll + line && top < scroll + view;
  const anchor = (id: string, { top, letter }: { top: number; letter: HTMLElement }): ReadingAnchor => ({
    id,
    offset: top - scroll,
    scroll,
    text: frameTextAt(letter, scroller, line, view),
  });
  if (preferred !== undefined) {
    const letter = letters.get(preferred);
    if (letter && inView(letter)) return anchor(preferred, letter);
  }
  for (const [id, letter] of letters) {
    if (inView(letter)) return anchor(id, letter);
  }
  return null;
}
