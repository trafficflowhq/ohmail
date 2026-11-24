/**
 * ONE LIST UNDER A FINGER: which row is pulled and how far, the verbs at each row's sides, and how far the list is
 * pulled down at its top. The listeners stand on the list's own scroller, never on a row, so a row stays the kit's
 * and the arithmetic stays one copy (`@ohmail/app-logic/touch`).
 *
 * A swipe is read from pointer events: the browser's vertical pan is left alone (`touch-action: pan-y`), and the
 * row is the finger's only once the phone's claim holds. A pull is read from touch events, the one way a list at its
 * top can keep the browser from scrolling or bouncing: a pointer is cancelled the moment the browser pans.
 */
import { cssPoint } from "@ohmail/app-logic/geometry";
import {
  pullClaims,
  pullFires,
  pullOffset,
  swipeDrawn,
  swipeEnd,
  swipeMove,
  swipeStart,
  type SwipeSides,
  type SwipeTrack,
} from "@ohmail/app-logic/touch";
import { startsAtDrawerEdge } from "../frame/rail-gesture.js";
import { NONE, type None } from "../host/index.js";
import type { ListPull, RowSides } from "./contract.js";

/** What the layer reads at the moment it decides, never earlier. */
export interface ListLive {
  readonly off: boolean;
  readonly pull: ListPull | None;
}

export interface ListTouchStore {
  /** How far the row `id` is drawn now, in px; 0 at rest. */
  pulledOf(id: string): number;
  /** How far the list is drawn down by a pull, in px. */
  pullOf(): number;
  /** How many releases have pulled: each one holds the spinner while the pull it asked for runs. */
  askedOf(): number;
  subscribe(changed: () => void): () => void;
  /** The verbs at a row's sides, by the row's id (its `data-id`). */
  sides(id: string, sides: RowSides): () => void;
  /** Listen on the list's scroller; the returned call takes every listener and the mark away. */
  attach(scroller: HTMLElement, live: () => ListLive, pull: boolean): () => void;
}

/** A press on a control inside a row is the control's, never the start of a swipe. */
const CONTROLS = "button, a, input, textarea, select, [data-press]";
const MARK = "data-touch-list";

interface Swiping {
  readonly id: string;
  readonly pointer: number;
  /** Where the finger came down, in the page's px: the travel is measured from here. */
  readonly at: number;
  readonly has: SwipeSides;
  track: SwipeTrack;
}

interface Pulling {
  readonly x: number;
  readonly y: number;
  claimed: boolean;
  dy: number;
}

/** One press on the list, as both gestures see it: one may claim it, never both. */
interface Press {
  swiping: Swiping | null;
  pulling: Pulling | null;
  /** The click that closes a claimed press is no tap. Bounded to that release: a frame later it is gone. */
  swallow: boolean;
}

/** Eat the click of this release only: a click with no press before it (a screen reader's, a key's) still acts. */
function swallowRelease(scroller: HTMLElement, press: Press): void {
  press.swallow = true;
  scroller.ownerDocument.defaultView?.requestAnimationFrame(() => {
    press.swallow = false;
  });
}

/** What the listeners tell the store. */
interface Drawn {
  row(next: { id: string; dx: number } | null): void;
  pull(down: number): void;
  /** A release past the mark: the spinner holds, whether this release starts the pull or one already runs. */
  asked(): void;
  verbs(id: string): RowSides | undefined;
}

type Listen = [type: string, listener: (event: never) => void, options: AddEventListenerOptions];
const PASSIVE = { capture: true, passive: true } as const;

/** A row's swipe, read from pointer events on the scroller. */
function swipeListeners(scroller: HTMLElement, press: Press, drawn: Drawn, live: () => ListLive): Listen[] {
  const down = (event: PointerEvent) => {
    /* A second finger ends the swipe in flight: nothing is pressed and the row goes back. */
    if (press.swiping) {
      press.swiping = null;
      drawn.row(null);
    }
    press.swallow = false;
    press.swiping = null;
    if (event.pointerType !== "touch") return;
    const target = event.target as Element | null;
    if (!target || target.closest(CONTROLS)) return;
    const row = target.closest<HTMLElement>("[data-id]");
    const id = row && scroller.contains(row) ? row.dataset.id : undefined;
    const sides = id === undefined ? undefined : drawn.verbs(id);
    if (id === undefined || !sides) return;
    const has = {
      right: Boolean(sides.right) && !startsAtDrawerEdge(target, event.clientX),
      left: Boolean(sides.left),
    };
    if (!has.right && !has.left) return;
    press.swiping = {
      id,
      pointer: event.pointerId,
      at: cssPoint(event).x,
      has,
      track: swipeStart(event.clientX, event.clientY),
    };
  };
  const move = (event: PointerEvent) => {
    const s = press.swiping;
    if (!s || event.pointerId !== s.pointer) return;
    const was = s.track.claimed;
    s.track = swipeMove(s.track, event.clientX, event.clientY, cssPoint(event).x - s.at);
    if (!s.track.claimed) return;
    if (!was) {
      /* A selection standing, or a pull under way: the row is not the finger's after all. */
      if (live().off || press.pulling?.claimed) {
        press.swiping = null;
        return;
      }
      press.pulling = null;
      try {
        scroller.setPointerCapture(event.pointerId);
      } catch {
        /* A pointer the browser already let go of: the moves still reach the list. */
      }
    }
    drawn.row({ id: s.id, dx: swipeDrawn(s.track, s.has) });
  };
  const up = (event: PointerEvent, cancelled: boolean) => {
    const s = press.swiping;
    if (!s || event.pointerId !== s.pointer) return;
    if (s.track.claimed && !cancelled) swallowRelease(scroller, press);
    const verb = swipeEnd(s.track, cancelled, s.has);
    press.swiping = null;
    drawn.row(null);
    if (verb !== null) drawn.verbs(s.id)?.[verb]?.press();
  };
  const click = (event: MouseEvent) => {
    if (!press.swallow) return;
    press.swallow = false;
    event.preventDefault();
    event.stopPropagation();
  };
  return [
    ["pointerdown", down, PASSIVE],
    ["pointermove", move, PASSIVE],
    ["pointerup", (event: PointerEvent) => up(event, false), PASSIVE],
    ["pointercancel", (event: PointerEvent) => up(event, true), PASSIVE],
    ["click", click, { capture: true }],
  ];
}

