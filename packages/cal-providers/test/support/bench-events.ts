/**
 * The bench's invented events: the studio's demo world (a pottery studio, a catalogue, a market).
 * No person, no place, no address. Every date is a wall-clock time in Europe/Zurich.
 *
 * One list, written twice: as iCalendar for CalDAV servers and as Google's event resource.
 */
export const BENCH_ID = "r2-cal-accounts-20261113";
export const BENCH_CALENDAR = `ohmail-bench-${BENCH_ID}`;
export const BENCH_MARKER = "ohmail-bench";
export const BENCH_KEY = "ohmail-bench-key";
export const BENCH_INVITE_MARKER = "ohmail-bench-invite";
export const ZONE = "Europe/Zurich";

interface Timed {
  key: string;
  summary: string;
  description: string;
  /** Local wall-clock, `YYYY-MM-DDTHH:MM:SS`. */
  start: string;
  end: string;
  /** An iCalendar rule, without the `RRULE:` name. */
  rule?: string;
  /** One changed day of the series: the occurrence that was at `was` is held at `start`..`end`. */
  moved?: { was: string; start: string; end: string };
  /** A pasted call link (CalDAV) or a request for the provider's own (Google). */
  call?: string;
}
interface AllDay {
  key: string;
  summary: string;
  description: string;
  /** `YYYY-MM-DD`; `endDate` is the day after the last, as calendars write it. */
  date: string;
  endDate: string;
}
export type BenchEvent = Timed | AllDay;

export const BENCH_EVENTS: readonly BenchEvent[] = [
  { key: "glaze-firing", summary: "Glaze firing", description: "Cone 6. The blue set for the catalogue goes in first.", start: "2026-11-19T09:00:00", end: "2026-11-19T11:00:00" },
  { key: "catalogue-proofs", summary: "Catalogue proofs", description: "Read the spring catalogue's proofs, page by page.", start: "2026-11-20T14:00:00", end: "2026-11-20T15:00:00" },
  {
    key: "wheel-class",
    summary: "Wheel class",
    description: "Six evenings at the wheel. Bring an apron.",
    start: "2026-11-17T18:00:00",
    end: "2026-11-17T19:30:00",
    rule: "FREQ=WEEKLY;COUNT=6;BYDAY=TU",
    moved: { was: "2026-12-01T18:00:00", start: "2026-12-02T19:00:00", end: "2026-12-02T20:30:00" },
  },
  { key: "market-day", summary: "Market day", description: "The stall at the winter market, all day.", date: "2026-11-21", endDate: "2026-11-22" },
  { key: "stall-planning-call", summary: "Stall planning call", description: "Who brings the shelves, who brings the till.", start: "2026-11-23T10:00:00", end: "2026-11-23T10:30:00", call: "https://call.ohmail-bench.example/stall-planning" },
];

/** The one invitation, Google to iCloud, planted once. */
export const BENCH_INVITATION: Timed = { key: "kiln-handover", summary: "Kiln handover", description: "The kiln's keys and its firing log change hands.", start: "2026-11-25T16:00:00", end: "2026-11-25T16:30:00" };

/** The keys a provider's count is read against. Google keeps a changed day as a record of its own. */
export const BENCH_KEYS = BENCH_EVENTS.map((e) => e.key);

const isAllDay = (e: BenchEvent): e is AllDay => "date" in e;
const compact = (local: string) => local.replace(/[-:]/g, "");
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${ZONE}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export const benchUid = (key: string) => `${key}.${BENCH_ID}@ohmail-bench.example`;
export const benchResource = (key: string) => `${key}.ics`;

