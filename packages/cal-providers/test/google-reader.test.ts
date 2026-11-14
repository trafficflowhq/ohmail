/**
 * Google's reading, on its recorded exchanges. No request leaves the process: the reader is handed
 * a request port that serves the recordings by address and throws on any other address.
 *
 * The expected values are written from the planted set as its builder described it (six records:
 * five events and the series' changed day; "Wheel class" weekly on Tuesday 18:00 Europe/Zurich, six
 * times from 17 November, the third moved to Wednesday 2 December 19:00) and from Google's own
 * reference for the addresses asked.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandSeries, instantOf, intlZones, parseRRule, plainDate, seriesOf, wall, zoned, type CalEvent, type EventTime } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { makeReader, provider } from "../src/google/index.js";
import { MAX_RETRY_AFTER_MS } from "../src/limits.js";
import type { ChangeItem, Connection, Credential } from "../src/port.js";
import type { ProviderRefusal } from "../src/refusals.js";
import type { HttpPort } from "../src/request/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const recorded = (name: string): any => JSON.parse(readFileSync(join(HERE, "support", "fixtures", "google", `${name}.json`), "utf8")).response.body;

const BASE = "https://www.googleapis.com/calendar/v3";
const EVENTS = `${BASE}/calendars/cal-1/events?singleEvents=false&showDeleted=true&maxResults=250`;
const CALENDARS = `${BASE}/users/me/calendarList?maxResults=250`;
const ZURICH = "Europe/Zurich";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | { refused: ProviderRefusal };
interface Sent {
  url: string;
  method: string;
  token: string | null;
  tokenGoesTo: Record<string, boolean>;
}

/** A request port that answers from a table and records what it was asked. An address the table does not hold is a failed test, never a request. */
function serving(routes: Record<string, Reply | Reply[]>) {
  const sent: Sent[] = [];
  const http: HttpPort = {
    async request(url, o) {
      const hosts = ["www.googleapis.com", "oauth2.googleapis.com", "accounts.google.com", "evil.example"];
      const token = o.auth !== null && o.auth.credential.kind === "bearer" ? o.auth.credential.token : null;
      sent.push({ url, method: o.method, token, tokenGoesTo: Object.fromEntries(hosts.map((h) => [h, o.auth?.admits(h) ?? false])) });
      const route = routes[url];
      if (route === undefined) throw new Error(`the test serves nothing at ${url}`);
      const reply = Array.isArray(route) ? route.shift() : route;
      if (reply === undefined) throw new Error(`the test has no further answer for ${url}`);
      if ("refused" in reply) return { arrived: false, reason: reply.refused };
      const body = new TextEncoder().encode(reply.text ?? JSON.stringify(reply.json ?? {}));
      return { arrived: true, status: reply.status ?? 200, header: (name) => reply.headers?.[name.toLowerCase()] ?? null, body, location: null, url, hops: 0 };
    },
  };
  return { http, sent };
}

const bearer = (token: string): Credential => ({ kind: "bearer", accessToken: async () => ({ ok: true, token }) });
const signedIn = (token = "t1"): Connection => ({ provider: "google", credential: bearer(token), start: null });
const zones = intlZones();
const readerOver = (routes: Record<string, Reply | Reply[]>) => {
  const { http, sent } = serving(routes);
  return { reader: makeReader({ http, clock: { now: () => NOW }, zones }), sent };
};
const never = new AbortController().signal;
const firstPage = { limit: 250, cursor: null, window: null };
const upserts = (items: readonly ChangeItem[]) => items.filter((i): i is Extract<ChangeItem, { kind: "upsert" }> => i.kind === "upsert");
const moment = (t: EventTime | null): number | null => (t === null || (t.kind !== "instant" && t.kind !== "zoned") ? null : (instantOf(t, zones)?.epochMs ?? null));

