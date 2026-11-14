"use client";

/**
 * THE READ RULE ON A STREAM'S SCROLLER. Listens on the stream's own scroller only (a wheel over the list beside it is
 * no hand), measures the mounted items, asks the rule and writes what it answers. A scroll that no hand made (a row's
 * press, `j`/`k`, a landing) reads nothing by itself; the rest after it may. A jump to an end (End, Home, Ctrl or Cmd
 * with an arrow) is a flight, not a hand: what it carries past is never read. A hidden tab reads nothing.
 */
import { useCallback, useEffect, useRef } from "react";
import { cssPoint, cssRect } from "../geometry/index.js";
import { isTypingTarget } from "../keys/keymap.js";
import { documentHidden } from "../session/document-hidden.js";
import {
  STREAM_REST_MS,
  createStreamReadRule,
  type StreamHand,
  type StreamItemBox,
  type StreamLook,
  type StreamReadRule,
} from "./read-rule.js";
import type { StreamLeaveState } from "./leave.js";

/** The keys that are a hand on the stream. Arrows, `j` and `k` are not: they move the selection. */
const HAND_KEYS = new Set([" ", "PageDown", "PageUp"]);
/** A jump to an end has rested once the scroller has not moved for this long (the web stream's `LANDING_QUIET_MS`). */
export const STREAM_LANDING_QUIET_MS = 150;

/** A key that carries the scroller to an end: End, Home, Ctrl or Cmd with an arrow; never in a field. */
function jumpsToAnEnd(e: KeyboardEvent): boolean {
  if (isTypingTarget(e.target)) return false;
  const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
  return e.key === "End" || e.key === "Home" || ((e.metaKey || e.ctrlKey) && arrow);
}
/** A finger drawn this far, and more up or down than sideways, is a hand on a stream that fits whole. */
const TOUCH_SLOP_PX = 10;

/** What the stream's model knows of an item: whether it is unread and whether its body is in. */
export interface StreamItemFacts {
  readonly unread: boolean;
  readonly ready: boolean;
}

export interface StreamReadDomOptions {
  /** The stream's own scroller, once it is mounted. */
  readonly scroller: HTMLElement | null;
  /** The stream's order, top to bottom. */
  readonly order: readonly string[];
  readonly factsOf: (id: string) => StreamItemFacts | null;
  /** Write these ids read now. */
  readonly write: (ids: readonly string[]) => void;
  /** A jump to an end has rested: the scroller stood still STREAM_LANDING_QUIET_MS after its key. */
  readonly onLanded?: () => void;
  /** The item the stream rests on; by default the one under the reading line that slides with the scroll. */
  readonly restingId?: (look: StreamLook) => string | null;
  /** The clock; the page's by default. */
  readonly now?: () => number;
}

export interface StreamReadDom {
  /** A press in the stream or on a row, an arrow, `j` or `k`. */
  enter(): void;
  keepUnread(id: string): void;
  /** What the leave commits from. */
  leaveState(): StreamLeaveState;
  /** A jump to an end is in flight: from its key until the scroller has rested. */
  flying(): boolean;
  readonly rule: StreamReadRule;
}

/** The item a stream rests on: the line slides from the top of the view at the head to its foot at the end. */
export function restingAt(l: StreamLook): string | null {
  const max = l.scrollHeight - l.viewHeight;
  const q = max > 0 ? l.scrollTop / max : 1;
  const at = l.scrollTop + l.viewHeight * (0.12 + 0.76 * q);
  let id: string | null = null;
  for (const item of l.items) if (id === null || item.top <= at) id = item.id;
  return id;
}

/** Measure the mounted items of the scroller, in the scroller's content px. */
export function measureStream(
  scroller: HTMLElement,
  factsOf: (id: string) => StreamItemFacts | null,
  at: number,
): StreamLook {
  const box = cssRect(scroller);
  const items: StreamItemBox[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-stream-item]")) {
    const id = el.dataset.streamItem;
    const facts = id ? factsOf(id) : null;
    if (!id || !facts) continue;
    const r = cssRect(el);
    items.push({
      id,
      top: r.top - box.top + scroller.scrollTop,
      height: r.height,
      unread: facts.unread,
      ready: facts.ready,
    });
  }
  items.sort((a, b) => a.top - b.top);
  return {
    scrollTop: scroller.scrollTop,
    viewHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    items,
    at,
  };
}

