/**
 * THE OHBOX AS A PLACE OF THE FRAME: its rail entry (its unread count, the engine's, stated only when it may be),
 * its list, and the reader's column beside it. What the column says with nothing open is the list's blank, which
 * `OhboxAbove` hands it.
 */
import { useOhboxModel } from "@ohmail/app-logic/ohbox";
import type { PlaceEntry } from "../frame/contract.js";
import { OhboxList } from "./OhboxList.js";

function useOhboxCount(): { count: string; hot: boolean } | null {
  const model = useOhboxModel();
  if (!model.mayState) return null;
  const unread = model.unreadIds.length;
  return unread > 0 ? { count: String(unread), hot: true } : null;
}

export const ohboxPlace: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title", keyHint: "g i", useCount: useOhboxCount },
  panes: { kind: "columns", List: OhboxList, Reading: "reader" },
};
