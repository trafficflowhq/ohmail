/**
 * THE WORLD OF THE CALENDAR'S REST, for its states page: Mila's three calendar accounts, her November with the
 * invitations it holds, the events found in her letters, and the settings, as the store's own records. All invented,
 * on the reference's clock (Tuesday 10 November 2026, 09:24 in Zürich). A mirror reads them and a port answers from
 * them; a setup port lists the three ways this build connects. Nothing here is pressed against a server.
 */
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
  CalendarSettingsWire,
} from "@ohmail/app-logic/calendar";
import type { CalendarSuggestionRecord } from "@ohmail/app-logic/calendar/found";
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";

export const ZONE = "Europe/Zurich";
const UPDATED = "2026-11-10T08:00:00.000Z";
/** The reference's clock, held for every reader of `Date.now()` on the page. */
export const NOW_MS = Date.parse("2026-11-10T08:24:00.000Z");

/** Which of the reference's states the world is in. */
export interface WorldState {
  /** Invitations: `one` after one answer, `clear` all answered. From mail: `added` after Add, `all` after Add 4. */
  readonly state: string | null;
  /** Calendar accounts: Google's sign-in is no longer accepted. */
  readonly signedOut: boolean;
  /** View: a second time zone is on. */
  readonly secondZone: boolean;
  /** The setup: our server refuses the sign-in. */
  readonly refused: boolean;
}

const connection = (
  id: string,
  provider: CalendarConnectionRecord["provider"],
  label: string,
  serverHost: string | null,
  over: Partial<CalendarConnectionRecord> = {},
): CalendarConnectionRecord => ({
  id,
  provider,
  label,
  status: "active",
  errorCode: null,
  grantMailboxId: null,
  serverHost,
  consentedAt: UPDATED,
  lastSyncedAt: UPDATED,
  createdAt: UPDATED,
  updatedAt: UPDATED,
  ...over,
});

const calendar = (
  id: string,
  connectionId: string,
  name: string,
  color: string,
  over: Partial<CalendarRecord> = {},
): CalendarRecord => ({
  id,
  connectionId,
  name,
  color,
  access: "owner",
  shown: true,
  isDefault: false,
  timeZone: ZONE,
  window: null,
  defaultAlarms: [],
  lastSyncedAt: UPDATED,
  errorCode: null,
  updatedAt: UPDATED,
  ...over,
});

const CALENDARS: readonly CalendarRecord[] = [
  calendar("mila", "google", "Mila", "#039BE5", { isDefault: true }),
  calendar("studio", "google", "Lichtgrat studio", "#0B8043"),
  calendar("holidays", "google", "Holidays in Switzerland", "#616161", { access: "reader" }),
  calendar("family", "icloud", "Family", "#FFCC00", { access: "writer" }),
  calendar("home", "icloud", "Home", "#34C759", { shown: false }),
  calendar("vidralva", "m365", "Vidralva", "#8764B8"),
  calendar("catalogue", "m365", "Catalogue 2027", "#B4009E", { access: "reader" }),
];

/** One clock time on a day in Zürich, as the store writes it: the day as eight digits, the time as `16:00`. */
const zoned = (day: string, hhmm: string) =>
  ({ kind: "zoned", value: `${day}T${hhmm.replace(":", "")}00`, zone: ZONE }) as const;

interface Plain {
  readonly id: string;
  readonly cal: string;
  readonly title: string;
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly place?: string;
  readonly by?: { readonly address: string; readonly name: string };
  readonly answer?: CalendarEventRecord["myAnswer"];
  readonly cancelled?: boolean;
  /** A whole day: `from` and `to` are not read. */
  readonly allDay?: boolean;
}

const nextDay = (day: string) => {
  const t = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + 1),
  );
  return t.toISOString().slice(0, 10).replaceAll("-", "");
};

function event(e: Plain): CalendarEventRecord {
  return {
    id: e.id,
    calendarId: e.cal,
    uid: `${e.id}@lichtgrat.example`,
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: e.cancelled ? "cancelled" : "confirmed",
    title: e.title,
    notes: null,
    place: e.place ?? null,
    callLink: null,
    start: e.allDay ? { kind: "date", value: e.day } : zoned(e.day, e.from),
    end: e.allDay ? { kind: "date", value: nextDay(e.day) } : zoned(e.day, e.to),
    duration: null,
    startsAt: UPDATED,
    endsAt: UPDATED,
    occurrenceAt: null,
    repeat: null,
    busy: true,
    private: false,
    organizer: e.by ?? null,
    myAnswer: e.by ? (e.answer ?? "none") : null,
    heldBack: false,
    invitees: [],
    alarms: [],
    cut: false,
    writes: [],
    updatedAt: UPDATED,
  };
}

