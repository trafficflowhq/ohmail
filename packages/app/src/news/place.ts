/**
 * NEWS AS A PLACE OF THE FRAME: its rail entry (its count is what is new since the last visit, stated only when it
 * may be), its list and its own stream in the reading column, which needs the room for the item's panel, and its seat
 * above both. The count reads the mail ground alone (`useStreamNew`): it is drawn for the frame's life, while News's
 * own model stands only with its columns. A visit opens at the top of the stream: no open item is kept.
 */
import { useStreamNew } from "@ohmail/app-logic/streams";
import type { PlaceEntry } from "../frame/contract.js";
import { NewsSeat, StreamList, StreamReading } from "../stream/index.js";

function useNewsCount(): { count: string; hot: boolean } | null {
  const fresh = useStreamNew("news");
  return fresh !== null && fresh > 0 ? { count: String(fresh), hot: false } : null;
}

export const newsPlace: PlaceEntry = {
  id: "news",
  body: "news",
  rail: {
    group: "main",
    icon: "news",
    drop: "move:reads",
    label: "title",
    keyHint: "g r",
    keyLabel: "goReads",
    useCount: useNewsCount,
  },
  panes: { kind: "columns", List: StreamList, Reading: StreamReading, room: true, Above: NewsSeat },
};
