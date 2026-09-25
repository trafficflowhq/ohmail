"use client";

/**
 * HISTORY AS THE STORE'S TIMELINE — the browser's bind of the engine's one walker
 * (`StoreTimelineWalker`, which the phone renders too). The view asks `want(visible range)`; the
 * walker fetches pages from the nearest seen keyset, reaches far slots by uncached steps, and the
 * mirror paints first until page one replaces it in place.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  StoreTimelineWalker,
  type EngineMessage,
  type OhmailEngine,
  type StoreTimelineState,
  type TimelineSegment,
} from "@ohmail/client-engine";

export type TimelineState = StoreTimelineState;

export interface StoreTimelineView {
  state: TimelineState;
  /** The store's own count, once it answered. */
  total: number | null;
  /** Slots in the list: the timeline's once ready, else the mirror's first paint. */
  length: number;
  /** The row in slot `i`: a message, `"gone"` where the mirror records it deleted, `null` unfetched. */
  rowAt: (i: number) => EngineMessage | "gone" | null;
  segments: readonly TimelineSegment[];
  /** Ask for the pages covering `[start, end)` — at most one request per direction in flight. */
  want: (start: number, end: number) => void;
  /** Ask the store again after it did not answer. */
  retry: () => void;
  /** A rail press: the page at that month's own anchor, asked at once. */
  jump: (start: number) => void;
}

export function useStoreTimeline(
  engine: OhmailEngine,
  /** The mirror's version — page rows re-read the mirror's live row when it moves. */
  version: number,
  /** The mirror's own rows, newest first — the first paint and the failure fallback. */
  mirrorRows: readonly EngineMessage[],
): StoreTimelineView {
  const walker = useMemo(() => new StoreTimelineWalker(engine), [engine]);
  useEffect(() => {
    walker.start();
    return () => walker.stop();
  }, [walker]);
  const rev = useSyncExternalStore(walker.subscribe, walker.revision, walker.revision);
  return useMemo(() => ({
    state: walker.state(),
    total: walker.total(),
    length: walker.length(mirrorRows.length),
    rowAt: (i: number) => walker.rowAt(i, mirrorRows),
    segments: walker.segments(),
    want: (start: number, end: number) => walker.want(start, end),
    retry: () => walker.start(),
    jump: (start: number) => walker.jump(start),
    // `rev` and `version` are the signals: the walker moved, or the mirror did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [walker, rev, version, mirrorRows]);
}
