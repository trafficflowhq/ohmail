"use client";

/**
 * THE SQUARES' WALK in a reading column: which letter the reader is on, and a press that puts a letter's top on the
 * reading line and holds it there until the person's own scroll (an app scroll is stamped and keeps it). The
 * geometry is the engine's `threadWalk`, the one the old column's squares run; the walk's channel lets a list row's
 * squares show the same place and press through to this column.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { threadWalk, type Walk } from "@ohmail/client-engine";
import { nextFrame, THREAD_DOM, type ThreadDomNames } from "../reading/reader-seen.js";
import type { ThreadWalkChannel } from "../reading/thread-walk-channel.js";
import { scrollProgrammatically, stampLive } from "../session/programmatic-scroll.js";
import { LANDING_ROOM, measureLanding, threadLayout, useThreadPosition } from "./thread-landing.js";

export { END_FAR_PX, OPEN_GAP_PX } from "./thread-landing.js";

export interface ThreadWalkInput {
  readonly scroller: HTMLElement | null;
  /** The cards of this conversation when it shares a scroller with other conversations. */
  readonly scope?: HTMLElement | null;
  /** The letters in the order they appear in the scroller. */
  readonly messages: readonly EngineMessage[];
  readonly openedId: string | null;
  readonly channel?: ThreadWalkChannel;
  /** A press on a square enters the visit. */
  readonly onEnter: () => void;
  readonly names?: ThreadDomNames;
  /**
   * Hold the chosen message while bodies land, without entering the visit. Let go at the person's first gesture,
   * a hand scroll, a square's press, or after {@link ANCHOR_CEILING_MS}.
   */
  readonly anchor?: boolean;
  readonly initialId?: string;
  readonly newestFirst?: boolean;
  /**
   * The open's anchor stands down for good while this answers true: the person's own reply has joined the
   * conversation (`sent-reveal`'s `claims`), which the reveal brings into view; the open must not pull it away.
   */
  readonly standsDown?: () => boolean;
}

/** A ceiling, not a schedule: a conversation still growing after this has something else wrong with it. */
export const ANCHOR_CEILING_MS = 6000;
/** What may be a person's intent, heard first (capture) on the column's own window. */
const HANDOVER = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

export interface ThreadWalk {
  /** The index of the letter the reader is on, or -1 before the column is measured. */
  readonly here: number;
  /** Put letter `index` on the reading line and hold it: false while the column is not laid out. */
  readonly jump: (index: number) => boolean;
  /** The column stands far from the latest letter's landing. */
  readonly latestFar: boolean;
  /** Recheck after a body writes its final size, in the same layout pass. */
  readonly refreshLayout: () => void;
}

