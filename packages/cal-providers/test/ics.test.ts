/**
 * A subscription by address: one calendar file at an address a person typed, asked through the
 * request port and read by the calendar core.
 *
 * The feeds here are invented, in the shape the two public holiday feeds had when they were read
 * (whole days, the older `X-WR-` header lines, no zone definition; 84 events over three years in
 * one, 120,663 characters in the other). No publisher's own text is kept in this repository.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { DEFAULT_LIMITS, intlZones, readCalendar, zonesOf } from "@ohmail/cal-core";
import type { HostResolver, PinnedRequestOptions, PinnedResponse } from "@trafficflow/core/net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeReader, provider } from "../src/ics/index.js";
import { makeIcsReader } from "../src/ics/reader.js";
import { MAX_URL_CHARS, TOKEN_MAX_CHARS } from "../src/limits.js";
import type { Answer, CalendarReader, ChangeItem, ChangePage, ChangeToken, Connection } from "../src/port.js";
import type { ProviderRefusal } from "../src/refusals.js";
import { guardedRequest, type AddressPolicy } from "../src/request/guarded.js";
import { namedHostRequest, type HttpAnswer, type HttpPort, type HttpRequest, type HttpResponse } from "../src/request/index.js";

const zones = intlZones();
const clock = { now: () => Date.parse("2026-11-14T08:00:00Z") };
const never = new AbortController().signal;

// Invented, and put together here so that no line of this file is shaped like a real private address.
const KEY = ["kiln", "glaze", "wheel"].join("-");
const FEED = `https://feeds.example.test/private-${KEY}/basic.ics`;
const SHOWS_THE_ADDRESS = /example|kiln|glaze|basic|feeds|private/;
const subscription = (url: string): Connection => ({ provider: "ics", credential: { kind: "address", url: () => url }, start: null });
const CALENDAR = { id: "subscription" };
const PAGE = { limit: 250, cursor: null, window: null };

/* ── invented feeds ─────────────────────────────────────────────────────────────────────────────── */

const text = (...lines: string[]): string => lines.map((line) => `${line}\r\n`).join("");
const event = (uid: string | null, ...lines: string[]): string[] => ["BEGIN:VEVENT", ...(uid === null ? [] : [`UID:${uid}`]), "DTSTAMP:20261113T080000Z", ...lines, "END:VEVENT"];
const calendar = (head: readonly string[], ...parts: string[][]): string => text("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example Almanac//Holidays//EN", ...head, ...parts.flat(), "END:VCALENDAR");
const two = (n: number): string => String(n).padStart(2, "0");

const HOLIDAY_HEAD = ["CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Holidays in Seldwyla", "X-WR-TIMEZONE:UTC", "X-WR-CALDESC:Public holidays of an invented canton"];
const holiday = (year: number, i: number): string[] =>
  event(`${year}${two(1 + (i % 12))}${two(1 + (i % 28))}-${i}@holidays.example.test`, `DTSTART;VALUE=DATE:${year}${two(1 + (i % 12))}${two(1 + (i % 28))}`, `SUMMARY:Lantern day ${i + 1}`, "TRANSP:TRANSPARENT");
/** A holiday feed: `perYear` whole-day events in each of `years`. */
const holidays = (years: readonly number[], perYear: number, head: readonly string[] = HOLIDAY_HEAD): string =>
  calendar(head, ...years.flatMap((year) => Array.from({ length: perYear }, (_, i) => holiday(year, i))));
const THREE_YEARS = holidays([2025, 2026, 2027], 28);

