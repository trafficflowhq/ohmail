/**
 * DRAFTS AS A PLACE OF THE FRAME: its rail entry in More, its list, and its own reading column. Registered and held
 * by its tests; a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { DraftsList } from "./DraftsList.js";
import { DraftsReading } from "./DraftsReading.js";

export const draftsPlace: PlaceEntry = {
  id: "drafts",
  body: "drafts",
  rail: { group: "more", icon: "drafts", label: "title", keyHint: "g d" },
  panes: { kind: "columns", List: DraftsList, Reading: DraftsReading },
};
