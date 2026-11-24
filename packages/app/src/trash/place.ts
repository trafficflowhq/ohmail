/**
 * TRASH AS A PLACE OF THE FRAME: its rail entry in More with the demo's key, its list, its own reading column (its rows
 * are not in the mirror) and its seat above both. It keeps its open letter over a walk away and back. Its entry counts
 * nothing: the demo's rail counts no Trash, and a count reads the mail ground alone, which holds none of Trash's rows.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { TrashSeat } from "./Seat.js";
import { TrashList } from "./TrashList.js";
import { TrashReading } from "./TrashReading.js";

export const trashPlace: PlaceEntry = {
  id: "trash",
  body: "trash",
  rail: {
    group: "more",
    icon: "trash",
    label: "title",
    keyHint: "g t",
    keyLabel: "goTrash",
    whileOpen: true,
    navigationRefusal: ({ engine }) => (engine.trashAvailable?.() === true ? undefined : "trash_unavailable"),
  },
  panes: {
    kind: "columns",
    List: TrashList,
    Reading: TrashReading,
    Above: TrashSeat,
    keepsOpen: true,
  },
};
