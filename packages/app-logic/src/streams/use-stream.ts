"use client";

/**
 * THE MODEL OF A STREAM PLACE (News, Receipts): the pile in its order with the line between new and seen, the count
 * the head says, the read rule on the reading column's scroller, the leave's one commit, Mark unread and Mark all
 * read. Called once, above both panes; the list and the stream read it from `StreamModelContext`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
} from "react";
import { appointmentStamp, type EngineMessage, type WaterlineMeta } from "@ohmail/client-engine";
import { leaveSaysSomething, streamLeaveCommit, type StreamLeaveCommit } from "./leave.js";
import { useStreamRead, type StreamReadDom } from "./stream-read-dom.js";
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

export type StreamPlace = "news" | "receipts";

/** What a host hands a stream place, under today's names (`ReadsView`'s and `ReceiptsView`'s props). */
export interface StreamInput {
  readonly place: StreamPlace;
  /** `MailState.settled` and `.owed`: nothing about the pile is stated before both allow it. */
  readonly settled: boolean;
  readonly owed: boolean;
  /** The engine's partition of the pile: above the line, at and below it, the line, the head's count. */
  readonly partition: {
    readonly fresh: readonly EngineMessage[];
    readonly seen: readonly EngineMessage[];
    readonly waterline: WaterlineMeta | null;
    readonly newCount: number;
  };
  /** The live write of the read rule: these ids read now (the shell batches them). */
  readonly markSeen: (ids: readonly string[]) => void;
  /** The leave's one anchored commit (`feed_mark_seen`). */
  readonly onLeaveSeen: (commit: StreamLeaveCommit) => void;
  /** Mark unread, through the press seam. */
  readonly markUnread: (id: string) => void;
  /** Mark all read: the unread ids, and the line to the top. */
  readonly markAllRead: (ids: readonly string[]) => void;
  /** An item's words while the reader's own letter is not handed: plain text, null while its body is not in. */
  readonly textOf: (id: string) => string | null;
  /** Ask for the bodies of these items. */
  readonly hydrate: (ids: readonly string[]) => void;
  /**
   * The tab going away is a leave too: the shell's page-hide, as a subscription (the web's and the desktop's
   * `pagehide`). Only a shell touches the window.
   */
  readonly onPageHide: (leave: () => void) => () => void;
  /** The item open (the route's), and the way to open one. */
  readonly openId: string | null;
  readonly open: (id: string | null) => void;
  /** A row's stamp in the list's own form (the shell's `displayTime`: the clock today, yesterday, the weekday, the date). */
  readonly stamp: (iso: string) => string;
}

export interface StreamModel {
  readonly place: StreamPlace;
  /** Nothing about the pile is said while the mailbox is not settled or a sync is owed. */
  readonly mayState: boolean;
  readonly items: readonly EngineMessage[];
  /** Items above the line; the line stands after them where a visit committed one. */
  readonly freshCount: number;
  readonly lineShown: boolean;
  /** When the line was drawn (the last visit's leave), as the pile says it; null where it says none. */
  readonly lineAt: string | null;
  readonly newCount: number;
  readonly openId: string | null;
  /** A row's stamp in the list's own form, as the seat hands it. */
  readonly stamp: (iso: string) => string;
  /** The stream's scroller once mounted, and the ref that mounts it (the reading sheet's `scroller`). */
  readonly scroller: HTMLDivElement | null;
  readonly attach: (el: HTMLDivElement | null) => void;
  readonly read: StreamReadDom;
  /** The stream's own scroll: the landing, the anchor hold, the cursor and the leave's range. */
  readonly scroll: StreamScroll;
  /** The item under the reading line, as the scroll last found it (a step's origin). */
  readonly current: string | null;
  /** A press on a row: the item opens and the stream is driven. */
  open(id: string): void;
  markUnread(id: string): void;
  markAllRead(): void;
  textOf(id: string): string | null;
}

export const StreamModelContext: Context<StreamModel | null> = createContext<StreamModel | null>(null);

