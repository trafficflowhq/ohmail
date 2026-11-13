/**
 * CalDAV read behind the port: the calendars of a home, and one calendar's objects by the server's
 * token for what changed, in pages.
 *
 * Two proofs. ONE list of servers, each a folder of recorded answers: what two real servers said to
 * the same requests, served by a request port that knows those answers and throws on anything else.
 * Another server is another row. And a server of this file's own on 127.0.0.1, written from the
 * standards (`caldav-stand-in.ts`) and reached through the real request port, for what no recording
 * holds: pages, a round from a token, a token the server threw away, an answer cut short.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ZONE_NAME_CHARS, intlZones, type CalEvent } from "@ohmail/cal-core";
import { pinnedHttpRequest, type HostResolver } from "@trafficflow/core/net";
import { afterEach, describe, expect, it } from "vitest";
import { makeReader } from "../src/caldav/index.js";
import { FETCH_BODY_MAX_BYTES, MAX_CALENDAR_NAME_CHARS, MAX_PAGES_PER_CALL, MAX_PAGE_LIMIT, MAX_VALIDATOR_CHARS } from "../src/limits.js";
import type { CalendarReader, CalendarRef, ChangeItem, ChangePage, ChangeToken, Connection } from "../src/port.js";
import { guardedRequest } from "../src/request/guarded.js";
import type { HttpAnswer, HttpPort } from "../src/request/index.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "./caldav-stand-in.js";

const ZONES = intlZones();
const CLOCK = { now: () => Date.UTC(2026, 10, 14, 9, 0, 0) };
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const slug = (id: string): string => id.slice(id.lastIndexOf("/") + 1).replace(/\.ics$/, "");
/** A page's items in a line each: `+name` for a stored object, `-name` for one that is gone. */
const names = (items: readonly ChangeItem[]): string[] => items.map((i) => (i.kind === "upsert" ? `+${slug(i.id)}` : i.kind === "gone" ? `-${slug(i.id)}` : "?"));
const events = (items: readonly ChangeItem[]): CalEvent[] => items.flatMap((i) => (i.kind === "upsert" ? [i.event] : []));

/* ── the list of servers ─────────────────────────────────────────────────────────────────────────── */

interface Exchange {
  readonly request: { readonly method: string; readonly url: string; readonly body?: string };
  readonly response: { readonly status: number; readonly body: string };
}
interface ServerRow {
  /** The folder of its recorded answers. */
  readonly name: string;
  /** What a person types. */
  readonly start: string;
  /**
   * No server's discovery is recorded, so its two answers are written here from the standards: the
   * host the starts answer at, the principal they name, and the calendar home that principal names,
   * as a path or as a full address on another host.
   */
  readonly origin: string;
  readonly principal: string;
  readonly home: string;
  /** Whether the server's reports also name the collection they were asked of. */
  readonly itself: 0 | 1;
  /** The five members in the order the server lists them. The recorder numbered the tags in that order. */
  readonly listed: readonly string[];
}
const CALDAV_READER_ROWS: readonly ServerRow[] = [
  { name: "bench", start: "http://127.0.0.1:8821/", origin: "http://127.0.0.1:8821", principal: "/bench/", home: "/bench/", itself: 0, listed: ["stall-planning-call", "wheel-class", "glaze-firing", "catalogue-proofs", "market-day"] },
  { name: "icloud", start: "caldav.icloud.com", origin: "https://caldav.icloud.com", principal: "/principal-1/principal/", home: "https://p00-caldav.icloud.com/principal-1/calendars/", itself: 1, listed: ["catalogue-proofs", "glaze-firing", "market-day", "stall-planning-call", "wheel-class"] },
];

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "support", "fixtures");
const CALENDAR = "ohmail-bench-r2-cal-accounts-20261113";
const anyone: Connection["credential"] = { kind: "basic", user: "mila", password: () => ["any", "thing"].join("-") };

/**
 * A request port that holds a server's recorded answers and no other. The reader's multiget is
 * answered with the recorded report of the same five members (no multiget was recorded; both are
 * the multistatus of RFC 4791 section 7.9 over the same objects), and only when it asks for exactly
 * those five.
 */
