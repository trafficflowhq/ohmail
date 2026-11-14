"use client";

import { useEffect, useRef, type RefObject } from "react";
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";
import { SCROLL_KEYS, cssRect } from "@ohmail/ui";
import { scrollProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { viewOf } from "@ohmail/app-logic/reading/reader-seen";

/**
 * THE REPLY YOU SENT, BROUGHT INTO VIEW. A send pressed in the reader's editor arms it; once the
 * editor has closed and the sent copy has joined the conversation at its foot, and the layout has
 * stood still for {@link REVEAL_QUIET_MS} (its body landed, the dock gone), one eased scroll puts the
 * copy's bottom on screen above the bar, or its top where it is taller than the view. Nothing moves
 * when it is already wholly on screen, when the person scrolled since the press, or past
 * {@link REVEAL_WINDOW_MS}; any scroll input of theirs ends the motion at once, and reduced motion
 * makes it one instant move. Every frame is the app's own stamped scroll (`programmatic-scroll.ts`),
 * which the read rule never takes for the person's, and the motion is shorter than the rule's dwell,
 * so nothing it passes turns read.
 */

export const REVEAL_MARGIN_PX = 16;
export const REVEAL_MIN_MS = 250;
export const REVEAL_MAX_MS = 450;
/** The layout stood still this long: the editor closed, the copy drawn at its height. */
export const REVEAL_QUIET_MS = 120;
/** A copy whose body is still landing is revealed this long after it joined, at the latest. */
export const REVEAL_SETTLE_CAP_MS = 1500;
/** A send confirmed later than this after its press moves nothing. */
export const REVEAL_WINDOW_MS = 60_000;

/** The reveal's clock and frames; tests drive them by hand. */
export const revealClock = {
  now: (): number => Date.now(),
  frame: (run: () => void): (() => void) => {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  },
  after: (ms: number, run: () => void): (() => void) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  },
};

/** A reply (or inline forward) to this message pressed: the shell's one send door says so, whatever pressed it. */
const pressNotes = new Set<(messageId: string) => void>();
export function noteReplyPress(messageId: string): void {
  for (const run of [...pressNotes]) run(messageId);
}
export function onReplyPress(run: (messageId: string) => void): () => void {
  pressNotes.add(run);
  return () => { pressNotes.delete(run); };
}

type Box = { top: number; bottom: number };

/** Where the scroller should stand to show `box` within `view`, or `null` when it already shows it. */
export function revealTop(view: Box, box: Box, scrollTop: number, maxTop: number, margin = REVEAL_MARGIN_PX): number | null {
  if (box.top >= view.top && box.bottom <= view.bottom) return null;
  const tall = box.bottom - box.top + 2 * margin > view.bottom - view.top;
  const delta = tall ? box.top - view.top - margin : box.bottom - view.bottom + margin;
  const to = Math.max(0, Math.min(maxTop, scrollTop + delta));
  return Math.abs(to - scrollTop) < 1 ? null : to;
}

/** Short, longer with the distance, capped. */
export function revealDuration(distance: number): number {
  return Math.round(Math.min(REVEAL_MAX_MS, REVEAL_MIN_MS + Math.abs(distance) / 4));
}

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** The person's own scroll input: a wheel, a touch, a scroll key outside a field, a press on the scrollbar. */
export function handScroll(e: Event, scroller: Element): boolean {
  if (e.type === "wheel" || e.type === "touchstart" || e.type === "touchmove") return true;
  if (e.type === "keydown") {
    const k = e as KeyboardEvent;
    return SCROLL_KEYS.has(k.key) && !editable(k.target) && !k.ctrlKey && !k.metaKey && !k.altKey;
  }
  return e.type === "pointerdown" && e.target === scroller;
}
const HAND = ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"] as const;

/** Listen for the person's scroll input on the window, before anything can stop it. */
function onHand(scroller: Element, run: () => void): () => void {
  const win = scroller.ownerDocument.defaultView;
  if (!win) return () => {};
  const h = (e: Event): void => { if (handScroll(e, scroller)) run(); };
  for (const ev of HAND) win.addEventListener(ev, h, { capture: true, passive: true });
  return () => { for (const ev of HAND) win.removeEventListener(ev, h, true); };
}