const ZURICH = ["BEGIN:VTIMEZONE", "TZID:Europe/Zurich", "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"];
// A zone no platform knows, an hour and a half east of UTC all year.
const OWN_ZONE = "Seldwyla Standard Time";
const SELDWYLA = ["BEGIN:VTIMEZONE", `TZID:${OWN_ZONE}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0130", "TZOFFSETTO:+0130", "END:STANDARD", "END:VTIMEZONE"];
const WHEEL_UID = "wheel-class@bench.example.test";
const WORKSHOP = calendar(
  [],
  ZURICH,
  SELDWYLA,
  event(WHEEL_UID, "DTSTART;TZID=Europe/Zurich:20261117T180000", "DTEND;TZID=Europe/Zurich:20261117T200000", "RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=TU", "SUMMARY:Wheel class"),
  event("glaze-firing@bench.example.test", `DTSTART;TZID=${OWN_ZONE}:20261119T090000`, "SUMMARY:Glaze firing"),
  event(WHEEL_UID, "RECURRENCE-ID;TZID=Europe/Zurich:20261201T180000", "DTSTART;TZID=Europe/Zurich:20261202T190000", "SUMMARY:Wheel class, moved"),
);

/* ── a request port that dials nothing ──────────────────────────────────────────────────────────── */

type Script = (url: string, req: HttpRequest, nth: number) => HttpAnswer;
const answered = (url: string, status: number, body = "", headers: Record<string, string> = {}, hops = 0): HttpResponse =>
  ({ arrived: true, status, header: (name) => headers[name.toLowerCase()] ?? null, body: new TextEncoder().encode(body), location: null, url, hops });
const serving = (body: string, headers: Record<string, string> = {}): Script => (url) => answered(url, 200, body, headers);
const refusing = (reason: ProviderRefusal): Script => () => ({ arrived: false, reason });

function scripted(script: Script): { reader: CalendarReader; asked: { url: string; req: HttpRequest }[] } {
  const asked: { url: string; req: HttpRequest }[] = [];
  const http: HttpPort = {
    request: async (url, req) => {
      asked.push({ url, req });
      return script(url, req, asked.length);
    },
  };
  return { reader: makeReader({ http, clock, zones }), asked };
}

function pageOf(answer: Answer<ChangePage>): ChangePage {
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
  return answer.value;
}
function tokenOf(page: ChangePage): ChangeToken {
  if (page.cursor.kind !== "end" || page.cursor.token === null) throw new Error("the page ends with no token");
  return page.cursor.token;
}
type Upsert = Extract<ChangeItem, { kind: "upsert" }>;
const upserts = (page: ChangePage): Upsert[] => page.items.filter((item): item is Upsert => item.kind === "upsert");
const read = (reader: CalendarReader, url: string, since: ChangeToken | null = null): Promise<Answer<ChangePage>> => reader.readChanges(subscription(url), CALENDAR, since, PAGE, never);

/* ── the real gate, with a lookup and a request that are stand-ins ──────────────────────────────── */

// A public address outside every range the gate refuses. It is only ever handed to a stand-in.
const PUBLIC = "203.0.114.1";
function gated(policy: AddressPolicy, table: Record<string, string[]>, answer: (url: string) => { status: number; headers?: Record<string, string>; body?: string } = () => ({ status: 200, body: THREE_YEARS })) {
  const looked: string[] = [];
  const dialled: string[] = [];
  const resolver: HostResolver = {
    resolve: async (name) => {
      looked.push(name);
      return table[name] ?? [];
    },
  };
  const request = async (url: string, _opts: PinnedRequestOptions): Promise<PinnedResponse> => {
    dialled.push(url);
    const a = answer(url);
    return { status: a.status, headers: a.headers ?? {}, stream: Readable.from([Buffer.from(a.body ?? "")]) as unknown as IncomingMessage };
  };
  const http = guardedRequest({ resolver, request, policy, hosts: null, limits: { connectMs: 2_000, totalMs: 4_000, maxRedirects: 5, maxBodyBytes: 1024 * 1024 } });
  return { reader: makeReader({ http, clock, zones }), looked, dialled };
}

describe("a subscription's file", () => {
  it("is read whole in one page: every event an item, whole days as dates, and a token at its end", async () => {
    const { reader, asked } = scripted(serving(THREE_YEARS));
    const page = pageOf(await read(reader, FEED));
    expect([page.mode, page.unchanged, page.items.length, page.left, page.expanded, page.refreshMs]).toEqual(["whole", false, 84, [], null, null]);
    const items = upserts(page);
    expect(items.filter((item) => item.event.start?.kind !== "date" || item.text === null || item.version === "")).toEqual([]);
    expect([items[0]!.id, items[0]!.event.summary, items[0]!.event.start]).toEqual(["20250101-0@holidays.example.test", "Lantern day 1", { kind: "date", year: 2025, month: 1, day: 1 }]);
    expect(new Set(items.map((item) => item.id)).size).toBe(84);
    expect(tokenOf(page).provider).toBe("ics");
    expect(asked.map((a) => [a.url, a.req.method, a.req.auth, a.req.validators, a.req.body])).toEqual([[FEED, "GET", null, null, null]]);
    expect(provider).toBe("ics");
  });

  it("reads a feed as long as the longest that was measured", async () => {
    const tenYears = Array.from({ length: 10 }, (_, i) => 2021 + i);
    const padded = (filler: number): string => calendar(HOLIDAY_HEAD, ...tenYears.flatMap((year) => Array.from({ length: 40 }, (_, i) => holiday(year, i))), event("notes@holidays.example.test", "DTSTART;VALUE=DATE:20301231", `DESCRIPTION:${"n".repeat(filler)}`));
    const feed = padded(120_663 - padded(0).length);
    expect(feed.length).toBe(120_663);
    const page = pageOf(await read(scripted(serving(feed)).reader, FEED));
    expect([page.items.length, page.left]).toEqual([401, []]);
  });

  it("names its one calendar by what the file says of itself: read only, and with no token of the provider's", async () => {
    const older = scripted(serving(THREE_YEARS));
    expect(await older.reader.listCalendars(subscription(FEED), never)).toEqual({ ok: true, value: [{ id: "subscription", name: "Holidays in Seldwyla", color: null, writable: false, byToken: false, zone: "UTC" }] });
    expect(older.asked.map((a) => [a.url, a.req.validators])).toEqual([[FEED, null]]);
    // The registered properties come before the older ones.
    const newer = scripted(serving(holidays([2026], 2, [...HOLIDAY_HEAD, "NAME:Seldwyla, days off", "COLOR:teal"])));
    const listed = await newer.reader.listCalendars(subscription(FEED), never);
    expect(listed.ok && [listed.value[0]!.name, listed.value[0]!.color]).toEqual(["Seldwyla, days off", "teal"]);
    // A name nobody could show is not kept.
    const long = scripted(serving(holidays([2026], 2, [`X-WR-CALNAME:${"n".repeat(5_000)}`, `COLOR:${"c".repeat(200)}`])));
    const unnamed = await long.reader.listCalendars(subscription(FEED), never);
    expect(unnamed.ok && [unnamed.value[0]!.name, unnamed.value[0]!.color]).toEqual([null, null]);
  });

  it("has no sign-in to check", async () => {
    const { reader, asked } = scripted(serving(THREE_YEARS));
    expect(await reader.checkSignIn(subscription(FEED), never)).toEqual({ ok: false, reason: "unsupported", retryAfterMs: null });
    expect(asked.length).toBe(0);
  });

  it("hands on a series and its changed day as one stored object, with the definition of a zone only the file knows", async () => {
    const items = upserts(pageOf(await read(scripted(serving(WORKSHOP)).reader, FEED)));
    expect(items.map((item) => [item.id, item.event.summary])).toEqual([[WHEEL_UID, "Wheel class"], [WHEEL_UID, "Wheel class, moved"], ["glaze-firing@bench.example.test", "Glaze firing"]]);
    const [series, moved, firing] = items as [Upsert, Upsert, Upsert];
    expect([moved.version, moved.text]).toEqual([series.version, series.text]);
    expect(firing.version).not.toBe(series.version);
    expect(series.event.rules.map((r) => r.text)).toEqual(["FREQ=WEEKLY;COUNT=6;BYDAY=TU"]);
    expect(moved.event.recurrenceId).toEqual({ kind: "zoned", tzid: "Europe/Zurich", wall: { year: 2026, month: 12, day: 1, hour: 18, minute: 0, second: 0 } });

    // The object reads back as the two events it holds. The platform knows Zurich's rules, so the file's copy of them stays behind.
    const wheel = readCalendar(series.text!, DEFAULT_LIMITS);
    expect(wheel.ok && [wheel.calendar.events.map((e) => [e.uid, e.summary, e.start]), wheel.calendar.timezones.length, wheel.dropped]).toEqual([
      [[WHEEL_UID, "Wheel class", series.event.start], [WHEEL_UID, "Wheel class, moved", moved.event.start]], 0, [],
    ]);
    // Nobody but the file knows the other zone: its definition travels with the event that names it.
    const glaze = readCalendar(firing.text!, DEFAULT_LIMITS);
    const at = Date.parse("2026-11-19T00:00:00Z");
    expect(zones.offsetAt(OWN_ZONE, at)).toBeNull();
    expect(glaze.ok && [glaze.calendar.events.length, glaze.calendar.timezones.map((z) => z.tzid), zonesOf(glaze.calendar, zones).offsetAt(OWN_ZONE, at)]).toEqual([1, [OWN_ZONE], 5_400_000]);
  });

  it("gives an event the same version while its text is the same, and another once it changed", async () => {
    const first = upserts(pageOf(await read(scripted(serving(WORKSHOP)).reader, FEED)));
    const again = upserts(pageOf(await read(scripted(serving(WORKSHOP)).reader, FEED)));
    const edited = upserts(pageOf(await read(scripted(serving(WORKSHOP.replace("SUMMARY:Glaze firing", "SUMMARY:Glaze firing, second load"))).reader, FEED)));
    expect(again.map((item) => item.version)).toEqual(first.map((item) => item.version));
    expect(edited.map((item, i) => item.version === first[i]!.version)).toEqual([true, true, false]);
  });

  it("keeps an event that names no UID under an id of its own, and says what the reader left out", async () => {
    const feed = calendar([], event(null, "DTSTART;VALUE=DATE:20261121", "SUMMARY:Market day"), event("u".repeat(1_025), "DTSTART;VALUE=DATE:20261122", "SUMMARY:Never shown"), event("stall@bench.example.test", "DTSTART;VALUE=DATE:20261123", "SUMMARY:Stall planning"));
    const page = pageOf(await read(scripted(serving(feed)).reader, FEED));
    const items = upserts(page);
    expect(items.map((item) => item.event.summary)).toEqual(["Market day", "Stall planning"]);
    expect([items[0]!.event.uid, items[0]!.id.length > 8, items[0]!.id === items[1]!.id]).toEqual([null, true, false]);
    expect(page.left.map((l) => l.reason)).toEqual(["uid_too_long"]);
    expect(page.left[0]!.id).not.toMatch(/uuuu/);
    // The same file again gives the same id: nothing else tells the two readings' events are one.
    const again = upserts(pageOf(await read(scripted(serving(feed)).reader, FEED)));
    expect(again[0]!.id).toBe(items[0]!.id);
  });

  it("reads every calendar a text holds as one set", async () => {
    const feed = holidays([2026], 3) + calendar([], event("stall@bench.example.test", "DTSTART;VALUE=DATE:20261123", "SUMMARY:Stall planning"));
    expect(upserts(pageOf(await read(scripted(serving(feed)).reader, FEED))).map((item) => item.event.summary)).toEqual(["Lantern day 1", "Lantern day 2", "Lantern day 3", "Stall planning"]);
  });

  it("takes the file's own wish for how often to ask, never below an hour and never above a week", async () => {
    const HOUR = 3_600_000;
    const wishes: [string | null, number | null][] = [
      [null, null],
      ["REFRESH-INTERVAL;VALUE=DURATION:PT12H", 12 * HOUR],
      ["REFRESH-INTERVAL;VALUE=DURATION:+P1W", 168 * HOUR],
      ["REFRESH-INTERVAL;VALUE=DURATION:+P30D", 168 * HOUR],
      ["REFRESH-INTERVAL;VALUE=DURATION:PT5M", HOUR],
      ["X-PUBLISHED-TTL:PT6H", 6 * HOUR],
      ["REFRESH-INTERVAL;VALUE=DURATION:-PT12H", null],
      ["REFRESH-INTERVAL;VALUE=DURATION:PT0S", null],
      ["REFRESH-INTERVAL;VALUE=DURATION:soon", null],
    ];
    for (const [line, ms] of wishes) {
      const page = pageOf(await read(scripted(serving(holidays([2026], 2, line === null ? [] : [line]))).reader, FEED));
      expect([line, page.refreshMs]).toEqual([line, ms]);
    }
  });
});

describe("the address as it was typed", () => {
  it("is asked over https when it was written as webcal or webcals", async () => {
    for (const typed of ["webcal://feeds.example.test/a.ics", "webcals://feeds.example.test/a.ics", "WEBCAL://feeds.example.test/a.ics", "  webcal://feeds.example.test/a.ics "]) {
      const { reader, asked } = scripted(serving(THREE_YEARS));
      expect(pageOf(await read(reader, typed)).items.length).toBe(84);
      expect(asked.map((a) => a.url)).toEqual(["https://feeds.example.test/a.ics"]);
    }
  });

  it("is asked as typed when it says http, and once more over https where this deployment fetches no http", async () => {
    const hosted = scripted((url) => (url.startsWith("http://") ? { arrived: false, reason: "address_not_allowed" } : answered(url, 200, THREE_YEARS)));
    expect(pageOf(await read(hosted.reader, "http://feeds.example.test:8080/a.ics")).items.length).toBe(84);
    expect(hosted.asked.map((a) => a.url)).toEqual(["http://feeds.example.test:8080/a.ics", "https://feeds.example.test:8080/a.ics"]);
    // A person's own server on the person's own network: the request port lets it through, and nothing else is tried.
    const home = scripted(serving(THREE_YEARS));
    expect(pageOf(await read(home.reader, "http://nas.local:5232/mila/a.ics")).items.length).toBe(84);
    expect(home.asked.map((a) => a.url)).toEqual(["http://nas.local:5232/mila/a.ics"]);
  });

  it("is never tried over http after https, and not a second time for any other failure", async () => {
    for (const [typed, reason] of [["https://feeds.example.test/a.ics", "connection_failed"], ["https://feeds.example.test/a.ics", "address_not_allowed"], ["http://feeds.example.test/a.ics", "timeout"], ["webcal://feeds.example.test/a.ics", "address_not_allowed"]] as const) {
      const { reader, asked } = scripted(refusing(reason));
      expect(await read(reader, typed)).toEqual({ ok: false, reason, retryAfterMs: null });
      expect(asked.map((a) => a.url.slice(0, 5))).toEqual([typed.startsWith("http://") ? "http:" : "https"]);
    }
  });

  it("is dialled over https alone on a hosted server, whatever scheme was typed", async () => {
    for (const typed of ["http://feeds.example.test/a.ics", "webcal://feeds.example.test/a.ics", "https://feeds.example.test/a.ics"]) {
      const { reader, looked, dialled } = gated({ kind: "cloud" }, { "feeds.example.test": [PUBLIC] });
      expect(pageOf(await read(reader, typed)).items.length).toBe(84);
      expect([looked, dialled]).toEqual([["feeds.example.test"], ["https://feeds.example.test/a.ics"]]);
    }
  });

  it("is refused before any request when it is no address: another scheme, none, nothing, too long, or a sign-in of another kind", async () => {
    for (const typed of ["ftp://feeds.example.test/a.ics", "file:///etc/hostname", "data:text/calendar,BEGIN:VCALENDAR", "feeds.example.test/a.ics", "//feeds.example.test/a.ics", "", "   ", `https://feeds.example.test/${"a".repeat(MAX_URL_CHARS)}`]) {
      const { reader, asked } = scripted(serving(THREE_YEARS));
      expect([typed.slice(0, 40), await read(reader, typed)]).toEqual([typed.slice(0, 40), { ok: false, reason: "address_invalid", retryAfterMs: null }]);
      expect(await reader.listCalendars(subscription(typed), never)).toEqual({ ok: false, reason: "address_invalid", retryAfterMs: null });
      expect(asked.length).toBe(0);
    }
    const { reader, asked } = scripted(serving(THREE_YEARS));
    const password: Connection = { provider: "ics", credential: { kind: "basic", user: "mila", password: () => KEY }, start: null };
    expect(await reader.readChanges(password, CALENDAR, null, PAGE, never)).toEqual({ ok: false, reason: "address_invalid", retryAfterMs: null });
    expect(asked.length).toBe(0);
  });
});

