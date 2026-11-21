"use client";

/**
 * A STREAM'S SCROLL, CARRIED OVER: the landing, the anchor hold, the scroll-spy and the leave range of the web shell's
 * `StreamShell`, line for line, with the card's names as an argument and none of its read code (what a stream reads is
 * `read-rule.ts`'s). A twin holds the two equal over one sequence (`apps/webapp/test/stream-scroll-twin.test.tsx`)
 * until the old stream leaves; a change to one is made to the other in the same change.
 *
 * - The landing (`scrollTo`, `stream-scroll-land.ts`).
 * - The anchor hold (`stream-scroll-hold.ts`).
 * - The spy: the current card is the last one whose top is at or above the reading line, the last one at the end;
 *   a jump in flight and a held cursor stand it down.
 * - The leave range: the newest card displayed this visit and the last one on screen, judged in the pile's order; a
 *   move that skips cards starts a new run.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useVisit } from "../lists/visit.js";
import { cssRect } from "../geometry/index.js";
import {
  StreamScrollCore,
  type StreamCardNames,
  type StreamRange,
  type StreamScrollSeam,
} from "./stream-scroll-core.js";
import { attachHold } from "./stream-scroll-hold.js";
import { landOn } from "./stream-scroll-land.js";

export type { StreamCardNames, StreamRange, StreamScrollSeam } from "./stream-scroll-core.js";
export { STREAM_HOLD_QUIET_MS } from "./stream-scroll-hold.js";

/**
 * The keys that move a stream by hand; a change in their count means the person took the pane. The arrows are not
 * among them here: in a place they step the stream as `j` and `k` do, and a held arrow's repeat must not cut its own
 * step's landing short (the web shell's stream still counts them).
 */
const HAND_KEYS = new Set([" ", "PageDown", "PageUp", "Home", "End"]);

export interface StreamScrollOptions {
  readonly scroller: HTMLElement | null;
  readonly card: StreamCardNames;
  /** Changes re-read the mounted cards. */
  readonly contentKey: unknown;
  /** The view's cursor: one this stream did not announce itself was put there by the person, and is held. */
  readonly cursor?: string | null;
  readonly onCurrentChange: (id: string, byHand?: boolean) => void;
  /** The view's order over the whole pile (`-1` for an id it does not hold). */
  readonly pileIndexOf?: (id: string) => number;
  readonly seam?: StreamScrollSeam;
}

export interface StreamScroll {
  /** Bring one card to the reading line and keep it there until it IS there; `onLanded` once, when it is. */
  scrollTo(id: string, onLanded?: () => void): void;
  /** Is this card in the port right now? */
  onScreen(id: string): boolean;
  settledInReadView(id: string): boolean;
  settledCursorInReadView(id: string): boolean;
  /** Call `cb` once, on the first scroll frame this card is out of the port or unmounted. */
  whenOffScreen(id: string, cb: () => void): void;
  /** An answered card is about to shrink: hold its own top; `land`, and bring its head to the line if it is above. */
  hold(id: string, land?: boolean): void;
  /** Reveal the end of the open editor's card and follow growth while it stays at the foot. */
  revealEnd(id: string, card: HTMLElement): () => void;
  /** A card is about to open or close (its own press, before the commit). */
  toggled(sid: string, open: boolean): void;
  /** The leave's range, read off the state alone. */
  range(): StreamRange;
  /** The previous address's range stops following the cursor. */
  resetRange(): void;
  /** The seam's jump to an end has rested. */
  endLanded(): void;
  /** The seam's judged scroll has ended. */
  judged(): void;
  /** A window committed a fresh set of cards at the current scroll position. */
  windowChanged(): void;
  /** A far landing or displaced anchor has no stable viewport to read. */
  readingBlocked(): boolean;
}