describe("Google: the calendars and the sign-in", () => {
  it("is the reader of the word google", () => {
    expect(provider).toBe("google");
    expect(readerOver({}).reader.provider).toBe("google");
  });

  it("lists the recorded calendar with its name, colour, zone and that it may be written", async () => {
    const { reader, sent } = readerOver({ [CALENDARS]: { json: recorded("calendar-list-writable") } });
    const answer = await reader.listCalendars(signedIn(), never);
    expect(answer).toEqual({ ok: true, value: [{ id: "cal-1", name: "google-account@bench.example", color: "#9fe1e7", writable: true, byToken: true, zone: ZURICH }] });
    expect(sent).toEqual([{ url: CALENDARS, method: "GET", token: "t1", tokenGoesTo: { "www.googleapis.com": true, "oauth2.googleapis.com": false, "accounts.google.com": false, "evil.example": false } }]);
  });

  it("follows the list's pages, leaves out a calendar that is deleted or shows only busy times, and reads a reader's as not writable", async () => {
    const { reader, sent } = readerOver({
      [CALENDARS]: { json: { items: [{ id: "a", summary: "Mine", accessRole: "owner" }, { id: "gone", summary: "Gone", accessRole: "owner", deleted: true }], nextPageToken: "n 2" } },
      [`${CALENDARS}&pageToken=n%202`]: { json: { items: [{ id: "b", summary: "Theirs", summaryOverride: "Team", accessRole: "reader", backgroundColor: "#16a765" }, { id: "c", summary: "Busy only", accessRole: "freeBusyReader" }] } },
    });
    const answer = await reader.listCalendars(signedIn(), never);
    expect(answer).toEqual({
      ok: true,
      value: [
        { id: "a", name: "Mine", color: null, writable: true, byToken: true, zone: null },
        { id: "b", name: "Team", color: "#16a765", writable: false, byToken: true, zone: null },
      ],
    });
    expect(sent.map((s) => s.url)).toEqual([CALENDARS, `${CALENDARS}&pageToken=n%202`]);
  });

  it("stops a list that never ends, and one that names the page it just gave", async () => {
    const endless: Record<string, Reply> = { [CALENDARS]: { json: { items: [], nextPageToken: "p1" } } };
    for (let n = 1; n <= 40; n++) endless[`${CALENDARS}&pageToken=p${n}`] = { json: { items: [], nextPageToken: `p${n + 1}` } };
    const long = readerOver(endless);
    // Twenty pages are followed; the link to a twenty-first is not.
    expect(await long.reader.listCalendars(signedIn(), never)).toEqual({ ok: false, reason: "page_link_refused", retryAfterMs: null });
    expect(long.sent.length).toBe(20);

    const circle = readerOver({ [CALENDARS]: { json: { items: [], nextPageToken: "same" } }, [`${CALENDARS}&pageToken=same`]: { json: { items: [], nextPageToken: "same" } } });
    expect(await circle.reader.listCalendars(signedIn(), never)).toEqual({ ok: false, reason: "page_link_refused", retryAfterMs: null });
    expect(circle.sent.length).toBe(2);
  });

  it("checks a sign-in on the calendar list and names the account by its primary calendar", async () => {
    const scrubbed = readerOver({ [CALENDARS]: { json: recorded("calendar-list-writable") } });
    expect(await scrubbed.reader.checkSignIn(signedIn(), never)).toEqual({ ok: true, value: { principal: "cal-1", addresses: [] } });

    const named = readerOver({ [CALENDARS]: { json: { items: [{ id: "holidays@group.calendar.example", accessRole: "reader" }, { id: "mila@lichtgrat.example", accessRole: "owner", primary: true }] } } });
    expect(await named.reader.checkSignIn(signedIn(), never)).toEqual({ ok: true, value: { principal: "mila@lichtgrat.example", addresses: ["mila@lichtgrat.example"] } });
    expect(named.sent.map((s) => s.url)).toEqual([CALENDARS]);

    const refused = readerOver({ [CALENDARS]: { status: 401, json: { error: { code: 401, message: "Invalid Credentials" } } } });
    expect(await refused.reader.checkSignIn(signedIn(), never)).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
  });
});

