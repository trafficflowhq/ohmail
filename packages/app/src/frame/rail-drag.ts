/**
 * A LETTER DRAGGED FROM A LIST ONTO THE RAIL. One semantic, new gesture: a drop runs exactly what the list's own
 * control runs (the pill's Move, Later, Set aside, Resurface; the bulk bar's verbs; the tag picker's apply), through
 * the list's own verbs and so through the press seam. The frame owns only the gesture (the threshold, the ghost, the
 * lit entries, the release and the cancel) and files nothing: what an entry takes is its registration's word
 * (`PlaceRail.drop`; a tag's entry says its tag by `data-rail-tag-id`), and the LIST is told where its rows landed.
 *
 * Moved from the web shell's `drag-file.ts`, the gesture word for word but for two things: it reads the page the row
 * stands in (shared code touches no global), and the entries it lights are the kit's (`RailEntry`'s `drop`), drawn
 * from the frame's own feed, not a class written on them from outside. Pointer events, not HTML5 drag and drop: the
 * desktop runs this inside WKWebView and WebView2, where HTML5 drag is unreliable. Touch is left out on purpose: with
 * a finger, dragging a list is scrolling it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import { DRAG_SLOP_PX } from "@ohmail/app-logic/lists/drag-slop";
import {
  dropLegal,
  type DragSource,
  type PileDropAction,
  type RailDropTarget,
} from "@ohmail/app-logic/lists/drag-source";
import { cssPoint, cssRect } from "@ohmail/app-logic/geometry";
import { useDragFeed, useFrame } from "./commands.js";
import { useSignal } from "./feeds.js";

/** A drag past its threshold: what it carries (for an entry's own legality) and the entry under the pointer. */
export interface Dragging {
  readonly messages: DragSource["messages"];
  readonly over: RailDropTarget | null;
}

/** The spring-back's travel time: the row-settle register (`SETTLE_MS` is 280). */
const SPRING_MS = 220;

const keyOf = (t: RailDropTarget): string => (t.kind === "tag" ? `tag:${t.tagId}` : t.action);

/**
 * How an entry that takes a drop draws while a letter is dragged: `ready` where dropping there would change
 * something, `over` while the pointer is on it, nothing else. A rail group a place draws itself (the tags) asks it
 * for each of its entries.
 */
export function useRailDropState(target: RailDropTarget | null): "ready" | "over" | undefined {
  const dragging = useSignal(useDragFeed());
  if (dragging === null || target === null || !dropLegal(target, dragging.messages)) return undefined;
  return dragging.over !== null && keyOf(dragging.over) === keyOf(target) ? "over" : "ready";
}

/** The drop target an element stands in, read off the boxes the rail's entries stand in. */
function targetOf(el: Element): RailDropTarget | null {
  const hit = el.closest<HTMLElement>("[data-rail-drop],[data-rail-tag-id]");
  if (!hit) return null;
  const tagId = hit.dataset.railTagId;
  if (tagId) return { kind: "tag", tagId };
  const action = hit.dataset.railDrop;
  return action ? { kind: "pile", action: action as PileDropAction } : null;
}

