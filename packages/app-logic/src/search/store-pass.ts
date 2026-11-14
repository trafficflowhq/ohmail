/**
 * THE WHOLE-MAILBOX PASS: the store's pages, on the one list walker. Keyed by the question it answers (query, sort,
 * pressed facet). A new question drops the old one's pages; an answer for a question since edited is never read.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
  StoreSearchWalker,
  type LocalSearchResult,
  type OhmailEngine,
  type ServerSearchFilters,
  type ServerSearchSort,
  type StoreSearchMeta,
  type StoreSearchState,
} from "@ohmail/client-engine";
import { useListWindow, type ListWindow } from "../lists/list-window.js";
import { useSessionReask } from "../session/session-reask.js";
import { ARCHIVE_DEBOUNCE_MS } from "./constants.js";

/**
 * EVERY WAY THE PASS ENDS IS ONE OF THREE VERDICTS — matched, nothing matched, or the server did
 * not answer. A refusal renders the third, not the server's text: the text can carry what the
 * person typed, so the log line takes the CLASS the walker kept and the screen says what is on it.
 */
function logUnanswered(cause: string): void {
  console.warn("[search] the whole-mailbox pass did not answer:", cause);
}

/** The device's rows at the moment the store's first page lands, by tier — they keep their places. */
export interface DeviceOrder {
  exact: string[];
  similar: string[];
}

export interface StorePass {
  readonly walker: StoreSearchWalker;
  /** The walker's revision: moves with every page, so a read of it re-derives. */
  readonly rev: number;
  /** The store can be asked on this host. */
  readonly available: boolean;
  /** The failure's class, never its text. */
  readonly cause: string | null;
  /** The walker's state, read as "searching" while a refused read waits on its renewal. */
  readonly passState: StoreSearchState;
  /** The question this render's walker answers. */
  readonly question: number;
  /** The store's reading of the match set, once its first page answered. */
  readonly ready: StoreSearchMeta | null;
  /** The text of the question the walker is answering, by its `question()` — what its facets are of. */
  readonly askedText: MutableRefObject<{ question: number; text: string } | null>;
  /** Ask again, at once. */
  retry(): void;
}

export function useStorePass(
  engine: OhmailEngine,
  trimmed: string,
  sort: ServerSearchSort,
  storeFilters: ServerSearchFilters | undefined,
  result: LocalSearchResult | null,
  /** The question is narrowed beside its words: with none it is still asked. */
  blankAsks: boolean,
): StorePass {
  /* The device's rows at this render, which the walker reads when the store's first page lands. */
  const deviceOrder = useRef<DeviceOrder>({ exact: [], similar: [] });
  deviceOrder.current = {
    exact: (result?.items ?? []).map((h) => h.message.id),
    similar: (result?.similar ?? []).map((h) => h.message.id),
  };
  const walker = useMemo(() => new StoreSearchWalker(engine), [engine]);
  const rev = useSyncExternalStore(walker.subscribe, walker.revision, walker.revision);
  const [retryTick, setRetryTick] = useState(0);
  const available = engine.serverSearchAvailable();

  /* Only TYPED text waits: the debounce, then its count and facets until the question has stood
     STORE_SEARCH_FOLLOWUP_HOLD_MS, so a prefix costs the store one page. Enter, the two "search
     again" controls, a pressed facet and a sort change settle the question: they ask at once. */
  const askedTick = useRef(retryTick);
  const lastText = useRef<string | null>(null);
  const askedText = useRef<{ question: number; text: string } | null>(null);
  useEffect(() => {
    const asked = askedTick.current !== retryTick;
    askedTick.current = retryTick;
    const typed = lastText.current !== trimmed;
    lastText.current = trimmed;
    // A single character is not a question: the local arm ignores it, and so does the store. No words with the
    // question narrowed (a person, unread, the days) is every letter the narrowing keeps.
    if (trimmed.length === 1 || (trimmed === "" && !blankAsks)) {
      walker.clear();
      askedText.current = null;
      return undefined;
    }
    const settled = asked || !typed;
    walker.start(
      { query: trimmed, sort, ...(storeFilters ? { filters: storeFilters } : {}) },
      (tier) => (tier === "similar" ? deviceOrder.current.similar : deviceOrder.current.exact),
      settled ? 0 : ARCHIVE_DEBOUNCE_MS,
      settled ? 0 : STORE_SEARCH_FOLLOWUP_HOLD_MS,
    );
    askedText.current = { question: walker.question(), text: trimmed };
    return () => walker.stop();
    // `sort` and the pressed facet are NEW QUESTIONS for the store, not re-presentations.
  }, [walker, trimmed, available, retryTick, sort, storeFilters, deviceOrder, blankAsks]);
  useEffect(() => () => walker.clear(), [walker]);

  const cause = walker.failureCause();
  /* A 401 is the session's answer: still searching while the renewal is out, asked again once it lands. */
  const read = useMemo(
    () => ({
      subscribe: walker.subscribe,
      cause: () => walker.failureCause(),
      answered: () => walker.info() !== null,
      reask: () => setRetryTick((n) => n + 1),
    }),
    [walker],
  );
  const renewing = useSessionReask(read);
  const passState: StoreSearchState = renewing ? "searching" : walker.state();
  const question = walker.question();
  useEffect(() => {
    if (cause !== null) logUnanswered(cause);
  }, [question, cause]);

  const ready = walker.info();
  /* The verdict below is committed: the walker hands this question's timings to the engine, which
     carries them to a desktop's engine log (`search-phases.ts`) and nowhere on the web. */
  useEffect(() => {
    if (ready !== null || cause !== null) walker.painted();
  }, [walker, ready, cause]);

  return {
    walker,
    rev,
    available,
    cause,
    passState,
    question,
    ready,
    askedText,
    retry: () => setRetryTick((n) => n + 1),
  };
}

/**
 * THE STORE'S LIST IS A WINDOW over the walker's slots: the pages on screen are asked for, and the cursor stays on
 * screen (a slot outside the rendered slice is scrolled to, when the cursor moves and only then).
 */
export function useStoreWindow(
  walker: StoreSearchWalker,
  storeReady: boolean,
  storeLength: number,
  rev: number,
  scrollerRef: RefObject<HTMLElement | null>,
  cursor: number,
): ListWindow {
  const win = useListWindow({ scrollerRef, count: storeLength });
  useEffect(() => {
    if (storeReady) walker.want(win.visibleStart, win.visibleEnd);
  }, [walker, storeReady, win.visibleStart, win.visibleEnd, rev]);
  /* The window as this render measured it, read by the effect below without making it run on every render. */
  const measured = useRef(win);
  measured.current = win;
  useEffect(() => {
    const el = scrollerRef.current;
    const w = measured.current;
    if (!storeReady || !el || cursor < 0) return;
    const top = w.offsetOf(cursor);
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - w.rowHeight) {
      el.scrollTop = Math.max(0, top - w.rowHeight);
    }
  }, [cursor, storeReady, scrollerRef]);
  return win;
}
