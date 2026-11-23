"use client";

/**
 * THE SQUARES' WALK in a reading column: which letter the reader is on, and a press that puts a letter's top on the
 * reading line and holds it there until the person's own scroll (an app scroll is stamped and keeps it). The
 * geometry is the engine's `threadWalk`, the one the old column's squares run; the walk's channel lets a list row's
 * squares show the same place and press through to this column.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { threadWalk, type Walk } from "@ohmail/client-engine";
import { cssRect } from "../geometry/index.js";
import { nextFrame, viewOf, THREAD_DOM, type ThreadDomNames } from "../reading/reader-seen.js";
import type { ThreadWalkChannel } from "../reading/thread-walk-channel.js";
import { scrollProgrammatically, stampLive } from "../session/programmatic-scroll.js";

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
/** How far under the column's top (under its head, where one stays there) an open puts the message's top. */
export const OPEN_GAP_PX = 14;
/** Far from the conversation's last letter: this far above its landing, or half the view where that is more. */
export const END_FAR_PX = 240;
/** What may be a person's intent, heard first (capture) on the column's own window. */
const HANDOVER = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

export interface ThreadWalk {
  /** The index of the letter the reader is on, or -1 before the column is measured. */
  readonly here: number;
  /** Put letter `index` on the reading line and hold it: false while the column is not laid out. */
  readonly jump: (index: number) => boolean;
  /** The column stands far from the latest letter's landing. */
  readonly latestFar: boolean;
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
  const key = ids.join(" ");
  const list = useRef(ids);
  list.current = ids;
  const walk = useRef<Walk | null>(null);
  const room = useRef({ view: 0, farEdge: END_FAR_PX });
  const drawn = useRef({ id: null as string | null, far: false });
  const pin = useRef<string | null>(initialId ?? null);
  const [here, setHere] = useState(() => {
    const last = channel?.get();
    return last && last.openedId === openedId ? last.here : null;
  });
  const [latestFar, setLatestFar] = useState(false);
  const latest = useRef({ onEnter, names, standsDown });
  latest.current = { onEnter, names, standsDown };
  /* The open's anchor, live from the open until it is let go. */
  const anchored = useRef(anchor);

  const look = useCallback((): void => {
    const w = walk.current;
    if (!scroller || !w) return;
    const at = pin.current === null ? -1 : list.current.indexOf(pin.current);
    const top = scroller.scrollTop;
    const i = w.current(top, at >= 0 ? { index: at } : null);
    const id = i >= 0 ? (list.current[i] ?? null) : drawn.current.id;
    const latest = w.scrollFor(newestFirst ? 0 : list.current.length - 1);
    const distance = newestFirst ? top - latest : latest - top;
    const far = list.current.length > 1 && room.current.view > 0 && distance > room.current.farEdge;
    if (id !== drawn.current.id) setHere(id);
    if (far !== drawn.current.far) setLatestFar(far);
    drawn.current = { id, far };
  }, [scroller, newestFirst]);

  const measure = useCallback((): void => {
    if (!scroller || !scope) return;
    const top0 = cssRect(scroller).top;
    room.current.farEdge = Math.max(END_FAR_PX, scroller.clientHeight / 2);
    const at = conversationTops(scope, top0, scroller.scrollTop);
    const v = viewOf(scroller, latest.current.names);
    room.current.view = Math.max(0, v.bottom - v.top);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (anchored.current && latest.current.standsDown?.() === true) anchored.current = false;
    const anchoring = anchored.current && list.current.length > 1 && room.current.view > 0;
    if (anchoring && (pin.current === null || !list.current.includes(pin.current))) {
      pin.current = list.current.at(newestFirst ? 0 : -1) ?? null;
    }
    const pinned = pin.current === null ? -1 : list.current.indexOf(pin.current);
    const top = at.get(pin.current ?? "");
    if (anchoring && pinned >= 0 && top !== undefined && Number.isFinite(top)) {
      const clearance = coverOf(scroller, latest.current.names, top0) + OPEN_GAP_PX;
      const offset = newestFirst && scope === scroller ? 0 : Math.max(0, top - clearance);
      scrollProgrammatically(scroller, Math.min(max, offset));
    }
    walk.current = threadWalk({
      tops: list.current.map((id) => at.get(id) ?? Number.NaN),
      max,
      view: room.current.view,
      opened: pinned,
    });
    look();
  }, [scroller, scope, look, newestFirst]);

