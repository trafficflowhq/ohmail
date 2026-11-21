/**
 * THE SCREENER AS A PLACE OF THE FRAME: its rail entry in the group of its own (how many first-time senders wait,
 * said only once the queue has settled), its list, and its own reading column.
 *
 * IT NAMES NO SEAT ABOVE ITS COLUMNS: what the Screener holds must outlive the place (a decision's window, its Undo,
 * what was bought, the Junk folder's page, the sender open in each section), so it stands in the mail ground for the
 * frame's life (`mail/ground/ScreenerMount.tsx` over `useScreenerLive`), and the panes read it there. So does the
 * count: it reads that one model, which the ground stands whether or not the Screener is on screen.
 */
import { useText } from "../text/index.js";
import type { PlaceEntry } from "../frame/contract.js";
import { useScreener } from "./contract.js";
import { ScreenerList } from "./ScreenerList.js";
import { ScreenerReading } from "./ScreenerReading.js";

function useWaitingCount() {
  const t = useText("screener");
  const model = useScreener();
  if (!model.queueSettled) return null;
  const waiting = model.waitingCount;
  return waiting > 0
    ? { count: String(waiting), hot: true, title: t("railWaiting", { count: waiting }) }
    : null;
}

export const screenerPlace: PlaceEntry = {
  id: "screener",
  body: "screener",
  rowMailboxLabels: true,
  rail: {
    group: "screener",
    icon: "screener",
    label: "title",
    keyHint: "g s",
    keyLabel: "goScreener",
    useCount: useWaitingCount,
  },
  panes: { kind: "columns", List: ScreenerList, Reading: ScreenerReading },
};
