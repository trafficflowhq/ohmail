/** Drafts in the frame, with its list and reading column on the same ground as Write. */
import { useContext, type ComponentType, type ReactNode } from "react";
import { ComposerContext } from "@ohmail/app-logic/writing/composer-record";
import type { PlaceEntry } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { DraftsList } from "./DraftsList.js";
import { DraftsReading } from "./DraftsReading.js";

/** The rail reads the same saved letters as Write, including while another place is open. */
function useDraftCount() {
  const t = useText("rail");
  const count = useContext(ComposerContext)?.drafts.length ?? 0;
  return count > 0 ? { count: String(count), hot: false, title: t("draftsTitle", { count }) } : null;
}

export function draftsPlaceOn(Above?: ComponentType<{ readonly children: ReactNode }>): PlaceEntry {
  return {
    id: "drafts",
    body: "drafts",
    rail: {
      group: "more",
      icon: "drafts",
      label: "title",
      keyHint: "g d",
      keyLabel: "goDrafts",
      useCount: useDraftCount,
    },
    panes: { kind: "columns", List: DraftsList, Reading: DraftsReading, Above },
  };
}

/** The columns for hosts that supply the model above the frame. */
export const draftsPlace = draftsPlaceOn();