/** One calendar object (RFC 5545): the event, and its changed day when it has one. */
export function toICalendar(e: BenchEvent, stamp = "20261113T120000Z"): string {
  const common = [`UID:${benchUid(e.key)}`, `DTSTAMP:${stamp}`, "SEQUENCE:0", `SUMMARY:${text(e.summary)}`, `DESCRIPTION:${text(e.description)}`, `X-OHMAIL-BENCH:${BENCH_ID}`];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//cal bench//EN", "CALSCALE:GREGORIAN"];
  if (isAllDay(e)) {
    lines.push("BEGIN:VEVENT", ...common, `DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(e.endDate)}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  } else {
    lines.push(...VTIMEZONE, "BEGIN:VEVENT", ...common, `DTSTART;TZID=${ZONE}:${compact(e.start)}`, `DTEND;TZID=${ZONE}:${compact(e.end)}`);
    if (e.rule) lines.push(`RRULE:${e.rule}`);
    if (e.call) lines.push(`URL:${e.call}`);
    lines.push("END:VEVENT");
    if (e.moved) {
      lines.push("BEGIN:VEVENT", ...common, `RECURRENCE-ID;TZID=${ZONE}:${compact(e.moved.was)}`, `DTSTART;TZID=${ZONE}:${compact(e.moved.start)}`, `DTEND;TZID=${ZONE}:${compact(e.moved.end)}`, "END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export interface GoogleEventBody {
  summary: string;
  description: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: "hangoutsMeet" } } };
  extendedProperties: { private: Record<string, string> };
}

/** Google's event resource for one bench event. A call is asked of Google (Meet), never pasted. */
export function toGoogleEvent(e: BenchEvent): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: e.summary,
    description: e.description,
    start: isAllDay(e) ? { date: e.date } : { dateTime: e.start, timeZone: ZONE },
    end: isAllDay(e) ? { date: e.endDate } : { dateTime: e.end, timeZone: ZONE },
    extendedProperties: { private: { [BENCH_MARKER]: BENCH_ID, [BENCH_KEY]: e.key } },
  };
  if (!isAllDay(e) && e.rule) body.recurrence = [`RRULE:${e.rule}`];
  if (!isAllDay(e) && e.call) body.conferenceData = { createRequest: { requestId: `${BENCH_ID}-${e.key}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return body;
}

/** The changed day of a series, for Google: the instance that started at `was` gets these times. */
export function googleMove(e: BenchEvent): { was: string; patch: Pick<GoogleEventBody, "start" | "end" | "extendedProperties"> } | undefined {
  if (isAllDay(e) || !e.moved) return undefined;
  return {
    was: e.moved.was,
    patch: {
      start: { dateTime: e.moved.start, timeZone: ZONE },
      end: { dateTime: e.moved.end, timeZone: ZONE },
      extendedProperties: { private: { [BENCH_MARKER]: BENCH_ID, [BENCH_KEY]: `${e.key}-moved` } },
    },
  };
}

// ---------------------------------------------------------------- is the planted set still there, as planted?

export interface CalDavReading {
  listStatus: number;
  /** Absent when the bench's calendar was not found and so not asked. */
  queryStatus: number | undefined;
  objects: number;
  /** The bench's keys whose UID was read, each once per object that carries it. */
  keys: readonly string[];
  /** Objects that carry the bench's own property. */
  marked: number;
}
const each = (keys: readonly (string | undefined)[], wanted: readonly string[]) => [
  ...wanted.filter((k) => !keys.includes(k)).map((k) => `${k} is missing`),
  ...wanted.filter((k) => keys.filter((x) => x === k).length > 1).map((k) => `${k} is there more than once`),
];

/** What is wrong with a CalDAV server's reading of the planted set. Empty: it stands as planted. */
export function caldavNotAsPlanted(r: CalDavReading): string[] {
  if (r.listStatus !== 207) return [`the home's list answered ${r.listStatus}`];
  if (r.queryStatus === undefined) return ["the bench's calendar is absent"];
  if (r.queryStatus !== 207) return [`the calendar's report answered ${r.queryStatus}`];
  const n = BENCH_EVENTS.length;
  return [...(r.objects === n ? [] : [`${r.objects} objects, planted ${n}`]), ...each(r.keys, BENCH_KEYS), ...(r.marked === r.objects ? [] : [`${r.marked} of ${r.objects} carry the bench's mark`])];
}

export interface GoogleReading {
  listStatus: number;
  /** The bench's key of every marked record, `undefined` for a record without one. */
  keys: readonly (string | undefined)[];
  /** The number of invitees of every record that carries the invitation's mark. */
  invitees: readonly number[];
}
/** The keys of Google's records: a changed day is a record of its own there. */
export const GOOGLE_PLANTED_KEYS: readonly string[] = [...BENCH_KEYS, "wheel-class-moved"];

/**
 * What is wrong with Google's reading of the planted set. It stands as planted in exactly two states:
 * the six records, or the six and the one invitation with its one invitee.
 */
export function googleNotAsPlanted(r: GoogleReading): string[] {
  if (r.listStatus !== 200) return [`the marked list answered ${r.listStatus}`];
  const invited = r.invitees.length > 0 || r.keys.includes(BENCH_INVITATION.key);
  const wanted = invited ? [...GOOGLE_PLANTED_KEYS, BENCH_INVITATION.key] : GOOGLE_PLANTED_KEYS;
  return [
    ...(r.keys.length === wanted.length ? [] : [`${r.keys.length} records, planted ${wanted.length}`]),
    ...each(r.keys, wanted),
    ...(invited && r.invitees.length !== 1 ? [`${r.invitees.length} records carry the invitation's mark, planted 1`] : []),
    ...r.invitees.filter((n) => n !== 1).map((n) => `an invitation with ${n} invitees, planted with 1`),
  ];
}