export function useThreadWalk({
  scroller,
  scope = scroller,
  messages,
  openedId,
  channel,
  onEnter,
  names = THREAD_DOM,
  anchor = false,
  initialId,
  newestFirst = false,
  standsDown,
}: ThreadWalkInput): ThreadWalk {
  const ids = messages.map((m) => m.id);
  const list = useRef(ids);
  list.current = ids;
  const pin = useRef<string | null>(initialId ?? null);
  const latest = useRef({ onEnter, names, standsDown });
  latest.current = { onEnter, names, standsDown };
  /* The open's anchor, live from the open until it is let go. */
  const anchored = useRef(anchor);
  const keepLanding = scope === scroller;
  const landingTop = useRef<number | null>(null);
  const releaseOpening = useOpeningRelease(scroller, keepLanding, anchored, landingTop);
  const manual = keepLanding && ids.length > 1;
  const { layout, readingAnchor, rememberReadingAnchor, wasClamped, moved } = useThreadPosition(
    scroller,
    manual,
    releaseOpening,
    pin,
  );

  const { walk, here, latestFar, look } = useWalkLook(
    { scroller, newestFirst, channel, openedId },
    list,
    pin,
    layout,
  );
  const measure = useCallback(
    (bodyChanged = false): void => {
      if (!scroller || !scope) return;
      const measured = threadLayout(scroller, scope, latest.current.names);
      layout.current = measured;
      const { line, at, view } = measured;
      const standsDown = latest.current.standsDown?.() === true;
      if (standsDown) releaseOpening();
      const anchoring = anchored.current && list.current.length > 1 && view > 0;
      if (anchoring && (pin.current === null || !list.current.includes(pin.current))) {
        pin.current = list.current.at(newestFirst ? 0 : -1) ?? null;
        landingTop.current = null;
      }
      const pinned = pin.current === null ? -1 : list.current.indexOf(pin.current);
      const landing = anchoring && pinned >= 0 ? at.get(pin.current ?? "") : undefined;
      const reading = !landing && !standsDown && manual ? readingAnchor.current : null;
      const visible = reading ? at.get(reading.id) : undefined;
      const position = measureLanding(scroller, landing ?? visible, reading?.offset ?? landingTop.current, {
        keepLanding,
        newestFirst,
        bodyChanged,
        line,
      });
      landingTop.current = landing ? position.top : null;
      if (standsDown) readingAnchor.current = null;
      else rememberReadingAnchor(landing ? (pin.current ?? undefined) : reading?.id);
      walk.current = threadWalk({
        tops: list.current.map((id) => at.get(id)?.top ?? Number.NaN),
        max: position.max,
        view,
        opened: pinned,
      });
      look();
    },
    [
      scroller,
      scope,
      look,
      newestFirst,
      keepLanding,
      manual,
      layout,
      readingAnchor,
      releaseOpening,
      rememberReadingAnchor,
      walk,
    ],
  );
  const refreshLayout = useCallback(() => measure(true), [measure]);

  const land = useCallback(
    (i: number): boolean => {
      measure();
      const id = list.current[i];
      if (!scroller || id === undefined || (layout.current?.view ?? 0) <= 0) return false;
      releaseOpening();
      const w = walk.current;
      if (!w) return false;
      scrollProgrammatically(scroller, w.scrollFor(i));
      pin.current = id;
      rememberReadingAnchor(id);
      look();
      latest.current.onEnter();
      return true;
    },
    [scroller, measure, look, layout, releaseOpening, rememberReadingAnchor, walk],
  );

  /* A press on the list row's squares made while no column stood is owed, and landed once this one is laid out. */
  const owedTo = useRef(channel);
  owedTo.current = channel;
  const landOwed = useCallback(() => landPending(owedTo.current, list.current, land), [land]);

  useAnchorRelease(scroller, anchored, anchor, pin, initialId, measure, landingTop, releaseOpening);
  useLayoutWatch(scroller, scope, ids.join(" "), measure, look, landOwed, wasClamped, moved);

  const shown = here !== null && ids.includes(here) ? here : null;
  useWalkChannel(channel, messages, shown, openedId, land);

  return { here: shown === null ? -1 : ids.indexOf(shown), jump: land, latestFar, refreshLayout };
}

function useWalkLook(
  {
    scroller,
    newestFirst,
    channel,
    openedId,
  }: Pick<ThreadWalkInput, "scroller" | "newestFirst" | "channel" | "openedId">,
  list: RefObject<string[]>,
  pin: RefObject<string | null>,
  layout: RefObject<ReturnType<typeof threadLayout> | null>,
) {
  const walk = useRef<Walk | null>(null);
  const drawn = useRef({ id: null as string | null, far: false });
  const [here, setHere] = useState(() => {
    const last = channel?.get();
    return last && last.openedId === openedId ? last.here : null;
  });
  const [latestFar, setLatestFar] = useState(false);
  const look = useCallback((): void => {
    const w = walk.current;
    const measured = layout.current;
    if (!scroller || !w || !measured) return;
    const at = pin.current === null ? -1 : list.current.indexOf(pin.current);
    const top = scroller.scrollTop;
    const i = w.current(top, at >= 0 ? { index: at } : null);
    const id = i >= 0 ? (list.current[i] ?? null) : drawn.current.id;
    const latest = w.scrollFor(newestFirst ? 0 : list.current.length - 1);
    const distance = newestFirst ? top - latest : latest - top;
    const far = list.current.length > 1 && measured.view > 0 && distance > measured.farEdge;
    if (id !== drawn.current.id) setHere(id);
    if (far !== drawn.current.far) setLatestFar(far);
    drawn.current = { id, far };
  }, [scroller, newestFirst, layout, list, pin]);
  return { walk, here, latestFar, look };
}

function useOpeningRelease(
  scroller: HTMLElement | null,
  keepLanding: boolean,
  anchored: { current: boolean },
  landingTop: { current: number | null },
): () => void {
  useLayoutEffect(() => {
    if (!keepLanding || !scroller) return;
    return () => {
      scroller.style.removeProperty(LANDING_ROOM);
    };
  }, [scroller, keepLanding]);

  return useCallback(() => {
    anchored.current = false;
    landingTop.current = null;
  }, [anchored, landingTop]);
}

