/**
 * HISTORY, LIVE: what History's seat calls once (`packages/app/src/history/Seat.tsx`). Every letter the account owns,
 * newest first: the store's timeline (`useStoreTimeline`, the engine's one walker), the mirror painting first and
 * standing where the store does not answer. Nothing here has moved: each row names the folder the mail server keeps
 * it in. A letter inside a delete's Undo window is gone from the list while the window stands.
 *
 * WHAT IS NOT HERE YET (the seat's handover names each): the store reached past the mirror's length (the list draws
 * no window, so the pages asked are the ones the mirror would have drawn), the store's own count in the head, and
 * the month rail's jump to a month whose page is not read.
 */
import { useEffect, useMemo } from "react";
import { HISTORY_PAGE_ROWS, physicalFolderOf } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { atStamp, useDerivedVersion, useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { usePlaceListFeed, usePlaceListKeys, type PlaceListLiveOwn } from "../place-list/live.js";
import { newestFirst } from "../place-list/place-list.js";
import { useDayClock } from "../session/day-clock.js";
import { useStoreTimeline } from "../session/store-timeline.js";
import { stampOver } from "../text/format.js";
import { useHistoryList, type HistoryModel } from "./model.js";

/** What only History's seat can read. */
export interface HistoryLiveOwn extends PlaceListLiveOwn {
  /** The zone the reader's clock runs in. */
  readonly zone: string;
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
  /* The pages the mirror's length covers, at least the first: asked again as each lands. */
  const reach = Math.max(HISTORY_PAGE_ROWS, mirrorRows.length);
  const { want } = tl;
  useEffect(() => want(0, reach), [want, reach, tl]);
  /* The letters inside a delete's Undo window: the seam's own set, a new one whenever a window opens or closes. */
  const { held } = args.press.deleting;
  const messages = useMemo(() => {
    const out: EngineMessage[] = [];
    for (let i = 0; i < tl.length; i++) {
      const row = tl.rowAt(i);
      if (row !== null && row !== "gone" && !held.has(row.id)) out.push(row);
    }
    return out;
  }, [tl, held]);
  const feed = usePlaceListFeed(args, own, messages);
  /* Where the store does not answer, the mirror's facts say whether the list may be called empty; else the store's. */
  const mirrorOnly = tl.state === "unavailable";
  const { placeLabel } = own;
  const model = useHistoryList({
    ...feed.list,
    arrival: "first",
    messages,
    settled: mirrorOnly ? feed.settled : tl.state === "ready",
    owed: mirrorOnly ? feed.owed : false,
    placeOf: useMemo(() => (m: EngineMessage) => placeLabel(physicalFolderOf(m)), [placeLabel]),
    stamp: useMemo(() => stampOver(now), [now]),
    store: useMemo(() => ({ down: tl.state === "unanswered", retry: tl.retry }), [tl.state, tl.retry]),
  });
  usePlaceListKeys(model.list, own);
  return model;
}
