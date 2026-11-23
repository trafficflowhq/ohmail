/**
 * SEARCH'S LIST, AS BEHAVIOUR — ONE list. The mirror's instant index paints first (the local pass, per keystroke);
 * the store's first page then REPLACES it in place — rows on screen that the store also returned keep their places —
 * and the rest is History's own list mechanism (`StoreSearchWalker`): pages by the store's cursor, at most
 * `HISTORY_PAGE_CACHE_ROWS` held, re-asked on the way back. Facets, the count and the indexing progress are the
 * store's, over the whole match set. Every pass ends in one of three verdicts. Guesses keep their own tier
 * (`search-rank`). No markup: a screen draws the model this hands back.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import type { SearchHit, StoreSearchWalker } from "@ohmail/client-engine";
import { substringOpen } from "@trafficflow/core/search-rank";
import { revealInScroller, type ListWindow } from "../lists/list-window.js";
import { atStamp } from "../engine/context.js";
import { useSearchAfterAction } from "./after-action.js";
import { ADDRESS_QUERY } from "./constants.js";
import { useSearchCursor } from "./cursor.js";
import { filterOf, NONE_PRESSED, pressOf, useFacets, type Pressed } from "./facets.js";
import { filtersFromLink, narrowingFromLink, searchLink, useSearchFilterLink } from "./link.js";
import { useSearchKeys } from "./keys.js";
import type { DevicePaint } from "./local-pass.js";
import { useSearchSort } from "./order.js";
import { restingPeople } from "./people.js";
import { useQuestion, wordsAsked } from "./question.js";
import { useStoreWindow } from "./store-pass.js";
import { useResultSlots, type Slots } from "./slots.js";
import type { SearchListInput, SearchListModel } from "./types.js";

export function useSearchList(input: SearchListInput): SearchListModel {
  const { engine, scope, query, onQuery, onOpen, boxRef, scrollerRef, t, searchBy, linkWords } = input;
  const [pressed, setPressed] = useState<Pressed>(() =>
    linkWords ? filtersFromLink(linkWords, t) : NONE_PRESSED,
  );
  /* Where the host's server takes a person, the place and the files are two parts of the question, each pressed and
     let go on its own, and they stand while the words change; elsewhere one facet stands at a time, as it always did. */
  const apart = searchBy === "people";
  const q = useQuestion(searchBy, pressed, linkWords && (() => narrowingFromLink(linkWords)));
  const { narrowing, isNarrowed } = q;
  useSearchFilterLink(input, pressed, narrowing);
  const trimmed = wordsAsked(query, searchBy);
  const resting = query.trim() === "" && !isNarrowed;
  const mailboxTotal = useMailboxTotal(scope, input.readMailboxTotal);
  const overviewPeople = usePeopleOverview(engine, searchBy === "people" ? input.people : undefined);
  const [sort, setSort] = useSearchSort(scope, trimmed === "" && isNarrowed);
  const rows = useResultSlots(input, trimmed, sort, pressed, q);
  const { store, length, hitAt, similarOn, storeLength } = rows;
  const { walker, rev, ready, passState } = store;
  const storeReady = ready !== null;
  const facets = useFacets({
    scope,
    store,
    engine,
    trimmed,
    pressed,
    apart,
    answered: rows.result !== null,
    similarOn,
    paint: rows.paint,
    walked: storeLength,
    t,
  });
  // A new query, order or pressed facet is a new question: the cursor starts at the top.
  const asked = `${trimmed}\u0000${sort}\u0000${pressed.map((f) => `${f.group}:${f.label}`).join("\u0001")}\u0000${JSON.stringify(narrowing)}`;
  const cursor = useSearchCursor(
    asked,
    length,
    (i) => {
      const x = hitAt(i);
      return x === null || x === "gone" ? null : x.message.id;
    },
    input.openId,
  );
  const win = useStoreWindow(walker, storeReady, storeLength, rev, scrollerRef);
  const { open, afterAction } = useSearchInteraction(input, {
    open: (hit, entered) => onOpen(hit, searchLink(query, pressed, narrowing), entered),
    length,
    cursor,
    hitAt,
    question: asked,
    win,
    present: rows.present,
    unread: narrowing.unread,
    walker: storeReady ? walker : null,
    waitingForStore: store.available && (passState === "idle" || passState === "searching"),
  });
  return {
    ...rows.verdict,
    query,
    text: trimmed,
    boxRef,
    scrollerRef,
    sort,
    setSort,
    indexing: rows.result?.indexing ?? false,
    tookMs: rows.tookMs,
    length,
    slotAt: rows.slotAt,
    /* The list's size as a screen reader hears it: the walked slots once the store's last page is in, the count the
       head states while that count is exact, and unknown (-1) until then. */
    setSize: walker.atEnd()
      ? storeLength
      : pressed.length === 0 && ready?.totalExact === true
        ? Math.max(rows.found, length)
        : -1,
    found: rows.found,
    similar: similarOn,
    /* WHERE A PART INSIDE A WORD IS LOOKED FOR, said on the store's empty and closest-words answers only. Not while
       the store is still indexing: its older rows are read by subject and sender alone. */
    partsSaid: storeReady && !ready.indexed && substringOpen(trimmed),
    cursor: cursor.at,
    facets,
    resting,
    restingPeople: overviewPeople,
    mailboxTotal,
    filtered: pressed.length > 0,
    pick: (p) => {
      const next = filterOf(p, t);
      setPressed((was) => pressOf(was, next, apart));
    },
    retry: store.retry,
    nearEnd: () => {
      if (walker.atBound()) walker.further();
      else walker.more();
    },
    window: storeReady
      ? { start: win.start, end: win.end, padTop: win.padTop, padBottom: win.padBottom }
      : { start: 0, end: length, padTop: 0, padBottom: 0 },
    addressOnly: ADDRESS_QUERY.test(trimmed),
    listing: storeReady ? "store" : "device",
    similarFrom: similarStart(storeReady, similarOn, rows.paint),
    ...q.model,
    open,
    afterAction,
    type: (typed) => {
      if (!apart) setPressed(NONE_PRESSED);
      onQuery(typed);
    },
    submit: () => {
      // Preserve the existing empty-answer retry behavior for this query.
      if (trimmed.toLowerCase() === "blanc" && length === 0) return;
      if ((trimmed || isNarrowed) && store.available) store.retry();
    },
  };
}