describe("an address the server may not fetch", () => {
  // Written from the rules of what a hosted server may fetch for a subscription, never from the gate's code.
  const WITH_USERINFO = ["https://", "u", ":", "p", "@", "feeds.example.test/a.ics"].join("");
  // This machine's address as one decimal number, 2,130,706,433. Made from its hex form: written out between two
  // slashes it would be a path segment of ten digits, the shape of an account's own address at a provider.
  const AS_ONE_NUMBER = String(0x7f000001);
  const FORBIDDEN: [string, ProviderRefusal][] = [
    ["http://127.0.0.1:8821/a.ics", "address_not_allowed"],
    ["https://localhost/a.ics", "address_not_allowed"],
    ["https://localhost./a.ics", "address_not_allowed"],
    ["https://[::1]/a.ics", "address_not_allowed"],
    ["https://[::ffff:127.0.0.1]/a.ics", "address_not_allowed"],
    ["https://[fe80::1%25eth0]/a.ics", "address_invalid"],
    ["https://[64:ff9b::7f00:1]/a.ics", "address_not_allowed"],
    ["https://[2002:7f00:1::]/a.ics", "address_not_allowed"],
    ["https://169.254.169.254/latest/meta-data/", "address_not_allowed"],
    ["webcal://169.254.169.254/a.ics", "address_not_allowed"],
    ["https://100.100.100.200/a.ics", "address_not_allowed"],
    ["https://0x7f000001/a.ics", "address_not_allowed"],
    [`https://${AS_ONE_NUMBER}/a.ics`, "address_not_allowed"],
    ["https://127.1/a.ics", "address_not_allowed"],
    ["https://0177.0.0.1/a.ics", "address_not_allowed"],
    ["https://10.0.0.1/a.ics", "address_not_allowed"],
    ["https://192.168.1.20:5001/a.ics", "address_not_allowed"],
    ["https://[fd00::1]/a.ics", "address_not_allowed"],
    ["https://metadata.google.internal/a.ics", "address_not_allowed"],
    ["https://nas.local/a.ics", "address_not_allowed"],
    ["https://x.railway.internal/a.ics", "address_not_allowed"],
    ["https://inside.example.test/a.ics", "address_not_allowed"],
    ["https://both.example.test/a.ics", "address_not_allowed"],
    ["https://nowhere.example.test/a.ics", "host_unresolved"],
    [WITH_USERINFO, "address_invalid"],
    ["https://feeds.example.test:25/a.ics", "port_not_allowed"],
    ["https://feeds.example.test:993/a.ics", "port_not_allowed"],
    ["webcal://feeds.example.test:143/a.ics", "port_not_allowed"],
  ];
  const NAMES = { "feeds.example.test": [PUBLIC], "inside.example.test": ["10.0.0.1"], "both.example.test": [PUBLIC, "10.0.0.1"], localhost: ["127.0.0.1"], "nas.local": ["192.168.1.20"] };

  it("is refused by its word before anything is dialled, for a read and for a first look alike", async () => {
    for (const [typed, reason] of FORBIDDEN) {
      const { reader, dialled } = gated({ kind: "cloud" }, NAMES);
      expect([typed, await read(reader, typed)]).toEqual([typed, { ok: false, reason, retryAfterMs: null }]);
      expect([typed, await reader.listCalendars(subscription(typed), never)]).toEqual([typed, { ok: false, reason, retryAfterMs: null }]);
      expect(dialled).toEqual([]);
    }
  });

  it("is refused as a redirect's target too, after the one request that named it and no other", async () => {
    const targets: [string | null, ProviderRefusal][] = [
      ["https://inside.example.test/a.ics", "address_not_allowed"],
      ["https://169.254.169.254/latest/meta-data/", "address_not_allowed"],
      ["https://localhost/a.ics", "address_not_allowed"],
      ["http://feeds.example.test/a.ics", "redirect_invalid"],
      [null, "redirect_invalid"],
    ];
    for (const [to, reason] of targets) {
      const headers: Record<string, string> = to === null ? {} : { location: to };
      const { reader, dialled } = gated({ kind: "cloud" }, NAMES, () => ({ status: 302, headers }));
      expect([to, await read(reader, FEED)]).toEqual([to, { ok: false, reason, retryAfterMs: null }]);
      expect(dialled).toEqual([FEED]);
    }
    const loop = gated({ kind: "cloud" }, NAMES, (url) => ({ status: 301, headers: { location: `${url}x` } }));
    expect(await read(loop.reader, FEED)).toEqual({ ok: false, reason: "too_many_redirects", retryAfterMs: null });
    expect(loop.dialled.length).toBe(6);
  });

  it("is the person's to reach from the person's own computer: the same addresses, the other verdict", async () => {
    for (const typed of ["http://127.0.0.1:8821/a.ics", "https://localhost/a.ics", "https://10.0.0.1/a.ics", "https://192.168.1.20:5001/a.ics", "https://nas.local/a.ics", "http://nas.local:5232/a.ics"]) {
      const hosted = gated({ kind: "cloud" }, NAMES);
      const own = gated({ kind: "own-network" }, NAMES);
      expect([typed, (await read(hosted.reader, typed)).ok, (await read(own.reader, typed)).ok]).toEqual([typed, false, true]);
      expect([hosted.dialled.length, own.dialled]).toEqual([0, [typed]]);
    }
  });
});

