/**
 * NEWS AS A PLACE OF THE FRAME: its rail entry (its count is what is new above the line, stated only when it may be),
 * its list and its own stream in the reading column, which needs the room for the item's panel.
 */
import { useContext } from "react";
import { StreamModelContext } from "@ohmail/app-logic/streams";
import type { PlaceEntry } from "../frame/contract.js";
import { StreamList, StreamReading } from "../stream/index.js";

function useNewsCount(): { count: string; hot: boolean } | null {
  /* Said only where the place's model stands above the rail (the seat's Above); else nothing. */
  const model = useContext(StreamModelContext);
  if (model === null || !model.mayState || model.newCount <= 0) return null;
  return { count: String(model.newCount), hot: false };
}

export const newsPlace: PlaceEntry = {
  id: "news",
  body: "news",
  rail: { group: "main", icon: "news", label: "title", keyHint: "g r", useCount: useNewsCount },
  panes: { kind: "columns", List: StreamList, Reading: StreamReading, room: true },
};
