/**
 * SEARCH'S LIST, AS BEHAVIOUR — ONE list. The mirror's instant index paints first (the local pass, per keystroke);
 * the store's first page then REPLACES it in place — rows on screen that the store also returned keep their places —
 * and the rest is History's own list mechanism (`StoreSearchWalker`): pages by the store's cursor, at most
 * `HISTORY_PAGE_CACHE_ROWS` held, re-asked on the way back. Facets, the count and the indexing progress are the
 * store's, over the whole match set. Every pass ends in one of three verdicts. Guesses keep their own tier
 * (`search-rank`). No markup: a screen draws the model this hands back.
 */
import { useEffect, useMemo, useState } from "react";
import type { SearchHit } from "@ohmail/client-engine";
import { substringOpen } from "@trafficflow/core/search-rank";
import { atStamp } from "../engine/context.js";
import { ADDRESS_QUERY, OPERATOR_WORD } from "./constants.js";
import { useSearchCursor } from "./cursor.js";
import { filterOf, NONE_PRESSED, pressOf, useFacets, type Pressed } from "./facets.js";
import { useSearchKeys } from "./keys.js";
import { useDevicePaint, useLocalPass } from "./local-pass.js";
import { useSearchSort } from "./order.js";
import { restingPeople } from "./people.js";
import { useQuestion, wordsAsked } from "./question.js";
import { useStorePass, useStoreWindow } from "./store-pass.js";
import { useSlots } from "./slots.js";
import type { SearchListInput, SearchListModel } from "./types.js";
import { verdictModel } from "./verdict.js";

export function useSearchList(input: SearchListInput): SearchListModel {
  const { engine, scope, query, onQuery, onOpen, boxRef, scrollerRef, t, searchBy } = input;
  const [pressed, setPressed] = useState<Pressed>(NONE_PRESSED);
  /* Where the host's server takes a person, the place and the files are two parts of the question, each pressed and
     let go on its own, and they stand while the words change; elsewhere one facet stands at a time, as it always did. */
  const apart = searchBy === "people";
  const q = useQuestion(searchBy, pressed);
  const { narrowing, storeFilters, isNarrowed } = q;
  const trimmed = wordsAsked(query, searchBy);
  const resting = query.trim() === "" && !isNarrowed;
  const mailboxTotal = useMailboxTotal(scope, input.readMailboxTotal);
  const overviewPeople = usePeopleOverview(
    engine,
    searchBy === "people" && resting ? input.people : undefined,
  );
  const [sort, setSort] = useSearchSort(scope, trimmed === "" && isNarrowed);
  const { result, tookMs } = useLocalPass(engine, trimmed, narrowing.person);
  const store = useStorePass(engine, trimmed, sort, storeFilters, result, isNarrowed);
  const { walker, rev, ready, passState } = store;
  const storeReady = ready !== null;
  const storeLength = storeReady ? walker.length() : 0;
  const paint = useDevicePaint(result, sort, pressed, storeReady, narrowing);
  const similarOn = storeReady ? ready.tier === "similar" && storeLength > 0 : paint.similarOn;
  const { hitAt, slotAt } = useSlots(result, walker, storeReady, paint, similarOn);
  const facets = useFacets({
    store,
    engine,
    trimmed,
    pressed,
    apart,
    answered: result !== null,
    similarOn,
    paint,
    walked: storeLength,
    t,
  });
  /** Slots in the list: the store's walked rows once it answered, else the device's paint. */
  const length = storeReady ? storeLength : paint.shown.length;
  const egg = trimmed.toLowerCase() === "blanc" && length === 0;
  /** The count on the result line: the store's own once it answered, else the rows on screen. */
  const found = storeReady && pressed.length === 0 ? Math.max(ready.total, length) : length;
  // A new query, order or pressed facet is a new question: the cursor starts at the top.
  const asked = `${trimmed}\u0000${sort}\u0000${pressed.map((f) => `${f.group}:${f.label}`).join("\u0001")}\u0000${JSON.stringify(narrowing)}`;
  const cursor = useSearchCursor(asked, length, (i) => {
    const x = hitAt(i);
    return x === null || x === "gone" ? null : x.message.id;
  });
  const win = useStoreWindow(walker, storeReady, storeLength, rev, scrollerRef, cursor.at);
  useSearchInteraction(input, length, cursor, hitAt);
  return {
    ...verdictModel(
      { text: trimmed, passState, ready, cause: store.cause, filtered: isNarrowed },
      { answered: result !== null, tookMs, atEnd: walker.atEnd(), walked: storeLength },
    ),
    query,
    text: trimmed,
    boxRef,
    scrollerRef,
    sort,
    setSort,
    indexing: result?.indexing ?? false,
    tookMs,
    length,
    slotAt,
    /* The list's size as a screen reader hears it: the walked slots once the store's last page is in, the count the
       head states while that count is exact, and unknown (-1) until then. */
    setSize: walker.atEnd() ? storeLength : pressed.length === 0 && ready?.totalExact === true ? found : -1,
    found,
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
    similarFrom: similarStart(storeReady, similarOn, paint),
    /* Where the server takes them, a typed operator becomes its filter (the screen's); elsewhere it is said. */
    operatorsTyped: searchBy === "words" && OPERATOR_WORD.test(trimmed),
    egg,
    ...q.model,
    open: onOpen,
    type: (typed) => {
      if (!apart) setPressed(NONE_PRESSED);
      onQuery(typed);
    },
    submit: () => {
      if ((trimmed || isNarrowed) && !egg && store.available) store.retry();
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

function useSearchInteraction(
  input: SearchListInput,
  length: number,
  cursor: ReturnType<typeof useSearchCursor>,
  hitAt: ReturnType<typeof useSlots>["hitAt"],
): void {
  const { boxRef, onOpen, onQuery, onExit, query, t } = input;
  /* RE-ENTRY DOES NOT APPEND: the kept text is selected on mount, so the first key replaces it ("invoicetickets");
     on every change it would swallow live typing's second character. */
  useEffect(() => {
    const box = boxRef.current;
    if (box && box.value.trim() !== "") box.select();
  }, [boxRef]);
  const openAt = (i: number): void => {
    const target = hitAt(i);
    if (target !== null && target !== "gone") onOpen(target);
  };
  useSearchKeys({
    t,
    /* Escape clears the field as it stands, an operator still being typed too. */
    text: query.trim(),
    onQuery,
    onExit,
    boxRef,
    count: length,
    cursor: cursor.at,
    stepTo: cursor.stepTo,
    openAt,
  });
}

function similarStart(
  storeReady: boolean,
  similarOn: boolean,
  paint: ReturnType<typeof useDevicePaint>,
): number | null {
  if (storeReady) return similarOn ? 0 : null;
  return paint.shown.length > paint.shownExact.length ? paint.shownExact.length : null;
}
