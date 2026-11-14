/**
 * RECEIPTS AS A PLACE OF THE FRAME: its rail entry (its count is what is new above the line, stated only when it may be),
 * its list and its own stream in the reading column, which needs the room for the item's panel.
 */
import { useContext } from "react";
import { StreamModelContext } from "@ohmail/app-logic/streams";
import type { PlaceEntry } from "../frame/contract.js";
import { StreamList, StreamReading } from "../stream/index.js";

function useReceiptsCount(): { count: string; hot: boolean } | null {
  /* Said only where the place's model stands above the rail (the seat's Above); else nothing. */
  const model = useContext(StreamModelContext);
  if (model === null || !model.mayState || model.newCount <= 0) return null;
  return { count: String(model.newCount), hot: false };
}

export const receiptsPlace: PlaceEntry = {
  id: "receipts",
  body: "receipts",
  rail: { group: "main", icon: "receipts", label: "title", keyHint: "g e", useCount: useReceiptsCount },
  panes: { kind: "columns", List: StreamList, Reading: StreamReading, room: true },
};