describe("what a feed's server may answer", () => {
  const ANSWERS: [number, Record<string, string>, ProviderRefusal, number | null][] = [
    [401, {}, "forbidden", null],
    [403, {}, "forbidden", null],
    [404, {}, "not_found", null],
    [410, {}, "ended", null],
    [429, { "retry-after": "120" }, "throttled", 120_000],
    [429, {}, "throttled", null],
    [503, { "retry-after": "Sat, 14 Nov 2026 08:05:00 GMT" }, "throttled", 300_000],
    [503, { "retry-after": "999999999" }, "throttled", 86_400_000],
    [500, {}, "unavailable", null],
    [502, {}, "unavailable", null],
    [204, {}, "not_a_calendar", null],
    [300, {}, "redirect_invalid", null],
    [418, {}, "unknown", null],
  ];

  it("is a word of the closed list for every status, with the wait the server asked for", async () => {
    for (const [status, headers, reason, retryAfterMs] of ANSWERS) {
      const { reader } = scripted((url) => answered(url, status, "<html>no</html>", headers));
      expect([status, await read(reader, FEED)]).toEqual([status, { ok: false, reason, retryAfterMs }]);
      expect([status, await reader.listCalendars(subscription(FEED), never)]).toEqual([status, { ok: false, reason, retryAfterMs }]);
    }
  });

  it("is no calendar when it holds none, whatever it calls itself; and a calendar under any content type", async () => {
    for (const body of ["<!doctype html><title>Sign in</title><p>BEGIN your session</p>", "", "calendar not found", "﻿"]) {
      const { reader } = scripted(serving(body, { "content-type": "text/calendar; charset=utf-8" }));
      expect(await read(reader, FEED)).toEqual({ ok: false, reason: "not_a_calendar", retryAfterMs: null });
    }
    for (const type of ["text/calendar", "text/plain", "application/octet-stream", "text/html"]) {
      expect(pageOf(await read(scripted(serving(THREE_YEARS, { "content-type": type })).reader, FEED)).items.length).toBe(84);
    }
    expect(pageOf(await read(scripted(serving(`﻿${THREE_YEARS}`)).reader, FEED)).items.length).toBe(84);
  });

  it("is the request port's own word when no answer arrived", async () => {
    for (const reason of ["timeout", "connection_failed", "too_large", "host_unresolved", "too_many_redirects", "redirect_invalid", "unreadable", "port_not_allowed", "address_invalid"] as const) {
      expect(await read(scripted(refusing(reason)).reader, FEED)).toEqual({ ok: false, reason, retryAfterMs: null });
    }
  });

  it("never says the address: not in a refusal, not in a token, not in a calendar's id", async () => {
    const shown: unknown[] = [];
    for (const [status, headers] of ANSWERS) shown.push(await read(scripted((url) => answered(url, status, "", headers)).reader, FEED));
    shown.push(await read(scripted(refusing("address_not_allowed")).reader, FEED), await read(scripted(serving("no calendar")).reader, FEED));
    const { reader } = scripted(serving(THREE_YEARS, { etag: '"v7"' }));
    shown.push(tokenOf(pageOf(await read(reader, FEED))), await reader.listCalendars(subscription(FEED), never));
    expect(shown.map((s) => JSON.stringify(s)).filter((s) => SHOWS_THE_ADDRESS.test(s.replace(/holidays\.example\.test|Example Almanac/g, "")))).toEqual([]);
  });
});

