/** Invented records for the lists' cases: one Google connection, one calendar of it, events built field by field. */
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarRecord,
  CalendarSuggestionRecord,
} from "@ohmail/wire";

export const ZURICH = "Europe/Zurich";
export const UPDATED = "2026-11-01T08:00:00.000Z";
export const OWN = "ada@studio.test";

export function connection(over: Partial<CalendarConnectionRecord> = {}): CalendarConnectionRecord {
  return {
    id: "conn-1",
    provider: "google",
    label: "Studio",
    status: "active",
    errorCode: null,
    grantMailboxId: null,
    serverHost: null,
    consentedAt: UPDATED,
    lastSyncedAt: UPDATED,
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...over,
  };
}

export function calendarOf(over: Partial<CalendarRecord> = {}): CalendarRecord {
  return {
    id: "cal-1",
    connectionId: "conn-1",
    name: "Studio",
    color: "#3366cc",
    access: "owner",
    shown: true,
    timeZone: ZURICH,
    window: null,
    defaultAlarms: [],
    lastSyncedAt: null,
    errorCode: null,
    updatedAt: UPDATED,
    ...over,
  };
}

/** An event at nine on `day` (`YYYYMMDD`) for half an hour, Zurich time. */
export function event(id: string, day: string, over: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id,
    calendarId: "cal-1",
    uid: `${id}@studio.test`,
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title: id,
    notes: null,
    place: null,
    callLink: null,
    start: { kind: "zoned", value: `${day}T090000`, zone: ZURICH },
    end: { kind: "zoned", value: `${day}T093000`, zone: ZURICH },
    duration: null,
    startsAt: UPDATED,
    endsAt: UPDATED,
    occurrenceAt: null,
    repeat: null,
    busy: true,
    private: false,
    organizer: null,
    myAnswer: null,
    heldBack: false,
    invitees: [],
    alarms: [],
    cut: false,
    writes: [],
    updatedAt: UPDATED,
    ...over,
  };
}

/** An invitation from someone else, not answered yet. */
export const invitation = (id: string, day: string, over: Partial<CalendarEventRecord> = {}) =>
  event(id, day, {
    organizer: { address: "marco@elsewhere.test", name: "Marco" },
    myAnswer: "none",
    ...over,
  });

export function suggestion(
  id: string,
  evidence: string,
  over: Partial<CalendarSuggestionRecord> = {},
): CalendarSuggestionRecord {
  return {
    id,
    messageId: `m-${id}`,
    mailboxId: "mb-1",
    evidence,
    proposed: {
      title: `Found ${id}`,
      start: { kind: "zoned", value: "20261120T190000", zone: ZURICH },
      end: { kind: "zoned", value: "20261120T210000", zone: ZURICH },
      place: "Kunsthalle",
    },
    sourceWords: "Friday, 20 November at 7pm",
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...over,
  };
}
