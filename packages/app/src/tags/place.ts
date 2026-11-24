/**
 * TAGS AS A PLACE OF THE FRAME: no rail entry of its own (the demo's Tags is a line that folds, not a place, and has no
 * key); the rail's Tags group is drawn by the place itself (`TagsRail`), one entry a tag. Its list (one tag, or every
 * tag where none is named), the reader's column beside it, and its seat above both.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { TagsSeat } from "./Seat.js";
import { TagsList } from "./TagsList.js";
import { TagsRail } from "./TagsRail.js";

export const tagsPlace: PlaceEntry = {
  id: "tags",
  body: "tags",
  rail: null,
  railGroup: { group: "tags", Body: TagsRail },
  panes: { kind: "columns", List: TagsList, Reading: "reader", Above: TagsSeat, keepsOpen: true },
};
