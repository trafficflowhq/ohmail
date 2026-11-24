import {
  dayShort,
  pressAndHear,
  type CalendarEventRecord,
  type CalendarPort,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { CalendarAct, CalendarEventFields } from "@ohmail/wire";
import { useLocale, useText, type Text } from "../text/index.js";
import { useReport } from "../frame/commands.js";
import type { EditableEvent } from "./editable-event.js";
import { eventWhen, guestNames } from "./event-words.js";
import { editGuestUpdate, eventUpdate, guestUpdate, type GuestUpdate } from "./guest-update.js";

const writtenField = (record: CalendarEventRecord, field: keyof CalendarEventFields) =>
  field === "alarms" ? [...new Set(record.alarms.map(({ minutesBefore }) => minutesBefore))] : record[field];

export function useSentUpdateLabel() {
  const t = useText("calendar");
  const e = useText("event");
  const locale = useLocale();
  return (
    record: CalendarEventRecord,
    change: Partial<CalendarEventFields>,
    update: GuestUpdate = guestUpdate(record, change),
  ): string | undefined => {
    const { names, invited, audience } = update;
    if (!names.length) return undefined;
    const invitation =
      invited.length > 0 &&
      Object.keys(change).length === 1 &&
      audience.guests.every((address) =>
        change.invitees?.some((guest) => guest.address.trim().toLowerCase() === address),
      );
    return e(invitation ? "taken.invitationAudience" : "taken.updateAudience", {
      guests: guestNames(invitation ? invited : names, locale, t, false),
    });
  };
}

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
  const previous = Object.fromEntries(fields.map((field) => [field, writtenField(before, field)]));
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
        fields.some((field) => JSON.stringify(writtenField(live, field)) !== JSON.stringify(change[field]))
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
  const sent = useSentUpdateLabel();
  return (
    range: { first: string; last: string },
    before: CalendarEventRecord,
    change: Partial<CalendarEventFields>,
    current: () => CalendarEventRecord | null,
    update: GuestUpdate,
  ) => {
    const year = range.first.slice(0, 4);
    const first = dayShort(range.first, locale, year);
    const last = dayShort(range.last, locale, year);
    reportCalendarUpdate(
      report,
      sent(before, change, update) ?? (range.first === range.last ? first : t("interval", { first, last })),
      port,
      before,
      change,
      current,
      e,
    );
  };
}

export function useCalendarGestureReport(port: CalendarPort, zone: string, zones: ZoneSource) {
  const reportRange = useRangeUpdateReport(port);
  const e = useText("event");
  const locale = useLocale();
  const report = useReport();
  const sent = useSentUpdateLabel();
  return (
    range: { first: string; last: string } | null | false,
    timed: boolean,
    selection: EditableEvent,
    current: () => CalendarEventRecord | null,
  ): ((act: Extract<CalendarAct, { kind: "calendar_event_update" }>) => void) | undefined => {
    const before = { ...selection.record };
    const update = (act: Extract<CalendarAct, { kind: "calendar_event_update" }>) =>
      editGuestUpdate(selection, act.change, act.scope);
    if (range) return (act) => reportRange(range, before, act.change, current, update(act));
    if (timed)
      return (act) =>
        reportCalendarUpdate(
          report,
          sent(before, act.change, update(act)) ??
            eventWhen(act.change, zone, zones, locale) ??
            e("taken.update"),
          port,
          before,
          act.change,
          current,
          e,
        );
  };
}