export function useStreamModel(): StreamModel {
  const model = useContext(StreamModelContext);
  if (model === null) throw new Error("useStreamModel() was called with no stream place above it");
  return model;
}

export function useStream(input: StreamInput): StreamModel {
  const { partition } = input;
  const items = useMemo(() => [...partition.fresh, ...partition.seen], [partition.fresh, partition.seen]);
  const order = useMemo(() => items.map((m) => m.id), [items]);
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const [scroller, attach] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /* A jump to an end that rested: the scroll's run starts again where it rests (set once the scroll stands, below). */
  const landedRef = useRef<() => void>(() => {});

  const read = useStreamRead({
    scroller,
    order,
    factsOf: (id) => {
      const m = byId.get(id);
      return m ? { unread: m.unread, ready: inputRef.current.textOf(id) !== null } : null;
    },
    write: (ids) => inputRef.current.markSeen(ids),
    onLanded: () => landedRef.current(),
  });

  /* The scroll: an app move drives the stream as a press does, and the scroll it makes is not the hand's. */
  const [current, setCurrent] = useState<string | null>(null);
  const indexOf = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]);
  const scroll = useStreamScroll({
    scroller,
    card: STREAM_ITEM,
    contentKey: order,
    cursor: input.openId,
    onCurrentChange: setCurrent,
    pileIndexOf: (id) => indexOf.get(id) ?? -1,
    seam: { moved: () => read.enter(), landing: () => read.flying() },
  });
  landedRef.current = () => scroll.endLanded();

  /* A letter this visit read that turns unread again (the panel's Mark unread, another device) is held unread. */
  const wasUnread = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const m of items) {
      const before = wasUnread.current.get(m.id);
      if (before === false && m.unread && read.rule.read(m.id)) read.keepUnread(m.id);
      wasUnread.current.set(m.id, m.unread);
    }
  }, [items, read]);

  /* The leave: once, on the way out, and when the tab goes away. */
  /* The range is the scroll's (the newest item displayed, the last on screen); what was read is the rule's. */
  const leave = useRef(() => ({ ...read.leaveState(), ...scroll.range() }));
  leave.current = () => ({ ...read.leaveState(), ...scroll.range() });
  useEffect(() => {
    const commit = (): void => {
      const c = streamLeaveCommit(leave.current(), itemsRef.current);
      const held = inputRef.current.partition.waterline?.newestSeenId ?? null;
      if (c && leaveSaysSomething(c, held)) inputRef.current.onLeaveSeen(c);
    };
    const off = inputRef.current.onPageHide(commit);
    return () => {
      off();
      commit();
    };
  }, []);

  /* The bodies of what stands near: the opening run and the open item. */
  const hydrateRef = useRef(new Set<string>());
  useEffect(() => {
    const want = order.slice(0, 8).filter((id) => !hydrateRef.current.has(id) && input.textOf(id) === null);
    if (input.openId && !hydrateRef.current.has(input.openId) && input.textOf(input.openId) === null)
      want.push(input.openId);
    for (const id of want) hydrateRef.current.add(id);
    if (want.length > 0) input.hydrate(want);
  }, [order, input]);

  const open = useCallback(
    (id: string) => {
      read.enter();
      inputRef.current.open(id);
    },
    [read],
  );
  const markUnread = useCallback(
    (id: string) => {
      read.keepUnread(id);
      inputRef.current.markUnread(id);
    },
    [read],
  );
  const markAllRead = useCallback(() => {
    inputRef.current.markAllRead(itemsRef.current.filter((m) => m.unread).map((m) => m.id));
  }, []);
  const textOf = useCallback((id: string) => inputRef.current.textOf(id), []);

  const mayState = input.settled && !input.owed;
  return {
    place: input.place,
    mayState,
    items,
    freshCount: partition.fresh.length,
    lineShown: partition.waterline !== null,
    lineAt: partition.waterline?.at ?? null,
    newCount: partition.newCount,
    openId: input.openId,
    stamp: input.stamp,
    scroller,
    attach,
    read,
    scroll,
    current,
    open,
    markUnread,
    markAllRead,
    textOf,
  };
}
