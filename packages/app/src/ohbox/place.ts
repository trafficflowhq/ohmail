/**
 * THE OHBOX AS A PLACE OF THE FRAME: its rail entry with its unread count, its list, the reader's column beside it,
 * and its seat above both. The count reads the mail ground alone (`useOhboxUnread`): it is drawn for the frame's
 * life, while the Ohbox's own model stands only with its columns.
 */
import { useOhboxUnread } from "@ohmail/app-logic/ohbox";
import type { PlaceEntry } from "../frame/contract.js";
import { useScreener } from "../screener/contract.js";
import { OhboxList } from "./OhboxList.js";
import { OhboxSeat } from "./Seat.js";

/** The Ohbox's unread count, drawn quiet: in the demo's rail and dock only the Screener's count is hot. */
function useOhboxCount(): { count: string; hot: boolean } | null {
  const unread = useOhboxUnread(useScreener().storeSettled);
  return unread !== null && unread > 0 ? { count: String(unread), hot: false } : null;
}

export const ohboxPlace: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: {
    group: "main",
    icon: "ohbox",
    label: "title",
    keyHint: "g o",
    keyLabel: "goOhbox",
    useCount: useOhboxCount,
    drop: "move:ohbox",
  },
  panes: { kind: "columns", List: OhboxList, Reading: "reader", Above: OhboxSeat, keepsOpen: true },
};
