/**
 * THE PHONE'S HISTORY AND SEARCH, READ FROM THE STORE — the webapp's two binds over the same
 * doors (`w.store`): both are the engine's one list walker, History over the timeline and Search
 * over one question's matches, whose first page replaces the device's paint. Neither reads the
 * mirror's window; the mirror only paints first. No engine import here: the world hands them in.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWorld, type WorldMail } from "./world";
import type { StoreMessage } from "./live";

/** Search's debounce — the webapp's `ARCHIVE_DEBOUNCE_MS`; the ceiling is the walker's own. */
export const STORE_SEARCH_DEBOUNCE_MS = 250;

const NONE: readonly StoreMessage[] = [];
const noWalker = (): (() => void) => () => undefined;
const zero = (): number => 0;

export interface PhoneHistory {
  state: "unavailable" | "loading" | "ready" | "unanswered";
  total: number | null;
  length: number;
  /** Slot `i`: a row, `"gone"` where the mirror records it deleted, `null` not fetched yet. */
  rowAt(i: number): WorldMail | "gone" | null;
  /** The raw store row behind slot `i`, for the reader's off-mirror open. */
  sourceAt(i: number): StoreMessage | null;
  /** The year strip: each year's first slot, newest first; the undated tail last. */
  years: { year: string | null; start: number }[];
  want(start: number, end: number): void;
  jump(start: number): void;
  retry(): void;
}

export function useStoreHistory(): PhoneHistory {
  const w = useWorld();
  const walker = w.store.walker;
  useEffect(() => {
    if (!walker) return undefined;
    walker.start();
    return () => walker.stop();
  }, [walker]);
  const rev = useSyncExternalStore(walker ? walker.subscribe : noWalker, walker ? walker.revision : zero, walker ? walker.revision : zero);
  const state = walker ? walker.state() : "unavailable";
  /* The first paint: the mirror's rows, sorted only while the store has not answered. */
  const mirror = useMemo(() => (state === "ready" ? NONE : w.store.mirrorRows()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state === "ready", w]);
  return useMemo(() => {
    const src = (i: number): StoreMessage | "gone" | null =>
      walker ? walker.rowAt(i, mirror) : (mirror[i] ?? null);
    const years: { year: string | null; start: number }[] = [];
    for (const s of walker?.segments() ?? []) {
      const y = s.month?.slice(0, 4) ?? null;
      if (years.length === 0 || years[years.length - 1]!.year !== y) years.push({ year: y, start: s.start });
    }
    return {
      state,
      total: walker ? walker.total() : null,
      length: walker ? walker.length(mirror.length) : mirror.length,
      rowAt: (i) => {
        const m = src(i);
        return m === null || m === "gone" ? m : w.store.rowOf(m, true);
      },
      sourceAt: (i) => {
        const m = src(i);
        return m === null || m === "gone" ? null : m;
      },
      years,
      want: (a, b) => walker?.want(a, b),
      jump: (start) => walker?.jump(start),
      retry: () => walker?.start(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walker, rev, mirror, w]);
}

export type PhoneSearchVerdict = "idle" | "searching" | "ready" | "unanswered" | "unavailable";

export interface PhoneStoreSearch {
  verdict: PhoneSearchVerdict;
  /** The store's list is on screen — its first page answered; before that the device's paint stands. */
  ready: boolean;
  /** Slots in the store's list: the rows walked so far, growing as `loadMore` reaches further. */
  length: number;
  /** Slot `i`: a row, `"gone"` where it was deleted, `null` while its page is not held. */
  rowAt(i: number): WorldMail | "gone" | null;
  /** The raw store row behind slot `i`, for the reader's off-mirror open. */
  sourceAt(i: number): StoreMessage | null;
  tier: "exact" | "similar";
  total: number;
  totalExact: boolean;
  ms: number | null;
  indexedPercent: number | null;
  /** The last relevance page of a cut set: the date orders walk the rest. */
  bounded: boolean;
  /** Ask for the pages covering `[start, end)` — an evicted page is asked again by its cursor. */
  want(start: number, end: number): void;
  loadMore(): void;
  retry(): void;
}

/**
 * THE WHOLE-MAILBOX PASS FOR ONE QUERY, on the walker History walks (`w.store.searchWalker`): the
 * page first, the summary after it, the next page on `loadMore`, one of three verdicts on every
 * outcome. `deviceIds` are the rows the device painted, in order — under relevance they keep their
 * places in the store's first page.
 */
export function useStoreSearch(query: string, deviceIds: readonly string[]): PhoneStoreSearch {
  const w = useWorld();
  const q = query.trim();
  const [tick, setTick] = useState(0);
  const walker = w.store.searchWalker;
  const ids = useRef(deviceIds);
  ids.current = deviceIds;
  const available = w.store.searchAvailable;

  useEffect(() => {
    if (!walker) return undefined;
    if (q.length < 2) {
      walker.clear();
      return undefined;
    }
    walker.start({ query: q }, () => ids.current, STORE_SEARCH_DEBOUNCE_MS);
    return () => walker.stop();
  }, [walker, q, tick, available]);
  useEffect(() => () => walker?.clear(), [walker]);

  const rev = useSyncExternalStore(walker ? walker.subscribe : noWalker, walker ? walker.revision : zero, walker ? walker.revision : zero);
  return useMemo(() => {
    const state = walker ? walker.state() : q.length < 2 ? "idle" : "unavailable";
    const info = walker?.info() ?? null;
    const at = (i: number): StoreMessage | "gone" | null => (walker ? walker.rowAt(i) : null);
    return {
      verdict: q.length < 2 ? "idle" : state === "idle" ? "searching" : state,
      ready: info !== null,
      length: info !== null && walker ? walker.length() : 0,
      rowAt: (i) => {
        const m = at(i);
        return m === null || m === "gone" ? m : w.store.rowOf(m, false);
      },
      sourceAt: (i) => {
        const m = at(i);
        return m === null || m === "gone" ? null : m;
      },
      tier: info?.tier ?? "exact",
      total: info?.total ?? 0,
      totalExact: info?.totalExact ?? true,
      ms: info?.ms ?? null,
      indexedPercent: info?.indexed ? Math.floor((100 * info.indexed.done) / info.indexed.total) : null,
      bounded: info !== null && info.bounded && walker !== null && walker.atEnd(),
      want: (start, end) => walker?.want(start, end),
      loadMore: () => walker?.more(),
      retry: () => setTick((n) => n + 1),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walker, rev, q, w]);
}
