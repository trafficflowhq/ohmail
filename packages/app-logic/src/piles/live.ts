"use client";

/**
 * THE THREE PILES, LIVE (Answer Later, Parked, Resurface): what the piles' seat calls once
 * (`packages/app/src/piles/Seat.tsx`). It assembles the piles' input (`PilesInput`) from the frame's side (`args`),
 * the mail ground's readers and the engine, and calls the piles' model (`usePiles`) once. One body for the three
 * places, as their model is one: the pile is the place the address names.
 *
 * WHERE EACH INPUT COMES FROM. The frame: the pile, the open letter and the way to open one, the one press seam.
 * The ground: the presented mirror the piles are read from (the very reader the rows' letters resolve through). The
 * list places' one verbs record (`usePlaceVerbs`): a letter's verbs, read state through the seam and the mail state's
 * two facts every count waits for. What only the seat can read (`own`): what a list place's seat hands, and the
 * clock's zone. The list's walk stands in the model; its keys are bound here, once.
 *
 * EVERY PRESS LEAVES THROUGH `args.press`: a letter's verbs are the list places' one record, never spelled here.
 */
import { useCallback, useMemo } from "react";
import { triagePiles, type EntityReader, type TriagePiles } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { atStamp, useDerivedVersion } from "../engine/context.js";
import type { PlaceLiveArgs, PlaceName } from "../lists/place-live.js";
import { usePlaceListFeed, type PlaceListLiveOwn } from "../place-list/live.js";
import { useListWalkKeys } from "../place-list/walk.js";
import { usePresented } from "../reading/presented-mirror.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import { PILE_IDS, usePiles, type PileId, type PilesModel } from "./use-piles.js";

/** The piles list nothing past the mirror: every row resolves through the presented mirror itself. */
const NO_SURFACE: readonly EngineMessage[] = [];

/** The piles of a presented mirror, by the stamp they were read at. */
const PILES_AT = new WeakMap<EntityReader, { readonly at: number; readonly piles: TriagePiles }>();

/**
 * The piles the mail ground presents, derived once a mirror's stamp: the three rail entries and the piles' seat read
 * this one, as the engine keeps its own pile rows (`pileRowsOf`).
 */
export function useGroundPiles(): TriagePiles {
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  return useMemo(() => {
    const held = PILES_AT.get(presented);
    if (held !== undefined && held.at === derived) return held.piles;
    const piles = triagePiles(presented);
    PILES_AT.set(presented, { at: derived, piles });
    return piles;
  }, [presented, derived]);
}

/** The pile a place of the frame is, or null for a place that is none of the three. */
export function pileOf(place: PlaceName): PileId | null {
  return (PILE_IDS as readonly string[]).includes(place) ? (place as PileId) : null;
}

/**
 * What only the piles' seat can read: what a list place's seat hands (the verbs record's, the walk's words, where the
 * keyboard's zones stand), and the clock's zone.
 */
export interface PilesLiveOwn extends PlaceListLiveOwn {
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  readonly openReply: (id: string) => void;
  readonly closeReply: (id: string) => void;
}

export function usePilesLive(args: PlaceLiveArgs, own: PilesLiveOwn): PilesModel {
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  const { route } = args;
  const pile = pileOf(route.place);
  if (pile === null)
    throw new Error(`usePilesLive: the piles' seat stands at ${route.place}, which is no pile`);
  const now = useDayClock(null, own.zone);
  const piles = useGroundPiles();
  const messageOf = useCallback(
    (id: string) => atStamp(derived, presented.get<EngineMessage>("message", id) ?? null),
    [presented, derived],
  );
  const { list, settled, owed } = usePlaceListFeed(args, own, NO_SURFACE);

  const model = usePiles({
    ...list,
    pile,
    piles,
    messageOf,
    settled,
    owed,
    onAction: list.act,
    write: own.openReply,
    close: own.closeReply,
    stamp: useMemo(() => stampOver(now), [now]),
    /* Today's view and the studio alike stand a pile's first letter open beside it on arrival. */
    arrival: "first",
  });
  useListWalkKeys(model.walk, own);
  return model;
}
