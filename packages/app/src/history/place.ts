/**
 * HISTORY AS A PLACE OF THE FRAME: its rail entry in More, its list, and the reader's column beside it. Registered and
 * held by its tests; a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { HistoryList } from "./HistoryList.js";

export const historyPlace: PlaceEntry = {
  id: "history",
  body: "history",
  rail: { group: "more", icon: "history", label: "title", keyHint: "g h" },
  panes: { kind: "columns", List: HistoryList, Reading: "reader" },
};