const PETRA = { address: "petra@makersfest.example", name: "Petra Wyss" };
const INES = { address: "ines@vidralva.example", name: "Inês Carvalho" };
const CARLA = { address: "carla@wintermarkt.example", name: "Carla Meier" };
const FLURINA = { address: "flurina@haldenlicht.example", name: "Flurina Caduff" };

/** Her own November around the invitations: what the views draw under the panel. */
const OWN: readonly Plain[] = [
  {
    id: "ev-poster-review",
    cal: "studio",
    title: "Poster review",
    day: "20261110",
    from: "14:30",
    to: "15:30",
  },
  { id: "ev-dentist", cal: "mila", title: "Dentist", day: "20261112", from: "09:30", to: "10:30" },
  { id: "ev-lunch-anna", cal: "mila", title: "Lunch with Anna", day: "20261113", from: "12:15", to: "13:30" },
  {
    id: "ev-studio-monday",
    cal: "studio",
    title: "Studio Monday",
    day: "20261116",
    from: "09:00",
    to: "09:30",
  },
  {
    id: "ev-flight-porto",
    cal: "mila",
    title: "Flight to Porto",
    day: "20261118",
    from: "06:55",
    to: "09:40",
  },
  {
    id: "ev-shoot-2",
    cal: "vidralva",
    title: "Catalogue shoot, day 2",
    day: "20261119",
    from: "10:00",
    to: "14:00",
  },
  {
    id: "ev-stand-setup",
    cal: "studio",
    title: "Stand set-up, Hall 2",
    day: "20261120",
    from: "15:30",
    to: "17:00",
    place: "Makersfest, Hall 2, Zürich",
  },
];

/** The invitations: three to answer, one cancelled by its sender, three answered. */
function invitations(state: string | null): readonly Plain[] {
  const answered = (first: boolean) =>
    state === "clear" || (state === "one" && first) ? "accepted" : "none";
  return [
    {
      id: "ev-techcheck",
      cal: "mila",
      title: "Tech check, main hall",
      day: "20261120",
      from: "16:00",
      to: "16:15",
      place: "Makersfest, Hall 2, Zürich",
      by: PETRA,
      answer: answered(true),
    },
    {
      id: "ev-shoot-1",
      cal: "vidralva",
      title: "Catalogue shoot, day 1",
      day: "20261118",
      from: "11:30",
      to: "18:00",
      place: "Vidralva, Porto",
      by: INES,
      answer: answered(false),
    },
    {
      id: "ev-catalogue-weekly-2026-11-17",
      cal: "vidralva",
      title: "Catalogue weekly",
      day: "20261117",
      from: "14:00",
      to: "14:45",
      place: "Call",
      by: INES,
      answer: "accepted",
      cancelled: true,
    },
    {
      id: "ev-dinner-porto",
      cal: "vidralva",
      title: "Dinner with Inês and Duarte",
      day: "20261118",
      from: "20:30",
      to: "22:30",
      place: "Porto",
      by: INES,
      answer: "accepted",
    },
    {
      id: "ev-stallholders",
      cal: "mila",
      title: "Stallholders' evening",
      day: "20261126",
      from: "19:00",
      to: "21:00",
      place: "Wintermarkt Lind",
      by: CARLA,
      answer: "tentative",
    },
    {
      id: "ev-briefing",
      cal: "mila",
      title: "Workshop briefing",
      day: "20261114",
      from: "09:00",
      to: "09:30",
      place: "Haldenlicht",
      by: FLURINA,
      answer: "declined",
    },
  ];
}

const found = (
  id: string,
  evidence: string,
  title: string,
  start: CalendarSuggestionRecord["proposed"]["start"],
  end: CalendarSuggestionRecord["proposed"]["end"],
  place: string | null,
  sourceWords: string,
): CalendarSuggestionRecord => ({
  id,
  messageId: `letter-${id}`,
  mailboxId: "studio",
  evidence,
  proposed: { title, start, end, place },
  sourceWords,
  createdAt: UPDATED,
  updatedAt: UPDATED,
});