/** A pull at the list's top, read from touch events on the scroller: only they can keep the browser from panning. */
function pullListeners(scroller: HTMLElement, press: Press, drawn: Drawn, live: () => ListLive): Listen[] {
  const start = (event: TouchEvent) => {
    if (press.pulling?.claimed) drawn.pull(0);
    press.pulling = null;
    const finger = event.touches[0];
    if (!finger || event.touches.length > 1 || scroller.scrollTop > 0) return;
    press.pulling = { x: finger.clientX, y: finger.clientY, claimed: false, dy: 0 };
  };
  const move = (event: TouchEvent) => {
    const p = press.pulling;
    const finger = event.touches[0];
    if (!p || !finger) return;
    const dx = finger.clientX - p.x;
    const dy = finger.clientY - p.y;
    if (!p.claimed) {
      if (press.swiping?.track.claimed || scroller.scrollTop > 0) {
        press.pulling = null;
        return;
      }
      if (!pullClaims(dx, dy)) return;
      p.claimed = true;
    }
    event.preventDefault();
    p.dy = dy;
    drawn.pull(pullOffset(dy));
  };
  const end = (cancelled: boolean) => {
    const p = press.pulling;
    press.pulling = null;
    if (!p?.claimed) return;
    drawn.pull(0);
    if (!cancelled) swallowRelease(scroller, press);
    const now = live().pull;
    if (cancelled || now === NONE || !pullFires(p.dy)) return;
    drawn.asked();
    /* One pull at a time: a release while one runs only holds the spinner for it. */
    if (!now.busy) now.run();
  };
  return [
    ["touchstart", start, PASSIVE],
    ["touchmove", move, { capture: true, passive: false }],
    ["touchend", () => end(false), PASSIVE],
    ["touchcancel", () => end(true), PASSIVE],
  ];
}

export function createListTouch(): ListTouchStore {
  const told = new Set<() => void>();
  const verbs = new Map<string, RowSides>();
  let pulled: { id: string; dx: number } | null = null;
  let pull = 0;
  let asked = 0;
  const tell = () => {
    for (const changed of [...told]) changed();
  };
  const drawn: Drawn = {
    row(next) {
      if (next?.id === pulled?.id && next?.dx === pulled?.dx) return;
      pulled = next;
      tell();
    },
    pull(down) {
      if (down === pull) return;
      pull = down;
      tell();
    },
    asked() {
      asked += 1;
      tell();
    },
    verbs: (id) => verbs.get(id),
  };

  return {
    pulledOf: (id) => (pulled?.id === id ? pulled.dx : 0),
    pullOf: () => pull,
    askedOf: () => asked,
    subscribe(changed) {
      told.add(changed);
      return () => told.delete(changed);
    },
    sides(id, sides) {
      verbs.set(id, sides);
      return () => {
        if (verbs.get(id) === sides) verbs.delete(id);
      };
    },
    attach(scroller, live, withPull) {
      const press: Press = { swiping: null, pulling: null, swallow: false };
      const listens = [
        ...swipeListeners(scroller, press, drawn, live),
        ...(withPull ? pullListeners(scroller, press, drawn, live) : []),
      ];
      scroller.setAttribute(MARK, "");
      for (const [type, listener, options] of listens)
        scroller.addEventListener(type, listener as EventListener, options);
      return () => {
        scroller.removeAttribute(MARK);
        for (const [type, listener, options] of listens)
          scroller.removeEventListener(type, listener as EventListener, options);
        drawn.row(null);
        drawn.pull(0);
      };
    },
  };
}
