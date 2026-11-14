/**
 * THE SCREENER AS A PLACE OF THE FRAME: its rail entry (how many first-time senders wait, said only once the queue
 * has settled), its list, and its own reading column.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { useScreener } from "./contract.js";
import { ScreenerList } from "./ScreenerList.js";
import { ScreenerReading } from "./ScreenerReading.js";

function useWaitingCount(): { count: string; hot: boolean } | null {
  const model = useScreener();
  if (!model.queueSettled) return null;
  const waiting = model.waitingCount;
  return waiting > 0 ? { count: String(waiting), hot: true } : null;
}

export const screenerPlace: PlaceEntry = {
  id: "screener",
  body: "screener",
  rail: { group: "main", icon: "screener", label: "title", keyHint: "g s", useCount: useWaitingCount },
  panes: { kind: "columns", List: ScreenerList, Reading: ScreenerReading },
};
