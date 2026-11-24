/**
 * THE CALENDAR'S SYNC THROUGH THE REAL PROVIDERS, made as the worker makes them, against the
 * bench's stand-ins on this machine: the CalDAV server and the double of Microsoft's Graph (both
 * imported from `cal-providers`' own tests, never copied). What is held is what only the real
 * readers and the real request port show: the deployment's address policy refuses a private host
 * before a socket opens, a member removed at the server goes at the next reading, and Microsoft's
 * cancelled days are found by the comparison of a whole reading and by nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { intlZones } from "@ohmail/cal-core";
import { makeCalendarProviders, Secret, type CalendarProvider, type HttpPort, type ProviderWord } from "@ohmail/cal-providers";
import { GOOGLE_TOKEN_URL, makeReader as makeGoogleReader } from "@ohmail/cal-providers/google";
import { makeReader as makeMicrosoftReader } from "@ohmail/cal-providers/microsoft";
import type { HostResolver } from "@trafficflow/core/net";
import { calCalendars, calConnections, calEvents, calWrites } from "@trafficflow/db";
import { calendarSyncPass } from "@ohmail/organizer/calendar-sync-pass";
import { calendarWriteDrain } from "@ohmail/organizer/calendar/write-drain";
import { startCalDavStandIn, type StandIn } from "../../../packages/cal-providers/test/caldav-stand-in.js";
// @ts-expect-error a plain module
import { startMsDouble } from "../../../packages/cal-providers/test/support/ms-double.mjs";
import {
  AVAILABLE, calendarsOf, capturedLog, changesOf, connectionOf, depsFor, eventsOf, openWorld, providersOf, recordWrite, seedConnection, tokenEndpoint,
  type World,
} from "../../../packages/organizer/test/_calendar-world.js";

const never = new AbortController().signal;
/** The byte no text or JSON column of the store takes. */
const NUL = String.fromCharCode(0);
const HERE = dirname(fileURLToPath(import.meta.url));
/** One of Google's recorded answers, as `cal-providers`' own tests keep it: read where it lies, never copied. */
const recordedGoogle = (name: string): unknown =>
  (JSON.parse(readFileSync(join(HERE, "../../../packages/cal-providers/test/support/fixtures/google", `${name}.json`), "utf8")) as { response: { body: unknown } }).response.body;
/** A request port that answers from a table of addresses; an address it does not hold is a failed test, never a request. */
function serving(answer: (url: string) => unknown | undefined, trade: HttpPort, tradeAt: (url: string) => boolean): HttpPort {
  return {
    async request(url, req) {
      if (tradeAt(url)) return trade.request(url, req);
      const json = answer(url);
      if (json === undefined) throw new Error(`the test serves nothing at ${url}`);
      return { arrived: true, status: 200, header: () => null, body: new TextEncoder().encode(JSON.stringify(json)), location: null, url, hops: 0 };
    },
  };
}
/** No name is looked up: the stand-ins are reached by this machine's number. */
const NOBODY: HostResolver = { resolve: async () => [] };
const providersFor = (policy: "cloud" | "own-network", enabled: ProviderWord[], graphBase: string | null = null) =>
  makeCalendarProviders({
    clock: { now: () => Date.now() }, zones: intlZones(), resolver: NOBODY, policy: { kind: policy },
    enabled: new Set(enabled), microsoft: graphBase === null ? null : { graphBase }, writes: true,
  });