  const land = useCallback(
    (i: number): boolean => {
      measure();
      const id = list.current[i];
      if (!scroller || id === undefined || room.current.view <= 0) return false;
      anchored.current = false;
      const w = walk.current;
      if (!w) return false;
      scrollProgrammatically(scroller, w.scrollFor(i));
      pin.current = id;
      look();
      latest.current.onEnter();
      return true;
    },
    [scroller, measure, look],
  );

  /* A press on the list row's squares made while no column stood is owed, and landed once this one is laid out. */
  const owedTo = useRef(channel);
  owedTo.current = channel;
  const landOwed = useCallback((): void => {
    const ch = owedTo.current;
    const i = ch?.pending == null ? -1 : list.current.indexOf(ch.pending);
    if (ch && i >= 0 && land(i)) ch.pending = null;
  }, [land]);

  /* A hand scroll lets go of the pressed letter and of the open's anchor; the app's own scroll keeps both. */
  const onHand = useCallback((): void => {
    anchored.current = false;
    pin.current = null;
  }, []);
  useAnchorRelease(scroller, anchored, anchor, pin, initialId, measure);
  useLayoutWatch(scroller, scope, key, measure, look, landOwed, onHand);

  /* The channel: this column's place, and its jump for a press on the list row's squares. */
  const shown = here !== null && ids.includes(here) ? here : null;
  useWalkChannel(channel, messages, shown, openedId, land);

  return { here: shown === null ? -1 : ids.indexOf(shown), jump: land, latestFar };
}

function conversationTops(scope: HTMLElement, top0: number, scrollTop: number): Map<string, number> {
  const at = new Map<string, number>();
  for (const panel of scope.querySelectorAll<HTMLElement>("[data-conv-id]")) {
    at.set(panel.dataset.convId ?? "", cssRect(panel).top - top0 + scrollTop);
  }
  return at;
}

/** Measured on every layout change, a frame after it; a scroll reads only the offset. */
function useLayoutWatch(
  scroller: HTMLElement | null,
  scope: HTMLElement | null,
  key: string,
  measure: () => void,
  look: () => void,
  landOwed: () => void,
  onHand: () => void,
): void {
  useLayoutEffect(() => {
    const win = scroller?.ownerDocument.defaultView;
    if (!scroller || !scope || !win) return;
    let measuring: (() => void) | null = null;
    let looking: (() => void) | null = null;
    const soon = (): void => {
      if (!measuring)
        measuring = nextFrame(win, () => {
          measuring = null;
          measure();
          landOwed();
        });
    };
    const onScroll = (): void => {
      if (!stampLive(scroller)) onHand();
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
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    ro?.observe(scroller);
    /* The letters grow while their bodies land: the stack is watched too. */
    for (const child of scope.children) ro?.observe(child);
    return () => {
      measuring?.();
      looking?.();
      ro?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", soon);
    };
  }, [scroller, scope, key, measure, look, landOwed, onHand]);
}

/** How much of the scroller's top its head covers while it stays there; nothing where it scrolls away with the rest. */
function coverOf(scroller: HTMLElement, names: ThreadDomNames, scrollerTop: number): number {
  const head = names.head === undefined ? null : scroller.querySelector<HTMLElement>(names.head);
  const win = scroller.ownerDocument.defaultView;
  if (head === null || win === null) return 0;
  return win.getComputedStyle(head).position === "sticky"
    ? Math.max(0, cssRect(head).bottom - scrollerTop)
    : 0;
}

/** The open's anchor is let go at the person's first gesture, wherever it lands, or at the ceiling. */
function useAnchorRelease(
  scroller: HTMLElement | null,
  anchored: { current: boolean },
  requested: boolean,
  pin: { current: string | null },
  initialId: string | undefined,
  measure: () => void,
): void {
  const prior = useRef(requested);
  useLayoutEffect(() => {
    if (prior.current === requested) return;
    prior.current = requested;
    anchored.current = requested;
    if (requested) {
      pin.current = initialId ?? null;
      measure();
    }
  }, [requested, anchored, pin, initialId, measure]);
  useEffect(() => {
    const win = scroller?.ownerDocument.defaultView;
    if (!win || !requested || !anchored.current) return;
    const release = (): void => {
      anchored.current = false;
    };
    const timer = win.setTimeout(release, ANCHOR_CEILING_MS);
    for (const ev of HANDOVER) win.addEventListener(ev, release, true);
    return () => {
      win.clearTimeout(timer);
      for (const ev of HANDOVER) win.removeEventListener(ev, release, true);
    };
  }, [scroller, anchored, requested]);
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
