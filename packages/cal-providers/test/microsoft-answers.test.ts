/**
 * What Microsoft's reader does with answers the bench's double does not give: every kind of repeat
 * Microsoft names, Windows' names for zones, a link that leaves the Graph base, the statuses, and
 * records that are left out. No request leaves the process: the reader is handed a request port that
 * answers from a table and throws on any other address.
 *
 * The expected rules are written from Microsoft's pages (recurrencePattern, recurrenceRange) and the
 * calendar standard's rule grammar; the expected words from Microsoft's pages on errors, throttling
 * and the delta query.
 */
import { expandSeries, instant, intlZones, parseRRule, plainDate, seriesOf, wall, zoned } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { ruleOfRecurrence } from "../src/microsoft/convert.js";
import { makeReader, MS_GRAPH_BASE } from "../src/microsoft/index.js";
import type { ChangeItem, Connection } from "../src/port.js";
import type { ProviderRefusal } from "../src/refusals.js";
import type { HttpPort } from "../src/request/index.js";

const BASE = MS_GRAPH_BASE;
const VIEW = `${BASE}/me/calendars/cal-1/calendarView/delta`;
const FIRST = `${VIEW}?startDateTime=2026-11-16T00:00:00Z&endDateTime=2027-01-01T00:00:00Z`;
const NEXT = `${VIEW}?$skiptoken=s1`;
const DELTA = `${VIEW}?$deltatoken=d1`;
const CALENDARS = `${BASE}/me/calendars`;
const SERIES = `${BASE}/me/calendars/cal-1/events/m-1`;
const BERLIN = "Europe/Berlin";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const WINDOW = { start: instant(Date.UTC(2026, 10, 16)), end: instant(Date.UTC(2027, 0, 1)) };
// The base with a user and a password in it, put together here so that no line of this file is shaped like one.
const BASE_WITH_SIGN_IN = ["https://", "user", ":", "pw", "@", "graph.microsoft.com/v1.0"].join("");

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | { refused: ProviderRefusal };
type Routes = Record<string, Reply | Reply[]>;

/** A request port that answers from a table and records what it was asked. An address the table does not hold is a failed test, never a request. */
function serving(routes: Routes) {
  const sent: { url: string; method: string; token: string | null; prefer: string | undefined; tokenGoesTo: Record<string, boolean> }[] = [];
  const http: HttpPort = {
    async request(url, o) {
      const token = o.auth !== null && o.auth.credential.kind === "bearer" ? o.auth.credential.token : null;
      sent.push({ url, method: o.method, token, prefer: o.headers.prefer, tokenGoesTo: Object.fromEntries(["graph.microsoft.com", "login.microsoftonline.com", "graph.evil.example"].map((h) => [h, o.auth?.admits(h) ?? false])) });
      const route = routes[url];
      if (route === undefined) throw new Error(`the test serves nothing at ${url}`);
      const reply = Array.isArray(route) ? route.shift() : route;
      if (reply === undefined) throw new Error(`the test has no further answer for ${url}`);
      if ("refused" in reply) return { arrived: false, reason: reply.refused };
      const body = new TextEncoder().encode(reply.text ?? JSON.stringify(reply.json ?? {}));
      return { arrived: true, status: reply.status ?? 200, header: (name) => reply.headers?.[name.toLowerCase()] ?? null, body, location: reply.headers?.location ?? null, url, hops: 0 };
    },
  };
  return { http, sent };
}

const zones = intlZones();
const readerOver = (routes: Routes, graphBase = BASE) => {
  const { http, sent } = serving(routes);
  return { reader: makeReader({ http, clock: { now: () => NOW }, zones, graphBase }), sent };
};
const signedIn = (token = "t1"): Connection => ({ provider: "microsoft", credential: { kind: "bearer", accessToken: async () => ({ ok: true, token }) }, start: null });
const never = new AbortController().signal;
const cal = { id: "cal-1" };
const firstPage = { limit: 250, cursor: null, window: WINDOW };
const upserts = (items: readonly ChangeItem[]) => items.filter((i): i is Extract<ChangeItem, { kind: "upsert" }> => i.kind === "upsert");
const refusal = (reason: ProviderRefusal, retryAfterMs: number | null = null) => ({ ok: false, reason, retryAfterMs });

/** Microsoft's own form of a time when no zone is asked for: seven digits of a second's fraction, in UTC. */
const utc = (dateTime: string) => ({ dateTime: `${dateTime}.0000000`, timeZone: "UTC" });
const W_EUROPE = { originalStartTimeZone: "W. Europe Standard Time", originalEndTimeZone: "W. Europe Standard Time" };
const single = (over: Record<string, unknown> = {}) => ({ id: "e-1", type: "singleInstance", iCalUId: "uid-e-1", subject: "Kiln cooling", start: utc("2026-11-30T07:00:00"), end: utc("2026-11-30T08:00:00"), ...W_EUROPE, ...over });
const series = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  type: "seriesMaster",
  iCalUId: "uid-m-1",
  subject: "Stock count",
  start: utc("2027-01-31T09:00:00"),
  end: utc("2027-01-31T10:00:00"),
  ...W_EUROPE,
  recurrence: { pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 31 }, range: { type: "noEnd", startDate: "2027-01-31", recurrenceTimeZone: "W. Europe Standard Time" } },
  ...over,
});
const day = (originalStart: string, over: Record<string, unknown> = {}) => ({ id: `d-${originalStart}`, type: "occurrence", seriesMasterId: "m-1", iCalUId: `uid-of-the-day-${originalStart}`, originalStart, start: utc(originalStart.slice(0, 19)), end: utc(originalStart.slice(0, 19)), ...W_EUROPE, ...over });

