/**
 * WHAT A LIST PLACE HANDS THE READING COLUMN, stood above both columns: the open letter's visit with its two steps
 * named, or with nothing open, what the place holds. The meeting is new only when its words or its visit change.
 */
import { useMemo, type ReactNode } from "react";
import type { ListBlank, ListMeeting, ListVisit } from "@ohmail/app-logic/reading";
import { ListMeetingContext } from "@ohmail/app-logic/reading";

export function PlaceMeeting({
  visit,
  blank,
  steps,
  children,
}: {
  visit: ListVisit | null;
  blank: ListBlank | null;
  /** The steps' names: toward the top of the list, toward its end. */
  steps: { up: string; down: string };
  children: ReactNode;
}) {
  const label = blank?.label;
  const hot = blank?.hot;
  const meeting = useMemo<ListMeeting>(
    () => ({
      visit:
        visit === null
          ? null
          : {
              ...visit,
              step: {
                up: { ...visit.step.up, label: steps.up },
                down: { ...visit.step.down, label: steps.down },
              },
            },
      blank: label === undefined || hot === undefined ? null : { label, hot },
    }),
    [visit, label, hot, steps.up, steps.down],
  );
  return <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>;
}
