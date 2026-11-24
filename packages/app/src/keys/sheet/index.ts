/**
 * THE KEY SHEET's door: an over of the frame, generated from the keyboard registry. It takes one reading of the
 * registry at the moment it opens (focus then moves into it, and a live read would list the wrong place's keys)
 * and holds it until it closes. Its own key (`?`) is declared in the registry.
 */
import type { OverEntry } from "../../frame/contract.js";
import { KeySheet } from "./KeySheet.js";

export { sheetColumns, foldRows } from "./rows.js";
export const keySheetOver: OverEntry = { id: "keys", Body: KeySheet };