/** The last item whose top stands above the view's foot. */
function bottomOf(l: StreamLook): string | null {
  const foot = l.scrollTop + l.viewHeight;
  let bottom: string | null = null;
  for (const item of l.items) if (item.top < foot) bottom = item.id;
  return bottom;
}

/** A jump to an end in flight: `flag` stands from its key until the scroller has not moved for the landing's quiet. */
function flightOf(flag: { current: boolean }, landed: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      flag.current = false;
      landed();
    }, STREAM_LANDING_QUIET_MS);
  };
  return {
    start(): void {
      flag.current = true;
      arm();
    },
    moved(): void {
      if (flag.current) arm();
    },
    stop(): void {
      clearTimeout(timer);
      flag.current = false;
    },
  };
}

export function useStreamRead(o: StreamReadDomOptions): StreamReadDom {
  const ruleRef = useRef<StreamReadRule | null>(null);
  ruleRef.current ??= createStreamReadRule();
  const rule = ruleRef.current;
  const opts = useRef(o);
  opts.current = o;
  const bottomRef = useRef<string | null>(null);
  const flyingRef = useRef(false);
  const now = (): number => (opts.current.now ?? (() => performance.now()))();

  useEffect(() => {
    const el = o.scroller;
    if (!el) return;
    let restTimer: ReturnType<typeof setTimeout> | undefined;
    let touchFrom: { x: number; y: number } | null = null;
    const measure = (): StreamLook => measureStream(el, opts.current.factsOf, now());
    const write = (ids: readonly string[]): void => {
      if (ids.length > 0) opts.current.write(ids);
    };
    const flight = flightOf(flyingRef, () => opts.current.onLanded?.());
    const rest = (): void => {
      if (documentHidden()) return;
      const l = measure();
      bottomRef.current = bottomOf(l);
      write(rule.rest(l, (opts.current.restingId ?? restingAt)(l)));
    };
    const armRest = (): void => {
      clearTimeout(restTimer);
      restTimer = setTimeout(rest, STREAM_REST_MS);
    };
    const onScroll = (): void => {
      flight.moved();
      const l = measure();
      bottomRef.current = bottomOf(l);
      write(rule.look(l, !documentHidden(), flyingRef.current));
      armRest();
    };
    const still = (by: StreamHand): void => {
      if (documentHidden()) return;
      write(rule.still(measure(), by));
      armRest();
    };
    const onWheel = (e: WheelEvent): void => {
      rule.hand("wheel", now());
      if (e.deltaY !== 0) still("wheel");
    };
    const onTouchStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      touchFrom = t ? cssPoint(t) : null;
      rule.hand("touch", now(), true);
    };
    const onTouchMove = (e: TouchEvent): void => {
      rule.hand("touch", now(), true);
      const t = e.touches[0];
      if (!t || !touchFrom) return;
      /* The finger's travel in CSS px, as the slop is: under the Text size a viewport read is off by its zoom. */
      const at = cssPoint(t);
      const dy = Math.abs(at.y - touchFrom.y);
      if (dy > TOUCH_SLOP_PX && dy > Math.abs(at.x - touchFrom.x)) still("touch");
    };
    const onTouchEnd = (): void => {
      touchFrom = null;
      rule.hand("touch", now(), false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (jumpsToAnEnd(e)) {
        /* It drives the stream, and its scroll is no hand's: nothing it carries past is read. */
        flight.start();
        rule.enter(now());
        return;
      }
      if (!HAND_KEYS.has(e.key)) return;
      rule.hand("key", now());
      still("key");
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("keydown", onKey);
    /* What stands in view at the opening is seen; nothing is read by it. */
    const first = measure();
    bottomRef.current = bottomOf(first);
    rule.look(first, !documentHidden(), false);
    return () => {
      clearTimeout(restTimer);
      flight.stop();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("keydown", onKey);
    };
    /* The options are read through the ref; a new scroller is listened on afresh. */
  }, [o.scroller, rule]);

  const enter = useCallback(() => {
    rule.enter(now());
  }, [rule]);
  const keepUnread = useCallback((id: string) => rule.keepUnread(id), [rule]);
  const leaveState = useCallback((): StreamLeaveState => {
    const newest = opts.current.order.find((id) => rule.shown(id)) ?? null;
    return {
      drove: rule.driven,
      newestSeenId: newest,
      bottomVisibleId: bottomRef.current,
      read: (id) => rule.read(id),
    };
  }, [rule]);
  const flying = useCallback(() => flyingRef.current, []);
  return { enter, keepUnread, leaveState, flying, rule };
}
