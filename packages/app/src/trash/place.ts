/**
 * TRASH AS A PLACE OF THE FRAME: its rail entry in More, its list, and its own reading column (its rows are not in
 * the mirror). It takes the room: its panel's Restore runs through the press seam. Registered and held by its tests;
 * a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { TrashList } from "./TrashList.js";
import { TrashReading } from "./TrashReading.js";

export const trashPlace: PlaceEntry = {
  id: "trash",
  body: "trash",
  rail: { group: "more", icon: "trash", label: "title" },
  panes: { kind: "columns", List: TrashList, Reading: TrashReading, room: true },
};
