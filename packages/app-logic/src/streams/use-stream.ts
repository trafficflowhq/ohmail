"use client";

/**
 * THE MODEL OF A STREAM PLACE (News, Receipts): the pile in its order with the line between new and seen, the count
 * the head says, the read rule on the reading column's scroller, the leave's one commit, Mark unread and Mark all
 * read. Called once, above both panes; the list and the stream read it from `StreamModelContext`.
 */
import type { StreamInput, StreamModel, StreamPlace } from "./stream-model.js";
export type { StreamInput, StreamModel, StreamPlace } from "./stream-model.js";
import { countWhen } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type RefObject,
} from "react";
import { appointmentStamp } from "@ohmail/client-engine";
import { createStreamLeave, leaveSaysSomething } from "./leave.js";
import { streamReadView, useStreamRead, type StreamReadDom } from "./stream-read-dom.js";
import { useStreamScroll, type StreamCardNames, type StreamScroll } from "./stream-scroll.js";
import { readerZone } from "../reader/head-model.js";

/**
 * When the line was drawn, as the line says it on the reader's own calendar: the clock today, the weekday and the
 * clock inside the week, the date past it (the shipped stream's `waterlineStamp`).
 */
export function lineStampOf(iso: string, now: Date, locale: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : appointmentStamp(at, now, readerZone(), locale);
}

/** The stream's items, as the reading column draws them: what the scroll measures and lands. */
export const STREAM_ITEM: StreamCardNames = { base: "st-item", attr: "data-stream-item", pending: "st-pend" };

/** Where this window left each pile. No letter is kept between visits. */
export const StreamVisits = createContext<{
  readonly cursors: Set<StreamPlace>;
  readonly positions: Map<
    StreamPlace,
    { readonly top: number; readonly id: string | null; readonly offset: number | null }
  >;
} | null>(null);

export const StreamModelContext: Context<StreamModel | null> = createContext<StreamModel | null>(null);

export function useStreamModel(): StreamModel {
  const model = useContext(StreamModelContext);
  if (model === null) throw new Error("useStreamModel() was called with no stream place above it");
  return model;
}

/** Commit the read rule's range once when the person leaves or the tab goes away. */
function useStreamLeave(
  inputRef: RefObject<StreamInput>,
  itemsRef: RefObject<readonly EngineMessage[]>,
  read: StreamReadDom,
  scroll: StreamScroll,
) {
  const [leave] = useState(createStreamLeave);
  const { leaveState, preview, rule } = read;
  const remember = useCallback((): void => {
    leave.remember({ ...leaveState(), ...scroll.range() }, itemsRef.current);
    preview();
  }, [leave, leaveState, itemsRef, preview, scroll]);
  const beforePreview = useCallback((): void => {
    remember();
    scroll.resetRange();
  }, [remember, scroll]);
  useEffect(() => {
    const commit = (): void => {
      remember();
      const c = leave.take(itemsRef.current, rule.keptUnread);
      const held = inputRef.current.partition.waterline?.newestSeenId ?? null;
      if (c && leaveSaysSomething(c, held)) inputRef.current.onLeaveSeen(c);
    };
    const off = inputRef.current.onPageHide(commit);
    return () => {
      off();
      commit();
    };
  }, [inputRef, itemsRef, leave, remember, rule]);
  return beforePreview;
}

/** Keep unread a letter the panel or another device made unread during this visit. */
function useExternalUnreadHolds(
  items: readonly EngineMessage[],
  keepUnread: StreamReadDom["keepUnread"],
): void {
  const wasUnread = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const m of items) {
      const before = wasUnread.current.get(m.id);
      if (before === false && m.unread) keepUnread(m.id);
      wasUnread.current.set(m.id, m.unread);
    }
  }, [items, keepUnread]);
}

/** Distinguish locally chosen rows from Search hits and incoming history links. */
function useStreamAddress(
  addressId: string | null,
  entered: StreamInput["entered"],
  beforePreview: () => void,
) {
  const pending = useRef<{ id: string; inPlace: boolean } | null>(null);
  const address = useRef({ id: addressId, local: false, inPlace: false });
  useLayoutEffect(() => {
    if (address.current.id === addressId) return;
    const local = addressId !== null && pending.current?.id === addressId;
    address.current = { id: addressId, local, inPlace: local && (pending.current?.inPlace ?? false) };
    pending.current = null;
    if (addressId === null || local || entered?.letter === addressId) return;
    beforePreview();
  }, [addressId, entered, beforePreview]);
  const openedLocally = useCallback((id: string) => address.current.id === id && address.current.local, []);
  const openedInPlace = useCallback((id: string) => address.current.id === id && address.current.inPlace, []);
  const requestLocalOpen = useCallback((id: string, inPlace: boolean) => {
    pending.current = { id, inPlace };
  }, []);
  return { openedLocally, openedInPlace, requestLocalOpen };
}