/** The minimal shape of a pointer event the gesture reads. */
interface PointerLike {
  button: number;
  clientX: number;
  clientY: number;
  pointerType?: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

interface Gesture {
  readonly engine: OhmailEngine;
  readonly doc: Document;
  readonly win: Window;
  readonly rowEl: HTMLElement;
  readonly rowId: string;
  readonly startX: number;
  readonly startY: number;
  /** Resolved at the threshold, not at the press: a press that stays a click resolves nothing. */
  source: DragSource | null;
  dragging: boolean;
  /** Escape or engine replacement: swallow the release click and run nothing. */
  cancelled: boolean;
  ghost: HTMLElement | null;
  /** The legal target under the pointer, or none. */
  over: RailDropTarget | null;
  readonly reducedMotion: boolean;
}

/** The element under the pointer: optional on purpose; absent reads as "over nothing". */
function elementAt(doc: Document, x: number, y: number): Element | null {
  const from = (doc as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint;
  return typeof from === "function" ? from.call(doc, x, y) : null;
}

function buildGhost(doc: Document, source: DragSource): HTMLElement {
  const g = doc.createElement("div");
  g.className = "drag-ghost";
  g.setAttribute("aria-hidden", "true");
  if (source.ids.length > 1) {
    const count = doc.createElement("span");
    count.className = "dg-count num";
    count.textContent = String(source.ids.length);
    g.appendChild(count);
  }
  const from = doc.createElement("span");
  from.className = "dg-from";
  from.textContent = source.label.from;
  const subj = doc.createElement("span");
  subj.className = "dg-subj";
  subj.textContent = source.label.subject;
  g.append(from, subj);
  return g;
}

/* Beside the pointer, not under it: the hit test must find the rail, never the ghost. */
function placeGhost(g: HTMLElement, x: number, y: number): void {
  g.style.transform = `translate3d(${x + 14}px, ${y + 10}px, 0)`;
}

/**
 * Swallow the click a finished drag's release makes, once: a press that became a drag was answered by the drop (or
 * the cancel), and the release must not also open the letter just filed. Capture on the window runs before React's
 * root, and it disarms on the next task in case no click follows (a release outside the window).
 */
function suppressNextClick(win: Window): void {
  const eat = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };
  const disarm = (): void => {
    win.removeEventListener("click", eat, true);
    win.clearTimeout(timer);
  };
  win.addEventListener("click", eat, true);
  const timer = win.setTimeout(disarm, 0);
}

/** Every trace of the ghost out of the page: at once, or after the spring back or the settle. */
function useGhosts() {
  const ghosts = useRef(new Set<HTMLElement>());
  const remove = useCallback((el: HTMLElement): void => {
    el.remove();
    ghosts.current.delete(el);
  }, []);
  /** Away it goes: back to the row on a cancel or an illegal drop, settling where it is on a landed drop. */
  const leave = useCallback(
    (g: Gesture, how: "spring" | "settle"): void => {
      const el = g.ghost;
      g.ghost = null;
      if (!el) return;
      if (g.reducedMotion || !el.isConnected) return remove(el);
      const r = how === "spring" && g.rowEl.isConnected ? cssRect(g.rowEl) : null;
      const ms = how === "spring" ? SPRING_MS : 140;
      el.style.transition =
        how === "spring"
          ? `transform ${ms}ms var(--swift), opacity ${ms}ms var(--swift)`
          : `opacity ${ms}ms var(--swift)`;
      if (r) el.style.transform = `translate3d(${r.left + 8}px, ${r.top + 6}px, 0)`;
      el.style.opacity = "0";
      const done = (): void => remove(el);
      el.addEventListener("transitionend", done, { once: true });
      g.win.setTimeout(done, ms + 60);
    },
    [remove],
  );
  return { ghosts, remove, leave };
}

/** A press that may become a drag: a plain press of the main button on a row, never a finger, never a pick. */
function gestureOf(e: PointerLike, rows: string, engine: OhmailEngine): Gesture | null {
  if (e.button !== 0 || e.pointerType === "touch") return null;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return null;
  const rowEl = (e.target as Element | null)?.closest?.<HTMLElement>(rows) ?? null;
  const rowId = rowEl?.dataset.id;
  const win = rowEl?.ownerDocument.defaultView;
  if (!rowEl || !rowId || !win) return null;
  return {
    engine,
    doc: rowEl.ownerDocument,
    win,
    rowEl,
    rowId,
    startX: e.clientX,
    startY: e.clientY,
    source: null,
    dragging: false,
    cancelled: false,
    ghost: null,
    over: null,
    reducedMotion: win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  };
}

/**
 * The gesture, armed on a list's rows (`rows`: where a row carrying `data-id` stands) in the page the list is drawn
 * in. `sourceFor` says what a row's drag stands for (the whole selection where the row is in it; null refuses the
 * drag), `onDrop` is the list's own verb. Both are read at use time.
 */
export function useRailDrag(opts: {
  readonly rows: string;
  readonly page: () => Document | null;
  readonly sourceFor: (rowId: string) => DragSource | null;
  readonly onDrop: (target: RailDropTarget, source: DragSource) => void;
}): void {
  const { engine } = useFrame().host;
  const feed = useDragFeed();
  const latest = useRef({ ...opts, engine });
  latest.current = { ...opts, engine };
  const gestureRef = useRef<Gesture | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const { ghosts, remove, leave } = useGhosts();

  useLayoutEffect(() => {
    const g = gestureRef.current;
    if (g === null || g.engine === engine) return;
    // Hide the old row immediately. Keep the release listener long enough to consume its click.
    g.cancelled = true;
    g.doc.body.classList.remove("dnd-active");
    feed.set(null);
    if (g.ghost !== null) remove(g.ghost);
    g.ghost = null;
  }, [engine, feed, remove]);

  const onPointerDown = useCallback(
    (e: PointerLike): void => {
      const { rows, engine } = latest.current;
      const g = gestureRef.current ? null : gestureOf(e, rows, engine);
      if (g === null) return;
      const { win } = g;
      gestureRef.current = g;
      const light = (over: RailDropTarget | null): void => {
        g.over = over;
        feed.set(g.dragging && !g.cancelled && g.source ? { messages: g.source.messages, over } : null);
      };
      const teardown = (): void => {
        detach.current = null;
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
        win.removeEventListener("pointercancel", onCancel);
        win.removeEventListener("keydown", onKey, true);
        g.doc.body.classList.remove("dnd-active");
        feed.set(null);
        gestureRef.current = null;
      };
      const onMove = (ev: Event): void => {
        const p = ev as unknown as PointerLike;
        if (g.cancelled || g.engine !== latest.current.engine) return;
        if (!g.dragging) {
          if (Math.hypot(p.clientX - g.startX, p.clientY - g.startY) < DRAG_SLOP_PX) return;
          const source = latest.current.sourceFor(g.rowId);
          if (!source || source.ids.length === 0) return teardown();
          g.source = source;
          g.dragging = true;
          g.ghost = buildGhost(g.doc, source);
          ghosts.current.add(g.ghost);
          g.doc.body.appendChild(g.ghost);
          g.doc.body.classList.add("dnd-active");
          light(null);
        }
        /* The ghost is placed in CSS px; the hit test takes the viewport's (`ui-zoom.ts`). */
        const at = cssPoint(p);
        placeGhost(g.ghost!, at.x, at.y);
        const under = elementAt(g.doc, p.clientX, p.clientY);
        const hit = under ? targetOf(under) : null;
        /* A target lights only where the drop is legal: an illegal one stays quiet, the gesture is an offer. */
        const over = hit && dropLegal(hit, g.source!.messages) ? hit : null;
        if ((over === null) !== (g.over === null) || (over && g.over && keyOf(over) !== keyOf(g.over)))
          light(over);
      };
      const onUp = (): void => {
        const { dragging, over, source } = g;
        const cancelled = g.cancelled || g.engine !== latest.current.engine;
        teardown();
        if (!dragging && !cancelled) return; // a plain click; the row's own handler answers it
        suppressNextClick(win);
        if (!cancelled && over && source) {
          leave(g, "settle");
          latest.current.onDrop(over, source);
        } else leave(g, "spring");
      };
      const onCancel = (): void => {
        const el = g.ghost;
        g.ghost = null;
        if (el) remove(el);
        teardown();
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== "Escape" || !g.dragging || g.cancelled) return;
        /* The drag is the innermost open thing: its Escape clears no selection and closes nothing. Capture on the
           window runs before the key registry's own listener. */
        ev.preventDefault();
        ev.stopPropagation();
        g.cancelled = true;
        light(null);
        leave(g, "spring");
      };
      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
      win.addEventListener("pointercancel", onCancel);
      win.addEventListener("keydown", onKey, true);
      detach.current = teardown;
    },
    [feed, ghosts, leave, remove],
  );

  useHeardOnThePage(() => latest.current.page(), onPointerDown);
  useEffect(
    () => () => {
      /* Gone mid-gesture: every trace out of the page at once. */
      detach.current?.();
      for (const el of ghosts.current) el.remove();
      ghosts.current.clear();
    },
    [ghosts],
  );
}

/**
 * The press is heard in the capture phase on the page: the frame's list section is no element of the place's own.
 * The page is known once the list stands, so it is asked again after each render until it answers.
 */
function useHeardOnThePage(page: () => Document | null, onPointerDown: (e: PointerEvent) => void): void {
  const latest = useRef(onPointerDown);
  latest.current = onPointerDown;
  const heard = useRef<{ doc: Document; off: () => void } | null>(null);
  useEffect(() => {
    const doc = page();
    if (doc === null || heard.current?.doc === doc) return;
    heard.current?.off();
    const down = (event: PointerEvent): void => latest.current(event);
    doc.addEventListener("pointerdown", down, true);
    heard.current = { doc, off: () => doc.removeEventListener("pointerdown", down, true) };
  });
  useEffect(
    () => () => {
      heard.current?.off();
      heard.current = null;
    },
    [],
  );
}
