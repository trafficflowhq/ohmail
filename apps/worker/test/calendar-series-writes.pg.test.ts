/**
 * A SERIES WRITTEN, through the worker's own turn and the real CalDAV writer, at the bench's stand-in
 * of a CalDAV server on this machine: what the server received is read whole (each request's method,
 * its precondition, and the object's text outside what the act names, byte for byte). Every act is
 * recorded as the door records it (the store's own parser and payload), so a row the door would
 * refuse today can be planted, and the drain is seen refusing it too. Nothing leaves this machine.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { fold, intlZones, vtimezoneFrom, writeComponent } from "@ohmail/cal-core";
import {
  BENCH_CALDAV_PLACE, PROVEN_REPEATS, makeCalendarProviders, proofPlaceOf, Secret, type CalendarProvider, type CalendarWriter, type ProvenRepeats,
} from "@ohmail/cal-providers";
import type { HostResolver } from "@trafficflow/core/net";
import { calCalendars, calConnections, calEvents, calWrites, changeLog } from "@trafficflow/db";
import { CONTINUED_FIELDS, type CalendarWritePayload } from "@trafficflow/db/calendar";
import { dbFor } from "@trafficflow/services";
import { CALENDAR_BUILDERS } from "@trafficflow/services/calendar";
import { calendarSyncPass } from "@ohmail/organizer/calendar-sync-pass";
import { calendarWriteDrain } from "@ohmail/organizer/calendar/write-drain";
import { startCalDavStandIn, type Seen, type StandIn, type StandInCalendar } from "../../../packages/cal-providers/test/caldav-stand-in.js";
import { AVAILABLE, capturedLog, depsFor, openWorld, providersOf, recordWrite, seedConnection, type World } from "../../../packages/organizer/test/_calendar-world.js";

const never = new AbortController().signal;
const ZONES = intlZones();
const NOBODY: HostResolver = { resolve: async () => [] };
const ZURICH = "Europe/Zurich";

/** The zone's definition as a calendar text writes it, over the stand-in's months: every member below carries it, so no write adds one. */
const ZONE_TEXT = (() => {
  const made = vtimezoneFrom(ZURICH, ZONES, { startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2028, 0, 1) });
  const text = made === null ? null : writeComponent(made);
  if (text === null || !text.ok) throw new Error("the zone's definition did not write");
  return text.text.trimEnd().split("\r\n");
})();