function recorded(row: ServerRow) {
  const fixture = (name: string): Exchange => JSON.parse(readFileSync(join(FIXTURES, row.name, `${name}.json`), "utf8")) as Exchange;
  const home = fixture("home-collections");
  const sync = fixture("sync-collection-first");
  const data = fixture("calendar-query-with-data");
  const collection = sync.request.url;
  const members = row.listed.map((name) => new URL(`${name}.ics`, collection).pathname).sort();
  const asked: { method: string; url: string; depth: string | null; body: string }[] = [];
  const answer = (url: string, body: string): HttpAnswer => ({ arrived: true, status: 207, header: () => null, body: bytes(body), location: null, url, hops: 0 });
  const written = (href: string, prop: string): string =>
    `<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>${href}</href><propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
  const port: HttpPort = {
    async request(url, req) {
      const body = req.body ?? "";
      const depth = req.headers.depth ?? null;
      asked.push({ method: req.method, url, depth, body });
      if (req.auth === null || !req.auth.admits(new URL(url).hostname)) throw new Error(`asked without the sign-in, or of a host it may not travel to: ${url}`);
      if (req.method === "PROPFIND" && depth === "0" && url === `${row.origin}/.well-known/caldav`) return answer(`${row.origin}/`, written("/", `<current-user-principal><href>${row.principal}</href></current-user-principal>`));
      if (req.method === "PROPFIND" && depth === "0" && url === `${row.origin}${row.principal}`) return answer(url, written(row.principal, `<C:calendar-home-set><href>${row.home}</href></C:calendar-home-set>`));
      if (req.method === "PROPFIND" && depth === "1" && url === home.request.url) return answer(url, home.response.body);
      if (req.method === "REPORT" && url === collection && body.includes("sync-collection") && body.includes("<D:sync-token></D:sync-token>")) return answer(url, sync.response.body);
      const wanted = [...body.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]!).sort();
      if (req.method === "REPORT" && url === collection && depth === null && body.includes("calendar-multiget") && JSON.stringify(wanted) === JSON.stringify(members)) return answer(url, data.response.body);
      throw new Error(`not recorded: ${req.method} ${url}`);
    },
  };
  return { reader: makeReader({ http: port, clock: CLOCK, zones: ZONES }), asked, collection, connection: { provider: "caldav", credential: anyone, start: row.start } satisfies Connection };
}

/** What an event says, its identity aside: the recorder numbers the identities anew in every folder. */
const said = (e: CalEvent) => ({ summary: e.summary, description: e.description, start: e.start, end: e.end, was: e.recurrenceId, rules: e.rules.map((r) => r.text), url: e.url });
const zurich = (month: number, day: number, hour: number, minute = 0) => ({ kind: "zoned", tzid: "Europe/Zurich", wall: { year: 2026, month, day, hour, minute, second: 0 } });

describe.each(CALDAV_READER_ROWS)("the recorded answers of $name", (row) => {
  it("lists the home's one calendar, with its name and that it keeps a token", async () => {
    const { reader, connection, collection } = recorded(row);
    expect(await reader.listCalendars(connection, signal())).toEqual({ ok: true, value: [{ id: collection, name: CALENDAR, color: null, writable: true, byToken: true, zone: null }] });
  });

  it("reads the calendar whole: five stored objects, the series and its changed day in one of them, and the token to go on from", async () => {
    const { reader, connection, collection, asked } = recorded(row);
    const answer = await reader.readChanges(connection, { id: collection }, null, { limit: 250, cursor: null, window: null }, signal());
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const page = answer.value;
    expect([page.mode, page.unchanged, page.left, page.expanded, page.refreshMs]).toEqual(["whole", false, [], null, null]);
    expect(page.cursor).toEqual({ kind: "end", token: { provider: "caldav", value: "sync:sync-1" } });
    // The collection's own response, where the server writes one, is no object: five, in the order of their addresses.
    expect(names(page.items)).toEqual(["+catalogue-proofs", "+glaze-firing", "+market-day", "+stall-planning-call", "+wheel-class", "+wheel-class"]);
    expect(new Set(page.items.map((i) => i.kind === "upsert" && i.id))).toEqual(new Set(row.listed.map((name) => `${collection}${name}.ics`)));
    // Each object's version is the tag the server gave it, as written.
    const versions = new Map(page.items.flatMap((i) => (i.kind === "upsert" ? [[slug(i.id), i.version] as const] : [])));
    expect([...versions].sort()).toEqual(row.listed.map((name, at) => [name, `"etag-${1 + row.itself + at}"`]).sort());

    const by = (name: string): CalEvent[] => page.items.flatMap((i) => (i.kind === "upsert" && slug(i.id) === name ? [i.event] : []));
    expect(by("glaze-firing").map(said)).toEqual([{ summary: "Glaze firing", description: "Cone 6. The blue set for the catalogue goes in first.", start: zurich(11, 19, 9), end: zurich(11, 19, 11), was: null, rules: [], url: null }]);
    expect(by("catalogue-proofs").map((e) => [e.summary, e.start])).toEqual([["Catalogue proofs", zurich(11, 20, 14)]]);
    expect(by("market-day").map((e) => [e.summary, e.start])).toEqual([["Market day", { kind: "date", year: 2026, month: 11, day: 21 }]]);
    expect(by("stall-planning-call").map((e) => [e.summary, e.start, e.url])).toEqual([["Stall planning call", zurich(11, 23, 10), "https://call.ohmail-bench.example/stall-planning"]]);
    // Weekly on Tuesdays at six, six times; the third evening moved to the Wednesday at seven.
    expect(by("wheel-class").map((e) => [e.summary, e.rules.map((r) => r.text), e.recurrenceId, e.start])).toEqual([
      ["Wheel class", ["FREQ=WEEKLY;COUNT=6;BYDAY=TU"], null, zurich(11, 17, 18)],
      ["Wheel class", [], zurich(12, 1, 18), zurich(12, 2, 19)],
    ]);
    // A series and its changed day are one stored object: one address, one version, one text, and that text whole.
    const wheel = page.items.filter((i) => i.kind === "upsert" && slug(i.id) === "wheel-class");
    expect(new Set(wheel.map((i) => i.kind === "upsert" && `${i.id} ${i.version} ${i.text}`)).size).toBe(1);
    for (const item of page.items) expect(item.kind === "upsert" && item.text !== null && item.text.startsWith("BEGIN:VCALENDAR") && item.text.trimEnd().endsWith("END:VCALENDAR")).toBe(true);

    // What was asked: the sync report and one multiget, and never a query, with or without a filter on one identifier.
    expect(asked.map((a) => [a.method, a.depth])).toEqual([["REPORT", "0"], ["REPORT", null]]);
    expect(asked.filter((a) => a.body.includes("calendar-query") || a.body.includes("prop-filter") || a.body.includes("expand"))).toEqual([]);
  });
});

it("the servers store one event differently and say the same of it: a rewritten zone definition and another order of lines change no event", async () => {
  const told = await Promise.all(
    CALDAV_READER_ROWS.map(async (row) => {
      const { reader, connection, collection } = recorded(row);
      const answer = await reader.readChanges(connection, { id: collection }, null, { limit: 250, cursor: null, window: null }, signal());
      if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
      return { said: answer.value.items.map((i) => (i.kind === "upsert" ? [slug(i.id), said(i.event)] : [])), texts: answer.value.items.map((i) => (i.kind === "upsert" ? i.text : null)) };
    }),
  );
  expect(told[1]!.said).toEqual(told[0]!.said);
  for (const [at, text] of told[1]!.texts.entries()) expect(text).not.toBe(told[0]!.texts[at]);
});

/* ── a server on this machine, written from the standards ────────────────────────────────────────── */

/** Three names for this machine, as in the discovery's own tests. */
const NAMES: Record<string, string[]> = { "caldav.example.test": ["127.0.0.1"], "elsewhere.example.net": ["127.0.0.1"] };
const resolver: HostResolver = { resolve: async (name) => NAMES[name] ?? [] };
/** The real request port with a low ceiling on an answer's bytes, so that one heavy object is past it. */
const SMALL_ANSWERS = 64 * 1024;
const overNetwork = (maxBodyBytes: number): HttpPort =>
  guardedRequest({ resolver, request: pinnedHttpRequest, policy: { kind: "own-network" }, hosts: null, limits: { connectMs: 5_000, totalMs: 20_000, maxRedirects: 5, maxBodyBytes } });
const http = overNetwork(SMALL_ANSWERS);
const reader = makeReader({ http, clock: CLOCK, zones: ZONES });

const servers: StandIn[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const here = (s: StandIn, path = ""): string => `http://127.0.0.1:${s.port}${path}`;
const signIn = (s: StandIn, password = s.options.password): Connection => ({ provider: "caldav", credential: { kind: "basic", user: s.options.user, password: () => password }, start: here(s) });
const event = (uid: string, summary: string, more: readonly string[] = []): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//caldav test//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261113T120000Z", "DTSTART:20261119T090000Z", "DTEND:20261119T100000Z", `SUMMARY:${summary}`, ...more, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

/** A server with one calendar `work` that holds an event for each name, put in the order given. */
async function studio(options: StandInOptions = {}, members: readonly string[] = ["a", "b", "c", "d", "e"], calendar: Parameters<StandIn["addCalendar"]>[1] = {}) {
  const s = await startCalDavStandIn(options);
  servers.push(s);
  s.addCalendar("work", calendar);
  for (const name of members) s.put("work", `${name}.ics`, event(`${name}@studio.example.test`, `Event ${name}`));
  return { s, c: signIn(s), cal: { id: here(s, s.paths.collection("work")) } satisfies CalendarRef };
}

const page = async (c: Connection, cal: CalendarRef, since: ChangeToken | null, limit: number, cursor: string | null, by: CalendarReader = reader): Promise<ChangePage> => {
  const answer = await by.readChanges(c, cal, since, { limit, cursor, window: null }, signal());
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
  return answer.value;
};
interface Pass {
  readonly pages: readonly ChangePage[];
  readonly items: readonly ChangeItem[];
  readonly left: ChangePage["left"];
  readonly token: ChangeToken | null;
}
/** Every page of one reading, from `first` on when a test already asked for that one. */
async function pass(c: Connection, cal: CalendarRef, since: ChangeToken | null, limit = 250, first: ChangePage | null = null, by: CalendarReader = reader): Promise<Pass> {
  const pages: ChangePage[] = [];
  let next = first ?? (await page(c, cal, since, limit, null, by));
  for (let n = 0; n < 60; n++) {
    pages.push(next);
    if (next.cursor.kind === "end") return { pages, items: pages.flatMap((p) => p.items), left: pages.flatMap((p) => p.left), token: next.cursor.token };
    next = await page(c, cal, since, limit, next.cursor.value, by);
  }
  throw new Error("the reading did not end");
}
const reports = (s: StandIn): (string | null)[] => s.seen.filter((r) => r.method === "REPORT").map((r) => r.asks);

describe("the calendars of a home", () => {
  it("lists what is a calendar for events, each with what the server says of it", async () => {
    const s = await startCalDavStandIn();
    servers.push(s);
    s.addCalendar("work", { name: " Work & play ", color: "#FF2968FF", timezoneId: "Europe/Zurich" });
    s.addCalendar("shared", { name: "Team", privileges: ["read", "read-current-user-privilege-set"], color: "not a colour" });
    s.addCalendar("old", { name: "", sync: false, privileges: null, components: null, timezone: ZONE_OF_NEW_YORK });
    s.addCalendar("tasks", { components: ["VTODO"] });
    s.addCalendar("both", { components: ["VTODO", "VEVENT"], privileges: ["all"] });
    s.addCalendar("inbox", { kind: "inbox" });
    s.addCalendar("attachments", { kind: "folder" });
    const answer = await reader.listCalendars(signIn(s), signal());
    const at = (name: string): string => here(s, s.paths.collection(name));
    expect(answer).toEqual({
      ok: true,
      value: [
        { id: at("work"), name: "Work & play", color: "#ff2968", writable: true, byToken: true, zone: "Europe/Zurich" },
        // May be read and no more: not writable. Its colour is none this reader knows.
        { id: at("shared"), name: "Team", color: null, writable: false, byToken: true, zone: null },
        // Says nothing of what it takes, of who may write, of a token: takes events, is tried at a write, is read by its tags.
        { id: at("old"), name: null, color: null, writable: true, byToken: false, zone: "America/New_York" },
        { id: at("both"), name: "both", color: null, writable: true, byToken: true, zone: null },
      ],
    });
    // One request for the list, after the three that find the home.
    expect(s.seen.map((r) => [r.path, r.depth])).toEqual([["/.well-known/caldav", "0"], ["/dav/", "0"], ["/dav/principals/mila/", "0"], ["/dav/calendars/mila/", "1"]]);
  });

  it("lists a calendar without a name or a zone that is longer than one may be", async () => {
    const s = await startCalDavStandIn();
    servers.push(s);
    s.addCalendar("long", { name: "n".repeat(MAX_CALENDAR_NAME_CHARS + 1), timezoneId: "Z".repeat(MAX_ZONE_NAME_CHARS + 1) });
    s.addCalendar("full", { name: "n".repeat(MAX_CALENDAR_NAME_CHARS), timezoneId: "Z".repeat(MAX_ZONE_NAME_CHARS) });
    const answer = await reader.listCalendars(signIn(s), signal());
    expect(answer.ok && answer.value.map((c) => [slug(c.id.slice(0, -1)), c.name?.length ?? null, c.zone?.length ?? null])).toEqual([["long", null, null], ["full", MAX_CALENDAR_NAME_CHARS, MAX_ZONE_NAME_CHARS]]);
  });
});

const ZONE_OF_NEW_YORK = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//caldav test//EN", "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19701101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD", "END:VTIMEZONE", "END:VCALENDAR", ""].join("\r\n");

describe("one calendar, read by the server's token", () => {
  it("reads it whole in pages, then nothing from the token, then what changed since", async () => {
    const { s, c, cal } = await studio();
    const whole = await pass(c, cal, null, 2);
    expect(whole.pages.map((p) => [p.mode, p.unchanged, names(p.items)])).toEqual([["whole", false, ["+a", "+b"]], ["whole", false, ["+c", "+d"]], ["whole", false, ["+e"]]]);
    expect(whole.left).toEqual([]);
    expect(whole.token?.provider).toBe("caldav");
    // An object as the port hands it: its address, the server's tag as written, its text as the server keeps it, and the event read from it.
    expect(whole.items[0]).toMatchObject({ kind: "upsert", id: here(s, "/dav/calendars/mila/work/a.ics"), version: `"work-a.ics-1"`, text: event("a@studio.example.test", "Event a") });
    expect(events(whole.items).map((e) => [e.uid, e.summary])).toEqual(["a", "b", "c", "d", "e"].map((n) => [`${n}@studio.example.test`, `Event ${n}`]));
    // The sync report is asked of the collection itself (Depth 0); a multiget carries no Depth line.
    expect(new Set(s.seen.filter((r) => r.method === "REPORT").map((r) => `${r.asks} ${r.depth} ${r.path}`))).toEqual(new Set(["sync-collection 0 /dav/calendars/mila/work/", "calendar-multiget null /dav/calendars/mila/work/"]));

    const quiet = await pass(c, cal, whole.token);
    expect(quiet.pages.map((p) => [p.mode, p.unchanged, p.items])).toEqual([["delta", false, []]]);
    expect(quiet.token).toEqual(whole.token);

    s.put("work", "b.ics", event("b@studio.example.test", "Event b, moved"));
    s.remove("work", "d.ics");
    s.put("work", "f.ics", event("f@studio.example.test", "Event f"));
    const changed = await pass(c, cal, quiet.token);
    expect(changed.pages.map((p) => [p.mode, names(p.items)])).toEqual([["delta", ["+b", "-d", "+f"]]]);
    expect(events(changed.items).map((e) => e.summary)).toEqual(["Event b, moved", "Event f"]);
    expect(changed.token).not.toEqual(whole.token);
    expect((await pass(c, cal, changed.token)).items).toEqual([]);
  });

  it("ends a reading with the token of its FIRST listing: what changed while it was read is told again by the next round, never lost", async () => {
    const { s, c, cal } = await studio();
    const first = await page(c, cal, null, 2, null);
    expect(names(first.items)).toEqual(["+a", "+b"]);
    // While the reading is under way: an object already handed out changes, and a new one sorts before everything read so far.
    s.put("work", "a.ics", event("a@studio.example.test", "Event a, changed"));
    s.put("work", "0.ics", event("0@studio.example.test", "Event 0"));
    const whole = await pass(c, cal, null, 2, first);
    expect(names(whole.items)).toEqual(["+a", "+b", "+c", "+d", "+e"]);
    const next = await pass(c, cal, whole.token);
    expect(next.pages[0]!.mode).toBe("delta");
    expect(events(next.items).map((e) => e.summary)).toEqual(["Event 0", "Event a, changed"]);
  });

  it("goes on from the token a server hands back when it cuts an answer short", async () => {
    const { c, cal } = await studio({ truncateAt: 2 });
    const whole = await pass(c, cal, null);
    expect(whole.pages.map((p) => [p.mode, names(p.items), p.cursor.kind])).toEqual([["whole", ["+a", "+b"], "more"], ["whole", ["+c", "+d"], "more"], ["whole", ["+e"], "end"]]);
    expect((await pass(c, cal, whole.token)).items).toEqual([]);
    // A page smaller than the server's own cut: the cut is read in pieces, then the next one.
    const { c: c2, cal: cal2 } = await studio({ truncateAt: 2 });
    expect((await pass(c2, cal2, null, 1)).pages.map((p) => names(p.items))).toEqual([["+a"], ["+b"], ["+c"], ["+d"], ["+e"]]);
  });

  it("begins a server's cut again when the server cuts otherwise the second time: no object of the new cut is passed over", async () => {
    // The server cuts after three changes, oldest first: z, y, x. They sort the other way round.
    const { s, c, cal } = await studio({ truncateAt: 3 }, ["z", "y", "x", "m", "k"]);
    const first = await page(c, cal, null, 2, null);
    expect(names(first.items)).toEqual(["+x", "+y"]);
    // z changes: it is now the newest, and the first three are y, x and m. `m` sorts before what was read.
    s.put("work", "z.ics", event("z@studio.example.test", "Event z, changed"));
    const whole = await pass(c, cal, null, 2, first);
    expect(new Set(names(whole.items))).toEqual(new Set(["+k", "+m", "+x", "+y", "+z"]));
    expect(events(whole.items).filter((e) => e.uid === "z@studio.example.test").map((e) => e.summary)).toEqual(["Event z, changed"]);
    expect((await pass(c, cal, whole.token)).items).toEqual([]);
  });

  it("reads a cut on in pages at a server that words its token anew in every answer: every object once, and the reading ends", async () => {
    const { c, cal } = await studio({ truncateAt: 3, rewordsTokens: true });
    const whole = await pass(c, cal, null, 2);
    expect(whole.pages.map((p) => names(p.items))).toEqual([["+a", "+b"], ["+c"], ["+d", "+e"]]);
    expect((await pass(c, cal, whole.token)).items).toEqual([]);
  });

  it("begins the cut again at such a server once an object it handed out is another: the change is not passed over", async () => {
    const { s, c, cal } = await studio({ truncateAt: 2, rewordsTokens: true }, ["a", "b", "c"]);
    const first = await page(c, cal, null, 1, null);
    expect(names(first.items)).toEqual(["+a"]);
    // All three change, in the order they stood in: the server's cut holds the same two names, and `a` under it is another object.
    for (const name of ["a", "b", "c"]) s.put("work", `${name}.ics`, event(`${name}@studio.example.test`, `Event ${name}, changed`));
    const whole = await pass(c, cal, null, 1, first);
    expect(events(whole.items).filter((e) => e.uid === "a@studio.example.test").map((e) => e.summary)).toEqual(["Event a", "Event a, changed"]);
    expect(new Set(names(whole.items))).toEqual(new Set(["+a", "+b", "+c"]));
    expect((await pass(c, cal, whole.token)).items).toEqual([]);
  });

  it("begins the cut again at such a server where another object stands, under the same tag, in the place of one it handed out", async () => {
    const { s, c, cal } = await studio({ truncateAt: 2, rewordsTokens: true }, []);
    s.put("work", "a.ics", event("a@studio.example.test", "Event a"), `"one-tag"`);
    for (const name of ["z", "q"]) s.put("work", `${name}.ics`, event(`${name}@studio.example.test`, `Event ${name}`));
    const first = await page(c, cal, null, 1, null);
    expect(names(first.items)).toEqual(["+a"]);
    // The server's cut is now `z` and a new object that sorts where `a` stood and carries its tag.
    s.remove("work", "a.ics");
    s.remove("work", "q.ics");
    s.put("work", "0.ics", event("0@studio.example.test", "Event 0"), `"one-tag"`);
    s.put("work", "y.ics", event("y@studio.example.test", "Event y"));
    expect(names((await pass(c, cal, null, 1, first)).items)).toEqual(["+a", "+0", "+z", "+y"]);
  });

  it("refuses to go round in a circle: a server that cuts short and hands back the token it was asked with", async () => {
    const { c, cal } = await studio({ truncateAt: 0 });
    const first = await page(c, cal, null, 250, null);
    expect([first.items, first.cursor.kind]).toEqual([[], "more"]);
    expect(await reader.readChanges(c, cal, null, { limit: 250, cursor: first.cursor.kind === "more" ? first.cursor.value : null, window: null }, signal())).toEqual({ ok: false, reason: "page_link_refused", retryAfterMs: null });
  });

  it("says that the token is gone when the server no longer knows it, by whichever status, and reads whole again from none", async () => {
    for (const deadTokenStatus of [403, 400, 412, 409]) {
      const { s, c, cal } = await studio({ deadTokenStatus });
      const whole = await pass(c, cal, null);
      s.forgetTokens("work");
      expect(await reader.readChanges(c, cal, whole.token, { limit: 250, cursor: null, window: null }, signal())).toEqual({ ok: false, reason: "token_gone", retryAfterMs: null });
      const again = await pass(c, cal, null);
      expect([again.pages[0]!.mode, names(again.items)]).toEqual(["whole", ["+a", "+b", "+c", "+d", "+e"]]);
    }
  });

  it("hands no item for the collection a report names beside its members", async () => {
    const { c, cal } = await studio({ namesItself: true });
    const whole = await pass(c, cal, null, 2);
    expect([names(whole.items), whole.left]).toEqual([["+a", "+b", "+c", "+d", "+e"], []]);
  });

  it("tells an object as gone when it went between the listing and the request for its text", async () => {
    const { s, c, cal } = await studio();
    let went = false;
    const racing: HttpPort = {
      async request(url, req) {
        if (!went && (req.body ?? "").includes("calendar-multiget")) {
          went = true;
          s.remove("work", "b.ics");
        }
        return http.request(url, req);
      },
    };
    const whole = await pass(c, cal, null, 250, null, makeReader({ http: racing, clock: CLOCK, zones: ZONES }));
    expect(names(whole.items)).toEqual(["+a", "-b", "+c", "+d", "+e"]);
    expect(names((await pass(c, cal, whole.token)).items)).toEqual(["-b"]);
  });

  it("hands a tag on as the server wrote it, and none for one that is longer than a tag may be", async () => {
    const { s, c, cal } = await studio({}, []);
    s.put("work", "weak.ics", event("weak@studio.example.test", "Weak"), `W/"7f3a"`);
    s.put("work", "long.ics", event("long@studio.example.test", "Long"), `"${"e".repeat(MAX_VALIDATOR_CHARS)}"`);
    const whole = await pass(c, cal, null);
    expect(whole.items.map((i) => i.kind === "upsert" && [slug(i.id), i.version])).toEqual([["long", ""], ["weak", `W/"7f3a"`]]);
  });

  it("knows a member again when a server escapes its address in the listing and writes it out in the answer that carries its text", async () => {
    const { c, cal } = await studio({ listsEscaped: true }, ["a", "wheel@studio"]);
    const whole = await pass(c, cal, null);
    expect([names(whole.items), whole.left]).toEqual([["+a", "+wheel%40studio"], []]);
  });

  it("takes a page's size from the caller within its own bounds", async () => {
    const many = Array.from({ length: MAX_PAGE_LIMIT + 1 }, (_, n) => `m${String(n).padStart(3, "0")}`);
    const { c, cal } = await studio({}, many);
    const roomy = makeReader({ http: overNetwork(FETCH_BODY_MAX_BYTES), clock: CLOCK, zones: ZONES });
    expect((await pass(c, cal, null, 1_000_000, null, roomy)).pages.map((p) => p.items.length)).toEqual([MAX_PAGE_LIMIT, 1]);
    expect((await page(c, cal, null, 0, null, roomy)).items.length).toBe(1);
    expect((await page(c, cal, null, Number.NaN, null, roomy)).items.length).toBe(1);
  });
});

describe("a calendar that keeps no token", () => {
  it("is read whole by its members' tags, and not at all while its own tag stands", async () => {
    const { s, c, cal } = await studio({}, ["a", "b", "c"], { sync: false });
    const whole = await pass(c, cal, null, 2);
    expect(whole.pages.map((p) => [p.mode, p.unchanged, names(p.items)])).toEqual([["whole", false, ["+a", "+b"]], ["whole", false, ["+c"]]]);
    expect(whole.token?.provider).toBe("caldav");
    // The sync report is tried once, refused, and the collection is listed instead.
    expect(s.seen.slice(0, 3).map((r) => [r.method, r.asks, r.depth])).toEqual([["REPORT", "sync-collection", "0"], ["PROPFIND", "propfind", "1"], ["REPORT", "calendar-multiget", null]]);

    s.seen.length = 0;
    const quiet = await page(c, cal, whole.token, 250, null);
    expect([quiet.mode, quiet.unchanged, quiet.items, quiet.cursor]).toEqual(["whole", true, [], { kind: "end", token: whole.token }]);
    expect(s.seen.map((r) => [r.method, r.depth])).toEqual([["PROPFIND", "0"]]);

    s.put("work", "d.ics", event("d@studio.example.test", "Event d"));
    const again = await pass(c, cal, quiet.cursor.kind === "end" ? quiet.cursor.token : null);
    expect([again.pages[0]!.mode, again.pages[0]!.unchanged, names(again.items)]).toEqual(["whole", false, ["+a", "+b", "+c", "+d"]]);
    expect(again.token).not.toEqual(whole.token);
  });

  it("ends a reading with the tag of its first listing, so that a change made meanwhile is read by the next round", async () => {
    const { s, c, cal } = await studio({}, ["a", "b", "c"], { sync: false });
    const first = await page(c, cal, null, 2, null);
    s.put("work", "0.ics", event("0@studio.example.test", "Event 0"));
    const whole = await pass(c, cal, null, 2, first);
    expect(names(whole.items)).toEqual(["+a", "+b", "+c"]);
    const next = await page(c, cal, whole.token, 250, null);
    expect([next.unchanged, names(next.items)]).toEqual([false, ["+0", "+a", "+b", "+c"]]);
  });

  it("hands out no token at all for a calendar that has neither a token nor a tag", async () => {
    const { c, cal } = await studio({}, ["a"], { sync: false, tagged: false });
    const whole = await pass(c, cal, null);
    expect([names(whole.items), whole.token]).toEqual([["+a"], null]);
  });
});

describe("what a calendar holds that is not read", () => {
  it("leaves it out by its word, reads the rest, and takes nothing a report names outside the collection", async () => {
    const strays = ["/dav/calendars/mila/other/x.ics", "http://elsewhere.example.net/dav/calendars/mila/work/y.ics"];
    const { s, c, cal } = await studio({ strays }, ["ok"]);
    s.put("work", "note.ics", "Dear all, the kiln is free on Thursday.");
    const kept = event("kept@studio.example.test", "Kept").split("\r\n");
    const tooLong = [...kept.slice(0, 3), "BEGIN:VEVENT", `UID:${"u".repeat(1100)}`, "DTSTAMP:20261113T120000Z", "DTSTART:20261120T090000Z", "SUMMARY:Left out", "END:VEVENT", ...kept.slice(3)].join("\r\n");
    s.put("work", "long.ics", tooLong);
    s.put("work", "todo.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//caldav test//EN", "BEGIN:VTODO", "UID:todo@studio.example.test", "DTSTAMP:20261113T120000Z", "SUMMARY:Mix the glaze", "END:VTODO", "END:VCALENDAR", ""].join("\r\n"));
    const whole = await pass(c, cal, null);
    // The object with one event too many to read still hands the one that reads; an object that holds no event is none for a calendar.
    expect(names(whole.items)).toEqual(["+long", "+ok", "-todo"]);
    expect(events(whole.items).map((e) => e.summary)).toEqual(["Kept", "Event ok"]);
    const at = (name: string): string => here(s, `/dav/calendars/mila/work/${name}`);
    expect([...whole.left].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: here(s, strays[0]!), reason: "unreadable" },
        { id: at("long.ics"), reason: "uid_too_long" },
        { id: at("note.ics"), reason: "not_a_calendar" },
        { id: strays[1]!, reason: "unreadable" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(s.seen.every((r) => r.host === `127.0.0.1:${s.port}`)).toBe(true);
  });

  it("says of an object it asked for and was told nothing of that it could not be read: neither there nor gone", async () => {
    const { s, c, cal } = await studio({ silentOn: ["b.ics"] });
    const whole = await pass(c, cal, null);
    expect([names(whole.items), whole.left]).toEqual([["+a", "+c", "+d", "+e"], [{ id: here(s, "/dav/calendars/mila/work/b.ics"), reason: "unreadable" }]]);
  });

  it("does not let one heavy object hold a calendar: the request is halved until the object stands alone", async () => {
    const { s, c, cal } = await studio();
    s.put("work", "c.ics", event("c@studio.example.test", "Event c", [`DESCRIPTION:${"clay ".repeat(SMALL_ANSWERS / 4)}`]));
    const whole = await pass(c, cal, null);
    expect([names(whole.items), whole.left]).toEqual([["+a", "+b", "+d", "+e"], [{ id: here(s, "/dav/calendars/mila/work/c.ics"), reason: "too_large" }]]);
    expect(whole.pages.length).toBe(1);
    expect(reports(s).filter((asks) => asks === "calendar-multiget").length).toBeLessThanOrEqual(MAX_PAGES_PER_CALL);
  });

  it("ends a page early when its requests are spent, and the next page goes on from there", async () => {
    const heavy = Array.from({ length: 30 }, (_, n) => `h${String(n).padStart(2, "0")}`);
    const { s, c, cal } = await studio({}, []);
    for (const name of heavy) s.put("work", `${name}.ics`, event(`${name}@studio.example.test`, name, [`DESCRIPTION:${"clay ".repeat(SMALL_ANSWERS / 4)}`]));
    const pages: ChangePage[] = [];
    const asked: number[] = [];
    let cursor: string | null = null;
    do {
      s.seen.length = 0;
      const next = await page(c, cal, null, 250, cursor);
      pages.push(next);
      asked.push(reports(s).filter((asks) => asks === "calendar-multiget").length);
      cursor = next.cursor.kind === "more" ? next.cursor.value : null;
    } while (cursor !== null && pages.length < 10);
    expect(cursor).toBeNull();
    expect(pages.length).toBeGreaterThan(1);
    expect(Math.max(...asked)).toBeLessThanOrEqual(MAX_PAGES_PER_CALL);
    expect(pages.flatMap((p) => p.items)).toEqual([]);
    expect(pages.flatMap((p) => p.left).map((l) => [slug(l.id), l.reason])).toEqual(heavy.map((name) => [name, "too_large"]));
  });
});

describe("what a reading is refused with", () => {
  it("asks nobody for a token, a cursor or a calendar that is none of this reader's", async () => {
    const { s, c, cal } = await studio();
    const ask = (over: { cal?: CalendarRef; since?: ChangeToken | null; cursor?: string | null }) =>
      reader.readChanges(c, over.cal ?? cal, over.since ?? null, { limit: 250, cursor: over.cursor ?? null, window: null }, signal());
    for (const since of [{ provider: "google", value: "sync:1" }, { provider: "caldav", value: "1" }, { provider: "caldav", value: "sync:" }, { provider: "caldav", value: `sync:${"t".repeat(5000)}` }] satisfies ChangeToken[]) {
      expect(await ask({ since })).toEqual({ ok: false, reason: "token_gone", retryAfterMs: null });
    }
    for (const cursor of ["", "more", "[]", `[1,"sync",true,"",null]`, `[2,"sync",true,"",null,null]`, `[1,"mail",true,"",null,null]`, `[1,"sync","yes","",null,null]`, `[1,"sync",true,7,null,null]`, "x".repeat(9000)]) {
      expect([cursor.slice(0, 40), await ask({ cursor })]).toEqual([cursor.slice(0, 40), { ok: false, reason: "token_gone", retryAfterMs: null }]);
    }
    const withSignIn = ["http://", "mila", ":", "kiln", "@", `127.0.0.1:${s.port}/dav/calendars/mila/work/`].join("");
    for (const id of ["", "work", "/dav/calendars/mila/work/", "ftp://127.0.0.1/work/", withSignIn]) {
      expect([id.slice(0, 20), await ask({ cal: { id } })]).toEqual([id.slice(0, 20), { ok: false, reason: "not_found", retryAfterMs: null }]);
    }
    // A calendar on a host the typed one's sign-in may not travel to.
    expect(await ask({ cal: { id: `http://elsewhere.example.net:${s.port}/dav/calendars/mila/work/` } })).toEqual({ ok: false, reason: "host_changed", retryAfterMs: null });
    expect(s.seen).toEqual([]);
  });

  it("names a refused sign-in, a calendar that is gone, a busy server and a broken one, each by its word and at the first answer", async () => {
    const { s, c, cal } = await studio();
    expect(await reader.readChanges(signIn(s, ["not", "the", "password"].join("-")), cal, null, { limit: 250, cursor: null, window: null }, signal())).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
    expect(await reader.readChanges(c, { id: here(s, "/dav/calendars/mila/gone/") }, null, { limit: 250, cursor: null, window: null }, signal())).toEqual({ ok: false, reason: "not_found", retryAfterMs: null });
    expect(s.seen.length).toBe(2);
    for (const [status, retryAfter, reason, wait] of [[429, "60", "throttled", 60_000], [503, "5", "throttled", 5_000], [503, undefined, "unavailable", null], [500, undefined, "unavailable", null], [404, undefined, "not_found", null]] as const) {
      s.answerNext(status, retryAfter);
      expect(await reader.readChanges(c, cal, null, { limit: 250, cursor: null, window: null }, signal())).toEqual({ ok: false, reason, retryAfterMs: wait });
    }
  });

  it("hands out nothing of a page whose objects could not be fetched", async () => {
    const { s, c, cal } = await studio();
    const failing: HttpPort = { request: async (url, req) => ((req.body ?? "").includes("calendar-multiget") ? s.answerNext(502) : undefined, http.request(url, req)) };
    expect(await makeReader({ http: failing, clock: CLOCK, zones: ZONES }).readChanges(c, cal, null, { limit: 2, cursor: null, window: null }, signal())).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
  });

  it("does not read an answer that declares types of its own, and says so by word", async () => {
    const { s, c, cal } = await studio();
    s.answerNext(207, undefined, `<?xml version="1.0"?><!DOCTYPE multistatus [<!ENTITY a "aaaaaaaaaa">]><multistatus xmlns="DAV:"><sync-token>&a;</sync-token></multistatus>`);
    expect(await reader.readChanges(c, cal, null, { limit: 250, cursor: null, window: null }, signal())).toEqual({ ok: false, reason: "unreadable", retryAfterMs: null });
  });
});
