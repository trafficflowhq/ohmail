/**
 * Where a suggestion list stands at its field: under it, or over it where the room under is short.
 *
 * It is a placement of its own beside a menu's (`menu-place.ts`), because a list at a field is held to three things
 * a menu is not: it stays inside what holds its field (one column, one side of a fold) and not only the window; its
 * floor is the top of a keyboard, since the field keeps the caret while the list stands; and where its room is short
 * it is CUT to that room and its rows scroll, where a menu is moved whole. The two share the edge they keep and the
 * way a number is held between two.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { cssRect, cssViewport, uiZoom } from "../ui-zoom.js";
import { between, EDGE, type Edges, type Size } from "./menu-place.js";

/* The room kept to the field, and the least height it is cut to. Not tokens yet. */
const GAP = 6;
const LEAST = 96;

/**
 * The list's corner and the most it may be tall, in the px of `room`'s own edges. It starts at the field's left
 * edge and never leaves the room on either side; it opens upwards when it does not fit under the field and
 * there is more room above; taller than its room, it is cut to it and its rows scroll.
 */
export function placeSuggestions(
  field: Edges,
  list: Size,
  room: Edges,
): { left: number; top: number; maxHeight: number; up: boolean } {
  const under = room.bottom - EDGE - (field.bottom + GAP);
  const above = field.top - GAP - (room.top + EDGE);
  const up = list.height > under && above > under;
  const maxHeight = Math.max(LEAST, up ? above : under);
  const height = Math.min(list.height, maxHeight);
  return {
    left: between(room.left + EDGE, room.right - EDGE - list.width, field.left),
    top: up ? field.top - GAP - height : field.bottom + GAP,
    maxHeight,
    up,
  };
}

/** What a list at a field is told about where to stand. */
export interface FieldPlace {
  /** The field it stands at: under it, or over it where the room under is short. */
  anchor: RefObject<Element | null> | Element;
  /** What it stays inside: the field's column, one side of a fold. Left out: the window. */
  boundary?: RefObject<Element | null> | Element;
  /** `text`: a row's words start where the field's words start, and it is as much wider on the other side. */
  align?: "text";
  /** The field’s form supplies the width of its suggestion popover. */
  span?: string;
  /** A footer the popover should leave exposed when they overlap. */
  avoid?: string;
}

const elementOf = (from: RefObject<Element | null> | Element | undefined): Element | null =>
  from ? ("current" in from ? from.current : from) : null;
/** An element's edges in the page's own px, as plain numbers (a browser's own rect carries none to spread). */
const edgesOf = (el: Element): Edges => {
  const { left, top, right, bottom } = cssRect(el);
  return { left, top, right, bottom };
};
/** Where the words in a field start, from its own left edge: its border and its padding. */
const leadOf = (el: Element): number => {
  const style = getComputedStyle(el);
  return (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.paddingLeft) || 0);
};

/** Puts `card` at its field, inside what holds it and above a keyboard, in the layer it stands in. */
function place(
  card: HTMLElement,
  layer: Element,
  { anchor, boundary, align, span, avoid }: FieldPlace,
): void {
  const at = elementOf(anchor);
  if (!at) return;
  const [field, stage, view] = [edgesOf(at), edgesOf(layer), cssViewport()];
  /* Over the keyboard: what the window shows of the page ends above it. */
  const sight = globalThis.visualViewport;
  const floor = sight ? Math.min(view.height, (sight.offsetTop + sight.height) / uiZoom()) : view.height;
  const held = elementOf(boundary);
  const inside = held ? edgesOf(held) : { left: 0, top: 0, right: view.width, bottom: view.height };
  const room = { ...inside, top: Math.max(inside.top, 0), bottom: Math.min(inside.bottom, floor) };
  const words = align === "text" ? card.querySelector("[data-words]") : null;
  const out = words ? edgesOf(words).left - edgesOf(card).left - leadOf(at) : 0;
  const left = field.left - out;
  const form = span && at.closest(span);
  const width = form
    ? edgesOf(form).right + edgesOf(form).left - 2 * left
    : field.right - field.left + 2 * out;
  const available = room.right - room.left - 2 * EDGE;
  if (span) card.style.minWidth = "0";
  card.style.width = `${span ? Math.min(available, between(280, 440, width)) : width}px`;
  /* As tall as it would be uncut: its box, and what its rows hold beyond what they show. */
  const rows = card.querySelector('[role="listbox"]');
  const size = {
    width: card.offsetWidth,
    height: card.offsetHeight + (rows ? rows.scrollHeight - rows.clientHeight : 0),
  };
  const footer = avoid ? at.ownerDocument.querySelector(avoid) : null;
  if (footer) {
    const box = edgesOf(footer);
    if (box.bottom > box.top && box.left < left + size.width && box.right > left)
      room.bottom = Math.min(room.bottom, box.top);
  }
  const to = placeSuggestions({ ...field, left }, size, room);
  card.style.left = `${to.left - stage.left}px`;
  card.style.top = `${to.top - stage.top}px`;
  card.style.maxHeight = `${to.maxHeight}px`;
  if (to.up) card.dataset.up = "";
  else delete card.dataset.up;
}

/**
 * Keeps a list at its field: placed after every draw (its rows, and so its height, change with every key), and again
 * whenever the window or the page under it moves. It listens for those once, while it is told its field, and
 * does nothing while no list is drawn.
 */
export function useAtField(card: RefObject<HTMLElement | null>, how: FieldPlace | null): void {
  const latest = useRef(how);
  /* Its own rows scrolling inside it move nothing. */
  const again = useRef((event?: Event) => {
    const el = card.current;
    const layer = el?.parentElement;
    if (!latest.current || !el || !layer) return;
    if (!(event?.target instanceof Node && el.contains(event.target))) place(el, layer, latest.current);
  });
  useLayoutEffect(() => {
    latest.current = how;
    again.current();
  });
  const stands = how !== null;
  useEffect(() => {
    if (!stands) return;
    const moved = (event: Event) => again.current(event);
    const sight = globalThis.visualViewport;
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    sight?.addEventListener("resize", moved);
    sight?.addEventListener("scroll", moved);
    return () => {
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
      sight?.removeEventListener("resize", moved);
      sight?.removeEventListener("scroll", moved);
    };
  }, [stands]);
}
