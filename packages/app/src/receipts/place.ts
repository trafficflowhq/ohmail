/**
 * RECEIPTS AS A PLACE OF THE FRAME: its rail entry (its count is what is new since the last visit, stated only when it
 * may be), its list and its own stream in the reading column, which needs the room for the item's panel, and its
 * seat above both. The count reads the mail ground alone (`useStreamNew`): it is drawn for the frame's life, while
 * Receipts' own model stands only with its columns. A visit opens at the top of the stream: no open item is kept.
 */
import { useStreamNew } from "@ohmail/app-logic/streams";
import type { PlaceEntry } from "../frame/contract.js";
import { ReceiptsSeat, StreamList, StreamReading } from "../stream/index.js";

function useReceiptsCount(): { count: string; hot: boolean } | null {
  const fresh = useStreamNew("receipts");
  return fresh !== null && fresh > 0 ? { count: String(fresh), hot: false } : null;
}

export const receiptsPlace: PlaceEntry = {
  id: "receipts",
  body: "receipts",
  rail: {
    group: "main",
    icon: "receipts",
    drop: "move:receipts",
    label: "title",
    keyHint: "g e",
    keyLabel: "goReceipts",
    useCount: useReceiptsCount,
  },
  panes: { kind: "columns", List: StreamList, Reading: StreamReading, room: true, Above: ReceiptsSeat },
};
