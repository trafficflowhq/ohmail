/**
 * WHAT STANDS ABOVE THE OHBOX'S COLUMNS, and the only place it is stood: the model for the Ohbox's own parts, the
 * shell's words beside it, and the meeting line the reading column reads (the open letter's visit, the blank).
 */
import type { ReactNode } from "react";
import { OhboxModelContext, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { useMemo } from "react";
import { useText } from "../text/index.js";
import { OhboxBesideContext, type OhboxBeside } from "./beside.js";
import { blankOf } from "./blank.js";

export function OhboxAbove({
  model,
  beside,
  children,
}: {
  model: OhboxListModel;
  beside: OhboxBeside;
  children: ReactNode;
}) {
  const t = useText("ohbox");
  /* The blank is plain values: the meeting is new when its words change, never for a new object of the same words. */
  const blank = blankOf(model, t);
  const label = blank?.label;
  const hot = blank?.hot;
  const visit = model.visit;
  const meeting: ListMeeting = useMemo(
    () => ({ visit, blank: label === undefined || hot === undefined ? null : { label, hot } }),
    [visit, label, hot],
  );
  return (
    <OhboxModelContext.Provider value={model}>
      <OhboxBesideContext.Provider value={beside}>
        <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>
      </OhboxBesideContext.Provider>
    </OhboxModelContext.Provider>
  );
}