describe("Google: what a calendar holds", () => {
  it("reads the six recorded records as five events and the changed day of the series, and keeps the token", async () => {
    const { reader, sent } = readerOver({ [EVENTS]: { json: recorded("events-list-marked") } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const page = answer.value;
    expect(sent.map((s) => [s.method, s.url, s.token])).toEqual([["GET", EVENTS, "t1"]]);
    expect(page.items.map((i) => (i.kind === "upsert" ? [i.kind, i.id, i.version, i.text] : [i.kind]))).toEqual([
      ["upsert", "evt-1", "2026-11-13T12:00:00.000Z", null],
      ["upsert", "evt-2", "2026-11-13T12:00:00.000Z", null],
      ["upsert", "evt-3", "2026-11-13T12:00:00.000Z", null],
      ["upsert", "evt-3_20261201T170000Z", "2026-11-13T12:00:00.000Z", null],
      ["upsert", "evt-4", "2026-11-13T12:00:00.000Z", null],
      ["upsert", "evt-5", "2026-11-13T12:00:00.000Z", null],
    ]);
    // A reading from no token is the calendar whole: what it does not name is gone. That is what a caller needs after a token has ended.
    expect({ mode: page.mode, unchanged: page.unchanged, left: page.left, cursor: page.cursor, expanded: page.expanded, refreshMs: page.refreshMs }).toEqual({
      mode: "whole",
      unchanged: false,
      left: [],
      cursor: { kind: "end", token: { provider: "google", value: "sync-2" } },
      expanded: null,
      refreshMs: null,
    });

    const [glaze, , series, moved, market, call] = upserts(page.items).map((i) => i.event) as [CalEvent, CalEvent, CalEvent, CalEvent, CalEvent, CalEvent];
    expect({ uid: glaze.uid, summary: glaze.summary, description: glaze.description, start: glaze.start, end: glaze.end, status: glaze.status, sequence: glaze.sequence, organizer: glaze.organizer?.email }).toEqual({
      uid: "evt-1@bench.example",
      summary: "Glaze firing",
      description: "Cone 6. The blue set for the catalogue goes in first.",
      start: zoned(wall(2026, 11, 19, 9), ZURICH),
      end: zoned(wall(2026, 11, 19, 11), ZURICH),
      status: "CONFIRMED",
      sequence: 0,
      organizer: "google-account@bench.example",
    });
    expect(glaze.lastModified).toEqual({ kind: "instant", epochMs: Date.UTC(2026, 10, 13, 12) });
    expect([market.start, market.end]).toEqual([plainDate(2026, 11, 21), plainDate(2026, 11, 22)]);
    expect(call.url).toBe("https://meet.bench.example/room-1");
    expect(series.rules.map((r) => r.rule)).toEqual([parseRRule("FREQ=WEEKLY;COUNT=6;BYDAY=TU")]);
    expect({ uid: moved.uid, was: moved.recurrenceId, start: moved.start, sequence: moved.sequence, rules: moved.rules }).toEqual({
      uid: "evt-3@bench.example",
      was: zoned(wall(2026, 12, 1, 18), ZURICH),
      start: zoned(wall(2026, 12, 2, 19), ZURICH),
      sequence: 1,
      rules: [],
    });
  });

  it("hands the series so that its changed day replaces the day it was: six evenings, the third on Wednesday at seven", async () => {
    const { reader } = readerOver({ [EVENTS]: { json: recorded("events-list-marked") } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const all = seriesOf(upserts(answer.value.items).map((i) => i.event), zones);
    expect(all.map((s) => [s.uid, s.master !== null, s.overrides.size])).toEqual([
      ["evt-1@bench.example", true, 0],
      ["evt-2@bench.example", true, 0],
      ["evt-3@bench.example", true, 1],
      ["evt-4@bench.example", true, 0],
      ["evt-5@bench.example", true, 0],
    ]);
    const evenings = expandSeries(all[2]!, { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2027, 1, 1), viewerZone: ZURICH }, zones);
    // Zurich is an hour east of UTC from the last Sunday of October: 18:00 there is 17:00 UTC.
    expect(evenings.occurrences.map((o) => moment(o.start))).toEqual([
      Date.UTC(2026, 10, 17, 17),
      Date.UTC(2026, 10, 24, 17),
      Date.UTC(2026, 11, 2, 18),
      Date.UTC(2026, 11, 8, 17),
      Date.UTC(2026, 11, 15, 17),
      Date.UTC(2026, 11, 22, 17),
    ]);
    expect(evenings.capped).toBe(false);
  });

  it("puts a changed day with its series also where Google names the day it replaces by the moment alone", async () => {
    // The same recorded page, the replaced day written in UTC and with no zone beside it.
    const page = recorded("events-list-marked");
    const changed = page.items.find((e: any) => e.recurringEventId === "evt-3");
    changed.originalStartTime = { dateTime: "2026-12-01T17:00:00Z" };
    const { reader } = readerOver({ [EVENTS]: { json: page } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const [wheel] = seriesOf(upserts(answer.value.items).map((i) => i.event), zones).filter((s) => s.uid === "evt-3@bench.example");
    const evenings = expandSeries(wheel!, { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2027, 1, 1), viewerZone: ZURICH }, zones);
    expect(evenings.occurrences.map((o) => moment(o.start))).toEqual([
      Date.UTC(2026, 10, 17, 17),
      Date.UTC(2026, 10, 24, 17),
      Date.UTC(2026, 11, 2, 18),
      Date.UTC(2026, 11, 8, 17),
      Date.UTC(2026, 11, 15, 17),
      Date.UTC(2026, 11, 22, 17),
    ]);
  });

  it("asks with the same query every time, the token and the page added to it, each escaped", async () => {
    const next = `${EVENTS}&syncToken=sync-2`;
    const paged = `${EVENTS}&syncToken=a%20b%26c%3Dd&pageToken=p%2F2`;
    const { reader, sent } = readerOver({ [next]: { json: { items: [], nextPageToken: "p/2" } }, [paged]: { json: { items: [], nextSyncToken: "sync-3" } } });
    const first = await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: "sync-2" }, firstPage, never);
    expect(first).toMatchObject({ ok: true, value: { mode: "delta", items: [], cursor: { kind: "more", value: "p/2" } } });
    const second = await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: "a b&c=d" }, { limit: 10, cursor: "p/2", window: null }, never);
    expect(second).toMatchObject({ ok: true, value: { cursor: { kind: "end", token: { provider: "google", value: "sync-3" } } } });
    expect(sent.map((s) => s.url)).toEqual([next, paged]);
  });

  it("keeps a calendar's id inside its one segment of the path", async () => {
    const id = "team/../../users?x=1#y@group.calendar.example";
    const url = `${BASE}/calendars/team%2F..%2F..%2Fusers%3Fx%3D1%23y%40group.calendar.example/events?singleEvents=false&showDeleted=true&maxResults=250`;
    const { reader, sent } = readerOver({ [url]: { json: { items: [] } } });
    expect((await reader.readChanges(signedIn(), { id }, null, firstPage, never)).ok).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([url]);
  });

  it("works a clock time out in the event's own zone, whatever offset Google wrote the moment with", async () => {
    const abroad = { id: "ny-1", status: "confirmed", iCalUID: "ny-1@bench.example", updated: "2026-11-13T12:00:00.000Z", start: { dateTime: "2026-11-19T15:00:00+01:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-19T16:00:00+01:00", timeZone: "America/New_York" } };
    const nowhere = { ...abroad, id: "x-1", iCalUID: "x-1@bench.example", start: { dateTime: "2026-11-19T15:00:00+01:00", timeZone: "Mars/Olympus_Mons" }, end: { dateTime: "2026-11-19T14:30:00Z" } };
    const { reader } = readerOver({ [EVENTS]: { json: { items: [abroad, nowhere] } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const [a, b] = upserts(answer.value.items).map((i) => i.event) as [CalEvent, CalEvent];
    // 15:00 at +01:00 is 14:00 UTC, and New York is five hours west of UTC in November.
    expect([a.start, a.end]).toEqual([zoned(wall(2026, 11, 19, 9), "America/New_York"), zoned(wall(2026, 11, 19, 10), "America/New_York")]);
    // A zone nobody knows: the moment stands, and no clock time is made up for it.
    expect([b.start, b.end]).toEqual([{ kind: "instant", epochMs: Date.UTC(2026, 10, 19, 14) }, { kind: "instant", epochMs: Date.UTC(2026, 10, 19, 14, 30) }]);
  });

  it("reads who is invited and what each answered, and whether the event is private", async () => {
    const invitation = {
      id: "kiln-1",
      etag: '"3526"',
      status: "tentative",
      iCalUID: "kiln-1@bench.example",
      updated: "2026-11-13T12:00:00.000Z",
      summary: "Kiln handover",
      location: "Studio, back room; ring twice",
      transparency: "transparent",
      visibility: "private",
      start: { dateTime: "2026-11-25T15:00:00Z", timeZone: ZURICH },
      end: { dateTime: "2026-11-25T15:30:00Z", timeZone: ZURICH },
      organizer: { email: "mila@lichtgrat.example", displayName: "Mila Brunner" },
      attendees: [
        { email: "petra@makersfest.example", displayName: "Petra Wyss", responseStatus: "accepted" },
        { email: "giulia@terracotta-milano.example", responseStatus: "needsAction", optional: true },
        { email: "not an address", responseStatus: "accepted" },
      ],
    };
    const { reader } = readerOver({ [EVENTS]: { json: { items: [invitation] } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const [item] = upserts(answer.value.items);
    expect(item!.version).toBe('"3526"');
    const e = item!.event;
    expect({ status: e.status, shown: e.transparency, cls: e.classification, location: e.location, start: e.start, organizer: [e.organizer?.name, e.organizer?.email] }).toEqual({
      status: "TENTATIVE",
      shown: "TRANSPARENT",
      cls: "PRIVATE",
      location: "Studio, back room; ring twice",
      start: zoned(wall(2026, 11, 25, 16), ZURICH),
      organizer: ["Mila Brunner", "mila@lichtgrat.example"],
    });
    expect(e.attendees.map((a) => [a.email, a.name, a.partstat, a.role])).toEqual([
      ["petra@makersfest.example", "Petra Wyss", "ACCEPTED", "REQ-PARTICIPANT"],
      ["giulia@terracotta-milano.example", null, "NEEDS-ACTION", "OPT-PARTICIPANT"],
    ]);
  });
});

describe("Google: what is gone", () => {
  const cancelledDay = { id: "evt-3_20261124T170000Z", status: "cancelled", recurringEventId: "evt-3", originalStartTime: { dateTime: "2026-11-24T18:00:00+01:00", timeZone: ZURICH } };
  const master = recorded("events-list-marked").items[2];

  it("reports a deleted event as gone by its id", async () => {
    const { reader } = readerOver({ [`${EVENTS}&syncToken=s1`]: { json: { items: [{ id: "evt-2", status: "cancelled" }], nextSyncToken: "s2" } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: "s1" }, firstPage, never);
    expect(answer).toMatchObject({ ok: true, value: { items: [{ kind: "gone", id: "evt-2" }], left: [] } });
  });

  it("reports a cancelled day of a series under the series' own UID, read off the same page where the series stands on it", async () => {
    const { reader, sent } = readerOver({ [EVENTS]: { json: { items: [master, cancelledDay] } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect(answer.value.items[1]).toEqual({ kind: "cancelled_occurrence", uid: "evt-3@bench.example", originalStart: zoned(wall(2026, 11, 24, 18), ZURICH) });
    expect(sent.length).toBe(1);
  });

  it("asks for the series once when a cancelled day comes without it, however many of its days are cancelled", async () => {
    const other = { ...cancelledDay, id: "evt-3_20261208T170000Z", originalStartTime: { dateTime: "2026-12-08T18:00:00+01:00", timeZone: ZURICH } };
    const seriesUrl = `${BASE}/calendars/cal-1/events/evt-3`;
    const { reader, sent } = readerOver({ [`${EVENTS}&syncToken=s1`]: { json: { items: [cancelledDay, other], nextSyncToken: "s2" } }, [seriesUrl]: { json: master } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: "s1" }, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect(answer.value.items).toEqual([
      { kind: "cancelled_occurrence", uid: "evt-3@bench.example", originalStart: zoned(wall(2026, 11, 24, 18), ZURICH) },
      { kind: "cancelled_occurrence", uid: "evt-3@bench.example", originalStart: zoned(wall(2026, 12, 8, 18), ZURICH) },
    ]);
    expect(sent.map((s) => s.url)).toEqual([`${EVENTS}&syncToken=s1`, seriesUrl]);
  });

  it("says nothing of a cancelled day whose series is itself gone, and refuses the page when the series cannot be asked for now", async () => {
    const seriesUrl = `${BASE}/calendars/cal-1/events/evt-3`;
    const gone = readerOver({ [EVENTS]: { json: { items: [cancelledDay], nextSyncToken: "s2" } }, [seriesUrl]: { status: 404, json: { error: { code: 404 } } } });
    expect(await gone.reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never)).toMatchObject({ ok: true, value: { items: [], left: [], cursor: { kind: "end" } } });
    const busy = readerOver({ [EVENTS]: { json: { items: [cancelledDay], nextSyncToken: "s2" } }, [seriesUrl]: { status: 429, headers: { "retry-after": "3" }, json: {} } });
    expect(await busy.reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never)).toEqual({ ok: false, reason: "throttled", retryAfterMs: 3000 });
  });
});

describe("Google: what is left out, and said", () => {
  const good = { id: "ok-1", status: "confirmed", iCalUID: "ok-1@bench.example", updated: "2026-11-13T12:00:00.000Z", start: { date: "2026-11-21" }, end: { date: "2026-11-22" } };

  it("leaves out a record whose UID, zone or repeat is past what the calendar reader takes, by the reader's word, and reads the rest", async () => {
    const items = [
      { ...good, id: "long-uid", iCalUID: "u".repeat(1025) },
      { ...good, id: "long-zone", start: { dateTime: "2026-11-19T09:00:00Z", timeZone: "Z".repeat(256) } },
      { ...good, id: "no-rule", recurrence: ["this is no content line"] },
      { ...good, id: "two-lines", recurrence: ["RRULE:FREQ=DAILY\r\nATTENDEE:mailto:someone@bench.example"] },
      { ...good, id: "long-zone-in-a-rule", recurrence: [`EXDATE;TZID=${"Z".repeat(256)}:20261201T180000`] },
      { ...good, id: "no-start", start: undefined },
      { ...good, id: "changed-day-of-nothing", recurringEventId: "evt-3" },
      { ...good, id: "i".repeat(1025) },
      "no record at all",
      good,
    ];
    const { reader } = readerOver({ [EVENTS]: { json: { items } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect(answer.value.left).toEqual([
      { id: "long-uid", reason: "uid_too_long" },
      { id: "long-zone", reason: "zone_name_too_long" },
      { id: "no-rule", reason: "unreadable" },
      { id: "two-lines", reason: "unreadable" },
      { id: "long-zone-in-a-rule", reason: "zone_name_too_long" },
      { id: "no-start", reason: "unreadable" },
      { id: "changed-day-of-nothing", reason: "unreadable" },
      // Past the ceiling it is no id of Google's: named by as much as an id may have, never by all of it.
      { id: "i".repeat(1024), reason: "uid_too_long" },
      { id: "", reason: "unreadable" },
    ]);
    expect(upserts(answer.value.items).map((i) => i.id)).toEqual(["ok-1"]);
  });

  it("names a record it leaves out by its whole id, so that a reading of the whole calendar can tell which stored object it was", async () => {
    // An imported event's id is its UID in another alphabet: far longer than the ids Google makes itself, and within Google's ceiling of 1,024.
    const imported = `_${"imported".repeat(12)}`;
    const atTheCeiling = "c".repeat(1024);
    const items = [{ ...good, id: imported, iCalUID: "u".repeat(1025) }, { ...good, id: atTheCeiling, start: undefined }, good];
    const { reader } = readerOver({ [EVENTS]: { json: { items } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect(answer.value.mode).toBe("whole");
    expect(answer.value.left).toEqual([{ id: imported, reason: "uid_too_long" }, { id: atTheCeiling, reason: "unreadable" }]);
  });

  it("answers, and does not fail, for an id or a token that is half a character and so can stand in no address", async () => {
    // JSON may carry half of a two-part character; no address can.
    const HALF = "\ud800";
    const records = { items: [{ ...good, id: `bad-${HALF}` }, { id: "day-1", status: "cancelled", recurringEventId: `series-${HALF}`, originalStartTime: { date: "2026-11-21" } }, good] };
    const { reader, sent } = readerOver({ [EVENTS]: { json: records }, [CALENDARS]: { json: { items: [], nextPageToken: HALF } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect(answer.value.left.map((l) => l.reason)).toEqual(["unreadable", "unreadable"]);
    expect(upserts(answer.value.items).map((i) => i.id)).toEqual(["ok-1"]);
    expect(await reader.listCalendars(signedIn(), never)).toEqual({ ok: false, reason: "unreadable", retryAfterMs: null });
    expect(sent.length).toBe(2);
    expect(await reader.readChanges(signedIn(), { id: HALF }, null, firstPage, never)).toEqual({ ok: false, reason: "not_found", retryAfterMs: null });
    expect(await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: HALF }, firstPage, never)).toEqual({ ok: false, reason: "token_gone", retryAfterMs: null });
    expect(await reader.readChanges(signedIn(), { id: "cal-1" }, null, { ...firstPage, cursor: HALF }, never)).toEqual({ ok: false, reason: "token_gone", retryAfterMs: null });
    expect(sent.length).toBe(2);
  });

  it("takes only a repeat's own lines from Google's list of them: another line adds nobody and changes nothing", async () => {
    const planted = { ...good, id: "r-1", summary: "Market day", recurrence: ["ATTENDEE:mailto:someone@bench.example", "SUMMARY:another name", "RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20271121"] };
    const { reader } = readerOver({ [EVENTS]: { json: { items: [planted] } } });
    const answer = await reader.readChanges(signedIn(), { id: "cal-1" }, null, firstPage, never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const e = upserts(answer.value.items)[0]!.event;
    expect({ summary: e.summary, attendees: e.attendees.length, rules: e.rules.map((r) => r.text), excluded: e.excluded }).toEqual({ summary: "Market day", attendees: 0, rules: ["FREQ=YEARLY"], excluded: [plainDate(2027, 11, 21)] });
  });
});

describe("Google: the answers that are no page", () => {
  const once = (reply: Reply, since: string | null = null) => {
    const { reader, sent } = readerOver({ [since === null ? EVENTS : `${EVENTS}&syncToken=${since}`]: reply });
    return { sent, answer: reader.readChanges(signedIn(), { id: "cal-1" }, since === null ? null : { provider: "google", value: since }, firstPage, never) };
  };
  const refusal = (reason: ProviderRefusal, retryAfterMs: number | null = null) => ({ ok: false, reason, retryAfterMs });

  it("reads a 410 as a token that is gone", async () => {
    const full = { error: { code: 410, message: "Sync token is no longer valid, a full sync is required.", errors: [{ domain: "calendar", reason: "fullSyncRequired" }] } };
    expect(await once({ status: 410, json: full }, "sync-2").answer).toEqual(refusal("token_gone"));
    // A token Google cannot read at all is as gone as one it no longer keeps. Without a token there is none to be gone.
    expect(await once({ status: 400, json: { error: { code: 400 } } }, "sync-2").answer).toEqual(refusal("token_gone"));
    expect(await once({ status: 400, json: { error: { code: 400 } } }).answer).toEqual(refusal("unknown"));
    expect(await once({ status: 410, json: full }).answer).toEqual(refusal("not_found"));
  });

  it("reads a page Google no longer keeps as a reading to begin again, never as a calendar that is not there", async () => {
    const paged = (status: number) => {
      const { reader } = readerOver({ [`${EVENTS}&pageToken=p2`]: { status, json: { error: { code: status } } } });
      return reader.readChanges(signedIn(), { id: "cal-1" }, null, { limit: 250, cursor: "p2", window: null }, never);
    };
    expect(await paged(410)).toEqual(refusal("token_gone"));
    expect(await paged(400)).toEqual(refusal("token_gone"));
    // The calendar itself gone in the middle of a reading is still that.
    expect(await paged(404)).toEqual(refusal("not_found"));
  });

  it.each<[string, Reply, ReturnType<typeof refusal>]>([
    ["a refused token", { status: 401, json: { error: { code: 401 } } }, refusal("sign_in_refused")],
    ["no right to read", { status: 403, json: { error: { code: 403, errors: [{ domain: "calendar", reason: "forbidden" }] } } }, refusal("forbidden")],
    ["a spent quota", { status: 403, json: { error: { code: 403, errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } } }, refusal("throttled")],
    ["a user's spent quota", { status: 403, json: { error: { code: 403, errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }] } } }, refusal("throttled")],
    ["a calendar that is not there", { status: 404, json: { error: { code: 404 } } }, refusal("not_found")],
    ["too many requests, with the wait in seconds", { status: 429, headers: { "retry-after": "7" }, json: {} }, refusal("throttled", 7000)],
    ["too many requests, with the wait as a date", { status: 429, headers: { "retry-after": "Sat, 14 Nov 2026 12:00:30 GMT" }, json: {} }, refusal("throttled", 30_000)],
    ["a wait longer than a day", { status: 429, headers: { "retry-after": "999999999" }, json: {} }, refusal("throttled", MAX_RETRY_AFTER_MS)],
    ["a wait that is no number", { status: 429, headers: { "retry-after": "soon" }, json: {} }, refusal("throttled")],
    ["a fault of Google's", { status: 500, text: "<html>Backend Error</html>" }, refusal("unavailable")],
    ["busy, with a wait", { status: 503, headers: { "retry-after": "20" }, text: "" }, refusal("unavailable", 20_000)],
    ["a page that is no JSON", { status: 200, text: "<html>Sign in</html>" }, refusal("unreadable")],
    ["a page whose records are no list", { status: 200, json: { items: { 0: {} } } }, refusal("unreadable")],
    ["more records than were asked for", { status: 200, json: { items: Array.from({ length: 251 }, () => ({})) } }, refusal("too_large")],
    ["a next page with no name", { status: 200, json: { items: [], nextPageToken: "" } }, refusal("unreadable")],
    ["a token that is no text", { status: 200, json: { items: [], nextSyncToken: 7 } }, refusal("unreadable")],
    ["a request that never left", { refused: "timeout" }, refusal("timeout")],
    ["an answer past the ceiling", { refused: "too_large" }, refusal("too_large")],
  ])("answers %s with its word", async (_what, reply, expected) => {
    expect(await once(reply).answer).toEqual(expected);
  });

  it("refuses a page that names the page it was asked for as the next one", async () => {
    const url = `${EVENTS}&pageToken=p1`;
    const { reader } = readerOver({ [url]: { json: { items: [], nextPageToken: "p1" } } });
    expect(await reader.readChanges(signedIn(), { id: "cal-1" }, null, { limit: 250, cursor: "p1", window: null }, never)).toEqual(refusal("page_link_refused"));
  });

  it("asks nothing when the sign-in gives no token, and passes its word and its wait on", async () => {
    for (const [reason, wait] of [["consent_needed", null], ["throttled", 60_000], ["unavailable", null]] as const) {
      const { reader, sent } = readerOver({});
      const c: Connection = { provider: "google", credential: { kind: "bearer", accessToken: async () => ({ ok: false, reason, retryAfterMs: wait }) }, start: null };
      expect(await reader.readChanges(c, { id: "cal-1" }, null, firstPage, never)).toEqual(refusal(reason, wait));
      expect(await reader.listCalendars(c, never)).toEqual(refusal(reason, wait));
      expect(sent).toEqual([]);
    }
  });

  it("asks nothing with a sign-in of another kind, with a token no header may hold, or with a token of another provider's reading", async () => {
    const { reader, sent } = readerOver({});
    const password: Connection = { provider: "google", credential: { kind: "basic", user: "mila", password: () => "x" }, start: null };
    expect(await reader.listCalendars(password, never)).toEqual(refusal("sign_in_refused"));
    expect(await reader.listCalendars(signedIn("t1\r\nx-injected: 1"), never)).toEqual(refusal("sign_in_refused"));
    expect(await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "caldav", value: "sync-2" }, firstPage, never)).toEqual(refusal("token_gone"));
    expect(await reader.readChanges(signedIn(), { id: "cal-1" }, { provider: "google", value: "s".repeat(4097) }, firstPage, never)).toEqual(refusal("token_gone"));
    expect(await reader.readChanges(signedIn(), { id: "" }, null, firstPage, never)).toEqual(refusal("not_found"));
    expect(sent).toEqual([]);
  });

  it("keeps nothing between two connections: each request carries its own sign-in", async () => {
    const { reader, sent } = readerOver({ [CALENDARS]: [{ json: { items: [] } }, { json: { items: [] } }] });
    await reader.listCalendars(signedIn("t1"), never);
    await reader.listCalendars(signedIn("t2"), never);
    expect(sent.map((s) => s.token)).toEqual(["t1", "t2"]);
  });
});