/** One count read per Search seat. Ignore a reply after the scope or its reader changed. */
function useMailboxTotal(
  scope: SearchListInput["scope"],
  read: SearchListInput["readMailboxTotal"],
): number | null {
  const [answer, setAnswer] = useState<{
    scope: SearchListInput["scope"];
    read: typeof read;
    total: number | null;
  }>();
  useEffect(() => {
    if (!read || scope === false) return;
    let current = true;
    void read().then(
      (total) => {
        if (current) setAnswer({ scope, read, total });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [read, scope]);
  return answer && answer.scope === scope && answer.read === read ? answer.total : null;
}

function usePeopleOverview(engine: SearchListInput["engine"], readPeople: SearchListInput["people"]) {
  const peopleStamp = readPeople ? engine.read().stampOf("message") : 0;
  return useMemo(
    () =>
      readPeople
        ? atStamp(
            peopleStamp,
            restingPeople(readPeople(), engine.read().list<SearchHit["message"]>("message")),
          )
        : [],
    [readPeople, engine, peopleStamp],
  );
}

interface SearchInteraction {
  readonly open: (hit: SearchHit, entered?: boolean) => void;
  readonly length: number;
  readonly cursor: ReturnType<typeof useSearchCursor>;
  readonly hitAt: Slots["hitAt"];
  readonly question: string;
  readonly win: ListWindow;
  readonly walker: StoreSearchWalker | null;
  readonly waitingForStore: boolean;
  readonly present: (message: EngineMessage) => EngineMessage | null;
  readonly unread: boolean;
}

function useSearchInteraction(input: SearchListInput, list: SearchInteraction) {
  const { open, length, cursor, hitAt, question, win, walker, present } = list;
  const { boxRef, onQuery, onExit, query, t } = input;
  /* RE-ENTRY DOES NOT APPEND: the kept text is selected on mount, so the first key replaces it ("invoicetickets");
     on every change it would swallow live typing's second character. */
  const openedOnMount = useRef(input.openId != null);
  useEffect(() => {
    const box = openedOnMount.current ? null : boxRef.current;
    if (box && box.value.trim() !== "") box.select();
  }, [boxRef]);
  const openAt = (i: number): void => {
    const target = hitAt(i);
    if (target !== null && target !== "gone") open(target);
  };
  const { openId, walkPreview, closePreview } = input;
  const afterAction = useSearchAfterAction({
    openId,
    question,
    index: cursor.at,
    length,
    hitAt,
    stillMatches: (message) => {
      const row = input.engine.storePageRow(message);
      return row !== null && present(row) !== null && !(list.unread && !row.unread);
    },
    nextPage:
      walker === null
        ? () => list.waitingForStore
        : (i) => {
            if (i < length) walker.want(i, i + 1);
            else if (!walker.atEnd() && !walker.atBound()) walker.more();
            else return false;
            return true;
          },
    open,
    close: closePreview,
  });
  const reveal = (i: number): void => {
    const el = input.scrollerRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (row) revealInScroller(el, row);
    else if (walker !== null) el.scrollTop = win.offsetOf(i);
    walker?.want(i, i + 1);
  };
  const pending = useRef<{ index: number; direction: number; question: string; openId: string } | null>(null);
  const step = (direction: number, start = cursor.at + direction): void => {
    for (let i = start; i >= 0 && i < length; i += direction) {
      const target = hitAt(i);
      if (target === "gone") continue;
      cursor.stepTo(i);
      reveal(i);
      if (openId && walkPreview) {
        if (target) open(target, false);
        else pending.current = { index: i, direction, question, openId };
      }
      return;
    }
  };
  useEffect(() => {
    const next = pending.current;
    if (next === null) return;
    if (next.question !== question || next.openId !== openId || next.index >= length) {
      pending.current = null;
    } else if (hitAt(next.index) !== null) {
      pending.current = null;
      step(next.direction, next.index);
    }
  });
  useSearchKeys({
    t,
    searchBy: input.searchBy,
    /* Escape clears the field as it stands, an operator still being typed too. */
    text: query.trim(),
    onQuery,
    onExit,
    boxRef,
    count: length,
    cursor: cursor.at,
    step,
    previewOpen: openId !== undefined && openId !== null,
    walkPreview: walkPreview === true,
    closePreview: input.dismissPreview ?? closePreview,
    openAt,
  });
  return { open, afterAction };
}

function similarStart(storeReady: boolean, similarOn: boolean, paint: DevicePaint): number | null {
  if (storeReady) return similarOn ? 0 : null;
  return paint.shown.length > paint.shownExact.length ? paint.shownExact.length : null;
}
