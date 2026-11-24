/**
 * THE ONE LIST'S SLOTS: the store's walked rows once it answered (a row the device also found keeps its highlighted
 * words), else the device's paint — its matches, then the closest words.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo } from "react";
import type {
  LocalSearchResult,
  SearchHit,
  ServerSearchSort,
  StoreSearchWalker,
} from "@ohmail/client-engine";
import { matchesFolder, type Pressed } from "./facets.js";
import { useDevicePaint, useLocalPass, type DevicePaint } from "./local-pass.js";
import type { Question } from "./question.js";
import { useStorePass } from "./store-pass.js";
import type { SearchListInput, SearchSlot } from "./types.js";
import { verdictModel } from "./verdict.js";

export interface Slots {
  hitAt(i: number): SearchHit | "gone" | null;
  slotAt(i: number): SearchSlot;
}

function useSlots(
  result: LocalSearchResult | null,
  walker: StoreSearchWalker,
  storeReady: boolean,
  paint: DevicePaint,
  similarOn: boolean,
  present: (message: EngineMessage) => EngineMessage | null,
): Slots {
  /** The device's hits by id. */
  const deviceHits = useMemo(() => {
    const byId = new Map<string, SearchHit>();
    for (const hit of [...(result?.items ?? []), ...(result?.similar ?? [])]) byId.set(hit.message.id, hit);
    return byId;
  }, [result]);
  const hitAt = (i: number): SearchHit | "gone" | null => {
    if (!storeReady) {
      const hit = paint.shown[i];
      if (!hit) return null;
      const m = present(hit.message);
      return m === null ? "gone" : m === hit.message ? hit : { ...hit, message: m };
    }
    const row = walker.rowAt(i);
    if (row === null || row === "gone") return row;
    const m = present(row);
    if (m === null) return "gone";
    return { message: m, score: 0, matches: deviceHits.get(m.id)?.matches ?? [] };
  };
  const slotAt = (i: number): SearchSlot => {
    const hit = hitAt(i);
    if (hit === "gone") return { kind: "gone" };
    if (hit === null) return { kind: "owed" };
    return { kind: "hit", hit, similar: storeReady ? similarOn : i >= paint.shownExact.length };
  };
  return { hitAt, slotAt };
}

/** Keep the store's slot positions and apply the latest scope to rows the reader may have changed. */
export function useResultSlots(
  { engine, holds, openId }: Pick<SearchListInput, "engine" | "holds" | "openId">,
  text: string,
  sort: ServerSearchSort,
  pressed: Pressed,
  { narrowing, storeFilters, isNarrowed }: Question,
) {
  const { result, tookMs } = useLocalPass(engine, text, narrowing.person);
  const store = useStorePass(engine, text, sort, storeFilters, result, isNarrowed);
  const { walker, ready } = store;
  const storeLength = ready === null ? 0 : walker.length();
  const paint = useDevicePaint(result, sort, pressed, ready !== null, narrowing, openId);
  const similarOn = ready === null ? paint.similarOn : ready.tier === "similar" && storeLength > 0;
  // The store owns sender and attachment matches. Reader actions can change placement or read state.
  const place = pressed.find((facet) => facet.group === "folder");
  const present = (message: EngineMessage): EngineMessage | null => {
    if (holds?.held.has(message.id) || (message.id !== openId && narrowing.unread && !message.unread))
      return null;
    const folder = holds?.places.get(message.id);
    const shown = folder !== undefined && folder !== message.folder ? { ...message, folder } : message;
    return place === undefined || matchesFolder(shown, place) ? shown : null;
  };
  const slots = useSlots(result, walker, ready !== null, paint, similarOn, present);
  const length = ready === null ? paint.shown.length : storeLength;
  let removed = 0;
  for (let i = 0; i < length; i++) {
    if (slots.hitAt(i) === "gone") removed++;
  }
  const count = ready === null ? 0 : Math.max(0, ready.total - removed);
  const found = ready !== null && pressed.length === 0 ? Math.max(count, length - removed) : length - removed;
  const verdict = verdictModel(
    {
      text,
      passState: store.passState,
      ready: ready && removed > 0 ? { ...ready, total: count } : ready,
      cause: store.cause,
      filtered: isNarrowed,
    },
    { answered: result !== null, tookMs, atEnd: walker.atEnd(), walked: storeLength },
  );
  return { result, tookMs, store, storeLength, paint, similarOn, present, length, found, verdict, ...slots };
}
