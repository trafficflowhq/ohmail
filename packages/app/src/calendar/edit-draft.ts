import { addDays, type CalendarEventRecord, type CalendarRecord } from "@ohmail/app-logic/calendar";
import type { CalendarEventFields, CalendarTime } from "@ohmail/wire";
import { fieldsOfDraft, type EventDraft } from "./event-draft.js";

const dayOf = (time: CalendarTime) =>
  time.value.slice(0, 4) + "-" + time.value.slice(4, 6) + "-" + time.value.slice(6, 8);
const clockOf = (time: CalendarTime) => time.value.slice(9, 11) + ":" + time.value.slice(11, 13);

export function draftOfRecord(record: CalendarEventRecord) {
  const { start, end } = record;
  const day = dayOf(start);
  const allDay = start.kind === "date";
  const from = allDay ? "09:00" : clockOf(start);
  const to = end && end.kind !== "date" ? clockOf(end) : "10:00";
  // A form with one date and two clock times can represent the same day or one night.
  const timeEditable = Boolean(
    end &&
    end.kind === start.kind &&
    end.zone === start.zone &&
    dayOf(end) === (allDay || to < from ? addDays(day, 1) : day) &&
    (allDay || (from !== to && start.value.slice(13, 15) === "00" && end.value.slice(13, 15) === "00")),
  );
  const draft: EventDraft = {
    day,
    from,
    to,
    allDay,
    title: record.title,
    place: record.place,
    notes: record.notes,
    busy: record.busy,
    private: record.private,
  };
  return { draft, timeEditable };
}

function timeLike(value: CalendarTime, original: CalendarTime): CalendarTime {
  if (value.kind === "date" || original.kind === "date" || original.kind === "zoned") return value;
  return original.kind === "instant"
    ? { kind: "instant", value: value.value + "Z" }
    : { kind: "floating", value: value.value };
}

/** Only the fields changed in this editor travel. Provider-only fields and time shapes stay exact. */
export function eventChanges(
  record: CalendarEventRecord,
  draft: EventDraft,
  calendar: CalendarRecord,
  viewerZone: string,
): Partial<CalendarEventFields> | null {
  const baseline = draftOfRecord(record);
  const first = baseline.draft;
  const title = draft.title.trim();
  if (!title) return null;
  const patch: Partial<CalendarEventFields> = {};
  if (title !== first.title) patch.title = title;
  for (const k of ["notes", "place"] as const) {
    if (draft[k] !== first[k] && (draft[k]?.trim() || null) !== first[k]) patch[k] = draft[k]?.trim() || null;
  }
  if (draft.busy !== first.busy) patch.busy = draft.busy;
  if (draft.private !== first.private) patch.private = draft.private;
  const timeFields = ["day", "from", "to", "allDay"] as const;
  if (timeFields.some((key) => draft[key] !== first[key])) {
    if (!baseline.timeEditable || !record.end) return null;
    const fields = fieldsOfDraft(draft, calendar, record.start.zone ?? viewerZone);
    if (!fields) return null;
    patch.start = timeLike(fields.start, record.start);
    patch.end = timeLike(fields.end, record.end);
  }
  return patch;
}
