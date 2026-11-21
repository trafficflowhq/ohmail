import type { CalendarEventFace } from "./faces.js";
import { addDays, dayOfIso, eventTimeOf, hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import type { CalendarEventFields, CalendarTime } from "@ohmail/wire";

export interface EventDraft {
  readonly title: string;
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly allDay: boolean;
  readonly busy: boolean;
  readonly private: boolean;
  readonly place: string | null;
  readonly notes: string | null;
}

const hour = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

export function startDraft(anchor: string, minute: number): EventDraft {
  const next = Math.floor(minute / 60) + 1;
  return {
    title: "",
    day: next === 24 ? addDays(anchor, 1) : anchor,
    from: hour(next),
    to: hour(next + 1),
    allDay: false,
    busy: true,
    private: false,
    place: null,
    notes: null,
  };
}

function clock(value: string): string | null {
  const parts = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!parts || Number(parts[1]) > 23) return null;
  return parts[1]!.padStart(2, "0") + parts[2];
}

export function fieldsOfDraft(
  draft: EventDraft,
  calendar: CalendarRecord,
  zone: string,
): CalendarEventFields | null {
  const title = draft.title.trim();
  if (!title || !dayOfIso(draft.day)) return null;
  const stamp = (day: string) => day.replaceAll("-", "");
  let start: CalendarTime;
  let end: CalendarTime;
  if (draft.allDay) {
    start = { kind: "date", value: stamp(draft.day) };
    end = { kind: "date", value: stamp(addDays(draft.day, 1)) };
  } else {
    const from = clock(draft.from),
      to = clock(draft.to);
    if (from === null || to === null || from === to) return null;
    const last = to < from ? addDays(draft.day, 1) : draft.day;
    start = { kind: "zoned", value: stamp(draft.day) + "T" + from + "00", zone };
    end = { kind: "zoned", value: stamp(last) + "T" + to + "00", zone };
  }
  return {
    title,
    start,
    end,
    busy: draft.busy,
    private: draft.private,
    place: draft.place?.trim() || null,
    notes: draft.notes?.trim() || null,
    callLink: null,
    repeat: null,
    invitees: [],
    alarms: [...new Set(calendar.defaultAlarms.map((alarm) => alarm.minutesBefore))],
  };
}

export const DRAFT_EVENT = "new-event";

export function previewOfDraft(
  draft: EventDraft,
  calendar: CalendarRecord,
  zone: string,
  untitled: string,
): CalendarEventFace | null {
  const fields = fieldsOfDraft({ ...draft, title: draft.title.trim() || untitled }, calendar, zone);
  if (!fields) return null;
  const start = eventTimeOf(fields.start);
  const end = eventTimeOf(fields.end);
  if (!start || !end) return null;
  return {
    id: DRAFT_EVENT,
    recordId: DRAFT_EVENT,
    people: [],
    notes: fields.notes,
    title: fields.title,
    start,
    end,
    ref: { event: DRAFT_EVENT, day: draft.day, occurrence: null },
    tone: hueOf(calendar.color),
    state: "draft",
    repeats: null,
    viewOnly: true,
    waits: false,
    status: null,
    second: fields.place,
  };
}
