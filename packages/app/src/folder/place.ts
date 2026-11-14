/**
 * A FOLDER AS A PLACE OF THE FRAME: no rail entry of its own; the rail's Folders group is drawn by the place itself
 * (the shelf, `FolderRailSeat`), while the account uses folders. Its list, the reader's column beside it, and its
 * seat above both.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { FolderList } from "./FolderList.js";
import { FolderRailSeat } from "./RailSeat.js";
import { FolderSeat } from "./Seat.js";

export const folderPlace: PlaceEntry = {
  id: "folder",
  body: "folder",
  rail: null,
  railGroup: { group: "folders", Body: FolderRailSeat },
  panes: { kind: "columns", List: FolderList, Reading: "reader", Above: FolderSeat, keepsOpen: true },
};
