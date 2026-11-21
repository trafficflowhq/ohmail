/**
 * HISTORY AS A PLACE OF THE FRAME: its rail entry in More with the demo's key, its list, the reader's column beside it,
 * and its seat above both. The rail names it by no count: History holds every letter, and nothing waits there.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { HistoryList } from "./HistoryList.js";
import { HistorySeat } from "./Seat.js";

export const historyPlace: PlaceEntry = {
  id: "history",
  body: "history",
  rail: { group: "more", icon: "history", label: "title", keyHint: "g h", keyLabel: "goHistory" },
  panes: { kind: "columns", List: HistoryList, Reading: "reader", Above: HistorySeat, keepsOpen: true },
};