function landPending(
  channel: ThreadWalkChannel | undefined,
  ids: readonly string[],
  land: (i: number) => boolean,
): void {
  if (channel?.pending == null) return;
  const i = ids.indexOf(channel.pending);
  if (i >= 0 && land(i)) channel.pending = null;
}

/** Measured on every layout change, a frame after it; a scroll reads only the offset. */
function useLayoutWatch(
  scroller: HTMLElement | null,
  scope: HTMLElement | null,
  key: string,
  measure: () => void,
  look: () => void,
  landOwed: () => void,
  wasClamped: () => boolean,
  moved: (hand: boolean) => boolean,
): void {
  useLayoutEffect(() => {
    const win = scroller?.ownerDocument.defaultView;
    if (!scroller || !scope || !win) return;
    let measuring: (() => void) | null = null;
    let looking: (() => void) | null = null;
    const check = (): void => {
      measure();
      landOwed();
    };
    const soon = (): void => {
      if (!measuring)
        measuring = nextFrame(win, () => {
          measuring = null;
          check();
        });
    };
    const onScroll = (): void => {
      const hand = !stampLive(scroller);
      // The browser can clamp scrollTop before ResizeObserver reports a shorter conversation.
      if (hand && wasClamped()) measure();
      else if (moved(hand) && scroller.style.getPropertyValue(LANDING_ROOM) !== "") measure();
      if (!looking)
        looking = nextFrame(win, () => {
          looking = null;
          look();
        });
    };
    measure();
    soon();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    win.addEventListener("resize", soon);
    // In the reader, compensate for movement above the landing before the changed layout paints.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scope === scroller ? check : soon);
    ro?.observe(scroller);
    /* The letters grow while their bodies land: the stack is watched too. */
    for (const child of scope.children) ro?.observe(child);
    if (scope === scroller) {
      for (const letter of scope.querySelectorAll("[data-conv-id]")) ro?.observe(letter);
    }
    return () => {
      measuring?.();
      looking?.();
      ro?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", soon);
    };
  }, [scroller, scope, key, measure, look, landOwed, wasClamped, moved]);
}

/** The opening gives way to the visible letter after a gesture or the ceiling. */
function useAnchorRelease(
  scroller: HTMLElement | null,
  anchored: { current: boolean },
  requested: boolean,
  pin: { current: string | null },
  initialId: string | undefined,
  measure: () => void,
  landingTop: { current: number | null },
  release: () => void,
): void {
  const prior = useRef(requested);
  useLayoutEffect(() => {
    if (prior.current === requested) return;
    prior.current = requested;
    anchored.current = requested;
    if (requested) {
      pin.current = initialId ?? null;
      landingTop.current = null;
      measure();
    }
  }, [requested, anchored, pin, initialId, measure, landingTop]);
  useEffect(() => {
    const win = scroller?.ownerDocument.defaultView;
    if (!win || !requested || (!anchored.current && landingTop.current === null)) return;
    const timer = win.setTimeout(() => {
      anchored.current = false;
    }, ANCHOR_CEILING_MS);
    for (const ev of HANDOVER) win.addEventListener(ev, release, true);
    return () => {
      win.clearTimeout(timer);
      for (const ev of HANDOVER) win.removeEventListener(ev, release, true);
    };
  }, [scroller, anchored, requested, landingTop, release]);
}

/**
 * The walk's channel: this column's place for the list row's squares, and its landing for a press there (one made
 * while no column stood is owed and landed once this one is laid out).
 */
function useWalkChannel(
  channel: ThreadWalkChannel | undefined,
  messages: readonly EngineMessage[],
  shown: string | null,
  openedId: string | null,
  land: (index: number) => boolean,
): void {
  /* The channel keeps what it was told by its key: a second telling of the same squares is nothing. */
  useLayoutEffect(() => {
    if (!channel) return;
    channel.publish({ messages, here: shown, openedId });
  }, [channel, messages, shown, openedId]);
  const latest = useRef({ land, messages });
  latest.current = { land, messages };
  useEffect(() => {
    if (!channel) return;
    const indexOf = (id: string): number => latest.current.messages.findIndex((m) => m.id === id);
    const owed = channel.pending;
    if (owed !== null && indexOf(owed) >= 0 && latest.current.land(indexOf(owed))) channel.pending = null;
    return channel.bindJump((id) => latest.current.land(indexOf(id)));
  }, [channel]);
}