export function prefersReducedMotion(win: Window | null): boolean {
  return win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Ease `scroller` to `to`. Ends at once on the person's scroll input or a scroll that is not this
 * one (the scroller found away from the last frame's place). Returns the stop.
 */
export function easeScroll(scroller: HTMLElement, to: number): () => void {
  const from = scroller.scrollTop;
  if (prefersReducedMotion(scroller.ownerDocument.defaultView)) {
    scrollProgrammatically(scroller, to);
    return () => {};
  }
  const ms = revealDuration(to - from);
  const t0 = revealClock.now();
  let last = from;
  let live = true;
  let pending: (() => void) | null = null;
  const stop = (): void => {
    if (!live) return;
    live = false;
    pending?.();
    off();
  };
  const step = (): void => {
    pending = null;
    if (!live) return;
    if (Math.abs(scroller.scrollTop - last) > 1) { stop(); return; }
    const p = Math.min(1, (revealClock.now() - t0) / ms);
    scrollProgrammatically(scroller, from + (to - from) * easeOutCubic(p));
    last = scroller.scrollTop;
    if (p >= 1) stop();
    else pending = revealClock.frame(step);
  };
  const off = onHand(scroller, stop);
  pending = revealClock.frame(step);
  return stop;
}

/** Show `el` in `scroller` (above its sticky bar and dock); `null` when nothing needs to move. */
export function revealIn(scroller: HTMLElement, el: Element): (() => void) | null {
  const view = viewOf(scroller);
  const r = cssRect(el);
  const to = revealTop(view, { top: r.top, bottom: r.bottom }, scroller.scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  return to === null ? null : easeScroll(scroller, to);
}

function scrollerOf(el: Element | null): HTMLElement | null {
  const win = el?.ownerDocument.defaultView;
  for (let a = el?.parentElement ?? null; a && win; a = a.parentElement) {
    if (/(auto|scroll|overlay)/.test(win.getComputedStyle(a).overflowY)) return a;
  }
  return null;
}

/** A pane mounted this soon after the one holding the press left takes it up: a remount, not a reader closed and opened again. */
export const REVEAL_REMOUNT_MS = 1000;

type Press = { visit: string; at: number; known: Set<string>; leftAt: number | null };
/** The last press, kept outside the pane so a remount of it picks the press up again. */
let lastPress: Press | null = null;
/** `lastPress` while it still owes its reveal. */
let owed: Press | null = null;

const within = (t: number, ms: number): boolean => {
  const d = revealClock.now() - t;
  return d >= 0 && d <= ms;
};
/** The last press, when a pane of `visit` takes over from the one that held it, inside the window. */
function carried(visit: string): Press | null {
  const p = lastPress;
  return p && p.visit === visit && within(p.at, REVEAL_WINDOW_MS) && (p.leftAt === null || within(p.leftAt, REVEAL_REMOUNT_MS)) ? p : null;
}

export interface SentReveal {
  /** This visit's own reply has joined: the pane's open anchor stands down for it, moved or not. */
  claims: () => boolean;
}

/**
 * The pane's reveal, armed by {@link noteReplyPress} for a message it draws while its editor is open.
 * `members` is what the pane draws (the conversation, or the lone letter); `pane` the element they are in.
 * The press holds until a copy is drawn, within {@link REVEAL_WINDOW_MS}: through the provisional copy giving way
 * to the mirror's row under another id, and through a remount of the pane.
 */
export function useSentReveal(o: {
  /** The visit: another message shown drops whatever was owed. */
  visit: string;
  members: readonly EngineMessage[];
  replying: boolean;
  enabled: boolean;
  pane: () => HTMLElement | null;
  scroller?: RefObject<HTMLElement | null>;
}): SentReveal {
  const members = useRef(o.members);
  members.current = o.members;
  const pane = useRef(o.pane);
  pane.current = o.pane;
  const visit = useRef(o.visit);
  visit.current = o.visit;
  const replying = useRef(o.replying && o.enabled);
  replying.current = o.replying && o.enabled;
  /** The members at the last press, kept for the whole visit: a scroll or the window ends the motion, not the claim. */
  const pressed = useRef<{ visit: string; known: Set<string> } | null>(null);
  pressed.current ??= carried(o.visit);
  const armed = useRef<{ at: number; off: () => void } | null>(null);
  /** The settle wait or the motion under way. */
  const running = useRef<(() => void) | null>(null);
  const scrollerNow = (): HTMLElement | null => o.scroller?.current ?? scrollerOf(pane.current());

  const stand = (): void => {
    armed.current?.off();
    armed.current = null;
    running.current?.();
    running.current = null;
  };
  const disarm = (): void => {
    stand();
    owed = null;
  };
  const arm = (at: number): void => {
    const sc = scrollerNow();
    armed.current = { at, off: sc ? onHand(sc, disarm) : () => {} };
  };
  const ownReply = (): EngineMessage | null => {
    const a = pressed.current;
    // Read in the commit that shows another message too, before the visit's cleanup drops it.
    if (!a || a.visit !== visit.current) return null;
    for (let i = members.current.length - 1; i >= 0; i--) {
      const m = members.current[i]!;
      if (!a.known.has(m.id) && isOwnOutbound(m)) return m;
    }
    return null;
  };
  const sentCopy = (): EngineMessage | null => (armed.current ? ownReply() : null);
  const api = useRef<SentReveal | null>(null);
  api.current ??= { claims: () => ownReply() !== null };
  /* A send pressed for a message this pane draws, its editor open: whichever door pressed it. */
  useEffect(() => onReplyPress((id) => {
    if (!replying.current || !members.current.some((m) => m.id === id)) return;
    disarm();
    owed = lastPress = { visit: visit.current, at: revealClock.now(), known: new Set(members.current.map((m) => m.id)), leftAt: null };
    pressed.current = owed;
    arm(owed.at);
  }), []);
  /* A pane remounted on its visit takes the press up (and the reveal, while owed); any other open drops it. */
  useEffect(() => {
    if (!o.enabled) return;
    const p = carried(o.visit);
    pressed.current = p;
    if (!p) { lastPress = owed = null; return; }
    p.leftAt = null;
    if (owed === p && !armed.current) arm(p.at);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.visit]);

  /* After every commit: once the editor is closed and the copy is drawn, wait for the layout to stand. */
  useEffect(() => {
    const a = armed.current;
    if (!a || running.current) return;
    if (!o.enabled || revealClock.now() - a.at > REVEAL_WINDOW_MS) { disarm(); return; }
    if (o.replying) return;
    if (!sentCopy()) return;
    let joined = revealClock.now();
    let copyId: string | null = null;
    let quiet: (() => void) | null = null;
    // The copy as it stands now: the provisional one gives way to the mirror's row under another id.
    const find = (): HTMLElement | null => {
      const id = sentCopy()?.id ?? null;
      if (id !== copyId) { copyId = id; joined = revealClock.now(); }
      return [...pane.current()?.querySelectorAll<HTMLElement>("[data-conv-id]") ?? []].find((el) => el.dataset.convId === id) ?? null;
    };
    // A layout still moving past the cap no longer holds the reveal back.
    const observed = typeof ResizeObserver === "undefined" ? null
      : new ResizeObserver(() => { if (revealClock.now() - joined < REVEAL_SETTLE_CAP_MS) wait(); });
    const stopWaiting = (): void => { quiet?.(); quiet = null; observed?.disconnect(); };
    const wait = (): void => {
      quiet?.();
      quiet = revealClock.after(REVEAL_QUIET_MS, () => {
        quiet = null;
        const el = find();
        const late = revealClock.now() - joined >= REVEAL_SETTLE_CAP_MS;
        if (!el || (!el.hasAttribute("data-body-ready") && !late)) {
          // Not drawn: the reveal stays armed, and the next commit that draws a copy starts the wait again.
          if (!el && (late || copyId === null)) { stopWaiting(); running.current = null; }
          else wait();
          return;
        }
        stopWaiting();
        const sc = scrollerNow();
        armed.current?.off();
        armed.current = null;
        owed = null;
        running.current = sc ? revealIn(sc, el) : null;
      });
    };
    const p = pane.current();
    if (p) observed?.observe(p);
    const el = find();
    if (el) observed?.observe(el);
    running.current = stopWaiting;
    wait();
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    stand();
    if (lastPress && pressed.current === lastPress) lastPress.leftAt = revealClock.now();
    pressed.current = null;
  }, [o.visit]);
  return api.current;
}
