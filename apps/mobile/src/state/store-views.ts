/**
 * THE PHONE'S HISTORY AND SEARCH, READ FROM THE STORE — the webapp's two binds over the same
 * doors (`w.store`): History is the engine's one timeline walker, Search the whole-mailbox pass
 * whose page replaces the device's first paint. Neither reads the mirror's window; the mirror only
 * paints first. No engine import here: the world hands the doors in.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWorld, type WorldMail } from "./world";
import type { ServerSearchOutcome, StoreMessage } from "./live";

/** Search's debounce and ceiling — the webapp's `ARCHIVE_DEBOUNCE_MS` / `ARCHIVE_TIMEOUT_MS`. */
export const STORE_SEARCH_DEBOUNCE_MS = 250;
export const STORE_SEARCH_TIMEOUT_MS = 15_000;

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
  /** The store's rows, replacing the device's paint; `null` while the device's paint stands. */
  rows: WorldMail[] | null;
  tier: "exact" | "similar";
  total: number;
  totalExact: boolean;
  ms: number | null;
  indexedPercent: number | null;
  /** The last relevance page of a cut set: the date orders walk the rest. */
  bounded: boolean;
  /** The raw store row behind a result, for the reader's off-mirror open. */
  sourceOf(id: string): StoreMessage | null;
  loadMore(): void;
  retry(): void;
}

interface Held {
  q: string;
  outcome: Extract<ServerSearchOutcome, { state: "ready" }> | { state: "searching" | "unanswered" | "unavailable" };
}

/**
 * THE WHOLE-MAILBOX PASS FOR ONE QUERY: page first, the summary (exact count, progress) after
 * it, the next page on `loadMore`; one of three verdicts on every outcome, the ceiling included.
 * `deviceIds` are the rows the device painted, in order — under relevance they keep their places.
 */
export function useStoreSearch(query: string, deviceIds: readonly string[]): PhoneStoreSearch {
  const w = useWorld();
  const q = query.trim();
  const [held, setHeld] = useState<Held | null>(null);
  const [tick, setTick] = useState(0);
  const paging = useRef(false);
  const doors = w.store;
  /* The doors behind a ref: the world re-derives on every drain, and a drain is not a question. */
  const door = useRef(doors);
  door.current = doors;
  const available = doors.searchAvailable;

  useEffect(() => {
    if (q.length < 2) {
      setHeld(null);
      return undefined;
    }
    if (!available) {
      setHeld({ q, outcome: { state: "unavailable" } });
      return undefined;
    }
    let live = true;
    setHeld({ q, outcome: { state: "searching" } });
    const ceiling = setTimeout(() => {
      if (live) setHeld((p) => (p && p.q === q && p.outcome.state === "searching" ? { q, outcome: { state: "unanswered" } } : p));
    }, STORE_SEARCH_TIMEOUT_MS);
    const timer = setTimeout(() => {
      void door.current.search(q, { parts: "page" }).then((out) => {
        if (!live) return;
        if (out.state !== "ready") {
          setHeld({ q, outcome: { state: out.state === "unavailable" ? "unavailable" : "unanswered" } });
          return;
        }
        setHeld({ q, outcome: out });
        void door.current.search(q, { parts: "summary" }).then((sum) => {
          if (!live || sum.state !== "ready") return;
          setHeld((p) => (p && p.q === q && p.outcome.state === "ready" ? { q, outcome: {
            ...p.outcome,
            ...(sum.totalExact ? { total: sum.total, totalExact: true } : {}),
            indexed: sum.indexed ?? p.outcome.indexed,
          } } : p));
        }, () => undefined);
      }, () => { if (live) setHeld({ q, outcome: { state: "unanswered" } }); });
    }, STORE_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(ceiling);
    };
  }, [q, tick, available]);

  const loadMore = useCallback(() => {
    const cur = held && held.q === q ? held.outcome : null;
    if (cur?.state !== "ready" || cur.nextCursor === null || paging.current) return;
    paging.current = true;
    void door.current.search(q, { parts: "page", cursor: cur.nextCursor }).then((out) => {
      paging.current = false;
      if (out.state !== "ready") return;
      setHeld((p) => {
        if (!p || p.q !== q || p.outcome.state !== "ready") return p;
        const seen = new Set(p.outcome.items.map((m) => m.id));
        return { q, outcome: {
          ...p.outcome, items: [...p.outcome.items, ...out.items.filter((m) => !seen.has(m.id))],
          nextCursor: out.nextCursor, bounded: out.bounded,
        } };
      });
    }, () => { paging.current = false; });
  }, [held, q]);

  const cur = held && held.q === q ? held.outcome : null;
  const rows = useMemo(() => {
    if (cur?.state !== "ready") return null;
    const byId = new Map(cur.items.map((m) => [m.id, m] as const));
    const kept = deviceIds.filter((id) => byId.has(id));
    const keptSet = new Set(kept);
    const ordered = [...kept.map((id) => byId.get(id)!), ...cur.items.filter((m) => !keptSet.has(m.id))];
    return ordered.map((m) => doors.rowOf(m, false));
  }, [cur, deviceIds, doors]);

  return {
    verdict: q.length < 2 ? "idle" : cur === null ? "searching" : cur.state,
    rows,
    tier: cur?.state === "ready" ? cur.tier : "exact",
    total: cur?.state === "ready" ? cur.total : 0,
    totalExact: cur?.state === "ready" ? cur.totalExact : true,
    ms: cur?.state === "ready" ? cur.ms : null,
    indexedPercent: cur?.state === "ready" && cur.indexed ? Math.floor((100 * cur.indexed.done) / cur.indexed.total) : null,
    bounded: cur?.state === "ready" && cur.bounded && cur.nextCursor === null,
    sourceOf: (id) => (cur?.state === "ready" ? cur.items.find((m) => m.id === id) ?? null : null),
    loadMore,
    retry: () => setTick((n) => n + 1),
  };
}
