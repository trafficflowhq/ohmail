/**
 * THE DEVICE'S OWN PASS: the mirror's instant index, asked per keystroke, keyed on what it can answer from. It paints
 * first, and it is what ends the search mark.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  NOT_DERIVED_FROM,
  type AddressResult,
  type LocalSearchResult,
  type OhmailEngine,
  type SearchHit,
  type ServerSearchSort,
} from "@ohmail/client-engine";
import { showSimilar } from "@trafficflow/core/search-rank";
import { endSearch } from "../session/ui-vitals.js";
import { applyFilter, type Pressed } from "./facets.js";
import { orderHits } from "./order.js";
import { applyNarrowing } from "./narrowing.js";
import type { SearchNarrowing } from "./question.js";
import type { SearchPerson } from "./types.js";

/**
 * WHAT THE INDEX ANSWERS FROM, subscribed on the engine handed in: the derived stamp (the mirror without the bodies:
 * the index reads none, and an open writes three) beside the index's own revision (the index lags the mirror on
 * purpose, so a build settling changes the answer with no record having moved). The formula is the shell's derived
 * stamp's (`useDerivedVersion`), over this engine rather than the provider's.
 */
function useIndexKey(engine: OhmailEngine): string {
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  const derived = useSyncExternalStore(
    subscribe,
    () => Math.max(engine.read().stampExcept(NOT_DERIVED_FROM), engine.placementStamp()),
    () => 0,
  );
  const indexRev = useSyncExternalStore(
    subscribe,
    () => engine.searchIndexRevision(),
    () => 0,
  );
  return `${derived}:${indexRev}`;
}

/** A person's letters on this device as the answer's matches, in the shape of the index's own answer. */
function personResult(theirs: AddressResult): LocalSearchResult {
  return {
    items: theirs.items,
    similar: [],
    tier: "exact",
    facets: { folder: {}, sender: [], hasAttachment: { true: 0, false: 0 }, unread: { true: 0, false: 0 } },
    coverage: { messages: theirs.items.length, full: 0 },
    indexing: theirs.indexing,
  };
}

export interface LocalPass {
  readonly result: LocalSearchResult | null;
  /** This device's pass, in ms. */
  readonly tookMs: number;
  /** The stamps the answer is of: a new one asks the index again. */
  readonly of: string;
}

/**
 * `alone`: a person set with no words. The device paints every letter on this device with them on that side (the
 * index's own `messagesWith`, over the same index), as its answer's matches.
 */
export function useLocalPass(engine: OhmailEngine, trimmed: string, alone: SearchPerson | null): LocalPass {
  const key = useIndexKey(engine);
  const asked = useMemo((): LocalPass => {
    if (!trimmed) return { result: null, tookMs: 0, of: key };
    const t0 = performance.now();
    const r = engine.search(trimmed);
    return { result: r, tookMs: Math.max(1, Math.round(performance.now() - t0)), of: key };
  }, [engine, trimmed, key]);
  const address = alone?.address ?? null;
  const dir = alone?.dir ?? "any";
  const theirs = useMemo((): LocalPass | null => {
    if (trimmed || address === null) return null;
    const t0 = performance.now();
    const result = personResult(engine.messagesWith(address, dir));
    return { result, tookMs: Math.max(1, Math.round(performance.now() - t0)), of: key };
  }, [engine, trimmed, address, dir, key]);
  const pass = theirs ?? asked;

  /**
   * THE SEARCH MARK ENDS AT THE FIRST RESULTS — the budget's "first results < 500 ms", measured
   * from the keystroke the shell started it on. The LOCAL pass is what ends it: those rows are
   * what a person sees, and waiting for the archive would report a network round trip as the
   * search's latency on every query that has one. Silent when nothing was pending, so a render
   * for a query the mark already closed records nothing rather than a zero.
   */
  useEffect(() => {
    if (pass.result !== null) endSearch();
  }, [pass.result]);

  /**
   * FILL THE INDEX WHILE THE PERSON IS STILL TYPING THE FIRST WORD. The engine builds it in
   * slices off the keystroke path, so the cost of asking early is nothing and the answer is
   * there by the second character rather than after it. Idempotent — a build already in flight
   * is joined, a fresh index is left alone.
   */
  useEffect(() => {
    void engine.warmSearchIndex();
  }, [engine]);

  return pass;
}

/** The device's first paint, ordered and narrowed: its matches, then the closest words when they are listed. */
export interface DevicePaint {
  /** The matches in the chosen order, before a facet narrows them (what the facets count). */
  readonly merged: readonly SearchHit[];
  /** The closest words in the chosen order, listed only under the floor of matches. */
  readonly mergedSimilar: readonly SearchHit[];
  readonly shownExact: readonly SearchHit[];
  /** The rows as one sequence: matches, then the closest words. */
  readonly shown: readonly SearchHit[];
  /** IS THERE A SIMILAR SECTION AT ALL — decided on the UNFILTERED exact count, so a facet can never make one appear. */
  readonly similarOn: boolean;
}

const NO_HITS: readonly SearchHit[] = [];

/** THE DEVICE'S FIRST PAINT — its two tiers, ordered by the chosen sort. Once the store's page lands the list IS the store's. */
export function useDevicePaint(
  result: LocalSearchResult | null,
  sort: ServerSearchSort,
  pressed: Pressed,
  storeReady: boolean,
  narrowing: SearchNarrowing,
  openId: string | null | undefined,
): DevicePaint {
  const exactRaw = result?.items ?? NO_HITS;
  const similarRaw = result?.similar ?? NO_HITS;
  const similarOn = showSimilar(exactRaw.length) && similarRaw.length > 0;
  const merged = useMemo(() => orderHits(exactRaw, sort), [exactRaw, sort]);
  const mergedSimilar = useMemo(
    () => (!similarOn || storeReady ? NO_HITS : orderHits(similarRaw, sort)),
    [similarRaw, similarOn, sort, storeReady],
  );
  const shownExact = useMemo(
    () => (storeReady ? NO_HITS : applyNarrowing(applyFilter(merged, pressed), narrowing, openId)),
    [merged, pressed, storeReady, narrowing, openId],
  );
  const shownSimilar = useMemo(
    () => (storeReady ? NO_HITS : applyNarrowing(applyFilter(mergedSimilar, pressed), narrowing, openId)),
    [mergedSimilar, pressed, storeReady, narrowing, openId],
  );
  const shown = useMemo(() => [...shownExact, ...shownSimilar], [shownExact, shownSimilar]);
  return { merged, mergedSimilar, shownExact, shown, similarOn };
}