/** One whole page of these records, read from the beginning. */
async function pageOf(records: readonly unknown[], more: Routes = {}) {
  const { reader, sent } = readerOver({ [FIRST]: { json: { value: records, "@odata.deltaLink": DELTA } }, ...more });
  const answer = await reader.readChanges(signedIn(), cal, null, firstPage, never);
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
  return { page: answer.value, sent };
}

describe("Microsoft's repeat as the one rule grammar", () => {
  const repeat = (pattern: Record<string, unknown>, range: Record<string, unknown> = { type: "noEnd", startDate: "2026-11-17" }) => ({ pattern: { interval: 1, ...pattern }, range });
  const WORKING_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

  it.each<[string, unknown, string]>([
    ["every second day", repeat({ type: "daily", interval: 2 }), "FREQ=DAILY;INTERVAL=2"],
    ["Monday and Wednesday of every second week, weeks beginning on Sunday, to the last day of the year", repeat({ type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "sunday" }, { type: "endDate", startDate: "2026-11-16", endDate: "2026-12-31" }), "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231;BYDAY=MO,WE;WKST=SU"],
    ["a week with no first day named, which at Microsoft begins on Sunday", repeat({ type: "weekly", daysOfWeek: ["friday"] }), "FREQ=WEEKLY;BYDAY=FR;WKST=SU"],
    ["the 15th of every month, twelve times", repeat({ type: "absoluteMonthly", dayOfMonth: 15 }, { type: "numbered", startDate: "2026-11-15", numberOfOccurrences: 12 }), "FREQ=MONTHLY;COUNT=12;BYMONTHDAY=15"],
    ["the 31st of every month, which in a shorter month is its last day", repeat({ type: "absoluteMonthly", dayOfMonth: 31 }), "FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1"],
    ["the second Tuesday of every month", repeat({ type: "relativeMonthly", daysOfWeek: ["tuesday"], index: "second" }), "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2"],
    ["the last working day of every third month", repeat({ type: "relativeMonthly", interval: 3, daysOfWeek: WORKING_DAYS, index: "last" }), "FREQ=MONTHLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"],
    ["a relative month with no place named, which at Microsoft is the first", repeat({ type: "relativeMonthly", daysOfWeek: ["sunday"] }), "FREQ=MONTHLY;BYDAY=SU;BYSETPOS=1"],
    ["14 March of every year", repeat({ type: "absoluteYearly", month: 3, dayOfMonth: 14 }), "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14"],
    ["29 February of every year, the 28th where there is none", repeat({ type: "absoluteYearly", month: 2, dayOfMonth: 29 }), "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1"],
    ["the fourth Thursday of November", repeat({ type: "relativeYearly", month: 11, daysOfWeek: ["thursday"], index: "fourth" }), "FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4"],
  ])("reads %s", (_what, recurrence, written) => {
    const expected = parseRRule(written);
    expect(expected).not.toBeNull();
    expect(ruleOfRecurrence(recurrence)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a kind of repeat Microsoft does not name", repeat({ type: "hourly" })],
    ["an interval of nothing", repeat({ type: "daily", interval: 0 })],
    ["a week with no weekday", repeat({ type: "weekly" })],
    ["a weekday nobody has", repeat({ type: "weekly", daysOfWeek: ["someday"] })],
    ["a relative month with no weekday", repeat({ type: "relativeMonthly", index: "first" })],
    ["a place in the month nobody named", repeat({ type: "relativeMonthly", daysOfWeek: ["monday"], index: "fifth" })],
    ["a month's 32nd day", repeat({ type: "absoluteMonthly", dayOfMonth: 32 })],
    ["a month's day that is not named", repeat({ type: "absoluteMonthly" })],
    ["a 13th month", repeat({ type: "absoluteYearly", month: 13, dayOfMonth: 1 })],
    ["no occurrences at all", repeat({ type: "daily" }, { type: "numbered", startDate: "2026-11-17", numberOfOccurrences: 0 })],
    ["an end that is no day", repeat({ type: "daily" }, { type: "endDate", startDate: "2026-11-17", endDate: "2026-02-30" })],
    ["an end of a kind Microsoft does not name", repeat({ type: "daily" }, { type: "someday", startDate: "2026-11-17" })],
    ["no pattern", { range: { type: "noEnd" } }],
    ["nothing", null],
  ])("reads %s as no rule at all, never as a rule that is nearly it", (_what, recurrence) => {
    expect(ruleOfRecurrence(recurrence)).toBeNull();
  });

  it("hands the series so that the 31st of every month falls on the last day of a shorter one, on the series' own clock", async () => {
    const { page, sent } = await pageOf([day("2027-02-28T09:00:00Z")], { [SERIES]: { json: series() } });
    expect(sent.map((s) => s.url)).toEqual([FIRST, SERIES]);
    const [stock] = upserts(page.items);
    // Windows' name for the zone becomes the name every calendar knows it by.
    expect({ id: stock!.id, uid: stock!.event.uid, start: stock!.event.start, end: stock!.event.end }).toEqual({ id: "m-1", uid: "uid-m-1", start: zoned(wall(2027, 1, 31, 10), BERLIN), end: zoned(wall(2027, 1, 31, 11), BERLIN) });
    // A day's own identifier differs from its series' at Microsoft: the day is known by the series'.
    expect(page.expanded).toEqual({ window: WINDOW, seen: [{ uid: "uid-m-1", originalStart: zoned(wall(2027, 2, 28, 10), BERLIN) }] });
    const [all] = seriesOf([stock!.event], zones);
    const days = expandSeries(all!, { startMs: Date.UTC(2027, 0, 1), endMs: Date.UTC(2027, 5, 1), viewerZone: BERLIN }, zones);
    expect(days.occurrences.map((o) => (o.start.kind === "zoned" ? [o.start.wall.month, o.start.wall.day, o.start.wall.hour] : null))).toEqual([[1, 31, 10], [2, 28, 10], [3, 31, 10], [4, 30, 10], [5, 31, 10]]);
  });

  it("ends a repeat with its last day on the series' own clock, also where that evening is already the next day in UTC", async () => {
    // Every evening at eight in Los Angeles from 1 to 3 December, "between the startDate and endDate inclusive". Eight there is four in the morning of the next day in UTC.
    const PACIFIC = { originalStartTimeZone: "Pacific Standard Time", originalEndTimeZone: "Pacific Standard Time" };
    const evenings = series({ ...PACIFIC, start: utc("2026-12-02T04:00:00"), end: utc("2026-12-02T05:00:00"), recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "endDate", startDate: "2026-12-01", endDate: "2026-12-03", recurrenceTimeZone: "Pacific Standard Time" } } });
    const { page } = await pageOf([day("2026-12-02T04:00:00Z", PACIFIC)], { [SERIES]: { json: evenings } });
    const [all] = seriesOf(upserts(page.items).map((i) => i.event), zones);
    const days = expandSeries(all!, { startMs: Date.UTC(2026, 10, 16), endMs: Date.UTC(2027, 0, 1), viewerZone: "America/Los_Angeles" }, zones);
    expect(days.occurrences.map((o) => (o.start.kind === "zoned" ? [o.start.wall.month, o.start.wall.day, o.start.wall.hour] : null))).toEqual([[12, 1, 20], [12, 2, 20], [12, 3, 20]]);
    expect(page.expanded!.seen).toEqual([{ uid: "uid-m-1", originalStart: zoned(wall(2026, 12, 1, 20), "America/Los_Angeles") }]);
  });

  it("tells a series' days on the clock its repeat names, where that is another than the one the event was made on", async () => {
    const made = series({ originalStartTimeZone: "Tokyo Standard Time", recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2027-01-31", recurrenceTimeZone: "W. Europe Standard Time" } } });
    const { page } = await pageOf([day("2027-02-01T09:00:00Z")], { [SERIES]: { json: made } });
    expect(upserts(page.items)[0]!.event.start).toEqual(zoned(wall(2027, 1, 31, 10), BERLIN));
    expect(page.expanded!.seen).toEqual([{ uid: "uid-m-1", originalStart: zoned(wall(2027, 2, 1, 10), BERLIN) }]);
  });

  it("reads a series of whole days as days: its start, its rule's end and each day seen, whichever midnight Microsoft tells a day by", async () => {
    const newYear = series({ isAllDay: true, start: utc("2027-01-01T00:00:00"), end: utc("2027-01-02T00:00:00"), recurrence: { pattern: { type: "absoluteYearly", interval: 1, month: 1, dayOfMonth: 1 }, range: { type: "endDate", startDate: "2027-01-01", endDate: "2030-01-01" } } });
    // The first day's start is midnight in UTC; the second's is midnight in Berlin, an hour earlier; the third's is no midnight anywhere.
    const { page } = await pageOf([day("2028-01-01T00:00:00Z"), day("2028-12-31T23:00:00Z"), day("2030-01-01T09:30:00Z")], { [SERIES]: { json: newYear } });
    const event = upserts(page.items)[0]!.event;
    expect({ start: event.start, end: event.end, rules: event.rules.map((r) => r.rule) }).toEqual({ start: plainDate(2027, 1, 1), end: plainDate(2027, 1, 2), rules: [parseRRule("FREQ=YEARLY;UNTIL=20300101;BYMONTH=1;BYMONTHDAY=1")] });
    expect(page.expanded!.seen).toEqual([{ uid: "uid-m-1", originalStart: plainDate(2028, 1, 1) }, { uid: "uid-m-1", originalStart: plainDate(2029, 1, 1) }]);
    expect(page.left).toEqual([{ id: "d-2030-01-01T09:30:00Z", reason: "unreadable" }]);
  });

  it("leaves out, and says so, a series whose rule it cannot follow or whose zone nobody knows, with its days", async () => {
    const records = [day("2027-02-28T09:00:00Z"), single()];
    const noRule = await pageOf(records, { [SERIES]: { json: series({ recurrence: { pattern: { type: "hourly", interval: 1 }, range: { type: "noEnd" } } }) } });
    const noZone = await pageOf(records, { [SERIES]: { json: series({ originalStartTimeZone: "tzone://Microsoft/Custom", recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2027-01-31" } } }) } });
    for (const { page } of [noRule, noZone]) {
      expect({ left: page.left, ids: upserts(page.items).map((i) => i.id), seen: page.expanded!.seen }).toEqual({ left: [{ id: "m-1", reason: "unreadable" }], ids: ["e-1"], seen: [] });
    }
  });

  it("says nothing of the days of a series that is itself gone, and refuses the page when the series cannot be asked for now", async () => {
    const gone = await pageOf([day("2027-02-28T09:00:00Z"), single()], { [SERIES]: { status: 404, json: { error: { code: "ErrorItemNotFound" } } } });
    expect({ left: gone.page.left, ids: upserts(gone.page.items).map((i) => i.id), seen: gone.page.expanded!.seen }).toEqual({ left: [], ids: ["e-1"], seen: [] });
    const busy = readerOver({ [FIRST]: { json: { value: [day("2027-02-28T09:00:00Z")], "@odata.deltaLink": DELTA } }, [SERIES]: { status: 429, headers: { "retry-after": "3" }, json: {} } });
    expect(await busy.reader.readChanges(signedIn(), cal, null, firstPage, never)).toEqual(refusal("throttled", 3000));
  });
});

describe("Microsoft: one event's fields", () => {
  it("works a clock time out in the event's own zone from the moment Microsoft wrote in UTC, and keeps the moment where nobody knows the zone", async () => {
    const { page } = await pageOf([
      single(),
      single({ id: "e-2", iCalUId: "uid-e-2", originalStartTimeZone: "Tokyo Standard Time", originalEndTimeZone: "America/New_York" }),
      single({ id: "e-3", iCalUId: "uid-e-3", originalStartTimeZone: "tzone://Microsoft/Custom", originalEndTimeZone: undefined }),
    ]);
    // 07:00 UTC on 30 November: 08:00 in Berlin, 16:00 in Tokyo; 08:00 UTC is 03:00 in New York.
    expect(upserts(page.items).map((i) => [i.event.start, i.event.end])).toEqual([
      [zoned(wall(2026, 11, 30, 8), BERLIN), zoned(wall(2026, 11, 30, 9), BERLIN)],
      [zoned(wall(2026, 11, 30, 16), "Asia/Tokyo"), zoned(wall(2026, 11, 30, 3), "America/New_York")],
      [instant(Date.UTC(2026, 10, 30, 7)), instant(Date.UTC(2026, 10, 30, 8))],
    ]);
  });

  it("reads a day-long event as its days, also where Microsoft wrote the day's midnight on the event's own clock", async () => {
    const { page } = await pageOf([
      single({ isAllDay: true, start: utc("2026-11-21T00:00:00"), end: utc("2026-11-22T00:00:00") }),
      single({ id: "e-2", iCalUId: "uid-e-2", isAllDay: true, start: utc("2026-11-20T23:00:00"), end: utc("2026-11-21T23:00:00") }),
      single({ id: "e-3", iCalUId: "uid-e-3", isAllDay: true, start: utc("2026-11-21T05:30:00"), end: utc("2026-11-22T05:30:00") }),
    ]);
    expect(upserts(page.items).map((i) => [i.id, i.event.start, i.event.end])).toEqual([
      ["e-1", plainDate(2026, 11, 21), plainDate(2026, 11, 22)],
      ["e-2", plainDate(2026, 11, 21), plainDate(2026, 11, 22)],
    ]);
    expect(page.left).toEqual([{ id: "e-3", reason: "unreadable" }]);
  });

  it("reads who is invited and what each answered, how the time is shown, and what is private or cancelled", async () => {
    const person = (name: string, address: string) => ({ emailAddress: { name, address } });
    const invitation = single({
      "@odata.etag": 'W/"ck-1"',
      changeKey: "ck-1",
      subject: "Kiln handover",
      body: { contentType: "text", content: "The kiln's keys and its firing log change hands." },
      bodyPreview: "The kiln's keys",
      location: { displayName: "Studio, back room; ring twice" },
      showAs: "free",
      sensitivity: "private",
      isCancelled: true,
      createdDateTime: "2026-11-13T12:00:00Z",
      lastModifiedDateTime: "2026-11-13T12:00:05.1234567Z",
      onlineMeeting: { joinUrl: "https://teams.bench.example/l/meetup-join/1" },
      organizer: person("Mila Brunner", "mila@lichtgrat.example"),
      attendees: [
        { type: "required", status: { response: "accepted" }, ...person("Petra Wyss", "petra@makersfest.example") },
        { type: "optional", status: { response: "tentativelyAccepted" }, ...person("", "giulia@terracotta-milano.example") },
        { type: "resource", status: { response: "declined" }, ...person("Back room", "room@lichtgrat.example") },
        { type: "required", status: { response: "organizer" }, ...person("Mila Brunner", "mila@lichtgrat.example") },
        { type: "required", status: { response: "none" }, ...person("Nobody", "not an address") },
      ],
    });
    const { page } = await pageOf([invitation, single({ id: "e-2", iCalUId: "uid-e-2", body: { contentType: "html", content: "<p>Six evenings</p>" }, bodyPreview: "Six evenings", sensitivity: "confidential", showAs: "oof" })]);
    const [first, second] = upserts(page.items);
    expect(first!.version).toBe('W/"ck-1"');
    const e = first!.event;
    expect({ summary: e.summary, description: e.description, location: e.location, shown: e.transparency, cls: e.classification, status: e.status, url: e.url, created: e.created, changed: e.lastModified, organizer: [e.organizer?.name, e.organizer?.email] }).toEqual({
      summary: "Kiln handover",
      description: "The kiln's keys and its firing log change hands.",
      location: "Studio, back room; ring twice",
      shown: "TRANSPARENT",
      cls: "PRIVATE",
      status: "CANCELLED",
      url: "https://teams.bench.example/l/meetup-join/1",
      created: instant(Date.UTC(2026, 10, 13, 12)),
      changed: instant(Date.UTC(2026, 10, 13, 12, 0, 5)),
      organizer: ["Mila Brunner", "mila@lichtgrat.example"],
    });
    expect(e.attendees.map((a) => [a.email, a.name, a.partstat, a.role])).toEqual([
      ["petra@makersfest.example", "Petra Wyss", "ACCEPTED", "REQ-PARTICIPANT"],
      ["giulia@terracotta-milano.example", null, "TENTATIVE", "OPT-PARTICIPANT"],
      ["room@lichtgrat.example", "Back room", "DECLINED", "NON-PARTICIPANT"],
      ["mila@lichtgrat.example", "Mila Brunner", "ACCEPTED", "REQ-PARTICIPANT"],
    ]);
    // A body in markup is read as Microsoft's own plain preview of it.
    expect({ description: second!.event.description, cls: second!.event.classification, shown: second!.event.transparency, status: second!.event.status }).toEqual({ description: "Six evenings", cls: "CONFIDENTIAL", shown: "OPAQUE", status: null });
  });

  it("hands a changed day of a series under the series' own identifier, replacing the day it was", async () => {
    const moved = day("2027-02-28T09:00:00Z", { id: "x-1", type: "exception", start: utc("2027-03-01T13:00:00"), end: utc("2027-03-01T14:00:00"), subject: "Stock count, moved" });
    const { page } = await pageOf([moved], { [SERIES]: { json: series() } });
    expect(upserts(page.items).map((i) => [i.id, i.event.uid, i.event.recurrenceId, i.event.start, i.event.summary])).toEqual([
      ["m-1", "uid-m-1", null, zoned(wall(2027, 1, 31, 10), BERLIN), "Stock count"],
      ["x-1", "uid-m-1", zoned(wall(2027, 2, 28, 10), BERLIN), zoned(wall(2027, 3, 1, 14), BERLIN), "Stock count, moved"],
    ]);
    expect(page.expanded!.seen).toEqual([{ uid: "uid-m-1", originalStart: zoned(wall(2027, 2, 28, 10), BERLIN) }]);
  });

  it("still names a changed day as one Microsoft showed when the change itself cannot be read: the day is there, and is not to be taken for a cancelled one", async () => {
    const broken = day("2027-02-28T09:00:00Z", { id: "x-1", type: "exception", start: { dateTime: "some time in March", timeZone: "UTC" } });
    const { page } = await pageOf([broken], { [SERIES]: { json: series() } });
    expect({ ids: upserts(page.items).map((i) => i.id), left: page.left, seen: page.expanded!.seen }).toEqual({
      ids: ["m-1"],
      left: [{ id: "x-1", reason: "unreadable" }],
      seen: [{ uid: "uid-m-1", originalStart: zoned(wall(2027, 2, 28, 10), BERLIN) }],
    });
  });
});

describe("Microsoft: what is left out, and said", () => {
  it("leaves out a record whose identifier or zone is past what the calendar reader takes, or that is no event, and reads the rest", async () => {
    const { page } = await pageOf([
      single({ id: "long-uid", iCalUId: "u".repeat(1025) }),
      single({ id: "long-zone", originalStartTimeZone: "Z".repeat(256) }),
      single({ id: "no-start", start: undefined }),
      single({ id: "no-clock", start: { dateTime: "next Tuesday", timeZone: "UTC" } }),
      single({ id: "another-zone-in-the-answer", start: { dateTime: "2026-11-30T08:00:00.0000000", timeZone: "Mars/Olympus_Mons" } }),
      single({ id: "strange", type: "somethingElse" }),
      day("", { id: "day-of-no-day", originalStart: undefined }),
      single({ id: "i".repeat(1025) }),
      "no record at all",
      { type: "singleInstance" },
      single(),
    ]);
    expect(page.left).toEqual([
      { id: "long-uid", reason: "uid_too_long" },
      { id: "long-zone", reason: "zone_name_too_long" },
      { id: "no-start", reason: "unreadable" },
      { id: "no-clock", reason: "unreadable" },
      { id: "another-zone-in-the-answer", reason: "unreadable" },
      { id: "strange", reason: "unreadable" },
      { id: "day-of-no-day", reason: "unreadable" },
      // Past the ceiling it is no id of Microsoft's: named by as much as an id may have, never by all of it.
      { id: "i".repeat(1024), reason: "uid_too_long" },
      { id: "", reason: "unreadable" },
      { id: "", reason: "unreadable" },
    ]);
    expect(upserts(page.items).map((i) => i.id)).toEqual(["e-1"]);
  });

  it("names what it leaves out by its whole id: two series of one mailbox are two ids, and a reading of the whole window can spare both", async () => {
    // Microsoft's ids run to some 150 characters, and the first hundred are the mailbox's and the folder's: the same for every event in a calendar.
    const mailbox = "mailbox-and-folder.".repeat(7);
    const [one, two] = [`${mailbox}series-one`, `${mailbox}series-two`];
    const noRule = { recurrence: { pattern: { type: "hourly", interval: 1 }, range: { type: "noEnd" } } };
    const at = (id: string): string => `${BASE}/me/calendars/cal-1/events/${id}`;
    const { page } = await pageOf(
      [
        day("2027-02-28T09:00:00Z", { id: `${one}.day`, seriesMasterId: one }),
        day("2027-02-28T09:00:00Z", { id: `${two}.day`, seriesMasterId: two }),
        single({ id: `${mailbox}no-start`, start: undefined }),
      ],
      { [at(one)]: { json: series({ id: one, ...noRule }) }, [at(two)]: { json: series({ id: two, ...noRule }) } },
    );
    expect(one.length).toBeGreaterThan(64);
    expect({ mode: page.mode, items: page.items, left: page.left }).toEqual({
      mode: "whole",
      items: [],
      left: [{ id: one, reason: "unreadable" }, { id: two, reason: "unreadable" }, { id: `${mailbox}no-start`, reason: "unreadable" }],
    });
  });

  it("reports what Microsoft marks as removed as gone, whatever reason it gives", async () => {
    const { page } = await pageOf([{ id: "e-7", "@removed": { reason: "deleted" } }, { id: "e-8", "@removed": { reason: "changed" } }]);
    expect(page.items).toEqual([{ kind: "gone", id: "e-7" }, { kind: "gone", id: "e-8" }]);
  });
});

describe("Microsoft: the links to a next page and to the next reading", () => {
  it("asks for the window in Microsoft's own form with the page's size, follows the next page's link whole, and keeps the last link as the token", async () => {
    const { reader, sent } = readerOver({ [FIRST]: { json: { value: [single()], "@odata.nextLink": NEXT } }, [NEXT]: { json: { value: [], "@odata.deltaLink": DELTA } }, [DELTA]: { json: { value: [], "@odata.deltaLink": `${VIEW}?$deltatoken=d2` } } });
    const first = await reader.readChanges(signedIn(), cal, null, { ...firstPage, limit: 40 }, never);
    if (!first.ok || first.value.cursor.kind !== "more") throw new Error("no next page");
    const second = await reader.readChanges(signedIn(), cal, null, { ...firstPage, limit: 40, cursor: first.value.cursor.value }, never);
    if (!second.ok || second.value.cursor.kind !== "end" || second.value.cursor.token === null) throw new Error("no token");
    const third = await reader.readChanges(signedIn(), cal, second.value.cursor.token, { ...firstPage, limit: 9999 }, never);
    expect(third).toMatchObject({ ok: true, value: { mode: "delta", items: [], cursor: { kind: "end", token: { provider: "microsoft" } } } });
    expect(sent.map((s) => [s.method, s.url, s.prefer, s.token])).toEqual([
      ["GET", FIRST, "odata.maxpagesize=40", "t1"],
      ["GET", NEXT, "odata.maxpagesize=40", "t1"],
      ["GET", DELTA, "odata.maxpagesize=250", "t1"],
    ]);
    expect(sent.every((s) => s.tokenGoesTo["graph.microsoft.com"] === true && !s.tokenGoesTo["login.microsoftonline.com"] && !s.tokenGoesTo["graph.evil.example"])).toBe(true);
  });

  it("keeps a calendar's id inside its one segment of the path", async () => {
    const url = `${BASE}/me/calendars/team%2F..%2F..%2Fusers%3Fx%3D1%23y/calendarView/delta?startDateTime=2026-11-16T00:00:00Z&endDateTime=2027-01-01T00:00:00Z`;
    const { reader, sent } = readerOver({ [url]: { json: { value: [], "@odata.deltaLink": DELTA } } });
    expect((await reader.readChanges(signedIn(), { id: "team/../../users?x=1#y" }, null, firstPage, never)).ok).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([url]);
  });

  it.each<[string, Record<string, unknown>, ProviderRefusal]>([
    ["a next page on another host", { "@odata.nextLink": "https://graph.evil.example/v1.0/me/calendars/cal-1/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next reading on another host", { "@odata.deltaLink": "https://graph.evil.example/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=d1" }, "page_link_refused"],
    ["a next page on another port of the host", { "@odata.nextLink": "https://graph.microsoft.com:8443/v1.0/me/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next page without encryption", { "@odata.nextLink": "http://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next page outside the base's path", { "@odata.nextLink": "https://graph.microsoft.com/beta/me/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next page beside the base's path", { "@odata.nextLink": "https://graph.microsoft.com/v1.0evil/me/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next page that climbs out of the base's path", { "@odata.nextLink": "https://graph.microsoft.com/v1.0/../beta/me/calendarView/delta?$skiptoken=s1" }, "page_link_refused"],
    ["a next page with a sign-in of its own in it", { "@odata.nextLink": `${BASE_WITH_SIGN_IN}/me/calendarView/delta?$skiptoken=s1` }, "page_link_refused"],
    ["the page just asked for as the next one", { "@odata.nextLink": FIRST }, "page_link_refused"],
    ["a next page and a next reading at once", { "@odata.nextLink": NEXT, "@odata.deltaLink": DELTA }, "unreadable"],
    ["neither a next page nor a next reading", {}, "unreadable"],
    ["a next page that is no text", { "@odata.nextLink": 7 }, "unreadable"],
    ["a link longer than any address", { "@odata.deltaLink": `${VIEW}?$deltatoken=${"d".repeat(8200)}` }, "unreadable"],
    ["a next reading too long to be kept as a token", { "@odata.deltaLink": `${VIEW}?$deltatoken=${"d".repeat(4100)}` }, "unreadable"],
  ])("refuses an answer that names %s, and asks nothing more", async (_what, links, reason) => {
    const { reader, sent } = readerOver({ [FIRST]: { json: { value: [day("2027-02-28T09:00:00Z")], ...links } }, [SERIES]: { json: series() } });
    expect(await reader.readChanges(signedIn(), cal, null, firstPage, never)).toEqual(refusal(reason));
    expect(sent.map((s) => s.url)).toEqual([FIRST]);
  });

  it("does not follow a token or a page that was made under another Graph base", async () => {
    const elsewhere = "https://graph.other.example/v1.0";
    const theirs = `${elsewhere}/me/calendars/cal-1/calendarView/delta`;
    const there = readerOver({ [`${theirs}?startDateTime=2026-11-16T00:00:00Z&endDateTime=2027-01-01T00:00:00Z`]: [{ json: { value: [], "@odata.nextLink": `${theirs}?$skiptoken=s1` } }, { json: { value: [], "@odata.deltaLink": `${theirs}?$deltatoken=d1` } }] }, elsewhere);
    const paged = await there.reader.readChanges(signedIn(), cal, null, firstPage, never);
    const ended = await there.reader.readChanges(signedIn(), cal, null, firstPage, never);
    if (!paged.ok || paged.value.cursor.kind !== "more" || !ended.ok || ended.value.cursor.kind !== "end" || ended.value.cursor.token === null) throw new Error("the other base did not answer as set up");

    const here = readerOver({});
    expect(await here.reader.readChanges(signedIn(), cal, ended.value.cursor.token, firstPage, never)).toEqual(refusal("token_gone"));
    expect(await here.reader.readChanges(signedIn(), cal, null, { ...firstPage, cursor: paged.value.cursor.value }, never)).toEqual(refusal("page_link_refused"));
    expect(await here.reader.readChanges(signedIn(), cal, { provider: "microsoft", value: "no token of this reader's" }, firstPage, never)).toEqual(refusal("token_gone"));
    expect(await here.reader.readChanges(signedIn(), cal, null, { ...firstPage, cursor: "no cursor of this reader's" }, never)).toEqual(refusal("token_gone"));
    expect(here.sent).toEqual([]);
  });

  it("has no reading from the beginning without the days asked for, or with days that are none", async () => {
    const { reader, sent } = readerOver({});
    for (const window of [null, { start: WINDOW.end, end: WINDOW.start }, { start: instant(Number.NaN), end: WINDOW.end }, { start: instant(-1), end: WINDOW.end }]) {
      expect(await reader.readChanges(signedIn(), cal, null, { limit: 250, cursor: null, window }, never)).toEqual(refusal("unsupported"));
    }
    expect(await reader.readChanges(signedIn(), { id: "" }, null, firstPage, never)).toEqual(refusal("not_found"));
    expect(sent).toEqual([]);
  });
});

describe("Microsoft: the answers that are no page", () => {
  const stateGone = { error: { code: "BadRequest", message: "x", innerError: { code: "SyncStateNotFound" } } };

  it.each<[string, Reply, ReturnType<typeof refusal>]>([
    ["a refused token", { status: 401, json: { error: { code: "InvalidAuthenticationToken" } } }, refusal("sign_in_refused")],
    ["no right to read", { status: 403, json: { error: { code: "ErrorAccessDenied" } } }, refusal("forbidden")],
    ["a calendar that is not there", { status: 404, json: { error: { code: "ErrorItemNotFound" } } }, refusal("not_found")],
    ["a request Microsoft does not take", { status: 400, json: { error: { code: "ErrorInvalidParameter" } } }, refusal("unknown")],
    ["too many requests, with the wait in seconds", { status: 429, headers: { "retry-after": "7" }, json: { error: { code: "TooManyRequests" } } }, refusal("throttled", 7000)],
    ["too many requests, with no wait named", { status: 429, json: {} }, refusal("throttled")],
    ["busy, with a wait", { status: 503, headers: { "retry-after": "20" }, text: "" }, refusal("throttled", 20_000)],
    ["busy, with no wait named", { status: 503, text: "" }, refusal("unavailable")],
    ["a spent bandwidth allowance", { status: 509, text: "" }, refusal("throttled")],
    ["a fault of Microsoft's", { status: 500, text: "<html>error</html>" }, refusal("unavailable")],
    ["a page that is no JSON", { status: 200, text: "<html>Sign in</html>" }, refusal("unreadable")],
    ["a page whose records are no list", { status: 200, json: { value: { 0: {} }, "@odata.deltaLink": DELTA } }, refusal("unreadable")],
    ["more records than a page may hold", { status: 200, json: { value: Array.from({ length: 251 }, () => ({})), "@odata.deltaLink": DELTA } }, refusal("too_large")],
    ["a request that never left", { refused: "timeout" }, refusal("timeout")],
    ["a base the deployment does not dial", { refused: "address_not_allowed" }, refusal("address_not_allowed")],
  ])("answers %s with its word", async (_what, reply, expected) => {
    const { reader } = readerOver({ [FIRST]: reply });
    expect(await reader.readChanges(signedIn(), cal, null, firstPage, never)).toEqual(expected);
  });

  it("reads a sync state that is gone off the status or off Microsoft's code for it, at any depth and in any letter case, and never goes where the answer points", async () => {
    const start = async () => {
      const made = readerOver({ [FIRST]: { json: { value: [], "@odata.deltaLink": DELTA } } });
      const answer = await made.reader.readChanges(signedIn(), cal, null, firstPage, never);
      if (!answer.ok || answer.value.cursor.kind !== "end" || answer.value.cursor.token === null) throw new Error("no token");
      return answer.value.cursor.token;
    };
    const token = await start();
    for (const reply of [
      { status: 410, headers: { location: `${VIEW}?startDateTime=2026-11-16T00:00:00Z&endDateTime=2027-01-01T00:00:00Z` }, json: { error: { code: "SyncStateNotFound" } } },
      { status: 410, text: "" },
      { status: 400, json: stateGone },
      { status: 404, json: { error: { code: "syncStateNotFound" } } },
      { status: 400, json: { error: { code: "x", innererror: { code: "y", innererror: { code: "SYNCSTATENOTFOUND" } } } } },
    ]) {
      const { reader, sent } = readerOver({ [DELTA]: reply });
      expect(await reader.readChanges(signedIn(), cal, token, firstPage, never)).toEqual(refusal("token_gone"));
      expect(sent.map((s) => s.url)).toEqual([DELTA]);
    }
    // Without a token there is none to be gone: the same answers are what their status says.
    const first = readerOver({ [FIRST]: [{ status: 410, text: "" }, { status: 400, json: { error: { code: "x", innererror: { code: "SomethingElse" } } } }] });
    expect(await first.reader.readChanges(signedIn(), cal, null, firstPage, never)).toEqual(refusal("not_found"));
    expect(await first.reader.readChanges(signedIn(), cal, null, firstPage, never)).toEqual(refusal("unknown"));
  });

  it("asks nothing when the sign-in gives no token, with a sign-in of another kind, or with a token no header may hold", async () => {
    const { reader, sent } = readerOver({});
    for (const [reason, wait] of [["consent_needed", null], ["throttled", 60_000]] as const) {
      const c: Connection = { provider: "microsoft", credential: { kind: "bearer", accessToken: async () => ({ ok: false, reason, retryAfterMs: wait }) }, start: null };
      expect(await reader.readChanges(c, cal, null, firstPage, never)).toEqual(refusal(reason, wait));
      expect(await reader.listCalendars(c, never)).toEqual(refusal(reason, wait));
      expect(await reader.checkSignIn(c, never)).toEqual(refusal(reason, wait));
    }
    const password: Connection = { provider: "microsoft", credential: { kind: "basic", user: "mila", password: () => "x" }, start: null };
    expect(await reader.listCalendars(password, never)).toEqual(refusal("sign_in_refused"));
    expect(await reader.listCalendars(signedIn("t1\r\nx-injected: 1"), never)).toEqual(refusal("sign_in_refused"));
    expect(sent).toEqual([]);
  });

  it("keeps nothing between two connections: each request carries its own sign-in", async () => {
    const { reader, sent } = readerOver({ [CALENDARS]: [{ json: { value: [] } }, { json: { value: [] } }] });
    await reader.listCalendars(signedIn("t1"), never);
    await reader.listCalendars(signedIn("t2"), never);
    expect(sent.map((s) => s.token)).toEqual(["t1", "t2"]);
  });
});

describe("Microsoft: the list of calendars", () => {
  const more = `${CALENDARS}?$skip=10`;

  it("follows the list's pages inside the base, reads a colour only where one was set, and names nobody where no default calendar says who owns it", async () => {
    const { reader, sent } = readerOver({
      [CALENDARS]: [{ json: { value: [{ id: "a", name: "Calendar", color: "auto", hexColor: "", canEdit: true, isDefaultCalendar: false }], "@odata.nextLink": more } }, { json: { value: [{ id: "a", name: "Calendar", isDefaultCalendar: true }] } }],
      [more]: { json: { value: [{ id: "b", name: "Team", color: "lightGreen", hexColor: "#16a765", canEdit: false, owner: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" } }, { name: "a calendar with no id" }, "no calendar at all"] } },
    });
    expect(await reader.listCalendars(signedIn(), never)).toEqual({
      ok: true,
      value: [
        { id: "a", name: "Calendar", color: null, writable: true, byToken: true, zone: null },
        { id: "b", name: "Team", color: "#16a765", writable: false, byToken: true, zone: null },
      ],
    });
    expect(sent.map((s) => s.url)).toEqual([CALENDARS, more]);
    expect(await reader.checkSignIn(signedIn(), never)).toEqual({ ok: true, value: { principal: null, addresses: [] } });
  });

  it("names the account by its default calendar's owner, wherever that calendar stands in the list: a calendar someone shared names its sharer", async () => {
    const shared = { id: "b", name: "Team", owner: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" } };
    const own = { id: "a", name: "Calendar", isDefaultCalendar: true, owner: { name: "Mila Brunner", address: "mila@lichtgrat.example" } };
    const { reader } = readerOver({ [CALENDARS]: { json: { value: [shared, own] } } });
    expect(await reader.checkSignIn(signedIn(), never)).toEqual({ ok: true, value: { principal: "mila@lichtgrat.example", addresses: ["mila@lichtgrat.example"] } });
  });

  it("stops a list that never ends, one that leaves the base and one that names the page it just gave", async () => {
    const endless: Routes = { [CALENDARS]: { json: { value: [], "@odata.nextLink": `${CALENDARS}?$skip=1` } } };
    for (let n = 1; n <= 40; n++) endless[`${CALENDARS}?$skip=${n}`] = { json: { value: [], "@odata.nextLink": `${CALENDARS}?$skip=${n + 1}` } };
    const long = readerOver(endless);
    // Twenty pages are followed; the link to a twenty-first is not.
    expect(await long.reader.listCalendars(signedIn(), never)).toEqual(refusal("page_link_refused"));
    expect(long.sent.length).toBe(20);

    const away = readerOver({ [CALENDARS]: { json: { value: [], "@odata.nextLink": "https://graph.evil.example/v1.0/me/calendars?$skip=10" } } });
    expect(await away.reader.listCalendars(signedIn(), never)).toEqual(refusal("page_link_refused"));
    expect(away.sent.length).toBe(1);

    const circle = readerOver({ [CALENDARS]: { json: { value: [], "@odata.nextLink": more } }, [more]: { json: { value: [], "@odata.nextLink": more } } });
    expect(await circle.reader.listCalendars(signedIn(), never)).toEqual(refusal("page_link_refused"));
    expect(circle.sent.length).toBe(2);
  });
});
