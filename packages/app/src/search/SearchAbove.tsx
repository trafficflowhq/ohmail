/**
 * WHAT STANDS ABOVE SEARCH'S COLUMNS, and the only place it is stood: the model for Search's own parts, the shell's
 * words beside it, and the meeting line the reading column reads. A result opened here hands no visit: the reader
 * runs its own and takes any explicit Search opening. With nothing open, the column says Search’s blank.
 */
import { useMemo, type ReactNode } from "react";
import { SearchModelContext, type SearchListModel } from "@ohmail/app-logic/search";
import { ListMeetingContext, type ListBlank, type ListMeeting } from "@ohmail/app-logic/reading";
import { SearchBesideContext, type SearchBeside } from "./beside.js";

export function SearchAbove({
  model,
  archiveHit,
  beside,
  blank,
  children,
}: {
  model: SearchListModel;
  archiveHit?: ListMeeting["archiveHit"];
  beside: SearchBeside;
  /** What the reading column says while nothing is open; null says nothing. */
  blank: ListBlank | null;
  children: ReactNode;
}) {
  const { afterAction } = model;
  const label = blank?.label;
  const hot = blank?.hot;
  const meeting: ListMeeting = useMemo(
    () => ({
      visit: null,
      archiveHit,
      afterAction,
      blank: label === undefined || hot === undefined ? null : { label, hot },
    }),
    [archiveHit, afterAction, label, hot],
  );
  return (
    <SearchModelContext.Provider value={model}>
      <SearchBesideContext.Provider value={beside}>
        <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>
      </SearchBesideContext.Provider>
    </SearchModelContext.Provider>
  );
}
