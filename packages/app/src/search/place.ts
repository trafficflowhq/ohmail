/**
 * SEARCH AS A PLACE OF THE FRAME: its rail entry (its key `/`, which stands at rest where keys are printed), its list,
 * the reader's column beside it, and its seat above both. A result opens where it is presented; one no place here can
 * show opens beside the list. Search counts nothing in the rail.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { SearchList } from "./SearchList.js";
import { SearchSeat } from "./Seat.js";

export const searchPlace: PlaceEntry = {
  id: "search",
  body: "search",
  rail: { group: "more", icon: "search", label: "title", keyHint: "/", keyLabel: "search", keyStands: true },
  panes: { kind: "columns", List: SearchList, Reading: "reader", Above: SearchSeat, keepsOpen: true },
};