/** A member's text as another program wrote it: a series of `rule` from Monday 23 November 2026 at 09:00 in Zurich, and its changed and excluded days. */
function seriesText(o: {
  readonly uid: string; readonly rule: string; readonly summary: string;
  readonly days?: readonly { readonly was: string; readonly start: string; readonly end: string; readonly summary: string }[];
  readonly excluded?: readonly string[];
  /** More lines of the series' own component (its organizer and invitees). */
  readonly more?: readonly string[];
}): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", ...ZONE_TEXT,
    "BEGIN:VEVENT", `UID:${o.uid}`, "DTSTAMP:20261113T120000Z", `DTSTART;TZID=${ZURICH}:20261123T090000`, `DTEND;TZID=${ZURICH}:20261123T100000`,
    `RRULE:${o.rule}`, ...(o.excluded ?? []).map((d) => `EXDATE;TZID=${ZURICH}:${d}`), `SUMMARY:${o.summary}`, "SEQUENCE:0", "X-ELSEWHERE-COLOUR:ochre",
    ...(o.more ?? []), "END:VEVENT",
    ...(o.days ?? []).flatMap((d) => [
      "BEGIN:VEVENT", `UID:${o.uid}`, "DTSTAMP:20261113T120000Z", `RECURRENCE-ID;TZID=${ZURICH}:${d.was}`,
      `DTSTART;TZID=${ZURICH}:${d.start}`, `DTEND;TZID=${ZURICH}:${d.end}`, `SUMMARY:${d.summary}`, "SEQUENCE:0", "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].map((line) => `${fold(line)}\r\n`).join("");
}

/** A text's top-level parts byte for byte: its own lines, and each component it holds, by name and in order. */
function partsOf(text: string): { readonly own: string[]; readonly components: { readonly name: string; readonly text: string }[] } {
  const own: string[] = [];
  const components: { name: string; text: string }[] = [];
  let open: { name: string; lines: string[] } | null = null;
  let depth = 0;
  for (const line of text.split("\r\n")) {
    if (line === "" || line === "BEGIN:VCALENDAR" || (line === "END:VCALENDAR" && depth === 0)) continue;
    if (line.startsWith("BEGIN:")) {
      depth += 1;
      if (depth === 1) open = { name: line.slice(6), lines: [] };
    }
    if (open !== null) open.lines.push(line);
    else own.push(line);
    if (line.startsWith("END:")) {
      depth -= 1;
      if (depth === 0 && open !== null) {
        components.push({ name: open.name, text: open.lines.join("\r\n") });
        open = null;
      }
    }
  }
  return { own, components };
}

/** Every component of a text but the series' own (the VEVENT without a RECURRENCE-ID), and the calendar's own lines: what a whole series' act leaves as it was. */
const besideTheSeries = (text: string) => {
  const p = partsOf(text);
  return { own: p.own, components: p.components.filter((c) => !(c.name === "VEVENT" && !/\r\nRECURRENCE-ID[;:]/.test(c.text))) };
};

describe.skipIf(!AVAILABLE)("a series written through the worker's turn, at the CalDAV stand-in", () => {
  let w: World;
  const servers: StandIn[] = [];
  beforeAll(async () => { w = await openWorld(); }, 120_000);
  afterAll(async () => {
    for (const s of servers) await s.close();
    await w?.close();
  });

  /**
   * A CalDAV account read from its own stand-in, the drain composed as the worker composes it, the
   * real writer (or one wrapped by the test) behind it. `turn()` runs one whole turn; `read()` one
   * turn without the drain (a reading alone).
   */
  /**
   * `proven`: the repeats the drain takes as proven, by place. By default this stand-in is taken as
   * the server the bench's proof was run at (its row is the bench's); `PROVEN_REPEATS` as shipped
   * names no row for it, a server the proof was not run at.
   */
  async function bench(
    members: Record<string, string>, wrap: (real: CalendarWriter) => CalendarWriter = (real) => real,
    o: {
      readonly autoSchedule?: boolean;
      readonly mailbox?: string;
      readonly proven?: ProvenRepeats;
      readonly calendar?: Partial<Omit<StandInCalendar, "slug">>;
      readonly clock?: { now(): number };
    } = {},
  ) {
    const dav = await startCalDavStandIn({ autoSchedule: o.autoSchedule ?? false });
    servers.push(dav);
    const calendar = dav.addCalendar("studio", { name: "Studio", ...o.calendar });
    for (const [name, text] of Object.entries(members)) dav.put("studio", name, text, `"${name}-1"`);
    const serverUrl = `http://127.0.0.1:${dav.port}${dav.paths.start}`;
    const t = await seedConnection(w, {
      provider: "caldav", credential: { kind: "basic", user: dav.options.user, password: new Secret(dav.options.password) },
      serverUrl, ...(o.mailbox === undefined ? {} : { mailboxAddress: o.mailbox }),
    });
    const real = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: NOBODY, policy: { kind: "own-network" }, enabled: new Set(["caldav"]), microsoft: null, writes: true,
    }).get("caldav")!;
    const provider: CalendarProvider = { ...real, writer: wrap(real.writer!) };
    const proven = o.proven ?? { [proofPlaceOf("caldav", serverUrl)!]: PROVEN_REPEATS[BENCH_CALDAV_PLACE]! };
    const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log, proven });
    const withDrain = depsFor(w, providersOf({ caldav: provider }), {
      drainWrites: drain, ...(o.clock && { clock: o.clock }),
    });
    const readingOnly = depsFor(w, providersOf({ caldav: provider }));
    const due = async () => {
      await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, t.accountId));
      await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
      await w.db.update(calWrites).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.state, "pending")));
    };
    const turn = async () => { await due(); return calendarSyncPass(withDrain, t.due, never); };
    const read = async () => { await due(); return calendarSyncPass(readingOnly, t.due, never); };
    expect((await calendarSyncPass(readingOnly, t.due, never)).kind).toBe("synced");
    /** The stored rows of a member: the series' own first, then its changed days. */
    const rows = async (name: string) => w.db.select({
      id: calEvents.id, updatedAt: calEvents.updatedAt, versionTag: calEvents.versionTag, recurrenceId: calEvents.recurrenceId, title: calEvents.title,
    }).from(calEvents).where(and(eq(calEvents.accountId, t.accountId), eq(calEvents.providerId, `http://127.0.0.1:${dav.port}${dav.paths.member("studio", name)}`)))
      .orderBy(asc(calEvents.recurrenceId));
    const writes = async () => (await w.db.select({ key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal })
      .from(calWrites).where(eq(calWrites.accountId, t.accountId)).orderBy(asc(calWrites.createdAt))).map((r) => [r.key, r.state, r.refusal]);
    /** What the server was asked to write, from a point on. */
    const written = (from: number): Seen[] => dav.seen.slice(from).filter((s) => ["PUT", "DELETE", "PATCH", "POST", "MOVE", "COPY"].includes(s.method));
    const press = (key: string, act: unknown, more: { readonly after?: string; readonly part?: CalendarWritePayload["part"] } = {}) =>
      recordWrite(w, { accountId: t.accountId, key, act, ...more });
    /**
     * A press on a day and the days after it, as the door records it: the series' end (`key`), then the new series (`key:2`, after
     * it), which names the series it comes from, the day, and the fields the person named.
     */
    const split = async (key: string, series: { id: string; updatedAt: Date }, at: string, change: Record<string, unknown>, fields: Record<string, unknown>, audience?: { organizer: string; guests: string[] }) => {
      const newEventId = randomUUID();
      const [cal] = await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, t.accountId));
      const first = await press(key, { kind: "calendar_event_update", eventId: series.id, base: series.updatedAt.toISOString(), scope: { kind: "following", at, newEventId }, change, ...(audience && { audience }) }, { part: { of: key, n: 1 } });
      const named = CONTINUED_FIELDS.filter((f) => change[f] !== undefined);
      const second = await press(`${key}:2`, { kind: "calendar_event_create", eventId: newEventId, calendarId: cal!.id, event: fields }, {
        after: first.id, part: { of: key, n: 2, from: { eventId: series.id, at, named, ...(audience && { confirmed: true }) } },
      });
      return { first, second, newEventId };
    };
    return { dav, calendar, t, turn, read, rows, writes, written, press, split };
  }

  const on = (row: { id: string; updatedAt: Date }) => ({ eventId: row.id, base: row.updatedAt.toISOString() });
  const zoned = (value: string) => ({ kind: "zoned", value, zone: ZURICH });
  const WEEKLY = seriesText({
    uid: "weekly@studio.example.test", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Weekly kiln",
    days: [{ was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "Weekly kiln, moved" }],
  });
  const PLAIN = seriesText({ uid: "plain@studio.example.test", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Glaze class" });

  it("refreshes a shared calendar's access before sending queued time changes", async () => {
    const organizer = ["sharer", "example.test"].join("@");
    const source = PLAIN.replace(/RRULE:[^\r]+\r\n/, `ORGANIZER:mailto:${organizer}\r\n`);
    let now = Date.now();
    const b = await bench({ "shared.ics": source }, undefined, {
      calendar: { owner: "/dav/principals/sharer/", homePrivileges: ["read"], privileges: ["read"] },
      clock: { now: () => now },
    });
    const stored = async () => (await w.db.select({ id: calCalendars.id, access: calCalendars.access })
      .from(calCalendars).where(eq(calCalendars.accountId, b.t.accountId)))[0]!;
    const original = await stored();
    expect(original.access).toBe("reader");
    expect((await b.turn()).kind).toBe("synced");

    now += 3_600_001;
    b.calendar.privileges = ["read", "write-content", "bind", "unbind"];
    expect((await b.turn()).kind).toBe("synced");
    expect(await stored()).toEqual({ id: original.id, access: "writer" });
    const [event] = await b.rows("shared.ics");
    const schedule = (hour: string) => ({ start: zoned(`20261123T${hour}0000`), end: zoned(`20261123T${Number(hour) + 1}0000`) });
    const move = (row: NonNullable<typeof event>, hour: string) => ({
      kind: "calendar_event_update", ...on(row), scope: { kind: "record" }, change: schedule(hour),
    });
    const from = b.dav.seen.length;
    await b.press("move", move(event!, "11"));
    expect((await b.turn()).kind).toBe("synced");
    expect(await b.writes()).toEqual([["move", "applied", null]]);
    expect(b.written(from).map((request) => request.method)).toEqual(["PUT"]);
    expect(b.written(from)[0]!.body).toContain(`DTSTART;TZID=${ZURICH}:20261123T110000`);

    const [current] = await b.rows("shared.ics");
    await b.press("stopped-move", move(current!, "13"));
    const after = b.dav.seen.length;
    now += 3_600_001;
    b.calendar.privileges = ["read"];
    expect((await b.turn()).kind).toBe("synced");
    expect(await stored()).toEqual({ id: original.id, access: "reader" });
    expect(b.written(after)).toHaveLength(0);
    expect(await b.writes()).toContainEqual(["stopped-move", "refused", "read_only"]);
  });

  it("keeps listing and sends an owned calendar edit when a share's privilege probe fails", async () => {
    let now = Date.now();
    const b = await bench({ "own.ics": PLAIN }, undefined, {
      clock: { now: () => now },
    });
    b.calendar.owner = b.dav.paths.principal;
    b.dav.addCalendar("share", { owner: "/dav/principals/another/", privileges: ["read"], accessProbeStatus: 500 });
    const [event] = await b.rows("own.ics");
    await b.press("edit", { kind: "calendar_event_update", ...on(event!), scope: { kind: "record" }, change: { title: "New title" } });
    const from = b.dav.seen.length;
    now += 3_600_001;
    expect((await b.turn()).kind).toBe("synced");
    expect(await b.writes()).toEqual([["edit", "applied", null]]);
    expect(b.written(from).map((request) => request.method)).toEqual(["PUT"]);
    const calendars = await w.db.select({ access: calCalendars.access }).from(calCalendars)
      .where(eq(calCalendars.accountId, b.t.accountId));
    expect(calendars.map(({ access }) => access)).toEqual(expect.arrayContaining(["owner", "reader"]));
  });

  it("rejects an owned calendar invitation with an unknown attendee before sending it", async () => {
    const organizer = ["sharer", "example.test"].join("@");
    const unknown = ["unrecognized", "example.test"].join("@");
    const source = PLAIN.replace(/RRULE:[^\r]+\r\n/, `ORGANIZER:mailto:${organizer}\r\nATTENDEE:mailto:${unknown}\r\n`);
    const b = await bench({ "invitation.ics": source }, undefined, { autoSchedule: true });
    b.calendar.owner = b.dav.paths.principal;
    const [event] = await b.rows("invitation.ics");
    await b.press("edit", {
      kind: "calendar_event_update", ...on(event!), scope: { kind: "record" }, change: { title: "New title" },
      audience: { organizer, guests: [unknown] },
    });
    const from = b.dav.seen.length;
    await b.turn();
    expect(await b.writes()).toEqual([["edit", "refused", "read_only"]]);
    expect(b.written(from)).toHaveLength(0);
  });

  it("sends a queued edit to a meeting the account organized and attends", async () => {
    const organizer = ["organizer", "example.test"].join("@");
    const guest = ["guest", "example.test"].join("@");
    const source = PLAIN.replace(/RRULE:[^\r]+\r\n/, [
      `ORGANIZER:mailto:${organizer}`,
      `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${organizer}`,
      `ATTENDEE:mailto:${guest}`, "",
    ].join("\r\n"));
    const b = await bench({ "meeting.ics": source }, undefined, { autoSchedule: true, mailbox: organizer });
    const [event] = await b.rows("meeting.ics");
    const [stored] = await w.db.select({ myAnswer: calEvents.myAnswer }).from(calEvents)
      .where(eq(calEvents.id, event!.id));
    expect(stored?.myAnswer).toBe("accepted");
    await b.press("edit", {
      kind: "calendar_event_update", ...on(event!), scope: { kind: "record" }, change: { title: "New title" },
      audience: { organizer, guests: [guest] },
    });
    const from = b.dav.seen.length;
    expect((await b.turn()).kind).toBe("synced");
    expect(await b.writes()).toEqual([["edit", "applied", null]]);
    const requests = b.written(from);
    expect(requests.map((request) => request.method)).toEqual(["PUT"]);
    expect(requests[0]!.body).toContain("SUMMARY:New title");
  });

  it("serves a cached series again when its shared calendar gains or loses write access", async () => {
    let now = Date.now();
    const b = await bench({ "shared.ics": PLAIN }, undefined, {
      calendar: { owner: "/dav/principals/another/", homePrivileges: ["read"], privileges: ["read"] },
      clock: { now: () => now },
    });
    const { accountId } = b.t;
    const db = dbFor(w.db, accountId);
    const [connection] = await w.db.select({ serverUrl: calConnections.serverUrl }).from(calConnections)
      .where(eq(calConnections.accountId, accountId));
    const [series] = await b.rows("shared.ics");
    const newest = async () => (await w.db.select({ seq: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId)).orderBy(sql`${changeLog.seq} desc`).limit(1))[0]!.seq;
    const built = async (ids: string[]) => {
      // Scope proofs are keyed by provider origin. Use the proven CalDAV fixture's origin for feed materialization.
      const saved = (serverUrl: string | null) => w.db.update(calConnections).set({ serverUrl })
        .where(eq(calConnections.accountId, accountId));
      await saved(BENCH_CALDAV_PLACE.replace("caldav:", "http://"));
      try {
        return (await CALENDAR_BUILDERS.calendar_event(db, accountId, ids)).get(series!.id);
      } finally {
        await saved(connection!.serverUrl);
      }
    };
    const cached = await built([series!.id]);
    expect(cached).not.toHaveProperty("deleteMembers");
    expect(cached).not.toHaveProperty("deleteScopes");
    for (const writable of [true, false]) {
      const since = await newest();
      now += 3_600_001;
      b.calendar.privileges = writable ? ["read", "write-content"] : ["read"];
      expect((await b.turn()).kind).toBe("synced");
      const changes = await w.db.select({ id: changeLog.entityId, op: changeLog.op }).from(changeLog)
        .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "calendar_event"), sql`${changeLog.seq} > ${since}`));
      expect(changes).toContainEqual({ id: series!.id, op: "update" });
      const record = await built(changes.map(({ id }) => id));
      expect(record).toBeDefined();
      if (writable) {
        expect(record?.deleteMembers).toMatchObject([{ at: null }]);
        expect(record?.deleteScopes).toContain("record");
      } else {
        expect(record).not.toHaveProperty("deleteMembers");
        expect(record).not.toHaveProperty("deleteScopes");
      }
    }
  });

  it("tries an edit on a share without access data and records the provider's refusal", async () => {
    const b = await bench({ "shared.ics": PLAIN }, undefined, {
      calendar: { owner: "/dav/principals/another/", privileges: null },
    });
    const [event] = await b.rows("shared.ics");
    await b.press("edit", { kind: "calendar_event_update", ...on(event!), scope: { kind: "record" }, change: { title: "New title" } });
    b.dav.refuseNextWriteOf("shared.ics", 403);
    const from = b.dav.seen.length;
    await b.turn();
    expect(b.written(from).map((request) => request.method)).toEqual(["PUT"]);
    expect(await b.writes()).toEqual([["edit", "refused", "read_only"]]);
    expect((await b.rows("shared.ics"))[0]?.title).toBe(event!.title);
  });

  it("remembers a successful listing when a queued edit has to wait", async () => {
    let wait = true;
    const b = await bench({ "own.ics": PLAIN }, (writer) => ({
      ...writer,
      async change(...args) {
        if (wait) return { ok: false, reason: "throttled", retryAfterMs: 30_000 };
        return writer.change(...args);
      },
    }));
    const [event] = await b.rows("own.ics");
    await b.press("edit", { kind: "calendar_event_update", ...on(event!), scope: { kind: "record" }, change: { title: "New title" } });
    expect(await b.turn()).toMatchObject({ kind: "backed_off", word: "throttled" });
    const from = b.dav.seen.length;
    wait = false;
    expect((await b.turn()).kind).toBe("synced");
    expect(b.dav.seen.slice(from).some((request) =>
      request.method === "PROPFIND" && request.path === b.dav.paths.home,
    )).toBe(false);
  });

  describe("the whole series (scope record on the series' own row)", () => {
    it("changes the series' own record and nothing beside it, under the version the write was recorded on, once", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      const from = b.dav.seen.length;
      await b.press("retitle", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { title: "Weekly kiln and glazes" } });
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["retitle", "applied", null]]);
      // The reach: one PUT, under the tag the write was recorded on; the changed day, the zone and the calendar's own lines as they were.
      const sent = b.written(from);
      expect(sent.map((s) => [s.method, s.headers["if-match"], s.headers["if-none-match"]])).toEqual([["PUT", '"weekly.ics-1"', undefined]]);
      expect(besideTheSeries(sent[0]!.body)).toEqual(besideTheSeries(WEEKLY));
      expect(sent[0]!.body).toContain("SUMMARY:Weekly kiln and glazes\r\n");
      expect(sent[0]!.body).toContain("X-ELSEWHERE-COLOUR:ochre\r\n");
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Weekly kiln and glazes", "Weekly kiln, moved"]);
    });

    it("sends a change made on a copy the provider has moved past under its own version, and overwrites nothing", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("mine", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { title: "Mine" } });
      // Someone else changes the series at the server, and a reading stores their copy before the write is sent.
      const theirs = WEEKLY.replace("SUMMARY:Weekly kiln\r\n", "SUMMARY:Theirs\r\n");
      b.dav.put("studio", "weekly.ics", theirs, '"weekly.ics-2"');
      expect((await b.read()).kind).toBe("synced");
      expect((await b.rows("weekly.ics"))[0]!.versionTag).toBe('"weekly.ics-2"');
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"']]);
      expect(await b.writes()).toEqual([["mine", "refused", "version_stale"]]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Theirs", "Weekly kiln, moved"]);
    });

    it("writes a change once after its answer was lost: sent again under its own version, the server's 412 and the compare close it", async () => {
      let cut = true;
      const b = await bench({ "weekly.ics": WEEKLY }, (real) => ({
        ...real,
        async change(...args: Parameters<CalendarWriter["change"]>) {
          const done = await real.change(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [series] = await b.rows("weekly.ics");
      await b.press("once", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { title: "Weekly kiln, once" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "pending", null]]);
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "applied", null]]);
      // Two PUTs under the one recorded tag: the first took, the second was refused 412 and nothing was written twice.
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"'], ["PUT", '"weekly.ics-1"']]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Weekly kiln, once", "Weekly kiln, moved"]);
    });

    it("removes the whole series, its changed days with it, by one DELETE under its version; after a lost answer, nothing is sent again", async () => {
      let cut = true;
      const b = await bench({ "weekly.ics": WEEKLY }, (real) => ({
        ...real,
        async remove(...args: Parameters<CalendarWriter["remove"]>) {
          const done = await real.remove(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [series] = await b.rows("weekly.ics");
      await b.press("drop", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "record" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      // The reading of that turn found the member gone and took its rows: the removal is done without a second request.
      expect(await b.rows("weekly.ics")).toEqual([]);
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["drop", "applied", null]]);
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["DELETE", '"weekly.ics-1"']]);
    });

    it("refuses a removal made on a copy the provider has moved past, and the member stays as the other wrote it", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("drop", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "record" } });
      b.dav.put("studio", "weekly.ics", WEEKLY.replace("SUMMARY:Weekly kiln\r\n", "SUMMARY:Theirs\r\n"), '"weekly.ics-2"');
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["DELETE", '"weekly.ics-1"']]);
      expect(await b.writes()).toEqual([["drop", "refused", "version_stale"]]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Theirs", "Weekly kiln, moved"]);
    });

    it("moves a series without changed days to a new time and a new repeat, each a day its rule names; the server gets the series alone", async () => {
      const b = await bench({ "plain.ics": PLAIN });
      const [series] = await b.rows("plain.ics");
      await b.press("later", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "record" },
        change: { start: zoned("20261124T110000"), end: zoned("20261124T120000"), repeat: "FREQ=WEEKLY;BYDAY=TU;COUNT=10" },
      });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["later", "applied", null]]);
      const [put] = b.written(from);
      expect([put!.method, put!.headers["if-match"]]).toEqual(["PUT", '"plain.ics-1"']);
      expect(besideTheSeries(put!.body)).toEqual(besideTheSeries(PLAIN));
      expect(put!.body).toContain(`DTSTART;TZID=${ZURICH}:20261124T110000\r\n`);
      expect(put!.body).toContain("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TU\r\n");
    });

    it("refuses what the door refuses, where a row was recorded before its check: a series with changed days keeps its start and its repeat; the server is asked nothing", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series, day] = await b.rows("weekly.ics");
      await b.press("new-start", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { start: zoned("20261123T110000"), end: zoned("20261123T120000") } });
      await b.press("new-repeat", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO;COUNT=4" } });
      await b.press("the-day-as-a-record", { kind: "calendar_event_update", ...on(day!), scope: { kind: "record" }, change: { title: "Only that day" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([
        ["new-start", "refused", "repeat_unsupported"], ["new-repeat", "refused", "repeat_unsupported"], ["the-day-as-a-record", "refused", "repeat_unsupported"],
      ]);
    });

    it("refuses with its word an act on a series in no proven shape, or moved to a day its rule does not name", async () => {
      const b = await bench({
        "hourly.ics": seriesText({ uid: "hourly@studio.example.test", rule: "FREQ=HOURLY;COUNT=3", summary: "Kiln watch" }),
        "plain.ics": PLAIN,
      });
      const [hourly] = await b.rows("hourly.ics");
      const [plain] = await b.rows("plain.ics");
      await b.press("hourly", { kind: "calendar_event_update", ...on(hourly!), scope: { kind: "record" }, change: { title: "Kiln watch, longer" } });
      await b.press("off-step", { kind: "calendar_event_update", ...on(plain!), scope: { kind: "record" }, change: { start: zoned("20261124T090000"), end: zoned("20261124T100000") } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([["hourly", "refused", "repeat_unsupported"], ["off-step", "refused", "repeat_unsupported"]]);
    });

    it("writes no series at a CalDAV server its proof was not run at: the shipped row is the bench's own server's, and this is another", async () => {
      const b = await bench({ "plain.ics": PLAIN }, undefined, { proven: PROVEN_REPEATS });
      const [series] = await b.rows("plain.ics");
      const [cal] = await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, b.t.accountId));
      await b.press("retitle", { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { title: "Glaze class, renamed" } });
      await b.press("not-that-day", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "occurrence", at: String(Date.UTC(2026, 11, 7, 8)) } });
      await b.press("drop", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "record" } });
      await b.press("new-series", {
        kind: "calendar_event_create", eventId: randomUUID(), calendarId: cal!.id,
        event: {
          title: "Throwing class", start: zoned("20261125T180000"), end: zoned("20261125T200000"), notes: null, place: null, callLink: null,
          busy: true, private: false, repeat: "FREQ=WEEKLY;BYDAY=WE;COUNT=4", invitees: [], alarms: [],
        },
      });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.path])).toEqual([]);
      expect(await b.writes()).toEqual([
        ["retitle", "refused", "repeat_unsupported"], ["not-that-day", "refused", "repeat_unsupported"],
        ["drop", "refused", "repeat_unsupported"], ["new-series", "refused", "repeat_unsupported"],
      ]);
    });
  });

  describe("a new series, and a repeat put on one event", () => {
    it("makes a new series once under its key, in its proven shape, a member of its own", async () => {
      let cut = true;
      const b = await bench({}, (real) => ({
        ...real,
        async create(...args: Parameters<CalendarWriter["create"]>) {
          const done = await real.create(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [cal] = await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, b.t.accountId));
      await b.press("new-series", {
        kind: "calendar_event_create", eventId: randomUUID(), calendarId: cal!.id,
        event: {
          title: "Throwing class", start: zoned("20261125T180000"), end: zoned("20261125T200000"), notes: null, place: null, callLink: null,
          busy: true, private: false, repeat: "FREQ=WEEKLY;BYDAY=WE;UNTIL=20270127T235959Z", invitees: [], alarms: [],
        },
      });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["new-series", "applied", null]]);
      const sent = b.written(from);
      expect(sent.map((s) => [s.method, s.headers["if-none-match"], s.headers["if-match"], s.path === sent[0]!.path])).toEqual([["PUT", "*", undefined, true], ["PUT", "*", undefined, true]]);
      expect(sent[0]!.body).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270127T235959Z;BYDAY=WE\r\n");
      expect((await w.db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.accountId, b.t.accountId))).length).toBe(1);
    });

    it("puts a repeat on one event under its version, as one more line of its own record", async () => {
      const single = PLAIN.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10\r\n", "").replace("UID:plain@", "UID:once@");
      const b = await bench({ "once.ics": single });
      const [one] = await b.rows("once.ics");
      await b.press("repeat-it", { kind: "calendar_event_update", ...on(one!), scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO;COUNT=6" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["repeat-it", "applied", null]]);
      const [put] = b.written(from);
      expect([put!.method, put!.headers["if-match"]]).toEqual(["PUT", '"once.ics-1"']);
      expect(besideTheSeries(put!.body)).toEqual(besideTheSeries(single));
      expect(put!.body).toContain("RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO\r\n");
      expect((await b.rows("once.ics")).map((r) => r.recurrenceId)).toEqual([""]);
    });
  });

  describe("one day (scope occurrence on the series' own row)", () => {
    /** Monday 7 December 2026 at 09:00 in Zurich, a day of the series nobody changed; Monday 30 November, the day another program moved. */
    const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
    const NOV_30 = String(Date.UTC(2026, 10, 30, 8));
    const theDay = (text: string, was: string) => partsOf(text).components.find((c) => c.name === "VEVENT" && c.text.includes(`\r\nRECURRENCE-ID;TZID=${ZURICH}:${was}\r\n`));
    const otherDays = (text: string, was: string) => partsOf(text).components.filter((c) => !(c.name === "VEVENT" && c.text.includes(`\r\nRECURRENCE-ID;TZID=${ZURICH}:${was}\r\n`)));

    it("changes one day in a component of its own, written after the series; the series and every other day go back byte for byte", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("one-day", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: DEC_7 },
        change: { title: "Weekly kiln, the glaze day", start: zoned("20261207T130000"), end: zoned("20261207T150000") },
      });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["one-day", "applied", null]]);
      const [put] = b.written(from);
      expect([b.written(from).length, put!.method, put!.headers["if-match"]]).toEqual([1, "PUT", '"weekly.ics-1"']);
      // Everything that was there is there as it was; one component more, for that day alone.
      expect(otherDays(put!.body, "20261207T090000")).toEqual(partsOf(WEEKLY).components);
      expect(partsOf(put!.body).own).toEqual(partsOf(WEEKLY).own);
      const day = theDay(put!.body, "20261207T090000")!.text;
      expect(day).toContain("SUMMARY:Weekly kiln\\, the glaze day\r\n");
      expect(day).toContain(`DTSTART;TZID=${ZURICH}:20261207T130000\r\n`);
      expect(day).not.toContain("RRULE");
      expect((await b.rows("weekly.ics")).map((r) => [r.recurrenceId, r.title])).toEqual([
        ["", "Weekly kiln"], [NOV_30, "Weekly kiln, moved"], [DEC_7, "Weekly kiln, the glaze day"],
      ]);
    });

    it("moves one day to another weekday than its series' own: the series' rule is not asked of that day", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("to-tuesday", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: DEC_7 },
        change: { start: zoned("20261208T090000"), end: zoned("20261208T100000") },
      });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["to-tuesday", "applied", null]]);
      const [put] = b.written(from);
      expect(theDay(put!.body, "20261207T090000")!.text).toContain(`DTSTART;TZID=${ZURICH}:20261208T090000\r\n`);
      expect(otherDays(put!.body, "20261207T090000")).toEqual(partsOf(WEEKLY).components);
    });

    it("changes a day another program changed in that day's own component, in place", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("that-day", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: NOV_30 }, change: { place: "Studio 2" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      const [put] = b.written(from);
      expect(otherDays(put!.body, "20261130T090000")).toEqual(otherDays(WEEKLY, "20261130T090000"));
      const day = theDay(put!.body, "20261130T090000")!.text;
      expect([day.includes("LOCATION:Studio 2\r\n"), day.includes("SUMMARY:Weekly kiln, moved\r\n"), day.includes("SEQUENCE:1\r\n")]).toEqual([true, true, true]);
      expect(partsOf(put!.body).components.length).toBe(partsOf(WEEKLY).components.length);
    });

    it("cancels one day by one more excluded day in the series' own component, and takes that day's own component out where it had one", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      const from = b.dav.seen.length;
      await b.press("not-dec-7", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "occurrence", at: DEC_7 } });
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["not-dec-7", "applied", null]]);
      const [updated] = await b.rows("weekly.ics");
      await b.press("not-nov-30", { kind: "calendar_event_delete", ...on(updated!), scope: { kind: "occurrence", at: NOV_30 } });
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["not-dec-7", "applied", null], ["not-nov-30", "applied", null]]);
      const sent = b.written(from);
      expect(sent.map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"'], ["PUT", '"studio-weekly.ics-2"']]);
      const masterOf = (text: string) => partsOf(text).components.find((c) => c.name === "VEVENT" && !c.text.includes("RECURRENCE-ID"))!.text.split("\r\n");
      // The first: the series' own lines as they were and one EXDATE line more; the changed day and the zone as they were.
      expect(masterOf(sent[0]!.body).filter((l) => !l.startsWith("EXDATE"))).toEqual(masterOf(WEEKLY));
      expect(masterOf(sent[0]!.body).filter((l) => l.startsWith("EXDATE"))).toEqual([`EXDATE;TZID=${ZURICH}:20261207T090000`]);
      expect(besideTheSeries(sent[0]!.body)).toEqual(besideTheSeries(WEEKLY));
      // The second: the changed day's own component out, its day excluded.
      expect(masterOf(sent[1]!.body).filter((l) => l.startsWith("EXDATE"))).toEqual([`EXDATE;TZID=${ZURICH}:20261207T090000`, `EXDATE;TZID=${ZURICH}:20261130T090000`]);
      expect(partsOf(sent[1]!.body).components.map((c) => c.name)).toEqual(["VTIMEZONE", "VEVENT"]);
      expect((await b.rows("weekly.ics")).map((r) => r.recurrenceId)).toEqual([""]);
    });

    it("sends a day's change made on a copy the provider has moved past under its own version, and overwrites nothing", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("mine", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: DEC_7 }, change: { title: "Mine" } });
      const theirs = WEEKLY.replace("SUMMARY:Weekly kiln\r\n", "SUMMARY:Theirs\r\n");
      b.dav.put("studio", "weekly.ics", theirs, '"weekly.ics-2"');
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"']]);
      expect(await b.writes()).toEqual([["mine", "refused", "version_stale"]]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Theirs", "Weekly kiln, moved"]);
    });

    it("writes a day's change once after its answer was lost: the server's 412 finds the day as the write wants it", async () => {
      let cut = true;
      const b = await bench({ "weekly.ics": WEEKLY }, (real) => ({
        ...real,
        async change(...args: Parameters<CalendarWriter["change"]>) {
          const done = await real.change(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [series] = await b.rows("weekly.ics");
      await b.press("once", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: DEC_7 }, change: { title: "Glaze day" } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "applied", null]]);
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"'], ["PUT", '"weekly.ics-1"']]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Weekly kiln", "Weekly kiln, moved", "Glaze day"]);
    });

    it("refuses a day that is none of the series', a day's change that carries a repeat, and a day of one event, each with its word; the server is asked nothing", async () => {
      const single = PLAIN.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10\r\n", "").replace("UID:plain@", "UID:once@");
      const b = await bench({ "weekly.ics": WEEKLY, "once.ics": single });
      const [series] = await b.rows("weekly.ics");
      const [one] = await b.rows("once.ics");
      await b.press("tuesday", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: String(Date.UTC(2026, 11, 8, 8)) }, change: { title: "x" } });
      await b.press("day-repeat", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: DEC_7 }, change: { repeat: "FREQ=DAILY" } });
      await b.press("one-event-day", { kind: "calendar_event_delete", ...on(one!), scope: { kind: "occurrence", at: String(Date.UTC(2026, 10, 23, 8)) } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([["tuesday", "refused", "event_gone"], ["day-repeat", "refused", "repeat_unsupported"], ["one-event-day", "refused", "repeat_unsupported"]]);
    });
  });

  describe("a day and the days after it (scope following: the series' end, then a series of their own)", () => {
    /** Monday 14 December 2026 at 09:00 in Zurich, a day after the changed one (30 November). */
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const NOV_30 = String(Date.UTC(2026, 10, 30, 8));
    const newTerm = (start = "20261214T090000", end = "20261214T100000", repeat = "FREQ=WEEKLY;BYDAY=MO") => ({
      title: "Weekly kiln, the new term", start: zoned(start), end: zoned(end), notes: null, place: null, callLink: null, busy: true, private: false,
      repeat, invitees: [], alarms: [],
    });
    const masterOf = (text: string) => partsOf(text).components.find((c) => c.name === "VEVENT" && !c.text.includes("RECURRENCE-ID"))!.text.split("\r\n");
    const unchangedLine = (l: string) => !/^(RRULE|SEQUENCE|DTSTAMP|LAST-MODIFIED)[;:]/.test(l);

    it("ends the series before the day, then makes the days after it a series of their own: two writes, in order, each once, nothing else of the old one moved", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      const { newEventId } = await b.split("term", series!, DEC_14, { title: "Weekly kiln, the new term" }, newTerm());
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["term", "applied", null], ["term:2", "applied", null]]);
      const [end, made] = b.written(from);
      expect([b.written(from).length, end!.method, end!.headers["if-match"], made!.method, made!.headers["if-none-match"]]).toEqual([2, "PUT", '"weekly.ics-1"', "PUT", "*"]);
      // The old series: its repeat ends the second before that day; the day changed before it, the zone and every other line stay.
      expect(masterOf(end!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO");
      expect(masterOf(end!.body).filter(unchangedLine)).toEqual(masterOf(WEEKLY).filter(unchangedLine));
      expect(besideTheSeries(end!.body)).toEqual(besideTheSeries(WEEKLY));
      // The new series: a member of its own, from that day, its repeat the old one's.
      expect(made!.path).not.toBe(end!.path);
      expect([made!.body.includes(`DTSTART;TZID=${ZURICH}:20261214T090000\r\n`), made!.body.includes("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"), made!.body.includes("SUMMARY:Weekly kiln\\, the new term\r\n")])
        .toEqual([true, true, true]);
      const [mine] = await w.db.select({ providerId: calEvents.providerId, title: calEvents.title, repeatRule: calEvents.repeatRule }).from(calEvents).where(eq(calEvents.id, newEventId));
      expect([mine!.providerId.endsWith(made!.path.split("/").pop()!), mine!.title, mine!.repeatRule]).toEqual([true, "Weekly kiln, the new term", "FREQ=WEEKLY;BYDAY=MO"]);
    });

    it("takes the series' changed days from that day on with the days they named; they are not carried to the new series", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.split("from-nov-30", series!, NOV_30, { place: "Studio 3" }, { ...newTerm("20261130T090000", "20261130T100000"), title: "Weekly kiln", place: "Studio 3" });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      const [end, made] = b.written(from);
      expect(partsOf(end!.body).components.map((c) => c.name)).toEqual(["VTIMEZONE", "VEVENT"]);
      expect(masterOf(end!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261130T075959Z;BYDAY=MO");
      expect(made!.body).not.toContain("RECURRENCE-ID");
      expect((await b.rows("weekly.ics")).map((r) => r.recurrenceId)).toEqual([""]);
    });

    it("writes the pair once after the first part's answer was lost: the series is found ended, nothing of it is sent again, and the new series is made once", async () => {
      let cut = true;
      const b = await bench({ "weekly.ics": WEEKLY }, (real) => ({
        ...real,
        async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
          const done = await real.endSeries(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [series] = await b.rows("weekly.ics");
      await b.split("once", series!, DEC_14, { title: "Weekly kiln, the new term" }, newTerm());
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "pending", null], ["once:2", "pending", null]]);
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "applied", null], ["once:2", "applied", null]]);
      // The reading of the first turn took in the ended series: the second attempt finds it so and sends nothing; the new series once.
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"] ?? s.headers["if-none-match"]])).toEqual([["PUT", '"weekly.ics-1"'], ["PUT", "*"]]);
    });

    it("leaves a half-done press as the new series' second part, refused with its word: retry makes it, and nothing of the old series is written again", async () => {
      let refuse = true;
      const b = await bench({ "weekly.ics": WEEKLY }, (real) => ({
        ...real,
        async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
          return refuse ? { ok: false, reason: "read_only", retryAfterMs: null } : real.continueSeries(...args);
        },
      }));
      const [series] = await b.rows("weekly.ics");
      const { newEventId } = await b.split("half", series!, DEC_14, { title: "Weekly kiln, the new term" }, newTerm());
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["half", "applied", null], ["half:2", "refused", "read_only"]]);
      expect(b.written(from).map((s) => s.method)).toEqual(["PUT"]);
      // The new series' row stands as the person wanted it, its second part's mark on it.
      const marks = await w.db.select({ eventId: calWrites.eventId, payload: calWrites.payload, state: calWrites.state }).from(calWrites)
        .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.state, "refused")));
      expect(marks.map((m) => [m.eventId, (m.payload as { part: { n: number } }).part.n])).toEqual([[newEventId, 2]]);
      // Retry, as its route puts it back: the second part alone is sent.
      refuse = false;
      await w.db.update(calWrites).set({ state: "pending", refusal: null, attempts: 0, nextAttemptAt: null }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "half:2")));
      const again = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["half", "applied", null], ["half:2", "applied", null]]);
      expect(b.written(again).map((s) => [s.method, s.headers["if-none-match"]])).toEqual([["PUT", "*"]]);
    });

    it("refuses the first part where the second could not be sent after it, and nothing is written: an unproven repeat for the days after", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.split("hourly", series!, DEC_14, { repeat: "FREQ=HOURLY;COUNT=3" }, newTerm(undefined, undefined, "FREQ=HOURLY;COUNT=3"));
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([["hourly", "refused", "repeat_unsupported"], ["hourly:2", "refused", "earlier_refused"]]);
    });

    it("refuses a press made on a copy the provider has moved past: the first part under its own version, the second with it, and nothing is made", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.split("stale", series!, DEC_14, { title: "Weekly kiln, the new term" }, newTerm());
      b.dav.put("studio", "weekly.ics", WEEKLY.replace("SUMMARY:Weekly kiln\r\n", "SUMMARY:Theirs\r\n"), '"weekly.ics-2"');
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"']]);
      expect(await b.writes()).toEqual([["stale", "refused", "version_stale"], ["stale:2", "refused", "earlier_refused"]]);
      expect((await b.rows("weekly.ics")).map((r) => r.title)).toEqual(["Theirs", "Weekly kiln, moved"]);
    });

    it("sends no part of a press alone: a first part without its second, and a second part whose first was refused, are refused, and nothing is written", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      // A first part whose second is not there (a row recorded otherwise): ending the series would leave the days after it nowhere.
      await b.press("alone", { kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: DEC_14, newEventId: randomUUID() }, change: { title: "x" } }, { part: { of: "alone", n: 1 } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([["alone", "refused", "content_refused"]]);
      // A second part whose first was refused, put back alone: it waits for nothing that will come, and is refused with it.
      const { second } = await b.split("pair", series!, DEC_14, { title: "Weekly kiln, the new term" }, newTerm());
      await w.db.update(calWrites).set({ state: "refused", refusal: "unavailable" }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "pair")));
      const later = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(later)).toEqual([]);
      expect((await b.writes()).filter(([key]) => String(key).startsWith("pair"))).toEqual([["pair", "refused", "unavailable"], ["pair:2", "refused", "earlier_refused"]]);
      expect(second.id).toEqual(expect.any(String));
    });

    it("removes a day and the days after it as the series' end alone: one write", async () => {
      const b = await bench({ "weekly.ics": WEEKLY });
      const [series] = await b.rows("weekly.ics");
      await b.press("drop-after", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "following", at: DEC_14 } });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["drop-after", "applied", null]]);
      const sent = b.written(from);
      expect(sent.map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"weekly.ics-1"']]);
      expect(masterOf(sent[0]!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO");
      expect(besideTheSeries(sent[0]!.body)).toEqual(besideTheSeries(WEEKLY));
    });
  });

  describe("an answer to a repeating invitation (the whole series, and one day)", () => {
    const MILA = "mila@studio.example.test";
    const INVITATION = seriesText({
      uid: "glaze-group@elsewhere.example.test", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze group",
      more: ["ORGANIZER;CN=Anna:mailto:anna@example.test", `ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${MILA}`, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@example.test"],
      days: [{ was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "Glaze group, moved" }],
    });
    const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
    const lines = (component: string) => component.replace(/\r\n[ \t]/g, "").split("\r\n");
    const ownLine = (component: string) => lines(component).find((l) => l.startsWith("ATTENDEE") && l.endsWith(`mailto:${MILA}`));
    const seriesPart = (text: string) => partsOf(text).components.find((c) => c.name === "VEVENT" && !c.text.includes("RECURRENCE-ID"))!.text;
    const invited = (wrap?: (real: CalendarWriter) => CalendarWriter, autoSchedule = true) => bench({ "glaze.ics": INVITATION }, wrap, { autoSchedule, mailbox: MILA });

    it("answers the whole series on the account's own line of the series' component; its changed day and everything else stay as they were", async () => {
      const b = await invited();
      const [series] = await b.rows("glaze.ics");
      await b.press("yes", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "record" }, answer: "accepted" });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["yes", "applied", null]]);
      const sent = b.written(from);
      expect(sent.map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"glaze.ics-1"']]);
      expect(ownLine(seriesPart(sent[0]!.body))).toBe(`ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${MILA}`);
      const others = (text: string) => lines(seriesPart(text)).filter((l) => !l.startsWith("DTSTAMP") && l !== ownLine(seriesPart(text)));
      expect(others(sent[0]!.body)).toEqual(others(INVITATION));
      expect(besideTheSeries(sent[0]!.body)).toEqual(besideTheSeries(INVITATION));
    });

    it("answers one day in that day's own component, the series' own answer and its other days as they were", async () => {
      const b = await invited();
      const [series] = await b.rows("glaze.ics");
      await b.press("not-that-day", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "occurrence", at: DEC_7 }, answer: "declined" });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["not-that-day", "applied", null]]);
      const [put] = b.written(from);
      const day = partsOf(put!.body).components.find((c) => c.text.includes(`RECURRENCE-ID;TZID=${ZURICH}:20261207T090000`))!.text;
      expect(ownLine(day)).toBe(`ATTENDEE;CN=Mila;PARTSTAT=DECLINED;RSVP=TRUE:mailto:${MILA}`);
      expect(partsOf(put!.body).components.filter((c) => c.text !== day)).toEqual(partsOf(INVITATION).components);
    });

    it("writes an answer once after its answer was lost: the server's 412 finds the line saying it", async () => {
      let cut = true;
      const b = await invited((real) => ({
        ...real,
        async answer(...args: Parameters<CalendarWriter["answer"]>) {
          const done = await real.answer(...args);
          if (cut) throw new Error("the connection dropped after the server answered");
          return done;
        },
      }));
      const [series] = await b.rows("glaze.ics");
      await b.press("once", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "record" }, answer: "tentative" });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      cut = false;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["once", "applied", null]]);
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"glaze.ics-1"'], ["PUT", '"glaze.ics-1"']]);
    });

    it("refuses an answer made on a copy the provider has moved past, and one at a server that does not send invitations itself; neither writes anything", async () => {
      const b = await invited();
      const [series] = await b.rows("glaze.ics");
      await b.press("late", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "record" }, answer: "accepted" });
      b.dav.put("studio", "glaze.ics", INVITATION.replace("SUMMARY:Glaze group\r\n", "SUMMARY:Glaze group, new room\r\n"), '"glaze.ics-2"');
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from).map((s) => [s.method, s.headers["if-match"]])).toEqual([["PUT", '"glaze.ics-1"']]);
      expect(await b.writes()).toEqual([["late", "refused", "version_stale"]]);
      const quiet = await invited(undefined, false);
      const [other] = await quiet.rows("glaze.ics");
      await quiet.press("no-schedule", { kind: "calendar_event_answer", ...on(other!), scope: { kind: "occurrence", at: DEC_7 }, answer: "accepted" });
      const before = quiet.dav.seen.length;
      expect((await quiet.turn()).kind).toBe("synced");
      expect(quiet.written(before)).toEqual([]);
      expect(await quiet.writes()).toEqual([["no-schedule", "refused", "invitees_unsupported"]]);
    });
  });

  describe("a day and the days after it of a series with invitees (the last thing built: at the stand-in alone)", () => {
    const MILA = "mila@studio.example.test";
    const OWN = seriesText({
      uid: "critique@studio.example.test", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
      more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, "ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:giulia@example.test"],
    });
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const newTerm = {
      title: "Glaze critique, the new term", start: zoned("20261214T090000"), end: zoned("20261214T100000"), notes: null, place: null, callLink: null,
      busy: true, private: false, repeat: "FREQ=WEEKLY;BYDAY=MO", invitees: [{ address: "giulia@example.test", name: "Giulia", role: "required" }], alarms: [],
    };

    it("ends the series and makes the new one with the series' invitees, at a server that sends invitations itself; each part once", async () => {
      const b = await bench({ "critique.ics": OWN }, undefined, { autoSchedule: true, mailbox: MILA });
      const [series] = await b.rows("critique.ics");
      await b.split("term", series!, DEC_14, { title: "Glaze critique, the new term" }, newTerm, { organizer: MILA, guests: newTerm.invitees.map((person) => person.address) });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(await b.writes()).toEqual([["term", "applied", null], ["term:2", "applied", null]]);
      const [made, end] = b.written(from);
      expect([end!.method, end!.headers["if-match"], made!.method, made!.headers["if-none-match"]]).toEqual(["PUT", '"critique.ics-1"', "PUT", "*"]);
      // The new series keeps the series' own organizer line as it is, and asks the series' invitee again, as the server is to send it.
      const people = made!.body.replace(/\r\n[ \t]/g, "").split("\r\n").filter((l) => /^(ORGANIZER|ATTENDEE)[;:]/.test(l));
      expect(people.sort()).toEqual(["ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:giulia@example.test", `ORGANIZER;CN=Mila:mailto:${MILA}`]);
      // Both parts asked the server whether it sends invitations itself before writing.
      expect(b.dav.seen.slice(from).filter((x) => x.method === "PROPFIND" && x.depth === "0").length).toBeGreaterThanOrEqual(2);
    });

    it("writes neither part at a server that does not send invitations itself", async () => {
      const b = await bench({ "critique.ics": OWN }, undefined, { autoSchedule: false, mailbox: MILA });
      const [series] = await b.rows("critique.ics");
      await b.split("term", series!, DEC_14, { title: "Glaze critique, the new term" }, newTerm, { organizer: MILA, guests: newTerm.invitees.map((person) => person.address) });
      const from = b.dav.seen.length;
      expect((await b.turn()).kind).toBe("synced");
      expect(b.written(from)).toEqual([]);
      expect(await b.writes()).toEqual([["term", "refused", "invitees_unsupported"], ["term:2", "refused", "earlier_refused"]]);
    });
  });
});
