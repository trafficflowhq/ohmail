import type { CalendarEventFace } from "./faces.js";
import {
  addDays,
  clockOf,
  dayOfIso,
  eventTimeOf,
  readerZones,
  viewOnlyOf,
  wallInstants,
  type CalendarConnectionRecord,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { CalendarEventFields, CalendarInvitee, CalendarTime } from "@ohmail/wire";
import { verifiedCallLink } from "./event-call.js";

export interface EventDraft {
  readonly title: string;
  readonly day: string;
  readonly endDay: string | null;
  readonly from: string;
  readonly to: string;
  readonly allDay: boolean;
  readonly zone?: string;
  readonly busy: boolean;
  readonly private: boolean;
  readonly place: string | null;
  readonly notes: string | null;
  readonly callLink?: string | null;
  readonly repeat?: string | null;
  readonly invitees?: readonly CalendarInvitee[];
  readonly alarms?: readonly number[];
}

export function draftCalendars(
  calendars: readonly CalendarRecord[],
  connections: ReadonlyMap<string, CalendarConnectionRecord>,
): readonly CalendarRecord[] {
  return calendars.filter((c) => c.shown && !viewOnlyOf(c, connections.get(c.connectionId)));
}

export function draftCalendarIsReadOnly(
  calendars: readonly CalendarRecord[],
  connections: ReadonlyMap<string, CalendarConnectionRecord>,
  choice: string | null | undefined,
  noChoices: boolean,
): boolean {
  return calendars.some(
    (calendar) =>
      calendar.shown &&
      (calendar.id === choice || noChoices) &&
      viewOnlyOf(calendar, connections.get(calendar.connectionId)),
  );
}

export function draftCallLink(value: EventDraft["callLink"]): string | null | undefined {
  const entered = value?.trim();
  if (!entered) return null;
  return verifiedCallLink(entered) ?? undefined;
}

const hour = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

export function startDraft(anchor: string, minute: number, slot?: string): EventDraft {
  const last = slot?.startsWith("date-") ? slot.slice(5) : null;
  const allDay =
    last !== null && last >= anchor && dayOfIso(last) !== null && dayOfIso(addDays(last, 1)) !== null;
  const [start, end] = slot?.split("-").map(Number) ?? [];
  const endDay = end >= 1440 ? addDays(anchor, Math.floor(end / 1440)) : null;
  const hasSlot = start >= 0 && start < 1440 && start < end && (endDay === null || dayOfIso(endDay) !== null);
  // Midnight starts a different civil day. Keep the last start hour on the chosen date.
  const next = Math.min(23, Math.floor(minute / 60) + 1);
  return {
    title: "",
    day: anchor,
    endDay: allDay ? last : hasSlot ? endDay : null,
    from: hasSlot ? clockOf(start) : hour(next),
    to: hasSlot ? clockOf(end % 1440) : hour(next + 1),
    allDay,
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

export function endDayOf(draft: EventDraft): string {
  if (draft.endDay !== null) return draft.endDay;
  const from = clock(draft.from);
  const to = clock(draft.to);
  return !draft.allDay && from !== null && to !== null && to < from ? addDays(draft.day, 1) : draft.day;
}

type TimedFields = Pick<CalendarEventFields, "start" | "end">;
type DraftTimes = { times: TimedFields; issue: "fold" | null } | { times: null; issue: "gap" | null };

export function draftTimes(draft: EventDraft, zone: string): DraftTimes {
  const last = endDayOf(draft);
  if (!dayOfIso(draft.day) || !dayOfIso(last) || last < draft.day) return { times: null, issue: null };
  const stamp = (day: string) => day.replaceAll("-", "");
  if (draft.allDay)
    return {
      times: {
        start: { kind: "date", value: stamp(draft.day) },
        end: { kind: "date", value: stamp(addDays(last, 1)) },
      },
      issue: null,
    };
  const from = clock(draft.from);
  const to = clock(draft.to);
  if (from === null || to === null) return { times: null, issue: null };
  const zoned = (day: string, time: string): CalendarTime => ({
    kind: "zoned",
    value: stamp(day) + "T" + time + "00",
    zone,
  });
  const times = { start: zoned(draft.day, from), end: zoned(last, to) };
  const instants = (time: CalendarTime) => {
    const read = eventTimeOf(time);
    return read?.kind === "zoned" ? wallInstants(read.wall, zone, readerZones()) : [];
  };
  const starts = instants(times.start);
  const ends = instants(times.end);
  const [start] = starts,
    [end] = ends;
  if (start === undefined || end === undefined) return { times: null, issue: "gap" };
  if (end <= start) return { times: null, issue: null };
  return { times, issue: starts.length > 1 || ends.length > 1 ? "fold" : null };
}

export function fieldsOfDraft(
  draft: EventDraft,
  calendar: CalendarRecord,
  zone: string,
): CalendarEventFields | null {
  const title = draft.title.trim();
  const { times } = draftTimes(draft, zone);
  const callLink = draftCallLink(draft.callLink);
  if (!title || !times || callLink === undefined) return null;
  return {
    title,
    ...times,
    busy: draft.busy,
    private: draft.private,
    place: draft.place?.trim() || null,
    notes: draft.notes?.trim() || null,
    callLink,
    repeat: draft.repeat ?? null,
    invitees: [],
    alarms: [...new Set(draft.alarms ?? calendar.defaultAlarms.map((alarm) => alarm.minutesBefore))],
  };
}

export const DRAFT_EVENT = "new-event";

export function previewOfDraft(
  draft: EventDraft,
  calendar: CalendarRecord,
  zone: string,
  untitled: string,
  tone: CalendarEventFace["tone"],
): CalendarEventFace | null {
  const fields = fieldsOfDraft(
    { ...draft, title: draft.title.trim() || untitled, callLink: null },
    calendar,
    zone,
  );
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
    tone,
    state: "draft",
    repeats: null,
    viewOnly: false,
    waits: false,
    status: null,
    second: fields.place,
  };
}
