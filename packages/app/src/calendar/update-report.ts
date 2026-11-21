import {
  dayShort,
  pressAndHear,
  type CalendarEventRecord,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { CalendarEventFields } from "@ohmail/wire";
import { useLocale, useText, type Text } from "../text/index.js";
import { useReport } from "../frame/commands.js";
import { eventUpdate, guestUpdate } from "./guest-update.js";

export function reportCalendarUpdate(
  report: ToastFn,
  label: string,
  port: CalendarPort,
  before: CalendarEventRecord,
  change: Partial<CalendarEventFields>,
  current: () => CalendarEventRecord | null,
  e: Text,
) {
  if (before.repeat || guestUpdate(before, change).names.length) {
    report(label);
    return;
  }
  const fields = Object.keys(change) as (keyof CalendarEventFields)[];
  const previous = Object.fromEntries(fields.map((field) => [field, before[field]]));
  report(label, {
    action: e("undoDelete"),
    duration: UNDO_MS,
    onAction: () => {
      const live = current();
      if (
        !live ||
        live.repeat ||
        live.calendarId !== before.calendarId ||
        guestUpdate(live, change).names.length ||
        fields.some((field) => JSON.stringify(live[field]) !== JSON.stringify(change[field]))
      ) {
        report(e("refusal.changed"));
        return;
      }
      void pressAndHear(port, eventUpdate(live, live.updatedAt, previous, { kind: "record" })).then(
        (heard) => {
          if (heard.say) report(e(heard.say));
        },
        () => report(e("refusal.unknown")),
      );
    },
  });
}

export function useRangeUpdateReport(port: CalendarPort) {
  const t = useText("calendar");
  const e = useText("event");
  const locale = useLocale();
  const report = useReport();
  return (
    range: { first: string; last: string },
    before: CalendarEventRecord,
    change: Partial<CalendarEventFields>,
    current: () => CalendarEventRecord | null,
  ) => {
    const year = range.first.slice(0, 4);
    const first = dayShort(range.first, locale, year);
    const last = dayShort(range.last, locale, year);
    reportCalendarUpdate(
      report,
      range.first === range.last ? first : t("interval", { first, last }),
      port,
      before,
      change,
      current,
      e,
    );
  };
}