/** Receipts fetches the cursor's body. Its viewport lookahead builds previews from the cache. */
function useReceiptCursorBody(
  { place, openId, bodyReady, prefetch, prefetchSource, textOf }: StreamInput,
  items: readonly EngineMessage[],
  cursor: string | null,
) {
  const kept = useRef<string | null>(null);
  const id = useMemo(() => {
    if (place !== "receipts") return null;
    if (cursor !== null || openId !== null) return cursor;
    const retained = kept.current;
    return retained !== null && items.some((item) => item.id === retained)
      ? retained
      : (items.find((item) => item.unread)?.id ?? items[0]?.id ?? null);
  }, [place, cursor, openId, items]);
  useEffect(() => {
    if (place !== "receipts") return;
    kept.current = cursor === null ? id : null;
    if (id !== null && !(bodyReady?.(id) ?? textOf(id) !== null)) prefetch?.([id]);
  }, [place, cursor, id, bodyReady, textOf, prefetch, prefetchSource]);
}

function useStreamHydration(inputRef: RefObject<StreamInput>): StreamModel["hydrateOpened"] {
  return useCallback(
    (id: string, ask = true) => {
      const current = inputRef.current;
      current.revealPrefetch?.(id);
      if (ask && current.textOf(id) === null) current.hydrate([id]);
    },
    [inputRef],
  );
}

export function useStream(input: StreamInput): StreamModel {
  const {
    partition,
    items,
    inputRef,
    itemsRef,
    toolbar,
    scrolled,
    setScrolled,
    sameAddress,
    selected,
    openId,
    hadCursor,
    standingId,
    scroller,
    attach,
    read,
    scroll,
    current,
    setInlineId,
  } = useStreamViewport(input);
  const beforePreview = useStreamLeave(inputRef, itemsRef, read, scroll);
  useExternalUnreadHolds(items, read.keepUnread);
  const hydrateOpened = useStreamHydration(inputRef);
  const { openedLocally, openedInPlace, requestLocalOpen } = useStreamAddress(
    input.openId,
    input.entered,
    beforePreview,
  );
  const { prefetch, prefetchSource } = input;
  useEffect(() => {
    if (input.place === "news" && openId !== null && input.openId === openId && !openedLocally(openId))
      prefetch?.([openId]);
  }, [input.place, input.openId, openId, openedLocally, prefetch, prefetchSource]);
  useReceiptCursorBody(input, items, openId ?? selected);
  const [keyboardOpened, setKeyboardOpened] = useState<{ readonly id: string } | null>(null);
  useLayoutEffect(() => {
    if (keyboardOpened !== null && keyboardOpened.id !== input.openId) setKeyboardOpened(null);
  }, [keyboardOpened, input.openId]);
  const selectForReading = useCallback(
    (id: string, viewport = false) => {
      read.enter(id, viewport);
      if (scrolled && id === openId && scrolled.id !== id) scroll.scrollTo(id);
      setScrolled(null);
    },
    [read, openId, scroll, scrolled, setScrolled],
  );
  const open = useCallback(
    (id: string, byKeyboard = false, viewport = false, inPlace = false) => {
      setKeyboardOpened(byKeyboard ? { id } : null);
      selectForReading(id, viewport);
      if (inputRef.current.openId !== id) requestLocalOpen(id, inPlace);
      inputRef.current.open(id);
    },
    [inputRef, selectForReading, requestLocalOpen],
  );
  const stepTo = (id: string): void => {
    scroll.select(id);
    if (input.inlineKeys) {
      selectForReading(id);
      setInlineId(id);
    } else open(id);
  };

  const keepUnread = read.keepUnread;
  const markUnread = useCallback(
    (id: string) => {
      keepUnread(id);
      inputRef.current.markUnread(id);
    },
    [inputRef, keepUnread],
  );
  const markAllRead = useCallback(() => {
    inputRef.current.markAllRead(itemsRef.current.filter((m) => m.unread).map((m) => m.id));
  }, [inputRef, itemsRef]);
  const textOf = useCallback((id: string) => inputRef.current.textOf(id), [inputRef]);
  const bodyStateOf = useCallback((id: string) => inputRef.current.bodyStateOf?.(id), [inputRef]);
  return {
    entered: input.entered,
    place: input.place,
    mayState: countWhen({ settled: input.settled, count: items.length, pending: input.owed }, true) === true,
    items,
    freshCount: partition.fresh.length,
    lineShown: partition.waterline !== null,
    lineAt: partition.waterline?.at ?? null,
    newCount: partition.newCount,
    openId: selected,
    toolbar,
    standingId: input.openId === null ? (current ?? standingId) : null,
    actionVisit: openId !== null || hadCursor,
    actionId: openId ?? selected,
    canDeleteKey: (id) =>
      id === selected &&
      !read.flying() &&
      !read.judging() &&
      (!sameAddress || scroll.settledCursorInReadView(id)),
    canAnswerKey: (id) => id === openId && scroll.settledInReadView(id),
    addressedId: openId,
    openedLocally,
    openedInPlace,
    stamp: input.stamp,
    scroller,
    attach,
    read,
    scroll,
    current,
    open,
    stepTo,
    closeInline: () => clearStreamCursor(setInlineId, setScrolled),
    keyboardOpened: keyboardOpened?.id === openId ? keyboardOpened : null,
    markUnread,
    markAllRead,
    hydrateOpened,
    prefetch,
    hasPreviewMarkup: (id) => input.hasPreviewMarkup?.(id) ?? false,
    textOf,
    bodyStateOf,
  };
}

