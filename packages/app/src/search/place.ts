/**
 * SEARCH AS A PLACE OF THE FRAME: its rail entry (its key `/`), its list, and the reader's column beside it. A result
 * opened here opens beside the list; the read rule and every verb are the reader's.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { SearchList } from "./SearchList.js";

export const searchPlace: PlaceEntry = {
  id: "search",
  body: "search",
  rail: { group: "more", icon: "search", label: "title", keyHint: "/" },
  panes: { kind: "columns", List: SearchList, Reading: "reader" },
};