/** The handle over one core: stable for the core's life. */
function handleOf(core: StreamScrollCore): StreamScroll {
  const scrollTo = (id: string, onLanded?: () => void): void => landOn(core, id, onLanded);
  return {
    scrollTo,
    onScreen: (id) => core.inPort(id),
    settledInReadView: (id) => core.settledInReadView(id),
    settledCursorInReadView: (id) => core.cur === id && core.settledInReadView(id),
    whenOffScreen: (id, cb) => {
      core.offScreen.set(id, cb);
    },
    hold: (id, land = false) => {
      const el = core.el;
      const item = el ? core.one(el, id) : null;
      if (!el || !item || core.cur !== id) return;
      core.toggledFn(id, true);
      if (land && cssRect(item).top < cssRect(el).top - 0.5) core.own(() => scrollTo(id));
    },
    revealEnd: (id, card) => {
      const el = core.el;
      if (!el || !el.contains(card)) return () => {};
      const below = () => cssRect(card).bottom - cssRect(el).bottom;
      const toEnd = (distance: number) => {
        if (distance <= 0.5) return;
        core.toggledFn(id, true);
        core.moved();
        core.own(() => el.scrollTo({ top: el.scrollTop + distance, behavior: "instant" }));
      };
      toEnd(below());
      const Observer = el.ownerDocument.defaultView?.ResizeObserver;
      if (!Observer) return () => {};
      let height = cssRect(card).height;
      const observer = new Observer(() => {
        const next = cssRect(card).height;
        const grew = next - height;
        const distance = below();
        height = next;
        if (distance > 0.5 && distance <= grew + 2) toEnd(distance);
      });
      const away = () => {
        if (Math.abs(below()) > 2) release();
      };
      const release = () => {
        observer.disconnect();
        el.removeEventListener("scroll", away);
      };
      observer.observe(card);
      el.addEventListener("scroll", away, { passive: true });
      return release;
    },
    toggled: (sid, open) => {
      // The card the person opened is the reading, and the cursor.
      if (open) {
        core.pin(sid);
        if (cursorOf.get(core) !== sid) core.inputs.onCurrentChange(sid);
      }
      core.toggledFn(sid, open);
    },
    range: () => ({ ...core.range }),
    resetRange: () => core.resetRange(),
    endLanded: () => core.endLanded(),
    judged: () => core.judged(),
    windowChanged: () => core.respy(),
    readingBlocked: () => core.landing || core.pendingShift() !== 0,
  };
}
/** The view's cursor as last rendered, per core (`cur` can differ: a quiet reading, a cursor cleared by Back). */
const cursorOf = new WeakMap<StreamScrollCore, string | null | undefined>();

/** Hands counted on the scroller itself, where the seam does not count them. */
function countHands(core: StreamScrollCore, el: HTMLElement): () => void {
  const hand = (): void => {
    core.ownHands += 1;
  };
  const key = (e: KeyboardEvent): void => {
    if (HAND_KEYS.has(e.key)) hand();
  };
  el.addEventListener("wheel", hand, { passive: true });
  el.addEventListener("touchstart", hand, { passive: true });
  el.addEventListener("keydown", key);
  return () => {
    el.removeEventListener("wheel", hand);
    el.removeEventListener("touchstart", hand);
    el.removeEventListener("keydown", key);
  };
}

export function useStreamScroll(o: StreamScrollOptions): StreamScroll {
  const coreRef = useRef<StreamScrollCore | null>(null);
  coreRef.current ??= new StreamScrollCore(o);
  const core = coreRef.current;
  core.inputs = o;
  core.el = o.scroller;
  cursorOf.set(core, o.cursor);
  const handleRef = useRef<StreamScroll | null>(null);
  handleRef.current ??= handleOf(core);

  useVisit(
    () => core.visitStart(),
    () => {},
  );
  useEffect(() => {
    // The cards a held reading waited for: read a frame later, after any jump this commit carries has begun.
    if (core.owed) core.respy();
  }, [core, o.contentKey]);
  useEffect(() => {
    core.measure();
    // A slide of the window can unmount a card somebody is waiting on.
    core.settleOffScreen();
  });
  /** An anchoring loop must not outlive the stream it is scrolling. */
  useEffect(
    () => () => {
      if (core.anchor) cancelAnimationFrame(core.anchor);
      core.anchor = 0;
      core.offScreen.clear();
    },
    [core],
  );
  useLayoutEffect(() => {
    if (o.cursor == null) core.held = null;
    else if (o.cursor !== core.cur) core.pin(o.cursor);
  }, [core, o.cursor]);
  const { scroller } = o;
  useEffect(() => (scroller ? attachHold(core, scroller) : undefined), [core, scroller]);
  useEffect(() => (scroller ? core.attachSpy(scroller) : undefined), [core, scroller]);
  useEffect(
    () => (scroller && !core.inputs.seam?.hands ? countHands(core, scroller) : undefined),
    [core, scroller],
  );
  return handleRef.current;
}
