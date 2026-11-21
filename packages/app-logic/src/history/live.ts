/**
 * HISTORY, LIVE: what History's seat calls once (`packages/app/src/history/Seat.tsx`). Every letter the account owns,
 * newest first: the store's timeline (`useStoreTimeline`, the engine's one walker), the mirror painting first and
 * standing where the store does not answer. Nothing here has moved: each row names the folder the mail server keeps
 * it in. A letter inside a delete's Undo window is gone from the list while the window stands.
 *
 * The viewport drives paging. The timeline answers the count and the rail independently of loaded rows.
 */
import { useEffect, useMemo, type RefObject } from "react";
import { physicalFolderOf } from "@ohmail/client-engine";
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { atStamp, useDerivedVersion, useEngine } from "../engine/context.js";
import { useListWindow } from "../lists/list-window.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { usePlaceListFeed, usePlaceListKeys, type PlaceListLiveOwn } from "../place-list/live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { newestFirst } from "../place-list/place-list.js";
import { useDayClock } from "../session/day-clock.js";
import { useStoreTimeline } from "../session/store-timeline.js";
import { stampOver } from "../text/format.js";
import { monthsOf, useHistoryList, type HistoryModel } from "./model.js";

/** What only History's seat can read. */
export interface HistoryLiveOwn extends PlaceListLiveOwn {
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  readonly scroller: RefObject<HTMLDivElement | null>;
  /** A folder as the person reads it: its place's word where it is a place's, else its last part. */
  readonly placeLabel: (folder: string) => string;
}

export function useHistoryLive(args: PlaceLiveArgs, own: HistoryLiveOwn): HistoryModel {
  const engine = useEngine();
  const derived = useDerivedVersion();
  const now = useDayClock(null, own.zone);
  /* The mirror's own rows, newest first: the timeline's first paint, and what stands where the store is silent. */
  const mirrorRows = useMemo(
    () => atStamp(derived, [...engine.read().list<EngineMessage>("message")].sort(newestFirst)),
    [engine, derived],
  );
  const tl = useStoreTimeline(engine, derived, mirrorRows);
  const window = useListWindow({ scrollerRef: own.scroller, count: tl.length, inserted: tl.shifted });
  const { want } = tl;
  useEffect(
    () => want(window.visibleStart, window.visibleEnd),
    [want, window.visibleStart, window.visibleEnd],
  );
  const { held } = args.press.deleting;
  const slots = useMemo(() => {
    const out: (EngineMessage | "gone" | null)[] = [];
    for (let i = window.start; i < window.end; i++) {
      const row = tl.rowAt(i);
      out.push(row !== null && row !== "gone" && held.has(row.id) ? "gone" : row);
    }
    return out;
  }, [tl, held, window.start, window.end]);
  const messages = useMemo(
    () => slots.filter((row): row is EngineMessage => row !== null && row !== "gone"),
    [slots],
  );
  const feed = usePlaceListFeed(args, own, messages);
  /* Where the store does not answer, the mirror's facts say whether the list may be called empty; else the store's. */
  const mirrorOnly = tl.state === "unavailable";
  const { placeLabel } = own;
  const folderPaths = useMemo(
    () =>
      new Set(
        atStamp(derived, engine.read().list<FolderEntity>("folder")).map((folder) =>
          JSON.stringify([folder.mailboxId, folder.name]),
        ),
      ),
    [engine, derived],
  );
  const months = useMemo(
    () => (tl.state === "ready" ? tl.segments : monthsOf(mirrorRows, own.zone)),
    [tl.state, tl.segments, mirrorRows, own.zone],
  );
  const model = useHistoryList({
    ...feed.list,
    arrival: "first",
    messages,
    windowed: { scroller: own.scroller, window, slots, jump: tl.jump },
    timelineCount: tl.state === "ready" || mirrorOnly ? (tl.total ?? tl.length) : undefined,
    timelineMonths: months,
    settled: mirrorOnly ? feed.settled : tl.state === "ready",
    owed: mirrorOnly ? feed.owed : false,
    placeOf: useStableCallback((m: EngineMessage) => {
      const folder = physicalFolderOf(m);
      return folderPaths.has(JSON.stringify([m.mailboxId, folder])) ? folder : placeLabel(folder);
    }),
    stamp: useMemo(() => stampOver(now), [now]),
    store: useMemo(() => ({ down: tl.state === "unanswered", retry: tl.retry }), [tl.state, tl.retry]),
  });
  usePlaceListKeys(model.list, own);
  return model;
}
