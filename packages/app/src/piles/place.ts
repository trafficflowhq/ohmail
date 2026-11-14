/**
 * THE THREE PILES AS PLACES OF THE FRAME: one body for the three (the switch moves between them in place), each its
 * own rail entry and count, the reader's column beside them.
 */
import { useContext } from "react";
import { PilesModelContext, type PileId } from "@ohmail/app-logic/piles";
import type { PlaceEntry } from "../frame/contract.js";
import { PilesList } from "./PilesList.js";

function countOf(pile: PileId) {
  return function usePileCount(): { count: string; hot: boolean } | null {
    /* Said only where the piles' model stands above the rail (the seat's Above); else nothing. */
    const model = useContext(PilesModelContext);
    if (model === null) return null;
    const n = model.counts[pile];
    return model.mayState && n > 0 ? { count: String(n), hot: false } : null;
  };
}

const panes = { kind: "columns", List: PilesList, Reading: "reader" } as const;

export const laterPlace: PlaceEntry = {
  id: "later",
  body: "piles",
  rail: { group: "later", icon: "later", label: "title", keyHint: "g l", useCount: countOf("later") },
  panes,
};
export const parkedPlace: PlaceEntry = {
  id: "parked",
  body: "piles",
  rail: { group: "later", icon: "parked", label: "title", keyHint: "g p", useCount: countOf("parked") },
  panes,
};
export const resurfacePlace: PlaceEntry = {
  id: "resurface",
  body: "piles",
  rail: { group: "later", icon: "resurface", label: "title", keyHint: "g b", useCount: countOf("resurface") },
  panes,
};