describe("what the reader refuses of a text", () => {
  const lowered = (over: Partial<typeof DEFAULT_LIMITS>, maxZoneTextChars = 1_000_000) => (body: string): Promise<Answer<ChangePage>> => {
    const http: HttpPort = { request: async (url) => answered(url, 200, body) };
    return read(makeIcsReader({ http, clock, zones }, { read: { ...DEFAULT_LIMITS, ...over }, maxZoneTextChars }), FEED);
  };

  it("is refused whole, with the calendar reader's own word beside the port's", async () => {
    expect(await read(scripted(serving(text("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:open@bench.example.test", "END:VCALENDAR"))).reader, FEED)).toEqual({ ok: false, reason: "unreadable", retryAfterMs: null, read: "unbalanced" });
    expect(await lowered({ maxComponents: 50 })(THREE_YEARS)).toEqual({ ok: false, reason: "too_large", retryAfterMs: null, read: "too_many_components" });
    expect(await lowered({ maxTextChars: 1_000 })(THREE_YEARS)).toEqual({ ok: false, reason: "too_large", retryAfterMs: null, read: "too_large" });
    expect(await lowered({ maxLines: 100 })(THREE_YEARS)).toEqual({ ok: false, reason: "too_large", retryAfterMs: null, read: "too_many_lines" });
    expect(pageOf(await lowered({})(THREE_YEARS)).items.length).toBe(84);
  });

  it("is refused when its events would carry more zone definitions than the whole text may be long", async () => {
    const inOwnZone = (n: number): string => calendar([], SELDWYLA, ...Array.from({ length: n }, (_, i) => event(`firing-${i}@bench.example.test`, `DTSTART;TZID=${OWN_ZONE}:202611${two(1 + i)}T090000`, "SUMMARY:Glaze firing")));
    expect(pageOf(await lowered({}, 500)(inOwnZone(3))).items.length).toBe(3);
    expect(await lowered({}, 500)(inOwnZone(10))).toEqual({ ok: false, reason: "too_large", retryAfterMs: null });
    // A zone the platform knows costs nothing, however many events name it.
    const inZurich = calendar([], ZURICH, ...Array.from({ length: 20 }, (_, i) => event(`class-${i}@bench.example.test`, `DTSTART;TZID=Europe/Zurich:202611${two(1 + i)}T180000`, "SUMMARY:Wheel class")));
    expect(pageOf(await lowered({}, 500)(inZurich)).items.length).toBe(20);
  });
});