function useStreamViewport(input: StreamInput) {
  const { partition } = input;
  const items = useMemo(() => [...partition.fresh, ...partition.seen], [partition.fresh, partition.seen]);
  const order = useMemo(() => items.map((m) => m.id), [items]);
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const [inlineId, setInlineId] = useState<string | null>(null);
  const inline =
    input.inlineKeys && input.openId === null && inlineId !== null && byId.has(inlineId) ? inlineId : null;
  if (inline !== inlineId) setInlineId(inline);
  // A linked item can arrive after the address. Only its own stream may open, fetch or read it.
  const openId = input.openId !== null && byId.has(input.openId) ? input.openId : inline;
  const [scroller, attach] = useState<HTMLDivElement | null>(null);
  const toolbar = useRef<string | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const visits = useContext(StreamVisits)?.cursors;
  const [hadCursor] = useState(() => visits?.has(input.place) === true);
  const [scrolled, setScrolled] = useState<{
    routeId: string | null;
    listed: boolean;
    id: string;
  } | null>(() => {
    const first = order[0];
    return input.openId === null && first && hadCursor ? { routeId: null, listed: false, id: first } : null;
  });
  // A pending addressed item can arrive later, at which point the address takes over again.
  const sameAddress = scrolled?.routeId === input.openId && scrolled.listed === (openId !== null);
  if (scrolled && !sameAddress) setScrolled(null);
  const wanted = sameAddress ? scrolled.id : openId;
  const selected = wanted !== null && byId.has(wanted) ? wanted : null;

  /* A jump to an end that rested: the scroll's run starts again where it rests (set once the scroll stands, below). */
  const landedRef = useRef<() => void>(() => {});
  const judgedRef = useRef<() => void>(() => {});
  const scrollRef = useRef<StreamScroll | null>(null);
  const bodyReady = input.bodyReady ?? ((id: string) => input.textOf(id) !== null);
  const read = useStreamRead({
    scroller,
    receipts: input.place === "receipts",
    openId,
    readyId: openId !== null && bodyReady(openId) ? openId : null,
    order,
    factsOf: (id) => {
      const m = byId.get(id);
      return m ? { unread: m.unread, ready: bodyReady(id) } : null;
    },
    write: (ids) => inputRef.current.markSeen(ids),
    onLanded: () => landedRef.current(),
    onJudged: () => judgedRef.current(),
    readingBlocked: () => scrollRef.current?.readingBlocked() ?? false,
    pendingShift: () => scrollRef.current?.pendingShift() ?? 0,
  });

  /* The scroll: an app move is no hand's, and drives nothing by itself; a press that moves it drives it (`open`). */
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (selected === null) visits?.delete(input.place);
    else visits?.add(input.place);
  }, [visits, input.place, selected]);
  const [standing, setStanding] = useState(() => order[0] ?? null);
  const standingId = standing !== null && byId.has(standing) ? standing : (order[0] ?? null);
  if (standing !== standingId) setStanding(standingId);
  const indexOf = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]);
  const scroll = useStreamScroll({
    scroller,
    card: STREAM_ITEM,
    contentKey: order,
    cursor: openId,
    onCurrentChange: (id, byHand) => {
      setCurrent(id);
      if (byHand) setScrolled({ routeId: input.openId, listed: openId !== null, id });
    },
    pileIndexOf: (id) => indexOf.get(id) ?? -1,
    seam: {
      own: read.own,
      moved: read.moved,
      hands: read.hands,
      landing: read.flying,
      edgeLanding: read.edgeFlight,
      judging: read.judging,
      settled: read.settled,
      readView: streamReadView,
    },
  });
  landedRef.current = scroll.endLanded;
  judgedRef.current = scroll.judged;
  scrollRef.current = scroll;

  return {
    partition,
    items,
    inputRef,
    itemsRef,
    toolbar,
    scrolled,
    setScrolled,
    sameAddress,
    selected,
    openId,
    hadCursor,
    standingId,
    scroller,
    attach,
    read,
    scroll,
    current,
    setInlineId,
  };
}

function clearStreamCursor(inline: (id: null) => void, scrolled: (cursor: null) => void): void {
  inline(null);
  scrolled(null);
}