/** A member's text: from 09:00 UTC on a day of November 2026, an hour long, or as long as `length` says (a DURATION, no DTEND). */
const event = (uid: string, day: number, summary: string, length: string | null = null): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261113T120000Z",
    `DTSTART:202611${String(day).padStart(2, "0")}T090000Z`, length === null ? `DTEND:202611${String(day).padStart(2, "0")}T100000Z` : `DURATION:${length}`,
    `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
/** What the log said was left out: one count for each page that left something out. */
const refusedCounts = (lines: readonly string[]): unknown[] =>
  lines.map((l) => JSON.parse(l) as { event?: string; count?: number }).filter((l) => l.event === "calendar_objects_refused").map((l) => l.count);
/** Valid grammar that any server or published file can carry: a thousand million weeks on from 2026 is no moment a Date holds. */
const ENDLESS = "P999999999W";

describe.skipIf(!AVAILABLE)("the calendar's sync through the real providers", () => {
  let w: World;
  let dav: StandIn;
  beforeAll(async () => {
    w = await openWorld();
    dav = await startCalDavStandIn();
    dav.addCalendar("work", { name: "Work" });
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) dav.put("work", `${name}.ics`, event(`${name}@studio.example.test`, 17 + i, `Event ${name}`));
  }, 120_000);
  afterAll(async () => {
    await dav?.close();
    await w?.close();
  });

  const start = (): string => `http://127.0.0.1:${dav.port}${dav.paths.start}`;
  const signIn = () => ({ kind: "basic" as const, user: dav.options.user, password: new Secret(dav.options.password) });
  const makeDue = async (accountId: string) => {
    await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, accountId));
  };

  it("a person's own server reaches their CalDAV server on their own network; a member removed there goes at the next reading", async () => {
    const t = await seedConnection(w, { provider: "caldav", credential: signIn(), serverUrl: start() });
    const deps = depsFor(w, providersFor("own-network", ["caldav"]));
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.title)).toEqual(["Event a", "Event b", "Event c", "Event d", "Event e"]);
    dav.remove("work", "c.ics");
    await makeDue(t.accountId);
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", changed: 1 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.title)).toEqual(["Event a", "Event b", "Event d", "Event e"]);
    dav.put("work", "c.ics", event("c@studio.example.test", 19, "Event c"));
  }, 60_000);

  it("a series and one changed day of it, read from the server, are never written: acts recorded on them are refused and the server is sent nothing", async () => {
    const own: StandIn = await startCalDavStandIn();
    try {
      own.addCalendar("studio", { name: "Studio" });
      own.put("studio", "weekly.ics", [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN",
        "BEGIN:VEVENT", "UID:weekly@studio.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z",
        "RRULE:FREQ=WEEKLY", "SUMMARY:Weekly kiln", "END:VEVENT",
        "BEGIN:VEVENT", "UID:weekly@studio.example.test", "DTSTAMP:20261113T120000Z", "RECURRENCE-ID:20261125T090000Z",
        "DTSTART:20261125T140000Z", "DTEND:20261125T150000Z", "SUMMARY:Weekly kiln, moved", "END:VEVENT",
        "END:VCALENDAR", "",
      ].join("\r\n"), '"w1"');
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: own.options.user, password: new Secret(own.options.password) },
        serverUrl: `http://127.0.0.1:${own.port}${own.paths.start}`,
      });
      const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: intlZones(), log: capturedLog().log });
      const deps = depsFor(w, providersFor("own-network", ["caldav"]), { drainWrites: drain });
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
      const rows = await w.db.select({ id: calEvents.id, updatedAt: calEvents.updatedAt, recurrenceId: calEvents.recurrenceId })
        .from(calEvents).where(eq(calEvents.accountId, t.accountId));
      const series = rows.find((r) => r.recurrenceId === "")!;
      const day = rows.find((r) => r.recurrenceId !== "")!;
      // Recorded as a door that took them would have recorded them: a removal of the one changed day, a new time for the whole series.
      await recordWrite(w, { accountId: t.accountId, key: "drop-the-day", act: { kind: "calendar_event_delete", eventId: day.id, base: day.updatedAt.toISOString(), scope: { kind: "record" } } });
      await recordWrite(w, { accountId: t.accountId, key: "move-the-series", act: {
        kind: "calendar_event_update", eventId: series.id, base: series.updatedAt.toISOString(), scope: { kind: "record" },
        change: { start: { kind: "instant", value: "20261118T160000Z" }, end: { kind: "instant", value: "20261118T170000Z" } },
      } });
      await makeDue(t.accountId);
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced" });
      expect(own.seen.filter((s) => ["PUT", "DELETE", "PATCH", "POST"].includes(s.method)).map((s) => s.method)).toEqual([]);
      expect((await w.db.select({ key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal }).from(calWrites)
        .where(eq(calWrites.accountId, t.accountId)).orderBy(asc(calWrites.createdAt))).map((r) => [r.key, r.state, r.refusal]))
        .toEqual([["drop-the-day", "refused", "repeat_unsupported"], ["move-the-series", "refused", "repeat_unsupported"]]);
      expect((await eventsOf(w, t.accountId)).map((e) => [e.recurrenceId === "" ? "series" : "changed day", e.title]))
        .toEqual([["series", "Weekly kiln"], ["changed day", "Weekly kiln, moved"]]);
    } finally {
      await own.close();
    }
  }, 60_000);

  it("one member whose title holds U+0000 is left out; the members beside it and the next calendar are read", async () => {
    const own: StandIn = await startCalDavStandIn();
    try {
      own.addCalendar("first", { name: "First" });
      own.put("first", "ok1.ics", event("ok1@studio.example.test", 17, "Event ok1"));
      own.put("first", "nul.ics", event("nul@studio.example.test", 18, `Event${String.fromCharCode(0)}nul`));
      own.addCalendar("second", { name: "Second" });
      own.put("second", "ok2.ics", event("ok2@studio.example.test", 19, "Event ok2"));
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: own.options.user, password: new Secret(own.options.password) },
        serverUrl: `http://127.0.0.1:${own.port}${own.paths.start}`,
      });
      const deps = depsFor(w, providersFor("own-network", ["caldav"]));
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 2 });
      expect((await eventsOf(w, t.accountId)).map((e) => e.title).sort()).toEqual(["Event ok1", "Event ok2"]);
      expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
      expect((await calendarsOf(w, t.accountId)).map((c) => c.errorCode)).toEqual([null, null]);
    } finally {
      await own.close();
    }
  }, 60_000);

  /** One turn of a connection to a CalDAV server of the person's own holding these calendars' members, and what it left. */
  async function turnOnOwnServer(calendars: Readonly<Record<string, Readonly<Record<string, string>>>>) {
    const own: StandIn = await startCalDavStandIn();
    try {
      for (const [name, members] of Object.entries(calendars)) {
        own.addCalendar(name, { name });
        for (const [member, text] of Object.entries(members)) own.put(name, member, text);
      }
      const captured = capturedLog();
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: own.options.user, password: new Secret(own.options.password) },
        serverUrl: `http://127.0.0.1:${own.port}${own.paths.start}`,
      });
      const outcome = await calendarSyncPass(depsFor(w, providersFor("own-network", ["caldav"]), { log: captured.log }), t.due, never);
      return {
        outcome, titles: (await eventsOf(w, t.accountId)).map((e) => e.title).sort(),
        calendars: (await calendarsOf(w, t.accountId)).map((c) => ({ token: c.syncToken !== null, word: c.errorCode })),
        connection: await connectionOf(w, t.accountId, t.connectionId), refused: refusedCounts(captured.lines),
      };
    } finally {
      await own.close();
    }
  }

  it("a member whose length derives no moment is left out and counted: the members beside it, the next calendar and the tokens are kept", async () => {
    const turn = await turnOnOwnServer({
      first: { "ok1.ics": event("ok1@studio.example.test", 17, "Event ok1"), "long.ics": event("long@studio.example.test", 18, "Event long", ENDLESS) },
      second: { "ok2.ics": event("ok2@studio.example.test", 19, "Event ok2") },
    });
    expect(turn).toMatchObject({
      outcome: { kind: "synced", calendars: 2 }, titles: ["Event ok1", "Event ok2"], calendars: [{ token: true, word: null }, { token: true, word: null }],
      connection: { status: "active", errorCode: null }, refused: [1],
    });
  }, 60_000);

  it("a length of 9,999,999 days derives a moment the store does not keep: its own statement is refused, so that event alone is left out and counted", async () => {
    // The control of the case before: the year 29,405 is a moment a Date holds, so it is the store that refuses the row.
    const turn = await turnOnOwnServer({
      first: { "ok1.ics": event("ok1@studio.example.test", 17, "Event ok1"), "long.ics": event("long@studio.example.test", 18, "Event long", "P9999999D") },
    });
    expect(turn).toMatchObject({
      outcome: { kind: "synced", calendars: 1 }, titles: ["Event ok1"], calendars: [{ token: true, word: null }],
      connection: { status: "active", errorCode: null }, refused: [1],
    });
  }, 60_000);

  it("a subscription's event whose length derives no moment is left out and counted: the event beside it and the file's token are kept", async () => {
    const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN",
      "BEGIN:VEVENT", "UID:ok@feeds.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261217T090000Z", "DTEND:20261217T100000Z", "SUMMARY:Event ok", "END:VEVENT",
      "BEGIN:VEVENT", "UID:long@feeds.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261218T090000Z", `DURATION:${ENDLESS}`, "SUMMARY:Event long", "END:VEVENT",
      "END:VCALENDAR", ""].join("\r\n");
    const publisher = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
      res.end(file);
    });
    await new Promise<void>((r) => publisher.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (publisher.address() as AddressInfo).port;
      const captured = capturedLog();
      const t = await seedConnection(w, { provider: "ics", credential: { kind: "address", url: new Secret(`http://127.0.0.1:${port}/feed.ics`) } });
      expect(await calendarSyncPass(depsFor(w, providersFor("own-network", ["ics"]), { log: captured.log }), t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
      expect((await eventsOf(w, t.accountId)).map((e) => e.title)).toEqual(["Event ok"]);
      expect((await calendarsOf(w, t.accountId)).map((c) => ({ token: c.syncToken !== null, word: c.errorCode }))).toEqual([{ token: true, word: null }]);
      expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
      expect(refusedCounts(captured.lines)).toEqual([1]);
    } finally {
      await new Promise<void>((r) => publisher.close(() => r()));
    }
  }, 60_000);

  it("a calendar whose listed name or zone holds U+0000 is kept without the byte and read: a CalDAV server's, and a subscription's own", async () => {
    const own: StandIn = await startCalDavStandIn();
    try {
      own.addCalendar("first", { name: "First" });
      own.put("first", "ok1.ics", event("ok1@studio.example.test", 17, "Event ok1"));
      own.addCalendar("third", { name: `Thi${NUL}rd`, timezoneId: `Europe/${NUL}Zurich` });
      own.put("third", "ok3.ics", event("ok3@studio.example.test", 20, "Event ok3"));
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: own.options.user, password: new Secret(own.options.password) },
        serverUrl: `http://127.0.0.1:${own.port}${own.paths.start}`,
      });
      const deps = depsFor(w, providersFor("own-network", ["caldav"]));
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 2 });
      expect((await calendarsOf(w, t.accountId)).map((c) => `${c.name} ${c.timeZone}`).sort()).toEqual(["First null", "Third Europe/Zurich"]);
      expect((await eventsOf(w, t.accountId)).map((e) => e.title).sort()).toEqual(["Event ok1", "Event ok3"]);
      expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
      // Listed again, the name is the one the row keeps: nothing is written for it a second time.
      const before = await changesOf(w, t.accountId);
      deps.memory.listedAt.clear();
      await makeDue(t.accountId);
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", changed: 0 });
      expect(await changesOf(w, t.accountId)).toEqual(before);
    } finally {
      await own.close();
    }

    // A subscription names itself in its own file.
    const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN", `X-WR-CALNAME:Holi${NUL}days`, `X-WR-TIMEZONE:Europe/${NUL}Zurich`,
      "BEGIN:VEVENT", "UID:holiday@feeds.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261225T090000Z", "DTEND:20261225T100000Z", "SUMMARY:Holiday",
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const publisher = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
      res.end(file);
    });
    await new Promise<void>((r) => publisher.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (publisher.address() as AddressInfo).port;
      const t = await seedConnection(w, { provider: "ics", credential: { kind: "address", url: new Secret(`http://127.0.0.1:${port}/holidays.ics`) } });
      expect(await calendarSyncPass(depsFor(w, providersFor("own-network", ["ics"])), t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
      expect((await calendarsOf(w, t.accountId)).map((c) => `${c.name} ${c.timeZone}`)).toEqual(["Holidays Europe/Zurich"]);
      expect((await eventsOf(w, t.accountId)).map((e) => e.title)).toEqual(["Holiday"]);
    } finally {
      await new Promise<void>((r) => publisher.close(() => r()));
    }
  }, 60_000);

  it("a subscription is fetched as often as its file wishes: a daily file twice in twenty-five hours, never every hour", async () => {
    let gets = 0;
    // The file's own wish: asked once a day (the duration of one day, written in two halves).
    const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN", "X-WR-CALNAME:Holidays", ["REFRESH-INTERVAL;VALUE=DURATION:P", "1D"].join(""),
      "BEGIN:VEVENT", "UID:holiday@feeds.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261225T090000Z", "DTEND:20261225T100000Z", "SUMMARY:Holiday",
      "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const publisher = createServer((_req, res) => {
      gets += 1;
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
      res.end(file);
    });
    await new Promise<void>((r) => publisher.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (publisher.address() as AddressInfo).port;
      const t = await seedConnection(w, { provider: "ics", credential: { kind: "address", url: new Secret(`http://127.0.0.1:${port}/holidays.ics`) } });
      const began = Date.now();
      let now = began;
      const deps = depsFor(w, providersFor("own-network", ["ics"]), { clock: { now: () => now } });
      /** The roster's part: the connection is turned when its row says it is due. */
      const turnIfDue = async (): Promise<number> => {
        const row = await connectionOf(w, t.accountId, t.connectionId);
        if (row.nextPollAt !== null && row.nextPollAt.getTime() > now) return 0;
        expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced" });
        return 1;
      };
      let turns = 0;
      for (let hour = 0; hour <= 25; hour++) {
        now = began + hour * 3_600_000;
        turns += await turnIfDue();
      }
      // Once listed (the file's name), once read: what a publisher sees of one subscriber in a day and an hour.
      expect({ turns, gets }).toEqual({ turns: 1, gets: 2 });
      expect((await eventsOf(w, t.accountId)).map((e) => e.title)).toEqual(["Holiday"]);
      // After its day and its share of the spread, it is read again, and not listed again.
      now = began + 27 * 3_600_000;
      expect(await turnIfDue()).toBe(1);
      expect(gets).toBe(3);
    } finally {
      await new Promise<void>((r) => publisher.close(() => r()));
    }
  }, 60_000);

  it("a hosted worker refuses the same server before a socket opens: the connection reads failing with the address's word", async () => {
    const t = await seedConnection(w, { provider: "caldav", credential: signIn(), serverUrl: start() });
    const before = dav.seen.length;
    const deps = depsFor(w, providersFor("cloud", ["caldav"]));
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "backed_off", word: "address_not_allowed" });
    expect(dav.seen.length).toBe(before);
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "failing", errorCode: "address_not_allowed" });
    expect(await eventsOf(w, t.accountId)).toEqual([]);
  }, 60_000);

  it("Google, on its recorded list: a series removed at Google takes its changed day's row with it", async () => {
    const BASE = "https://www.googleapis.com/calendar/v3";
    const EVENTS = `${BASE}/calendars/cal-1/events?singleEvents=false&showDeleted=true&maxResults=250`;
    const table = new Map<string, unknown>([
      [`${BASE}/users/me/calendarList?maxResults=250`, recordedGoogle("calendar-list-writable")],
      [EVENTS, recordedGoogle("events-list-marked")],
    ]);
    const trade = tokenEndpoint(async () => ({ status: 200, body: { access_token: ["short", "google", "fixture"].join("-"), expires_in: 3600 } }));
    const http = serving((url) => table.get(url), trade, (url) => url === GOOGLE_TOKEN_URL);
    const reader = makeGoogleReader({ http, clock: { now: () => Date.UTC(2026, 10, 14, 12) }, zones: intlZones() });
    const t = await seedConnection(w, { provider: "google", credential: { kind: "oauth", provider: "google", refreshToken: new Secret(["lasting", "google", "fixture"].join("-")) } });
    const deps = depsFor(w, providersOf({ google: { reader, http } }), {
      oauth: { google: { clientId: "calendar-test.apps.example", clientSecret: ["registration", "fixture"].join("-") }, microsoft: null },
    });
    const ids = async () => (await eventsOf(w, t.accountId)).map((e) => e.providerId).sort();
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
    expect(await ids()).toEqual(["evt-1", "evt-2", "evt-3", "evt-3_20261201T170000Z", "evt-4", "evt-5"]);
    // The series is removed at Google. Its delta names the series and, as Google does, the changed day's own record, both cancelled.
    table.set(`${EVENTS}&syncToken=sync-2`, {
      items: [
        { id: "evt-3", status: "cancelled" },
        { id: "evt-3_20261201T170000Z", status: "cancelled", recurringEventId: "evt-3", originalStartTime: { dateTime: "2026-12-01T18:00:00+01:00", timeZone: "Europe/Zurich" } },
      ],
      nextSyncToken: "sync-3",
    });
    table.set(`${BASE}/calendars/cal-1/events/evt-3`, { id: "evt-3", status: "cancelled" });
    await makeDue(t.accountId);
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced" });
    expect(await ids()).toEqual(["evt-1", "evt-2", "evt-4", "evt-5"]);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(2);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("sync-3");
  }, 60_000);

  it("Google: a record's id, a cancelled record's id or a cancelled day's series UID that holds U+0000 costs that record alone; a listed calendar's name, colour and zone are kept without the byte", async () => {
    const BASE = "https://www.googleapis.com/calendar/v3";
    const events = (calendar: string): string => `${BASE}/calendars/${calendar}/events?singleEvents=false&showDeleted=true&maxResults=250`;
    const good = {
      id: "evt-ok", status: "confirmed", iCalUID: "ok@google.example", summary: "Fine", etag: "\"1\"", updated: "2026-11-13T12:00:00Z",
      start: { dateTime: "2026-11-17T18:00:00+01:00" }, end: { dateTime: "2026-11-17T19:00:00+01:00" },
    };
    const table = new Map<string, unknown>([
      [`${BASE}/users/me/calendarList?maxResults=250`, { items: [
        { id: "cal-1", summary: "Studio", accessRole: "owner", primary: true },
        { id: "cal-2", summary: `Shared${NUL} one`, backgroundColor: `#aa${NUL}bbcc`, timeZone: `Europe/${NUL}Zurich`, accessRole: "reader" },
      ] }],
      [events("cal-1"), { nextSyncToken: "sync-2", items: [
        good,
        { ...good, id: `evt${NUL}bad`, iCalUID: "bad@google.example" },
        { id: `gone${NUL}id`, status: "cancelled" },
        {
          id: "evt-s_20261124T170000Z", status: "cancelled", recurringEventId: "evt-s", iCalUID: `se${NUL}ries@google.example`,
          originalStartTime: { dateTime: "2026-11-24T18:00:00+01:00", timeZone: "Europe/Zurich" },
        },
      ] }],
      [events("cal-2"), { nextSyncToken: "sync-2", items: [{ ...good, id: "evt-shared", iCalUID: "shared@google.example" }] }],
    ]);
    const trade = tokenEndpoint(async () => ({ status: 200, body: { access_token: ["short", "google", "fixture"].join("-"), expires_in: 3600 } }));
    const http = serving((url) => table.get(url), trade, (url) => url === GOOGLE_TOKEN_URL);
    const reader = makeGoogleReader({ http, clock: { now: () => Date.UTC(2026, 10, 14, 12) }, zones: intlZones() });
    const t = await seedConnection(w, { provider: "google", credential: { kind: "oauth", provider: "google", refreshToken: new Secret(["lasting", "google", "fixture"].join("-")) } });
    const deps = depsFor(w, providersOf({ google: { reader, http } }), {
      oauth: { google: { clientId: "calendar-test.apps.example", clientSecret: ["registration", "fixture"].join("-") }, microsoft: null },
    });
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 2 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId).sort()).toEqual(["evt-ok", "evt-shared"]);
    expect((await calendarsOf(w, t.accountId)).map((c) => [c.providerId, c.name, c.color, c.timeZone, c.syncToken, c.errorCode])).toEqual([
      ["cal-1", "Studio", null, null, "sync-2", null],
      ["cal-2", "Shared one", "#aabbcc", "Europe/Zurich", "sync-2", null],
    ]);
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
  }, 60_000);

  describe("Microsoft, against the double of Graph", () => {
    let double: { base: string; origin: string; token: string; close: () => Promise<void> };
    /** The double's own calls, on this machine only, with the token it made at its start. */
    const ms = {
      graph: async (method: string, path: string) => fetch(`${double.base}${path}`, { method, headers: { Authorization: `Bearer ${double.token}` } }),
      control: async (name: string) => (await fetch(`${double.origin}/__double/${name}`, { method: "POST", headers: { Authorization: `Bearer ${double.token}` } })).status,
    };
    beforeAll(async () => {
      double = await startMsDouble({ port: 0 });
    }, 60_000);
    afterAll(async () => { await double?.close(); });

    /**
     * A Microsoft connection over the real reader and port. The sign-in's trade goes to a token
     * address answered here with the double's own token (the double has none); everything else to
     * the double. The clock stands on 10 December 2024, so that the window's far end, 731 days on,
     * falls between the wheel class's evenings: the two after it are outside the window.
     */
    async function msTurns() {
      expect(await ms.control("reset")).toBeLessThan(300);
      const seeded = await seedConnection(w, { provider: "microsoft", credential: { kind: "oauth", provider: "microsoft", refreshToken: new Secret(["lasting", "ms", "fixture"].join("-")) } });
      const made = providersFor("own-network", ["microsoft"], double.base).get("microsoft")!;
      const trade = tokenEndpoint(async () => ({ status: 200, body: { access_token: double.token, expires_in: 3600 } }));
      const http: HttpPort = { request: (url, req) => (new URL(url).hostname === "login.microsoftonline.com" ? trade.request(url, req) : made.http.request(url, req)) };
      const provider: CalendarProvider = { reader: made.reader, writer: null, notices: null, http };
      const deps = depsFor(w, providersOf({ microsoft: provider }), {
        clock: { now: () => Date.UTC(2024, 11, 10, 12) },
        oauth: { google: null, microsoft: async () => ({ clientId: "calendar-test-client", clientSecret: ["ms", "fixture"].join("-"), defaultTenant: "common", kind: "confidential" }) },
      });
      const turn = async () => {
        await makeDue(seeded.accountId);
        return calendarSyncPass(deps, seeded.due, never);
      };
      const wheel = async () => (await eventsOf(w, seeded.accountId)).find((e) => e.providerId === "evt-wheel-class");
      const studio = async () => (await calendarsOf(w, seeded.accountId)).find((c) => c.providerId === "cal-studio")!;
      return { seeded, turn, wheel, studio };
    }

    it("a day cancelled at Microsoft inside the window joins the series' excluded days; a delta compares nothing; the days past the window are not touched", async () => {
      const t = await msTurns();
      expect(await t.turn()).toMatchObject({ kind: "synced", calendars: 3 });
      expect(await t.wheel()).toMatchObject({ excluded: [] });
      // The evening of 24 November is cancelled at Microsoft.
      expect((await ms.graph("DELETE", "/me/events/evt-wheel-class.2026-11-24")).status).toBe(204);
      // The delta names a removed day by its own id, which nobody stores: it compares nothing, and reads the window whole again.
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      expect(await t.wheel()).toMatchObject({ excluded: [] });
      expect((await t.studio()).syncToken).toBeNull();
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      const after = await t.wheel();
      expect(after?.excluded).toEqual(["20261124T180000"]);
    }, 60_000);

    it("a changed day deleted at Microsoft goes with its day: the series does not show that day again at its first time", async () => {
      const t = await msTurns();
      expect(await t.turn()).toMatchObject({ kind: "synced", calendars: 3 });
      const moved = async () => (await eventsOf(w, t.seeded.accountId)).find((e) => e.providerId === "evt-wheel-class.2026-12-01");
      expect(await moved()).toBeDefined();
      expect(await t.wheel()).toMatchObject({ excluded: [] });
      // The evening of 1 December, which was moved to the 2nd, is deleted at Microsoft.
      expect((await ms.graph("DELETE", "/me/events/evt-wheel-class.2026-12-01")).status).toBe(204);
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      expect(await moved()).toBeUndefined();
      // Its day leaves the series with it, in the same transaction: 1 December 18:00 in Zurich.
      expect((await t.wheel())?.excluded).toEqual(["20261201T170000Z"]);
      // And the window is read whole again, which finds the same and adds nothing.
      expect((await t.studio()).syncToken).toBeNull();
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      expect((await t.wheel())?.excluded).toEqual(["20261201T170000Z"]);
      expect((await t.studio()).syncToken).not.toBeNull();
    }, 60_000);

    /** The double's own records of the studio's calendar: the wheel class's series, and what a view of two months shows. */
    async function studioRecords() {
      expect(await ms.control("reset")).toBeLessThan(300);
      const series = await (await ms.graph("GET", "/me/calendars/cal-studio/events/evt-wheel-class")).json() as Record<string, unknown>;
      const view = await (await ms.graph("GET", "/me/calendars/cal-studio/calendarView/delta?startDateTime=2026-11-01T00:00:00Z&endDateTime=2026-12-31T00:00:00Z")).json() as { value: Record<string, unknown>[] };
      return { series, view: view.value };
    }
    /** One turn of the real reader over a page served as written here, the wheel class's series answered with `series` when asked for. */
    async function turnOverServedPage(page: readonly Record<string, unknown>[], series: Record<string, unknown>) {
      const GRAPH = "https://graph.example.test/v1.0";
      const answer = (url: string): unknown => {
        if (url === `${GRAPH}/me/calendars`) return { value: [{ id: "cal-studio", name: "Studio", canEdit: true }] };
        if (url.startsWith(`${GRAPH}/me/calendars/cal-studio/calendarView/delta?`)) {
          return { value: page, "@odata.deltaLink": `${GRAPH}/me/calendars/cal-studio/calendarView/delta?$deltatoken=after` };
        }
        return url === `${GRAPH}/me/calendars/cal-studio/events/evt-wheel-class` ? series : undefined;
      };
      const trade = tokenEndpoint(async () => ({ status: 200, body: { access_token: ["short", "ms", "fixture"].join("-"), expires_in: 3600 } }));
      const http = serving(answer, trade, (url) => new URL(url).hostname === "login.microsoftonline.com");
      const now = Date.UTC(2024, 11, 10, 12);
      const reader = makeMicrosoftReader({ http, clock: { now: () => now }, zones: intlZones(), graphBase: GRAPH });
      const t = await seedConnection(w, { provider: "microsoft", credential: { kind: "oauth", provider: "microsoft", refreshToken: new Secret(["lasting", "ms", "fixture"].join("-")) } });
      const deps = depsFor(w, providersOf({ microsoft: { reader, http } }), {
        clock: { now: () => now },
        oauth: { google: null, microsoft: async () => ({ clientId: "calendar-test-client", clientSecret: ["ms", "fixture"].join("-"), defaultTenant: "common", kind: "confidential" }) },
      });
      expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
      return t;
    }

    it("a page that carries a series' own record beside its days stores the series", async () => {
      const { series, view } = await studioRecords();
      const evenings = view.filter((r) => r.seriesMasterId === "evt-wheel-class").slice(0, 3);
      expect({ type: series.type, evenings: evenings.length }).toEqual({ type: "seriesMaster", evenings: 3 });
      // Served as Graph may: the series' record on the page itself, before its days.
      const t = await turnOverServedPage([series, ...evenings], series);
      expect((await eventsOf(w, t.accountId)).filter((e) => e.recurrenceId === "").map((e) => e.providerId)).toEqual(["evt-wheel-class"]);
    }, 60_000);

    it("a series whose UID holds U+0000 is left out with its days: the reading ends with its token, and the events beside it are stored", async () => {
      const { series, view } = await studioRecords();
      const uid = `${String(series.iCalUId)}${NUL}`;
      const ofSeries = (r: Record<string, unknown>): boolean => r.seriesMasterId === "evt-wheel-class";
      const singles = view.filter((r) => r.type === "singleInstance");
      expect({ evenings: view.filter(ofSeries).length > 0, singles: singles.length > 0 }).toEqual({ evenings: true, singles: true });
      const t = await turnOverServedPage([...view.filter(ofSeries).map((r) => ({ ...r, iCalUId: uid })), ...singles], { ...series, iCalUId: uid });
      expect((await eventsOf(w, t.accountId)).map((e) => e.providerId).sort()).toEqual(singles.map((r) => String(r.id)).sort());
      const [studio] = await calendarsOf(w, t.accountId);
      expect(studio).toMatchObject({ errorCode: null });
      expect(studio?.syncToken ?? null).not.toBeNull();
      expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
    }, 60_000);

    it("a sync state Microsoft forgot is read again from no token in the same turn", async () => {
      const t = await msTurns();
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      const token = (await t.studio()).syncToken;
      expect(token).not.toBeNull();
      expect(await ms.control("expire-sync-state")).toBe(204);
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      const again = (await t.studio()).syncToken;
      expect(again).not.toBeNull();
      expect(again).not.toBe(token);
      expect((await eventsOf(w, t.seeded.accountId)).length).toBeGreaterThan(0);
    }, 60_000);
  });

});