describe("a text that did not change", () => {
  const VALIDATORS = { etag: '"v7"', "last-modified": "Fri, 13 Nov 2026 08:00:00 GMT" };
  const HALF_A_DAY = holidays([2026], 4, ["REFRESH-INTERVAL;VALUE=DURATION:PT12H"]);

  it("is not sent again where the server keeps validators: they go back to the address they came from, and a 304 is nothing to apply", async () => {
    const { reader, asked } = scripted((url, req) => (req.validators === null ? answered(url, 200, HALF_A_DAY, VALIDATORS) : answered(url, 304, "", { etag: '"v7"' })));
    const first = pageOf(await read(reader, FEED));
    const second = pageOf(await read(reader, FEED, tokenOf(first)));
    expect(asked.map((a) => a.req.validators)).toEqual([null, { etag: '"v7"', lastModified: "Fri, 13 Nov 2026 08:00:00 GMT" }]);
    expect([first.unchanged, first.items.length, first.refreshMs]).toEqual([false, 4, 43_200_000]);
    expect([second.mode, second.unchanged, second.items, second.left, second.refreshMs]).toEqual(["whole", true, [], [], 43_200_000]);
    // The token after a 304 still carries what the next ask needs.
    const third = pageOf(await read(reader, FEED, tokenOf(second)));
    expect([third.unchanged, asked[2]!.req.validators]).toEqual([true, { etag: '"v7"', lastModified: "Fri, 13 Nov 2026 08:00:00 GMT" }]);
  });

  it("is not read twice where the server keeps none: an equal text is known by its hash", async () => {
    const { reader, asked } = scripted(serving(HALF_A_DAY));
    const first = pageOf(await read(reader, FEED));
    const second = pageOf(await read(reader, FEED, tokenOf(first)));
    expect([second.unchanged, second.items, second.refreshMs, asked[1]!.req.validators]).toEqual([true, [], 43_200_000, null]);
    const changed = scripted(serving(HALF_A_DAY.replace("Lantern day 1", "Lantern eve")));
    const third = pageOf(await read(changed.reader, FEED, tokenOf(first)));
    expect([third.unchanged, third.items.length, tokenOf(third).value === tokenOf(first).value]).toEqual([false, 4, false]);
  });

  it("is not claimed by a 304 nobody asked for", async () => {
    expect(await read(scripted((url) => answered(url, 304)).reader, FEED)).toEqual({ ok: false, reason: "unreadable", retryAfterMs: null });
  });

  it("keeps no validator of an address a redirect led to, and sends none to an address they did not come from", async () => {
    const moved = scripted((url) => answered("https://elsewhere.example.test/moved.ics", 200, HALF_A_DAY, VALIDATORS, 1));
    const first = pageOf(await read(moved.reader, FEED));
    const second = pageOf(await read(moved.reader, FEED, tokenOf(first)));
    expect([moved.asked[1]!.req.validators, second.unchanged]).toEqual([null, true]);

    const direct = scripted(serving(HALF_A_DAY, VALIDATORS));
    const token = tokenOf(pageOf(await read(direct.reader, FEED)));
    await read(direct.reader, "https://feeds.example.test/another.ics", token);
    await read(direct.reader, FEED, token);
    expect(direct.asked.map((a) => a.req.validators !== null)).toEqual([false, false, true]);
  });

  it("reads everything again from a token that is none of its own, and never calls a token gone", async () => {
    for (const since of [{ provider: "google", value: "sync-2" }, { provider: "ics", value: "not a token" }, { provider: "ics", value: "{}" }, { provider: "ics", value: `{"v":1,"h":7}` }, { provider: "ics", value: "x".repeat(TOKEN_MAX_CHARS + 1) }] as ChangeToken[]) {
      const { reader, asked } = scripted(serving(HALF_A_DAY, VALIDATORS));
      const page = pageOf(await read(reader, FEED, since));
      expect([since.value.slice(0, 20), page.unchanged, page.items.length, asked[0]!.req.validators]).toEqual([since.value.slice(0, 20), false, 4, null]);
    }
  });

  it("keeps its token inside the ceiling: a validator too long to keep is not kept, the hash is", async () => {
    // One validator longer than any is kept; then two that each fit and, written into the token, do not fit together.
    const kept: Record<string, string>[] = [{ etag: `"${"e".repeat(3_000)}"` }, { etag: '"'.repeat(1_000), "last-modified": "\\".repeat(1_024) }];
    for (const headers of kept) {
      const { reader, asked } = scripted(serving(HALF_A_DAY, headers));
      const first = pageOf(await read(reader, FEED));
      expect(tokenOf(first).value.length).toBeLessThanOrEqual(TOKEN_MAX_CHARS);
      const second = pageOf(await read(reader, FEED, tokenOf(first)));
      expect([asked[1]!.req.validators, second.unchanged]).toEqual([null, true]);
    }
  });
});

