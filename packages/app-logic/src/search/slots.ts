/**
 * THE ONE LIST'S SLOTS: the store's walked rows once it answered (a row the device also found keeps its highlighted
 * words), else the device's paint — its matches, then the closest words.
 */
import { useMemo } from "react";
import type { LocalSearchResult, SearchHit, StoreSearchWalker } from "@ohmail/client-engine";
import type { DevicePaint } from "./local-pass.js";
import type { SearchSlot } from "./types.js";

export interface Slots {
  hitAt(i: number): SearchHit | "gone" | null;
  slotAt(i: number): SearchSlot;
}

export function useSlots(
  result: LocalSearchResult | null,
  walker: StoreSearchWalker,
  storeReady: boolean,
  paint: DevicePaint,
  similarOn: boolean,
): Slots {
  /** The device's hits by id. */
  const deviceHits = useMemo(() => {
    const byId = new Map<string, SearchHit>();
    for (const hit of [...(result?.items ?? []), ...(result?.similar ?? [])]) byId.set(hit.message.id, hit);
    return byId;
  }, [result]);
  const hitAt = (i: number): SearchHit | "gone" | null => {
    if (!storeReady) return paint.shown[i] ?? null;
    const m = walker.rowAt(i);
    if (m === null || m === "gone") return m;
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
