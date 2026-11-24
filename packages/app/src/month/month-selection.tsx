import { dayShort, type MonthWeek, type ViewEvent } from "@ohmail/app-logic/calendar";
import { EventChip } from "@ohmail/ui/calendar";
import type { CalendarViewProps } from "../calendar/view.js";

export function monthSelection(
  w: MonthWeek<ViewEvent>,
  selection: NonNullable<CalendarViewProps["monthSelection"]>,
  locale: string,
  thisYear: string,
) {
  const from = w.days.findIndex((d) => d.id >= selection.first && d.id <= selection.last);
  if (from < 0) return null;
  const next = w.days.findIndex((d) => d.id > selection.last);
  const to = (next < 0 ? w.days.length : next) - 1;
  const row =
    [0, 1, 2, 3].find(
      (r) =>
        !w.pieces.some((p) => p.row === r && p.from <= to && p.to >= from) &&
        (r !== 3 || !w.days.slice(from, to + 1).some((d) => d.more > 0)),
    ) ?? 0;
  return (
    <EventChip
      size="line"
      run
      state="draft"
      drag="copy"
      title={
        selection.first === selection.last
          ? dayShort(selection.first, locale, thisYear)
          : `${dayShort(selection.first, locale, thisYear)} – ${dayShort(selection.last, locale, thisYear)}`
      }
      tone={selection.tone}
      style={{
        gridColumn: `${from + 1} / ${to + 2}`,
        gridRow: row + 2,
      }}
    />
  );
}