/* ── from here on: the real pinned request, against a server of this file's own on 127.0.0.1 ────── */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let port = 0;
let handler: Handler = (_req, res) => res.end();
const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];
let connections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  server.on("connection", () => connections++);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("on a real connection", () => {
  const looked: string[] = [];
  const resolver: HostResolver = {
    resolve: async (name) => {
      looked.push(name);
      return name === "localhost" ? ["127.0.0.1"] : [];
    },
  };
  const through = (policy: AddressPolicy): CalendarReader => makeReader({ http: namedHostRequest({ resolver, policy }), clock, zones });
  const serve = (h: Handler): void => {
    handler = h;
    seen.length = 0;
    looked.length = 0;
    connections = 0;
  };
  const feed: Handler = (req, res) => {
    if (req.url === "/old.ics") res.writeHead(301, { location: "/holidays.ics" }).end();
    else if (req.headers["if-none-match"] === '"v1"') res.writeHead(304, { etag: '"v1"' }).end();
    else res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"' }).end(THREE_YEARS);
  };

  it("reads a feed on the person's own network by its name, pinned to what the name resolved to, and asks with the tag the second time", async () => {
    serve(feed);
    const reader = through({ kind: "own-network" });
    const typed = `http://localhost:${port}/holidays.ics`;
    const first = pageOf(await read(reader, typed));
    expect([first.items.length, looked, connections]).toEqual([84, ["localhost"], 1]);
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
    expect([seen[0]!.headers["accept-encoding"], seen[0]!.headers["user-agent"], seen[0]!.headers.host]).toEqual(["identity", "ohmail-Calendar/2.0", `localhost:${port}`]);
    // The name is looked up again for the second ask; whether the first connection is used again is the platform's.
    const second = pageOf(await read(reader, typed, tokenOf(first)));
    expect([second.unchanged, second.items.length, seen[1]!.headers["if-none-match"], looked]).toEqual([true, 0, '"v1"', ["localhost", "localhost"]]);
  });

  it("follows a redirect and keeps no tag of the address it led to", async () => {
    serve(feed);
    const reader = through({ kind: "own-network" });
    const typed = `http://localhost:${port}/old.ics`;
    const first = pageOf(await read(reader, typed));
    const second = pageOf(await read(reader, typed, tokenOf(first)));
    expect([first.items.length, second.unchanged, seen.map((s) => [s.url, s.headers["if-none-match"]])]).toEqual([84, true, [["/old.ics", undefined], ["/holidays.ics", undefined], ["/old.ics", undefined], ["/holidays.ics", undefined]]]);
  });

  it("opens no socket for the same address on a hosted server", async () => {
    serve(feed);
    expect(await read(through({ kind: "cloud" }), `http://localhost:${port}/holidays.ics`)).toEqual({ ok: false, reason: "address_not_allowed", retryAfterMs: null });
    expect([connections, looked]).toEqual([0, []]);
  });

  it("never falls back to http for an address typed as webcal: a server that speaks no TLS is a failed connection", async () => {
    serve(feed);
    expect(await read(through({ kind: "own-network" }), `webcal://localhost:${port}/holidays.ics`)).toEqual({ ok: false, reason: "connection_failed", retryAfterMs: null });
    expect(seen).toEqual([]);
  });
});
