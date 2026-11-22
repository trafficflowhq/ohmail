import {
  addDays,
  dayNumberOf,
  storedTimeOf,
  type CalendarEventRecord,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { CalendarChangeScope, CalendarEventFields, CalendarTime } from "@ohmail/wire";
import { draftCallLink, draftTimes, type EventDraft } from "./event-draft.js";
import type { CalendarEventFace } from "./faces.js";

const dayOf = (time: CalendarTime) =>
  time.value.slice(0, 4) + "-" + time.value.slice(4, 6) + "-" + time.value.slice(6, 8);
const clockOf = (time: CalendarTime) => time.value.slice(9, 11) + ":" + time.value.slice(11, 13);

export function editCopy(record: CalendarEventRecord, face: CalendarEventFace): CalendarEventRecord {
  return record.repeat && face.ref.occurrence
    ? { ...record, start: storedTimeOf(face.start), end: storedTimeOf(face.end) }
    : record;
}

/** The form shows the selected occurrence. An all-events edit applies its civil day shift to the master. */
export function patchOnScope(
  patch: Partial<CalendarEventFields>,
  scope: CalendarChangeScope | undefined,
  master: CalendarEventRecord,
  shown: CalendarEventRecord,
): Partial<CalendarEventFields> {
  if (scope?.kind !== "record" || !master.repeat || !patch.start || !patch.end || !master.end || !shown.end)
    return patch;
  const shift = (time: CalendarTime, first: CalendarTime, occurrence: CalendarTime): CalendarTime => {
    const days = dayNumberOf(dayOf(first))! - dayNumberOf(dayOf(occurrence))!;
    const date = addDays(dayOf(time), days);
    if (
      shown.recurrenceId &&
      time.kind !== "date" &&
      time.kind === first.kind &&
      time.kind === occurrence.kind &&
      time.zone === first.zone &&
      time.zone === occurrence.zone
    ) {
      const clock = (value: CalendarTime) =>
        Number(value.value.slice(9, 11)) * 60 + Number(value.value.slice(11, 13));
      const shifted = new Date(Date.parse(date) + (clock(first) + clock(time) - clock(occurrence)) * 60_000);
      const wall = shifted.toISOString().slice(0, 16).replaceAll("-", "").replaceAll(":", "");
      return { ...time, value: wall + time.value.slice(13) };
    }
    return { ...time, value: date.replaceAll("-", "") + time.value.slice(8) };
  };
  return {
    ...patch,
    start: shift(patch.start, master.start, shown.start),
    end: shift(patch.end, master.end, shown.end),
  };
}

export function draftOfRecord(record: CalendarEventRecord, viewerZone?: string) {
  const { start, end } = record;
  const day = dayOf(start);
  const allDay = start.kind === "date";
  const from = allDay ? "09:00" : clockOf(start);
  const to = end && end.kind !== "date" ? clockOf(end) : "10:00";
  const last = end ? (allDay ? addDays(dayOf(end), -1) : dayOf(end)) : day;
  const inferred = !allDay && to < from ? addDays(day, 1) : day;
  // Mixed time shapes and seconds cannot be represented by the form's minute fields.
  const timeEditable = Boolean(
    end &&
    end.kind === start.kind &&
    end.zone === start.zone &&
    last >= day &&
    (allDay || last > day || to > from) &&
    (allDay || (start.value.slice(13, 15) === "00" && end.value.slice(13, 15) === "00")),
  );
  const draft: EventDraft = {
    day,
    endDay: last === inferred ? null : last,
    from,
    to,
    allDay,
    zone:
      start.kind === "instant" ? "UTC" : (start.zone ?? (start.kind === "floating" ? viewerZone : undefined)),
    invitees: record.invitees.filter(
      (person) => person.address.toLowerCase() !== record.organizer?.address.toLowerCase(),
    ),
    alarms: [...new Set(record.alarms.map((alarm) => alarm.minutesBefore))],
    title: record.title,
    place: record.place,
    notes: record.notes,
    callLink: record.callLink,
    busy: record.busy,
    private: record.private,
  };
  return { draft, timeEditable };
}

export function draftForDuplicate(
  record: CalendarEventRecord,
  occurrence: CalendarEventFace,
  zone: string,
): EventDraft {
  if (occurrence.ref.occurrence === null) {
    return { ...draftOfRecord(record, zone).draft, callLink: null, invitees: [] };
  }
  const { draft } = draftOfRecord(
    {
      ...record,
      start: storedTimeOf(occurrence.start),
      end: storedTimeOf(occurrence.end),
    },
    zone,
  );
  return {
    ...draft,
    callLink: null,
    invitees: draft.invitees
      ?.filter(({ role }) => role === "required" || role === "optional")
      .map((guest) => ({ ...guest, answer: "none" })),
  };
}

function timeLike(value: CalendarTime, original: CalendarTime): CalendarTime {
  if (value.kind === "date" || original.kind === "date" || original.kind === "zoned") return value;
  return original.kind === "instant"
    ? { kind: "instant", value: value.value + "Z" }
    : { kind: "floating", value: value.value };
}

export function draftTimeChanged(draft: EventDraft, first: EventDraft) {
  return (["day", "endDay", "from", "to", "allDay", "zone"] as const).some(
    (key) => draft[key] !== first[key],
  );
}

/** Only the fields changed in this editor travel. Provider-only fields and time shapes stay exact. */
export function eventChanges(
  record: CalendarEventRecord,
  draft: EventDraft,
  _calendar: CalendarRecord,
  viewerZone: string,
  canWriteCall = false,
): Partial<CalendarEventFields> | null {
  const baseline = draftOfRecord(record, viewerZone);
  const first = baseline.draft;
  const title = draft.title.trim();
  if (!title) return null;
  const patch: Partial<CalendarEventFields> = {};
  if (draft.title !== first.title && title !== first.title) patch.title = title;
  for (const k of ["notes", "place"] as const) {
    if (draft[k] !== first[k] && (draft[k]?.trim() || null) !== first[k]) patch[k] = draft[k]?.trim() || null;
  }
  if (draft.callLink !== undefined && draft.callLink !== first.callLink) {
    const link = draftCallLink(draft.callLink);
    if (!canWriteCall || link === undefined) return null;
    if (link !== first.callLink) patch.callLink = link;
  }
  if (draft.busy !== first.busy) patch.busy = draft.busy;
  if (draft.private !== first.private) patch.private = draft.private;
  if (JSON.stringify(draft.alarms) !== JSON.stringify(first.alarms)) patch.alarms = [...(draft.alarms ?? [])];
  if (JSON.stringify(draft.invitees) !== JSON.stringify(first.invitees)) {
    patch.invitees = (draft.invitees ?? []).flatMap(({ address, name, role }) =>
      role === "required" || role === "optional" ? [{ address, name, role }] : [],
    );
  }
  if (draftTimeChanged(draft, first)) {
    if (!baseline.timeEditable || !record.end) return null;
    const { times } = draftTimes(draft, draft.zone ?? viewerZone);
    if (!times) return null;
    const converted = draft.zone !== first.zone && draft.zone !== undefined;
    const start = converted ? times.start : timeLike(times.start, record.start);
    const end = converted ? times.end : timeLike(times.end, record.end);
    if (
      JSON.stringify(start) !== JSON.stringify(record.start) ||
      JSON.stringify(end) !== JSON.stringify(record.end)
    ) {
      patch.start = start;
      patch.end = end;
    }
  }
  return patch;
}
