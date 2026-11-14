/**
 * THE THREE PILES AS PLACES OF THE FRAME: one body and one seat for the three (the switch moves between them in
 * place), each its own rail entry and count, the reader's column beside them, which keeps its open letter over a walk
 * away and back. Each count reads the mail ground alone (`usePileCount`): it is drawn for the frame's life, while the
 * piles' own model stands only with their columns.
 */
import { usePileCount, type PileId } from "@ohmail/app-logic/piles";
import type { PlaceEntry, PlaceRail } from "../frame/contract.js";
import { PilesList } from "./PilesList.js";
import { PilesSeat } from "./Seat.js";

function countOf(pile: PileId): NonNullable<PlaceRail["useCount"]> {
  return function usePileRailCount(): { count: string; hot: boolean } | null {
    const n = usePileCount(pile);
    return n !== null && n > 0 ? { count: String(n), hot: false } : null;
  };
}

const panes = {
  kind: "columns",
  List: PilesList,
  Reading: "reader",
  Above: PilesSeat,
  keepsOpen: true,
} as const;

export const laterPlace: PlaceEntry = {
  id: "later",
  body: "piles",
  rail: {
    group: "later",
    icon: "later",
    label: "title",
    keyHint: "g l",
    keyLabel: "goLater",
    drop: "later",
    useCount: countOf("later"),
  },
  panes,
};
export const parkedPlace: PlaceEntry = {
  id: "parked",
  body: "piles",
  rail: {
    group: "later",
    icon: "parked",
    label: "title",
    keyHint: "g p",
    keyLabel: "goParked",
    drop: "aside",
    useCount: countOf("parked"),
  },
  panes,
};
export const resurfacePlace: PlaceEntry = {
  id: "resurface",
  body: "piles",
  rail: {
    group: "later",
    icon: "resurface",
    label: "title",
    keyHint: "g b",
    keyLabel: "goResurface",
    drop: "resurface",
    useCount: countOf("resurface"),
  },
  panes,
};