/** The events found in her letters: four the letters' own data carries, and one guess that is never offered. */
const SUGGESTIONS: readonly CalendarSuggestionRecord[] = [
  found(
    "sug-winternacht",
    "calendar",
    "Winternacht",
    zoned("20261121", "19:30"),
    null,
    null,
    "Saturday 21 November, doors 19:30",
  ),
  found(
    "sug-lugano",
    "data",
    "Train to Lugano",
    zoned("20261114", "08:02"),
    zoned("20261114", "11:24"),
    "Winterthur → Lugano",
    "Saturday 14 November, departs 08:02, arrives 11:24",
  ),
  found(
    "sug-glaze",
    "calendar",
    "Glaze order #2291 arrives",
    { kind: "date", value: "20261112" },
    null,
    "Studio, Winterthur",
    "Thursday 12 November, before noon",
  ),
  found(
    "sug-talk",
    "calendar",
    "Wabi-sabi for web people",
    zoned("20261121", "11:00"),
    null,
    "Makersfest, main hall",
    "Saturday 21 November at 11:00 in the main hall",
  ),
  found("sug-lunch", "sentence", "Lunch", zoned("20261115", "12:00"), null, null, "lunch on Sunday?"),
];

/** What Add has made by the state: the found event on her calendar, as the provider gives it back. */
function addedOf(state: string | null): readonly Plain[] {
  const winternacht: Plain = {
    id: "ev-winternacht",
    cal: "mila",
    title: "Winternacht",
    day: "20261121",
    from: "19:30",
    to: "20:30",
  };
  if (state === "added") return [winternacht];
  if (state !== "all") return [];
  return [
    winternacht,
    { id: "ev-lugano", cal: "mila", title: "Train to Lugano", day: "20261114", from: "08:02", to: "11:24" },
    {
      id: "ev-talk",
      cal: "mila",
      title: "Wabi-sabi for web people",
      day: "20261121",
      from: "11:00",
      to: "12:00",
    },
    {
      id: "ev-glaze",
      cal: "studio",
      title: "Glaze order #2291 arrives",
      day: "20261112",
      from: "",
      to: "",
      allDay: true,
    },
  ];
}

export interface World {
  readonly engine: OhmailEngine;
  readonly port: CalendarPort;
  readonly setup: CalendarSetupPort;
}

export function worldOf(at: WorldState): World {
  const connections: CalendarConnectionRecord[] = [
    connection(
      "google",
      "google",
      "mila@lichtgrat.example",
      null,
      at.signedOut ? { status: "reconnect" } : {},
    ),
    connection("icloud", "caldav", "mila.brunner@icloud.example", "p42-caldav.icloud.com"),
    connection("m365", "microsoft", "mila.brunner@vidralva.example", null),
  ];
  const events = [...OWN, ...invitations(at.state), ...addedOf(at.state)].map(event);
  const kinds: Record<string, readonly { readonly id: string }[]> = {
    calendar_connection: connections,
    calendar: CALENDARS,
    calendar_event: events,
    calendar_suggestion: SUGGESTIONS,
  };
  const entries = (type: string) => (kinds[type] ?? []).map((entity) => ({ entity }));
  const subscribe = () => () => undefined;
  const engine = {
    store: { entries },
    subscribe,
    read: () => ({ version: () => 1 }),
  } as unknown as OhmailEngine;
  const settings: CalendarSettingsWire = {
    enabledAt: UPDATED,
    secondZone: at.secondZone ? "Europe/Lisbon" : null,
    weekNumbers: false,
    dayFromMinute: 7 * 60,
    dayToMinute: 21 * 60,
    newEventsCalendarId: "mila",
  };
  const port: CalendarPort = {
    newId: () => "new",
    press: () => new Promise(() => undefined),
    flush: async () => undefined,
    verdict: () => null,
    events: () =>
      (kinds.calendar_event as readonly CalendarEventRecord[]).map((record) => ({
        record,
        waiting: null,
        refusal: null,
        refusedWriteId: null,
      })),
    settings: async () => settings,
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
    version: () => 1,
    subscribe,
  };
  const answer = async () =>
    at.refused ? ({ kind: "refused", fault: "sign_in_refused" } as const) : ({ kind: "taken" } as const);
  const setup: CalendarSetupPort = {
    ways: async () => ["icloud", "caldav", "ics"],
    connect: answer,
    signInAgain: answer,
    remove: async () => undefined,
    check: async () => undefined,
    setCalendar: async () => undefined,
    saveSettings: async () => settings,
  };
  return { engine, port, setup };
}
