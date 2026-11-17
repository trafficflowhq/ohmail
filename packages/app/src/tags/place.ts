/**
 * TAGS AS A PLACE OF THE FRAME: its rail entry, its list (one tag, or every tag where none is named), and the reader's
 * column beside it. Registered and held by its tests; a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { TagsList } from "./TagsList.js";

export const tagsPlace: PlaceEntry = {
  id: "tags",
  body: "tags",
  rail: { group: "tags", icon: "tags", label: "title", keyHint: "g t" },
  panes: { kind: "columns", List: TagsList, Reading: "reader" },
};
