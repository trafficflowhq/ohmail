/**
 * A FOLDER AS A PLACE OF THE FRAME: no rail entry of its own (the rail's Folders group lists the folders), its list,
 * and the reader's column beside it. Registered and held by its tests; a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { FolderList } from "./FolderList.js";

export const folderPlace: PlaceEntry = {
  id: "folder",
  body: "folder",
  rail: null,
  panes: { kind: "columns", List: FolderList, Reading: "reader" },
};
