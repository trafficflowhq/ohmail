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
  pullEnd,
  pullMove,
  pullStart,
  swipeDrawn,
  swipeEnd,
  swipeMove,
  swipeStart,
  type SwipeSides,
  type SwipeTrack,
  type PullTrack,
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
  /** How far the list is drawn down by a claimed pull, in px, or null between gestures. */
  pullOf(): number | null;
  /** How many releases have pulled: each one holds the spinner while the pull it asked for runs. */
  askedOf(): number;
  subscribe(changed: () => void): () => void;
  /** The verbs at a row's sides, by the row's id (its `data-id`). */
  sides(id: string, sides: RowSides): () => void;
  /** Listen on the list's scroller; the returned call takes every listener and the mark away. */
  attach(scroller: HTMLElement, live: () => ListLive, enabled: { swipe: boolean; pull: boolean }): () => void;
}

/** A press on a control inside a row is the control's, never the start of a swipe. */
const CONTROLS = "button, a, input, textarea, select, [data-press]";
const PULL_CONTROLS = `${CONTROLS}, [role=button], [role=menuitem], [contenteditable]`;
const MARK = "data-touch-list";
const PULL_MARK = "data-pull-list";
const AT_TOP = "data-pull-at-top";

interface Swiping {
  readonly id: string;
  readonly pointer: number;
  /** Where the finger came down, in the page's px: the travel is measured from here. */
  readonly at: number;
  readonly has: SwipeSides;
  track: SwipeTrack;
}

interface Pulling {
  readonly finger: number;
  track: PullTrack;
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
  pull(down: number | null): void;
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
      if (live().off || press.pulling?.track.claimed) {
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
  return [
    ["pointerdown", down, PASSIVE],
    ["pointermove", move, PASSIVE],
    ["pointerup", (event: PointerEvent) => up(event, false), PASSIVE],
    ["pointercancel", (event: PointerEvent) => up(event, true), PASSIVE],
  ];
}

/** A pull at the list's top, read from touch events on the scroller: only they can keep the browser from panning. */
function pullListeners(scroller: HTMLElement, press: Press, drawn: Drawn, live: () => ListLive): Listen[] {
  const atTop = () => scroller.scrollTop <= 0;
  const syncTop = () => scroller.toggleAttribute(AT_TOP, atTop());
  const end = (cancelled: boolean) => {
    const p = press.pulling;
    press.pulling = null;
    if (!p) return;
    const now = live().pull;
    const outcome = pullEnd(p.track, cancelled || now === NONE, now !== NONE && now.busy);
    if (!outcome.claimed) return;
    drawn.pull(null);
    if (!cancelled) swallowRelease(scroller, press);
    if (outcome.hold) drawn.asked();
    if (outcome.run && now !== NONE) now.run();
  };
  const start = (event: TouchEvent) => {
    end(true);
    const finger = event.touches[0];
    const target = event.target as Element | null;
    if (!finger || event.touches.length !== 1 || live().off || target?.closest(PULL_CONTROLS)) return;
    const track = pullStart(finger.clientX, finger.clientY, atTop());
    if (track) press.pulling = { finger: finger.identifier, track };
  };
  const move = (event: TouchEvent) => {
    const p = press.pulling;
    if (!p) return;
    const finger = event.touches[0];
    if (
      !finger ||
      finger.identifier !== p.finger ||
      event.touches.length !== 1 ||
      event.defaultPrevented ||
      !event.cancelable ||
      live().off ||
      press.swiping?.track.claimed
    ) {
      end(true);
      return;
    }
    const track = pullMove(p.track, finger.clientX, finger.clientY, atTop());
    if (!track) {
      end(true);
      return;
    }
    p.track = track;
    if (track.claimed) {
      event.preventDefault();
      drawn.pull(track.offset);
    }
  };
  const release = (event: TouchEvent) => {
    const p = press.pulling;
    const finger = event.changedTouches?.[0];
    if (p?.track.claimed && finger?.identifier === p.finger) {
      p.track = pullMove(p.track, finger.clientX, finger.clientY, atTop()) ?? p.track;
    }
    end(false);
  };
  syncTop();
  return [
    ["scroll", syncTop, PASSIVE],
    ["touchstart", start, PASSIVE],
    ["touchmove", move, { capture: true, passive: false }],
    ["touchend", release, PASSIVE],
    ["touchcancel", () => end(true), PASSIVE],
  ];
}

export function createListTouch(): ListTouchStore {
  const told = new Set<() => void>();
  const verbs = new Map<string, RowSides>();
  let pulled: { id: string; dx: number } | null = null;
  let pull: number | null = null;
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
    attach(scroller, live, enabled) {
      const press: Press = { swiping: null, pulling: null, swallow: false };
      const click = (event: MouseEvent) => {
        if (!press.swallow) return;
        press.swallow = false;
        event.preventDefault();
        event.stopPropagation();
      };
      const listens: Listen[] = [
        ["click", click, { capture: true }],
        ...(enabled.swipe ? swipeListeners(scroller, press, drawn, live) : []),
        ...(enabled.pull ? pullListeners(scroller, press, drawn, live) : []),
      ];
      if (enabled.swipe) scroller.setAttribute(MARK, "");
      if (enabled.pull) scroller.setAttribute(PULL_MARK, "");
      for (const [type, listener, options] of listens)
        scroller.addEventListener(type, listener as EventListener, options);
      return () => {
        scroller.removeAttribute(MARK);
        scroller.removeAttribute(PULL_MARK);
        scroller.removeAttribute(AT_TOP);
        for (const [type, listener, options] of listens)
          scroller.removeEventListener(type, listener as EventListener, options);
        drawn.row(null);
        drawn.pull(null);
      };
    },
  };
}
