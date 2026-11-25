/**
 * THE CALENDAR'S SYNC, ON A REAL POSTGRES: a reading written in pages of short transactions, its
 * token kept only once its last page committed, and every page safe to apply twice, out of order,
 * or after a crash. The provider here is a script, so the store's own rules are what is held: what
 * a page writes, what a whole reading drops at its end, and what it spares.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import { calCalendars, calConnections, calEvents, calSettings, calWrites, changeLog, mailboxes, type Tx } from "@trafficflow/db";
import { zoned, wall, type ZoneSource } from "@ohmail/cal-core";
import { Secret, type ChangeItem, type StoredCredential } from "@ohmail/cal-providers";
import { calendarSyncPass, calendarTurnFailed } from "../src/calendar/sync-pass.js";
import { CalendarKeyRingFault } from "../src/calendar/sign-in.js";
import { applyChunks, chunksOf, objectWrite, type Work } from "../src/calendar/apply.js";
import { removeCalendar } from "../src/calendar/calendars.js";
import { setConnectionState } from "../src/calendar/state.js";
import {
  CalendarTurnOverdue, calendarPool, inConnection, newCalendarSyncMemory, occurrenceKey, parkConnection, passDb, rowsOfObject,
  type CalendarSyncOutcome,
} from "../src/calendar/index.js";
import { RETRY_FLOOR_MS, WAIT_DAY_MS } from "../src/calendar/words.js";
import {
  AVAILABLE, ZONES, calendarsOf, capturedLog, changesOf, childrenOf, connectionOf, depsFor, eventOf, eventsOf, openWorld, providersOf, scriptedReader,
  seedConnection, silentHttp, single, upsert, type ScriptedPage, type World,
} from "./_calendar-world.js";

const never = new AbortController().signal;
const SERVER = "https://dav.example.test/dav/";
const caldav: StoredCredential = { kind: "basic", server: SERVER, user: "mila", password: new Secret(["kiln", "wheel", "glaze"].join("-")) };
const google: StoredCredential = { kind: "oauth", provider: "google", refreshToken: new Secret(["lasting", "google", "fixture"].join("-")) };
const GOOGLE_REGISTRATION = { clientId: "calendar-test.apps.example", clientSecret: ["registration", "fixture"].join("-") };

/** Pages of single events, ids `<prefix><i>.ics`, all at version `v`. */
function eventsInPages(prefix: string, count: number, perPage: number, v = "v1"): ScriptedPage[] {
  const pages: ScriptedPage[] = [];
  for (let i = 0; i < count; i += perPage) {
    const items: ChangeItem[] = [];
    for (let j = i; j < Math.min(count, i + perPage); j++) items.push(upsert(`${prefix}${j}.ics`, v, single(`${prefix}${j}@x.test`, 1 + (j % 28))));
    pages.push({ items });
  }
  return pages;
}

describe.skipIf(!AVAILABLE)("the calendar's sync, page by page", () => {
  let w: World;
  let press: ReturnType<typeof postgres>;
  beforeAll(async () => {
    w = await openWorld();
    press = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  }, 120_000);
  afterAll(async () => {
    await press?.end({ timeout: 5 });
    await w?.close();
  });

  /** Every calendar and the connection of the account due again now. */
  async function makeDue(accountId: string): Promise<void> {
    await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, accountId));
  }

  it("keeps the authenticated CalDAV organizer addresses of the connection and replaces them on discovery", async () => {
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [] }]]]) });
    const first = ["second-principal", "example.test"].join("@");
    const next = ["new-principal", "example.test"].join("@");
    let addresses = [first.toUpperCase(), first];
    reader.checkSignIn = async () => ({ ok: true, value: { principal: "/principal", addresses } });
    const providers = providersOf({ caldav: { reader, http: silentHttp() } });
    const read = async () => (await w.db.select({ addresses: calConnections.organizerAddresses }).from(calConnections)
      .where(eq(calConnections.id, seeded.due.id)))[0]?.addresses;
    const run = () => calendarSyncPass(depsFor(w, providers), seeded.due, never);
    expect(await run()).toMatchObject({ kind: "synced" });
    expect(await read()).toEqual([first]);
    addresses = [next];
    await makeDue(seeded.due.accountId);
    expect(await run()).toMatchObject({ kind: "synced" });
    expect(await read()).toEqual([next]);
    await w.db.update(calCalendars).set({ autoSchedule: true }).where(eq(calCalendars.accountId, seeded.accountId));
    const beforeWithdrawal = await changesOf(w, seeded.accountId);
    reader.checkSignIn = async () => ({ ok: false, reason: "unreadable", retryAfterMs: null });
    await makeDue(seeded.due.accountId);
    expect(await run()).toMatchObject({ kind: "backed_off", word: "unreadable" });
    expect(await read()).toEqual([]);
    expect((await changesOf(w, seeded.accountId))["calendar:update"]).toBe((beforeWithdrawal["calendar:update"] ?? 0) + 1);
  });

  /** Turns until a turn ends with nothing more to read. */
  async function turnsUntilDone(deps: Parameters<typeof calendarSyncPass>[0], due: Parameters<typeof calendarSyncPass>[1]): Promise<CalendarSyncOutcome[]> {
    const out: CalendarSyncOutcome[] = [];
    for (let i = 0; i < 40; i++) {
      const o = await calendarSyncPass(deps, due, never);
      out.push(o);
      if (o.kind !== "synced" || !o.more) return out;
    }
    throw new Error("the reading did not end");
  }

  /**
   * The world's database with `before` run ahead of each of its transactions until `end`: somebody else
   * at work between two of a pass's own. It sits on the pool's own handle, which the binder knows, so
   * a turn's handle bound over it opens its transactions through it too.
   */
  function dbWith(before: () => Promise<void>): { db: World["db"]; end(): void } {
    const pool = w.db as unknown as { transaction(fn: unknown, config?: unknown): Promise<unknown> };
    // What stands there is the factory's own `transaction`, an own property that stamps every
    // transaction it opens: `end` puts it back as it was, never deletes it.
    const stood = Object.getOwnPropertyDescriptor(pool, "transaction");
    const real = pool.transaction;
    Object.defineProperty(pool, "transaction", {
      configurable: true,
      value: async function (this: unknown, fn: unknown, config?: unknown) {
        await before();
        return real.call(this, fn, config);
      },
    });
    return {
      db: w.db,
      end: () => {
        if (stood) Object.defineProperty(pool, "transaction", stood);
        else Reflect.deleteProperty(pool, "transaction");
      },
    };
  }

  /** One event written into a calendar by somebody else. */
  async function strangersEvent(accountId: string, calendarId: string, n: number): Promise<void> {
    await w.db.insert(calEvents).values({
      accountId, calendarId, providerId: `stranger-${n}.ics`, uid: `stranger-${n}@x.test`, startKind: "instant",
      startLocal: "20261120T090000Z", startsAt: new Date("2026-11-20T09:00:00Z"), endsAt: new Date("2026-11-20T10:00:00Z"),
    });
  }

  /** A CalDAV connection over a scripted reader. */
  async function caldavWorld(readings: Map<string, readonly ScriptedPage[]>, endToken?: (since: string | null) => string | null) {
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { readings, ...(endToken ? { endToken } : {}) });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    return { ...seeded, reader, deps };
  }

  it("keeps known capabilities after a timed-out probe and publishes a confirmed change", async () => {
    const t = await caldavWorld(new Map([["", [{ items: [] }]]]));
    const list = t.reader.listCalendars.bind(t.reader);
    let capability: true | null | undefined = true;
    t.reader.listCalendars = async (...args) => {
      const result = await list(...args);
      return result.ok
        ? { ...result, value: result.value.map((calendar) => ({ ...calendar, autoSchedule: capability, nativeMove: capability })) }
        : result;
    };
    await calendarSyncPass(t.deps, t.due, never);
    expect((await calendarsOf(w, t.accountId))[0]).toMatchObject({ autoSchedule: true, nativeMove: true });
    const before = await changesOf(w, t.accountId);
    capability = null;
    await makeDue(t.accountId);
    await calendarSyncPass({ ...t.deps, memory: newCalendarSyncMemory() }, t.due, never);
    expect.soft((await calendarsOf(w, t.accountId))[0]).toMatchObject({ autoSchedule: true, nativeMove: true });
    expect.soft((await changesOf(w, t.accountId))["calendar:update"]).toBe(before["calendar:update"]);
    capability = undefined;
    await makeDue(t.accountId);
    await calendarSyncPass({ ...t.deps, memory: newCalendarSyncMemory() }, t.due, never);
    expect((await calendarsOf(w, t.accountId))[0]).toMatchObject({ autoSchedule: false, nativeMove: false });
    expect((await changesOf(w, t.accountId))["calendar:update"]).toBe(before["calendar:update"]! + 1);
  });

  it("a first reading is stored page by page, and the token is kept only once the last page committed", async () => {
    const pages: ScriptedPage[] = [
      { items: [upsert("a.ics", "v1", single("a@x.test", 17)), upsert("b.ics", "v1", single("b@x.test", 18))] },
      { items: [upsert("c.ics", "v1", single("c@x.test", 19))] },
    ];
    const t = await caldavWorld(new Map([["", pages]]));
    const outcome = await calendarSyncPass(t.deps, t.due, never);
    expect(outcome).toMatchObject({ kind: "synced", calendars: 1, pages: 2, changed: 4, more: false });
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId)).toEqual(["a.ics", "b.ics", "c.ics"]);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("t2");
    expect(await changesOf(w, t.accountId)).toEqual({ "calendar:create": 1, "calendar_event:create": 3, "calendar:update": 1, "calendar_connection:update": 1 });
    expect((await connectionOf(w, t.accountId, t.connectionId)).status).toBe("active");
  }, 60_000);

  it("a calendar's first reading says it was read even when the calendar holds nothing, and only that once", async () => {
    const t = await caldavWorld(new Map([["", [{ items: [] }]], ["t1", [{ items: [], unchanged: true }]]]), () => "t1");
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1, changed: 1 });
    const [read] = await calendarsOf(w, t.accountId);
    expect(read?.lastSyncedAt).not.toBeNull();
    expect(await changesOf(w, t.accountId)).toEqual({ "calendar:create": 1, "calendar:update": 1, "calendar_connection:update": 1 });
    await makeDue(t.accountId);
    await calendarSyncPass(t.deps, t.due, never);
    expect((await calendarsOf(w, t.accountId))[0]?.lastSyncedAt).toEqual(read?.lastSyncedAt);
    expect(await changesOf(w, t.accountId)).toEqual({ "calendar:create": 1, "calendar:update": 1, "calendar_connection:update": 2 });
  }, 60_000);

  it("each successful empty listing advances only the account it checked", async () => {
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const other = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { calendars: [], readings: new Map() });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", calendars: 0, changed: 0 });
    const first = await connectionOf(w, seeded.accountId, seeded.connectionId);
    expect(first.lastSyncedAt).not.toBeNull();
    expect(await changesOf(w, seeded.accountId)).toEqual({ "calendar_connection:update": 1 });
    expect((await connectionOf(w, other.accountId, other.connectionId)).lastSyncedAt).toBeNull();
    expect(await changesOf(w, other.accountId)).toEqual({});

    await makeDue(seeded.accountId);
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", calendars: 0, changed: 0 });
    expect((await connectionOf(w, seeded.accountId, seeded.connectionId)).lastSyncedAt!.getTime()).toBeGreaterThan(first.lastSyncedAt!.getTime());
    expect(await changesOf(w, seeded.accountId)).toEqual({ "calendar_connection:update": 2 });
    expect((await connectionOf(w, other.accountId, other.connectionId)).lastSyncedAt).toBeNull();
    expect(await changesOf(w, other.accountId)).toEqual({});
  }, 60_000);

  it("an unchanged reading advances the account’s last check without recording event or calendar changes", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("n", 3, 3)], ["tok", [{ items: [], unchanged: true }]]]), () => "tok");
    await calendarSyncPass(t.deps, t.due, never);
    const before = await changesOf(w, t.accountId);
    const checked = (await connectionOf(w, t.accountId, t.connectionId)).lastSyncedAt!;
    await makeDue(t.accountId);
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", calendars: 1, changed: 0, dropped: 0 });
    expect((await connectionOf(w, t.accountId, t.connectionId)).lastSyncedAt!.getTime()).toBeGreaterThan(checked.getTime());
    expect(await changesOf(w, t.accountId)).toEqual({ ...before, "calendar_connection:update": before["calendar_connection:update"]! + 1 });
    expect(t.reader.calls.at(-1)).toEqual({ since: "tok", cursor: null });
  }, 60_000);

  it("a crash between two pages loses and doubles nothing: the next turn reads again from the token that stands", async () => {
    const pages = eventsInPages("k", 9, 3);
    const unbroken = await caldavWorld(new Map([["", pages]]));
    await calendarSyncPass(unbroken.deps, unbroken.due, never);

    const t = await caldavWorld(new Map([["", pages]]));
    const crashing = scriptedReader("caldav", { readings: new Map([["", pages]]) });
    const real = crashing.readChanges.bind(crashing);
    let served = 0;
    crashing.readChanges = async (...args) => {
      served += 1;
      if (served === 3) throw new Error("the worker died here");
      return real(...args);
    };
    await expect(calendarSyncPass(depsFor(w, providersOf({ caldav: { reader: crashing, http: silentHttp() } })), t.due, never)).rejects.toThrow();
    // Two pages are written, and the calendar still reads from where it stood before: no token.
    expect((await eventsOf(w, t.accountId)).length).toBe(6);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBeNull();

    // A fresh process: nothing of the reading is remembered.
    await makeDue(t.accountId);
    await calendarSyncPass(t.deps, t.due, never);
    const strip = (rows: Awaited<ReturnType<typeof eventsOf>>) => rows.map(({ providerId, recurrenceId, uid, title, versionTag }) => ({ providerId, recurrenceId, uid, title, versionTag }));
    expect(strip(await eventsOf(w, t.accountId))).toEqual(strip(await eventsOf(w, unbroken.accountId)));
    expect((await changesOf(w, t.accountId))["calendar_event:create"]).toBe(9);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("t3");
  }, 60_000);

  it("pages applied twice and out of order converge without recording duplicate calendar or event changes", async () => {
    const pages = eventsInPages("r", 12, 4);
    const shuffled: ScriptedPage[] = [{ items: [...pages[2]!.items, ...pages[0]!.items] }, { items: [...pages[1]!.items, ...pages[2]!.items] }, pages[0]!];
    const t = await caldavWorld(new Map([["", pages], ["tok", shuffled]]), () => "tok");
    await calendarSyncPass(t.deps, t.due, never);
    const rows = await eventsOf(w, t.accountId);
    const changes = await changesOf(w, t.accountId);
    await makeDue(t.accountId);
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", changed: 0 });
    expect(await eventsOf(w, t.accountId)).toEqual(rows);
    expect(await changesOf(w, t.accountId)).toEqual({ ...changes, "calendar_connection:update": changes["calendar_connection:update"]! + 1 });
  }, 60_000);

  it("a whole reading drops at its end what no page named, and spares a left id, a newer row, and an owed write", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("d", 6, 6)]]), () => null);
    await calendarSyncPass(t.deps, t.due, never);
    const [cal] = await calendarsOf(w, t.accountId);
    // d5 has a write owed to the provider: a person's change waits for it, so it is not dropped.
    const [d5] = await w.db.select({ id: calEvents.id }).from(calEvents).where(and(eq(calEvents.accountId, t.accountId), eq(calEvents.providerId, "d5.ics")));
    await w.db.insert(calWrites).values({ accountId: t.accountId, calendarId: cal!.id, eventId: d5!.id, op: "update", payload: {}, idempotencyKey: "owed-1" });

    const second: ScriptedPage[] = [
      { items: [upsert("d0.ics", "v1", single("d0@x.test", 1)), upsert("d1.ics", "v1", single("d1@x.test", 2))], left: [{ id: "d2.ics", reason: "unreadable" }] },
      { items: [upsert("d3.ics", "v1", single("d3@x.test", 4))] },
    ];
    const reader = scriptedReader("caldav", { readings: new Map([["", second]]), endToken: () => null });
    const real = reader.readChanges.bind(reader);
    let served = 0;
    reader.readChanges = async (...args) => {
      served += 1;
      if (served === 2) {
        // Between the pages: nothing is dropped yet, and a row is written by somebody else meanwhile.
        expect((await eventsOf(w, t.accountId)).map((e) => e.providerId)).toContain("d4.ics");
        await w.db.insert(calEvents).values({
          accountId: t.accountId, calendarId: cal!.id, providerId: "fresh.ics", uid: "fresh@x.test", startKind: "instant",
          startLocal: "20261120T090000Z", startsAt: new Date("2026-11-20T09:00:00Z"), endsAt: new Date("2026-11-20T10:00:00Z"),
        });
      }
      return real(...args);
    };
    await makeDue(t.accountId);
    const outcome = await calendarSyncPass(depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { memory: t.deps.memory }), t.due, never);
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId)).toEqual(["d0.ics", "d1.ics", "d2.ics", "d3.ics", "d5.ics", "fresh.ics"]);
    expect(outcome).toMatchObject({ kind: "synced", dropped: 1 });
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(1);
  }, 60_000);

  it("a whole reading that would drop most of a calendar waits for a second one that shows the same", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("m", 24, 24)]]), () => null);
    await calendarSyncPass(t.deps, t.due, never);
    const few = scriptedReader("caldav", { readings: new Map([["", eventsInPages("m", 3, 3)]]), endToken: () => "after" });
    const deps = depsFor(w, providersOf({ caldav: { reader: few, http: silentHttp() } }), { memory: t.deps.memory });
    await makeDue(t.accountId);
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", dropped: 0 });
    expect((await eventsOf(w, t.accountId)).length).toBe(24);
    const [held] = await calendarsOf(w, t.accountId);
    // Not on one reading's word: no token, and the next whole reading within a minute.
    expect(held?.syncToken).toBeNull();
    expect(held!.nextPollAt!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    await makeDue(t.accountId);
    expect(await calendarSyncPass(deps, t.due, never)).toMatchObject({ kind: "synced", dropped: 21 });
    expect((await eventsOf(w, t.accountId)).length).toBe(3);
  }, 60_000);

  it("stores newly confirmed Google event types even when the provider version is unchanged", async () => {
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const ordinary = upsert("ordinary", "same-version", single("ordinary", 17));
    const imported = upsert("imported", "same-version", single("imported", 17));
    const reviewed = { ...ordinary, googleDefaultEvent: true as const };
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [ordinary, imported] }]],
      ["cursor", [{ items: [reviewed, imported] }]],
    ]);
    const reader = scriptedReader("google", { readings, endToken: () => "cursor" });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    }
    const held = await w.db.select().from(calEvents).where(eq(calEvents.accountId, seeded.accountId));
    expect(held).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "ordinary", googleDefaultEvent: true }),
      expect.objectContaining({ providerId: "imported", googleDefaultEvent: false }),
    ]));
  }, 60_000);

  it("Google: a cancelled day joins its series' excluded days, survives the series' next change, and leaves it once the day is changed", async () => {
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const series = (summary: string) => eventOf(["UID:series-1@x.test", "DTSTAMP:20261113T120000Z", "DTSTART;TZID=Europe/Zurich:20261117T180000",
      "DTEND;TZID=Europe/Zurich:20261117T190000", "RRULE:FREQ=WEEKLY;COUNT=6", `SUMMARY:${summary}`]);
    const second = zoned(wall(2026, 11, 24, 18), "Europe/Zurich");
    const changedDay = eventOf(["UID:series-1@x.test", "DTSTAMP:20261113T130000Z", "RECURRENCE-ID;TZID=Europe/Zurich:20261124T180000",
      "DTSTART;TZID=Europe/Zurich:20261125T180000", "DTEND;TZID=Europe/Zurich:20261125T190000", "SUMMARY:Wheel class, moved"]);
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("series1", "e1", series("Wheel class"))] }]],
      ["g1", [{ items: [{ kind: "cancelled_occurrence", uid: "series-1@x.test", originalStart: second }] }]],
      ["g2", [{ items: [upsert("series1", "e2", series("Wheel class, renamed"))] }]],
      ["g3", [{ items: [upsert("series1_20261124", "e3", changedDay)] }]],
    ]);
    const tokens = new Map<string | null, string>([[null, "g1"], ["g1", "g2"], ["g2", "g3"], ["g3", "g4"]]);
    const reader = scriptedReader("google", { readings, endToken: (since) => tokens.get(since)! });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    const run = async () => {
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    };
    const master = async () => (await eventsOf(w, seeded.accountId)).find((e) => e.providerId === "series1")!;
    await run();
    expect((await master()).excluded).toEqual([]);
    await run();
    expect((await master()).excluded).toEqual(["20261124T180000"]);
    await run();
    expect(await master()).toMatchObject({ title: "Wheel class, renamed", excluded: ["20261124T180000"] });
    await run();
    expect((await master()).excluded).toEqual([]);
    expect((await eventsOf(w, seeded.accountId)).map((e) => e.providerId)).toEqual(["series1", "series1_20261124"]);
    // Each of the series' three changes reached the change log: the cancelled day, the new name, the day that came back.
    expect(await changesOf(w, seeded.accountId)).toMatchObject({ "calendar_event:create": 2, "calendar_event:update": 3 });
  }, 60_000);

  it("echoes a finite series unchanged when a separate exception moves past its range", async () => {
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const series = eventOf(["UID:finite-series", "DTSTAMP:20261113T120000Z", "DTSTART:20231114T180000Z",
      "DTEND:20231114T190000Z", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Wheel class"]);
    const exception = eventOf(["UID:finite-series", "DTSTAMP:20261113T130000Z", "RECURRENCE-ID:20231121T180000Z",
      "DTSTART:20261125T180000Z", "DTEND:20261125T190000Z", "SUMMARY:Wheel class, moved"]);
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("master", "first", series)] }]],
      ["ready", [{ items: [upsert("changed", "moved", exception)] }]],
    ]);
    const reader = scriptedReader("google", { readings, endToken: (since) => since === null ? "ready" : "done" });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    const master = async () => (await w.db.select({ id: calEvents.id, updatedAt: calEvents.updatedAt, version: calEvents.versionTag })
      .from(calEvents).where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.providerId, "master"))))[0];
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    const before = await master();
    await makeDue(seeded.accountId);
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    expect(await master()).toEqual(before);
    const matches = await w.db.select({ op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.accountId, seeded.accountId), eq(changeLog.entityType, "calendar_event"), eq(changeLog.entityId, before!.id)))
      .orderBy(changeLog.seq);
    expect(matches.map((row) => row.op)).toEqual(["create", "update"]);
  });

  it("Microsoft: a whole reading excludes a day its window should show and no page did; a delta reading compares nothing", async () => {
    const seeded = await seedConnection(w, { provider: "microsoft", credential: { kind: "oauth", provider: "microsoft", refreshToken: new Secret(["lasting", "ms", "fixture"].join("-")) } });
    const series = (summary: string) => eventOf(["UID:wheel@x.test", "DTSTAMP:20261113T120000Z", "DTSTART;TZID=Europe/Zurich:20261117T180000",
      "DTEND;TZID=Europe/Zurich:20261117T190000", "RRULE:FREQ=WEEKLY;COUNT=6", `SUMMARY:${summary}`]);
    const evening = (day: number, month = 11) => ({ uid: "wheel@x.test", originalStart: zoned(wall(2026, month, day, 18), "Europe/Zurich") });
    // The clock stands on 10 December 2024: the window reaches 11 December 2026, so the evenings of the 15th and 22nd lie past it.
    const window = { start: { kind: "instant" as const, epochMs: Date.UTC(2023, 11, 10) }, end: { kind: "instant" as const, epochMs: Date.UTC(2026, 11, 11) } };
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", series("Wheel class"))], expanded: { window, seen: [evening(17), evening(1, 12), evening(8, 12)] } }]],
      ["ms1", [{ items: [upsert("wheel", "e2", series("Wheel class, renamed"))], expanded: { window, seen: [evening(1, 12)] } }]],
    ]);
    const reader = scriptedReader("microsoft", { readings, endToken: (since) => (since === null ? "ms1" : "ms2") });
    const deps = depsFor(w, providersOf({ microsoft: { reader, http: silentHttp() } }), {
      clock: { now: () => Date.UTC(2024, 11, 10, 12) },
      oauth: { google: null, microsoft: async () => ({ clientId: "calendar-test-client", clientSecret: ["ms", "fixture"].join("-"), defaultTenant: "common", kind: "confidential" }) },
    });
    const wheel = async () => (await eventsOf(w, seeded.accountId)).find((e) => e.providerId === "wheel")!;
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    expect((await wheel()).excluded).toEqual(["20261124T180000"]);
    await makeDue(seeded.accountId);
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
    expect(await wheel()).toMatchObject({ title: "Wheel class, renamed", excluded: ["20261124T180000"] });
    // The excluded day and the new name are two changes of the one series.
    expect(await changesOf(w, seeded.accountId)).toMatchObject({ "calendar_event:create": 1, "calendar_event:update": 2 });
  }, 60_000);

  // ── the two providers that keep a changed day as an object of its own ──────────────────────────
  const wheel = (summary = "Wheel class") => eventOf(["UID:wheel@x.test", "DTSTAMP:20261113T120000Z", "DTSTART;TZID=Europe/Zurich:20261117T180000",
    "DTEND;TZID=Europe/Zurich:20261117T190000", "RRULE:FREQ=WEEKLY;COUNT=6", `SUMMARY:${summary}`]);
  /** The evening of 24 November, moved to the 25th: an object of its own that carries the series' UID. */
  const wheelMoved = eventOf(["UID:wheel@x.test", "DTSTAMP:20261113T130000Z", "RECURRENCE-ID;TZID=Europe/Zurich:20261124T180000",
    "DTSTART;TZID=Europe/Zurich:20261125T180000", "DTEND;TZID=Europe/Zurich:20261125T190000", "SUMMARY:Wheel class, moved"]);
  const evening = (day: number, month = 11) => ({ uid: "wheel@x.test", originalStart: zoned(wall(2026, month, day, 18), "Europe/Zurich") });
  // The clock stands on 10 December 2024: Microsoft's window reaches 11 December 2026.
  const window = { start: { kind: "instant" as const, epochMs: Date.UTC(2023, 11, 10) }, end: { kind: "instant" as const, epochMs: Date.UTC(2026, 11, 11) } };
  const shown = (...seen: ReturnType<typeof evening>[]) => ({ window, seen });
  /** A Microsoft connection over scripted readings; `ms1` is the token a reading from none ends with. */
  async function microsoftWorld(readings: Map<string, readonly ScriptedPage[]>) {
    const seeded = await seedConnection(w, { provider: "microsoft", credential: { kind: "oauth", provider: "microsoft", refreshToken: new Secret(["lasting", "ms", "fixture"].join("-")) } });
    const reader = scriptedReader("microsoft", { readings, endToken: (since) => (since === null ? "ms1" : "ms2") });
    const deps = depsFor(w, providersOf({ microsoft: { reader, http: silentHttp() } }), {
      clock: { now: () => Date.UTC(2024, 11, 10, 12) },
      oauth: { google: null, microsoft: async () => ({ clientId: "calendar-test-client", clientSecret: ["ms", "fixture"].join("-"), defaultTenant: "common", kind: "confidential" }) },
    });
    const turn = async () => {
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
      return (await eventsOf(w, seeded.accountId)).map((e) => ({ id: e.providerId, excluded: e.excluded }));
    };
    return { ...seeded, turn };
  }
  async function googleWorld(readings: Map<string, readonly ScriptedPage[]>) {
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const reader = scriptedReader("google", { readings, endToken: (since) => (since === null ? "g1" : "g2") });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    const turn = async () => {
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced" });
      return (await eventsOf(w, seeded.accountId)).map((e) => e.providerId).sort();
    };
    return { ...seeded, turn };
  }

  it("Google: a series that is removed takes its changed days' rows with it, each with its delete", async () => {
    const t = await googleWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", wheel()), upsert("wheel_20261124", "e1", wheelMoved), upsert("solo", "e1", single("solo@x.test", 19))] }]],
      ["g1", [{ items: [{ kind: "gone", id: "wheel" }] }]],
    ]));
    expect(await t.turn()).toEqual(["solo", "wheel", "wheel_20261124"]);
    expect(await t.turn()).toEqual(["solo"]);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(2);
  }, 60_000);

  it("an object of more rows than one transaction records, and a series with as many changed days, are written and removed in parts", async () => {
    const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replaceAll("-", "");
    const daily = (uid: string, count: number) => eventOf([`UID:${uid}`, "DTSTAMP:20261113T120000Z", "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", `RRULE:FREQ=DAILY;COUNT=${count}`, "SUMMARY:Daily"]);
    const changed = (uid: string, i: number) => eventOf([`UID:${uid}`, "DTSTAMP:20261113T130000Z", `RECURRENCE-ID:${day(i)}T090000Z`, `DTSTART:${day(i)}T110000Z`, `DTEND:${day(i)}T120000Z`, "SUMMARY:Daily, later"]);
    const mostInOne = async (accountId: string): Promise<number> => {
      const per = await w.db.select({ n: sql<number>`count(*)::int` }).from(changeLog).where(eq(changeLog.accountId, accountId)).groupBy(changeLog.createdAt);
      return Math.max(...per.map((r) => Number(r.n)));
    };

    // One object's text holding a series and 449 of its days changed (CalDAV): 450 rows under one id.
    const text = "BEGIN:VCALENDAR";
    const big: ChangeItem[] = [upsert("big.ics", "v1", daily("big@x.test", 450), text)];
    for (let i = 1; i < 450; i++) big.push(upsert("big.ics", "v1", changed("big@x.test", i), text));
    const dav = await caldavWorld(new Map([["", [{ items: big }]], ["tok", [{ items: [{ kind: "gone", id: "big.ics" }] }]]]), () => "tok");
    await calendarSyncPass(dav.deps, dav.due, never);
    expect((await eventsOf(w, dav.accountId)).length).toBe(450);
    await makeDue(dav.accountId);
    expect(await calendarSyncPass(dav.deps, dav.due, never)).toMatchObject({ kind: "synced", changed: 450 });
    expect(await eventsOf(w, dav.accountId)).toEqual([]);
    expect(await mostInOne(dav.accountId)).toBeLessThanOrEqual(200);

    // A series and 250 changed days, each an object of its own (Google): the series' removal takes all of them.
    const many: ChangeItem[] = [upsert("g", "e1", daily("g@x.test", 300))];
    for (let i = 1; i <= 250; i++) many.push(upsert(`g_${i}`, "e1", changed("g@x.test", i)));
    const g = await googleWorld(new Map<string, readonly ScriptedPage[]>([["", [{ items: many }]], ["g1", [{ items: [{ kind: "gone", id: "g" }] }]]]));
    expect((await g.turn()).length).toBe(251);
    expect(await g.turn()).toEqual([]);
    expect((await changesOf(w, g.accountId))["calendar_event:delete"]).toBe(251);
    expect(await mostInOne(g.accountId)).toBeLessThanOrEqual(200);
  }, 120_000);

  it("Google: a cancelled day goes for a changed day's row whose series is not stored", async () => {
    const t = await googleWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel_20261124", "e1", wheelMoved)] }]],
      ["g1", [{ items: [{ kind: "cancelled_occurrence", uid: "wheel@x.test", originalStart: zoned(wall(2026, 11, 24, 18), "Europe/Zurich") }] }]],
    ]));
    expect(await t.turn()).toEqual(["wheel_20261124"]);
    expect(await t.turn()).toEqual([]);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(1);
  }, 60_000);

  it("Microsoft: a changed day removed in a delta takes its day out of the series, and the window is read whole again", async () => {
    const first: ScriptedPage = { items: [upsert("wheel", "e1", wheel()), upsert("wheel.d24", "x1", wheelMoved)], expanded: shown(evening(17), evening(24), evening(1, 12), evening(8, 12)) };
    const t = await microsoftWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [first]],
      ["ms1", [{ items: [{ kind: "gone", id: "wheel.d24" }], expanded: shown() }]],
    ]));
    expect(await t.turn()).toEqual([{ id: "wheel", excluded: [] }, { id: "wheel.d24", excluded: [] }]);
    // The moved evening is deleted at Microsoft: without its day excluded, the rule would show 24 November 18:00 again.
    expect(await t.turn()).toEqual([{ id: "wheel", excluded: ["20261124T170000Z"] }]);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBeNull();
    expect(await changesOf(w, t.accountId)).toMatchObject({ "calendar_event:delete": 1, "calendar_event:update": 1 });

    // Where the same reading shows that day (the series was reset and the day is an ordinary one again), nothing is excluded.
    const reset = await microsoftWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [first]],
      ["ms1", [{ items: [{ kind: "gone", id: "wheel.d24" }], expanded: shown(evening(24)) }]],
    ]));
    await reset.turn();
    expect(await reset.turn()).toEqual([{ id: "wheel", excluded: [] }]);
  }, 60_000);

  it("Microsoft: a whole reading that left a record out compares nothing; a day excluded that a later reading shows comes back", async () => {
    // Graph showed all four evenings, but the reader could not place the record of 24 November: it is in `left`, not in `seen`.
    const left = await microsoftWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", wheel())], left: [{ id: "wheel.2026-11-24", reason: "unreadable" }], expanded: shown(evening(17), evening(1, 12), evening(8, 12)) }]],
    ]));
    expect(await left.turn()).toEqual([{ id: "wheel", excluded: [] }]);

    const mended = await microsoftWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", wheel())], expanded: shown(evening(17), evening(1, 12), evening(8, 12)) }]],
      ["ms1", [{ items: [], expanded: shown(evening(24)) }]],
    ]));
    expect(await mended.turn()).toEqual([{ id: "wheel", excluded: ["20261124T180000"] }]);
    expect(await mended.turn()).toEqual([{ id: "wheel", excluded: [] }]);
    expect((await changesOf(w, mended.accountId))["calendar_event:update"]).toBe(2);
  }, 60_000);

  it("a record a page hands twice is stored once; two events for one day inside one object's text are still no object", async () => {
    const ms = await microsoftWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", wheel()), upsert("wheel", "e1", wheel())], expanded: shown(evening(17), evening(24), evening(1, 12), evening(8, 12)) }]],
    ]));
    expect(await ms.turn()).toEqual([{ id: "wheel", excluded: [] }]);

    const text = "BEGIN:VCALENDAR";
    const dav = await caldavWorld(new Map([["", [{ items: [
      upsert("two.ics", "v1", single("two@x.test", 17, "One"), text), upsert("two.ics", "v1", single("two@x.test", 18, "Other"), text),
      upsert("one.ics", "v1", single("one@x.test", 19)),
    ] }]]]));
    await calendarSyncPass(dav.deps, dav.due, never);
    expect((await eventsOf(w, dav.accountId)).map((e) => e.providerId)).toEqual(["one.ics"]);
  }, 60_000);

  it("a first read of five thousand events never holds the account's counter across a provider's call, nor more than 200 changes in one transaction", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("p", 5_000, 250)]]));
    const real = t.reader.readChanges.bind(t.reader);
    const waits: string[] = [];
    let presses = 0;
    t.reader.readChanges = async (...args) => {
      // A letter's press on the same account, while the provider's call is open: it may wait 50 ms, no more.
      try {
        await press.begin(async (tx) => {
          await tx`set local lock_timeout = '50ms'`;
          await tx`insert into account_sync_state (account_id) values (${t.accountId}) on conflict do nothing`;
          await tx`update account_sync_state set next_seq = next_seq + 1 where account_id = ${t.accountId}`;
        });
        presses += 1;
      } catch (err) {
        waits.push((err as { code?: string }).code ?? "error");
      }
      return real(...args);
    };
    const turns = await turnsUntilDone(t.deps, t.due);
    expect(turns.length).toBe(3);
    expect(turns.slice(0, 2).every((o) => o.kind === "synced" && o.more)).toBe(true);
    expect({ presses, waits }).toEqual({ presses: 20, waits: [] });
    expect((await eventsOf(w, t.accountId)).length).toBe(5_000);
    const perTransaction = await w.db.select({ n: sql<number>`count(*)::int` }).from(changeLog)
      .where(eq(changeLog.accountId, t.accountId)).groupBy(changeLog.createdAt);
    expect(Math.max(...perTransaction.map((r) => Number(r.n)))).toBeLessThanOrEqual(200);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("t20");
  }, 180_000);

  it("a reading the worker's stop cuts keeps its place and no token, and the next turn goes on from it", async () => {
    let stop = false;
    const t = await caldavWorld(new Map([["", eventsInPages("h", 6, 2)]]));
    const real = t.reader.readChanges.bind(t.reader);
    t.reader.readChanges = async (...args) => {
      const answer = await real(...args);
      // The stop arrives while the second page is asked: the first is written, the second is not.
      if (args[3].cursor === "1") stop = true;
      return answer;
    };
    const halting = { ...t.deps, halted: () => stop };
    expect(await calendarSyncPass(halting, t.due, never)).toEqual({ kind: "halted" });
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBeNull();
    expect((await eventsOf(w, t.accountId)).length).toBe(2);
    stop = false;
    t.reader.readChanges = real;
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", more: false });
    expect(t.reader.calls.map((c) => c.cursor)).toEqual([null, "1", "1", "2"]);
    expect((await eventsOf(w, t.accountId)).length).toBe(6);
  }, 60_000);

  it("a token the provider forgot, on a calendar longer than one turn, is read to its end with each page asked once", async () => {
    const readings = new Map<string, readonly ScriptedPage[]>([["", eventsInPages("f", 2, 2)]]);
    // A whole reading's token is named after how many pages the calendar had: tok-1 now, tok-12 later.
    const t = await caldavWorld(readings, () => `tok-${readings.get("")!.length}`);
    await calendarSyncPass(t.deps, t.due, never);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("tok-1");
    // The provider no longer knows tok-1, and from no token the calendar is twelve pages: four more than a turn reads.
    readings.set("", eventsInPages("f", 24, 2));
    t.reader.calls.length = 0;
    await makeDue(t.accountId);
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", pages: 8, more: true });
    // The forgotten token is gone from the row at once: a crash here reads from no token, never from tok-1 again.
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBeNull();
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", pages: 5, more: false });
    expect(t.reader.calls).toEqual([
      { since: "tok-1", cursor: null },
      ...Array.from({ length: 12 }, (_, i) => ({ since: null, cursor: i === 0 ? null : String(i) })),
    ]);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("tok-12");
    expect((await eventsOf(w, t.accountId)).length).toBe(24);
  }, 60_000);

  it("nine first readings open at once, each longer than a turn, all end: none is given up for another", async () => {
    const memory = newCalendarSyncMemory();
    const worlds: Awaited<ReturnType<typeof caldavWorld>>[] = [];
    for (let i = 0; i < 9; i++) {
      const t = await caldavWorld(new Map([["", eventsInPages(`n${i}-`, 5, 1)]]));
      worlds.push({ ...t, deps: { ...t.deps, memory, turn: { pages: 2, ms: 10_000 } } });
    }
    // Turns in the runner's order: each connection in turn, round after round, until its calendar has its token.
    const done = new Set<number>();
    for (let round = 0; round < 12 && done.size < worlds.length; round++) {
      for (const [i, t] of worlds.entries()) {
        if (done.has(i)) continue;
        await makeDue(t.accountId);
        expect((await calendarSyncPass(t.deps, t.due, never)).kind).toBe("synced");
        if (((await calendarsOf(w, t.accountId))[0]?.syncToken ?? null) !== null) done.add(i);
      }
    }
    expect(done.size).toBe(9);
    for (const t of worlds) expect((await eventsOf(w, t.accountId)).length).toBe(5);
    // Every page asked once, but for the one reading that began with every place taken: its first two were asked again.
    expect(worlds.reduce((n, t) => n + t.reader.calls.length, 0)).toBeLessThanOrEqual(9 * 5 + 2);
    expect(memory.readings.size).toBe(0);
  }, 120_000);

  it("readings that are being read are never given up for the time between their turns: nine of twenty pages, a round of the lane two and a half hours long, all end", async () => {
    const memory = newCalendarSyncMemory();
    let now = Date.now();
    const worlds: Awaited<ReturnType<typeof caldavWorld>>[] = [];
    for (let i = 0; i < 9; i++) {
      const t = await caldavWorld(new Map([["", eventsInPages(`q${i}-`, 20, 1)]]));
      worlds.push({ ...t, deps: { ...t.deps, memory, clock: { now: () => now } } });
    }
    // A lane with much to read: each connection is turned once a round, and a round takes 150 minutes.
    const done = new Set<number>();
    for (let round = 0; round < 14 && done.size < worlds.length; round++) {
      for (const [i, t] of worlds.entries()) {
        if (done.has(i)) continue;
        await makeDue(t.accountId);
        expect((await calendarSyncPass(t.deps, t.due, never)).kind).toBe("synced");
        if (((await calendarsOf(w, t.accountId))[0]?.syncToken ?? null) !== null) done.add(i);
        now += Math.floor(150 * 60_000 / 9);
      }
    }
    expect(done.size).toBe(9);
    // Every page asked once, but for the reading that began with every place taken: its first turn's eight were asked again.
    expect(worlds.reduce((n, t) => n + t.reader.calls.length, 0)).toBeLessThanOrEqual(9 * 20 + 8);
    expect(memory.readings.size).toBe(0);
  }, 180_000);

  it("a kept reading gives its place up, when one is needed, only once the roster no longer hands its connection over: removed, stopped for the person, or parked", async () => {
    const memory = newCalendarSyncMemory();
    let now = Date.now();
    const long = async (prefix: string) => {
      const t = await caldavWorld(new Map([["", eventsInPages(prefix, 5, 1)]]));
      return { ...t, deps: { ...t.deps, memory, clock: { now: () => now }, turn: { pages: 2, ms: 10_000 } } };
    };
    // Eight readings begin and are kept.
    const kept: Awaited<ReturnType<typeof long>>[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await long(`a${i}-`);
      expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", more: true });
      kept.push(t);
    }
    expect(memory.readings.size).toBe(8);
    const ninth = await long("late-");
    const turn = async () => {
      await makeDue(ninth.accountId);
      const o = await calendarSyncPass(ninth.deps, ninth.due, never);
      return o.kind === "synced" ? o.more : o.kind;
    };
    // While their connections are due, none is given up, however long ago its last turn was: the ninth waits.
    expect(await turn()).toBe(false);
    now += 5 * 3_600_000;
    expect(await turn()).toBe(false);
    expect((await calendarsOf(w, ninth.accountId))[0]?.syncToken ?? null).toBeNull();
    expect(memory.readings.size).toBe(8);
    // Three of them are no longer turned, and nothing tells this memory: one connection is being removed, one
    // waits for the person, one account is parked for an hour.
    await w.db.update(calConnections).set({ status: "removing" }).where(eq(calConnections.id, kept[0]!.connectionId));
    await w.db.update(calConnections).set({ status: "reconnect" }).where(eq(calConnections.id, kept[1]!.connectionId));
    await parkConnection(calendarPool(w.db), kept[2]!.due, new Date(now + 3_600_000));
    // The ninth takes one of the three places and ends; the five that are still read keep theirs.
    expect([await turn(), await turn(), await turn()]).toEqual([true, true, false]);
    expect((await calendarsOf(w, ninth.accountId))[0]?.syncToken ?? null).not.toBeNull();
    expect([...new Set([...memory.readings.values()].map((r) => r.connectionId))].sort()).toEqual(kept.slice(3).map((t) => t.connectionId).sort());
  }, 120_000);

  it("the worker's stop during a call writes no word and no wait; a turn whose own time ran out says timeout and waits", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("s", 4, 2)]]));
    const real = t.reader.readChanges.bind(t.reader);
    /** A call that stays open until its signal ends, then answers as the request port does. */
    const hangs = (opened: () => void): typeof t.reader.readChanges => ((_c: unknown, _cal: unknown, _since: unknown, _page: unknown, signal: AbortSignal) => {
      opened();
      return new Promise((res) => { signal.addEventListener("abort", () => res({ ok: false, reason: "timeout", retryAfterMs: null }), { once: true }); });
    }) as never;
    const during = async (signal: AbortController, end: () => void, deps = t.deps) => {
      let opened!: () => void;
      const open = new Promise<void>((r) => { opened = r; });
      t.reader.readChanges = hangs(opened);
      const turn = calendarSyncPass(deps, t.due, signal.signal);
      await open;
      end();
      return turn;
    };

    let stopping = false;
    const stop = new AbortController();
    expect(await during(stop, () => { stopping = true; stop.abort(); }, { ...t.deps, halted: () => stopping })).toEqual({ kind: "halted" });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null, nextPollAt: null });

    // The turn's own time, while a call is open: the connection says so and waits.
    const late = new AbortController();
    expect(await during(late, () => late.abort(new CalendarTurnOverdue()))).toMatchObject({ kind: "backed_off", word: "timeout" });
    const waiting = await connectionOf(w, t.accountId, t.connectionId);
    expect(waiting.errorCode).toBe("timeout");
    expect(waiting.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // And between two pages: the first page is kept, the turn ends with its word, not as if the worker stopped.
    const between = new AbortController();
    t.reader.readChanges = async (...args) => {
      const answer = await real(...args);
      between.abort(new CalendarTurnOverdue());
      return answer;
    };
    await makeDue(t.accountId);
    expect(await calendarSyncPass(t.deps, t.due, between.signal)).toMatchObject({ kind: "backed_off", word: "timeout" });
    expect((await eventsOf(w, t.accountId)).length).toBe(2);
    expect(t.deps.memory.readings.size).toBe(0);
  }, 60_000);

  it("a turn that threw has its word written: unknown and a wait, failing from the third in a row; a key ring that cannot open writes the wait alone", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("u", 2, 2)]]));
    t.reader.readChanges = async () => { throw new Error("a fault of this program"); };
    const throwsAndSettles = async () => {
      await makeDue(t.accountId);
      const err = await calendarSyncPass(t.deps, t.due, never).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const until = await calendarTurnFailed(t.deps, t.due, err);
      return { until, row: await connectionOf(w, t.accountId, t.connectionId) };
    };
    const first = await throwsAndSettles();
    expect(first.row).toMatchObject({ status: "active", errorCode: "unknown" });
    expect(first.until).toBe(first.row.nextPollAt!.getTime());
    expect(first.until!).toBeGreaterThan(Date.now() + 30_000);
    await throwsAndSettles();
    expect((await throwsAndSettles()).row).toMatchObject({ status: "failing", errorCode: "unknown" });
    expect((await changesOf(w, t.accountId))["calendar_connection:update"]).toBe(2);

    // The host's key ring is nobody's sign-in: the row waits and says nothing.
    const k = await caldavWorld(new Map([["", eventsInPages("k", 2, 2)]]));
    const until = await calendarTurnFailed(k.deps, k.due, new CalendarKeyRingFault());
    expect(await connectionOf(w, k.accountId, k.connectionId)).toMatchObject({ status: "active", errorCode: null, nextPollAt: new Date(until!) });
    expect(until!).toBeGreaterThan(Date.now() + 30_000);
    expect(await changesOf(w, k.accountId)).toEqual({});
  }, 60_000);

  it("an object the store cannot keep is left out alone: its neighbours are stored, its old copy stays, and the reading ends", async () => {
    const nul = String.fromCharCode(0);
    const first: ScriptedPage[] = [{ items: [
      upsert("a.ics", "v1", single("a@x.test", 17)), upsert("bad.ics", "v1", single("bad@x.test", 18, "Fine at first")), upsert("b.ics", "v1", single("b@x.test", 19)),
    ] }];
    const t = await caldavWorld(new Map([["", first]]), () => null);
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", changed: 4 });
    // Read whole again: the same object now carries U+0000 in its title, and four more carry what no row can hold.
    const second: ScriptedPage[] = [{ items: [
      upsert("a.ics", "v1", single("a@x.test", 17)),
      upsert("bad.ics", "v2", single("bad@x.test", 18, `Kiln${nul}day`)),
      upsert("notes.ics", "v1", single("notes@x.test", 20, "Notes", [`DESCRIPTION:bring${nul}clay`])),
      upsert("guest.ics", "v1", single("guest@x.test", 21, "Guest", [`ATTENDEE;CN=Mi${nul}la:mailto:mila@x.test`])),
      // A zone's name with half a pair of code units: the excluded days are kept as JSON, which takes no such text.
      upsert("zone.ics", "v1", { ...single("zone@x.test", 22, "Zone"), excluded: [zoned(wall(2026, 11, 23, 9), "Europe/\ud800")] }),
      upsert("seq.ics", "v1", { ...single("seq@x.test", 23, "Sequence"), sequence: 3_000_000_000 }),
      upsert("b.ics", "v1", single("b@x.test", 19)),
      upsert("c.ics", "v1", single("c@x.test", 24)),
    ] }];
    const reader = scriptedReader("caldav", { readings: new Map([["", second]]), endToken: () => "after" });
    await makeDue(t.accountId);
    const outcome = await calendarSyncPass(depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { memory: t.deps.memory }), t.due, never);
    expect(outcome).toMatchObject({ kind: "synced", changed: 1, dropped: 0 });
    expect((await eventsOf(w, t.accountId)).map((e) => `${e.providerId} ${e.title} ${e.versionTag}`).sort()).toEqual([
      "a.ics Event a@x.test v1", "b.ics Event b@x.test v1", "bad.ics Fine at first v1", "c.ics Event c@x.test v1",
    ]);
    expect((await calendarsOf(w, t.accountId))[0]).toMatchObject({ syncToken: "after", errorCode: null });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
  }, 60_000);

  /** An event from 09:00 UTC on a day of November 2026, as long as `length` says: a DURATION, and no DTEND. */
  const lasting = (uid: string, day: number, length: string) =>
    eventOf([`UID:${uid}`, "DTSTAMP:20261113T120000Z", `DTSTART:202611${String(day).padStart(2, "0")}T090000Z`, `DURATION:${length}`, `SUMMARY:Event ${uid}`]);
  /** A zone source that answers, for one zone, a distance from UTC no clock has: a time in that zone derives no moment a Date holds. */
  const ELSEWHERE = "Studio/Elsewhere";
  const elsewhere: ZoneSource = { offsetAt: (tzid, ms, left) => (tzid === ELSEWHERE ? 9e15 : ZONES.offsetAt(tzid, ms, left)) };
  /** An event that starts in that zone and ends at a moment in UTC: its start alone derives no moment. */
  const startsElsewhere = (uid: string) =>
    eventOf([`UID:${uid}`, "DTSTAMP:20261113T120000Z", `DTSTART;TZID=${ELSEWHERE}:20261118T090000`, "DTEND:20261118T100000Z", `SUMMARY:Event ${uid}`]);
  /** A day replaced at a moment past the last one a Date holds: its key, sixteen digits, fits the store's bound and names no moment. */
  const pastTheLastMoment = { kind: "instant" as const, epochMs: 9e15 };
  /** What the log said was left out: one count for each page that left something out. */
  const refusedCounts = (lines: readonly string[]): unknown[] =>
    lines.map((l) => JSON.parse(l) as { event?: string; count?: number }).filter((l) => l.event === "calendar_objects_refused").map((l) => l.count);

  it("the mapper calls unstorable an object one of whose values no row can hold, whichever value it is", () => {
    const nul = String.fromCharCode(0);
    const reasonOf = (item: ChangeItem, zones: ZoneSource = ZONES): string => {
      const mapped = rowsOfObject([item as never], { zones, ownAddresses: new Set() });
      return mapped.ok ? "kept" : mapped.reason;
    };
    const cannot: Record<string, ChangeItem> = {
      "the title": upsert("t.ics", "v1", single("t@x.test", 18, `Kiln${nul}day`)),
      "the notes": upsert("n.ics", "v1", single("n@x.test", 18, "Notes", [`DESCRIPTION:bring${nul}clay`])),
      "the place": upsert("p.ics", "v1", single("p@x.test", 18, "Place", [`LOCATION:Hall${nul}B`])),
      "an invitee's name": upsert("g.ics", "v1", single("g@x.test", 18, "Guest", [`ATTENDEE;CN=Mi${nul}la:mailto:mila@x.test`])),
      "the UID": upsert("u.ics", "v1", { ...single("u@x.test", 18), uid: `u${nul}@x.test` }),
      "the id": upsert(`i${nul}.ics`, "v1", single("i@x.test", 18)),
      "a zone, half a pair": upsert("z.ics", "v1", { ...single("z@x.test", 18), excluded: [zoned(wall(2026, 11, 23, 9), "Europe/\ud800")] }),
      "the counter": upsert("s.ics", "v1", { ...single("s@x.test", 18), sequence: 3_000_000_000 }),
      // A row is found again by these three: half a pair in one of them is written as another character, and the row is lost to its own name.
      "the id, half a pair": upsert("i\ud800.ics", "v1", single("ih@x.test", 18)),
      "the UID, half a pair": upsert("uh.ics", "v1", { ...single("uh@x.test", 18), uid: "u\udc00@x.test" }),
      // A time a row's range is derived from, whose moment no Date holds: the end, and the day a changed day replaces.
      "a length that derives no moment": upsert("l.ics", "v1", lasting("l@x.test", 18, "P999999999W")),
      "a replaced day that derives no moment": upsert("r.ics", "v1", { ...single("r@x.test", 18), recurrenceId: pastTheLastMoment }),
    };
    expect(Object.fromEntries(Object.entries(cannot).map(([what, item]) => [what, reasonOf(item)])))
      .toEqual(Object.fromEntries(Object.keys(cannot).map((what) => [what, "unstorable"])));
    expect(reasonOf(upsert("fine.ics", "v1", single("fine@x.test", 18, "Kiln day 🏺")))).toBe("kept");
    // And the start, where the zones answer a distance from UTC that no clock has.
    expect(reasonOf(upsert("e.ics", "v1", startsElsewhere("e@x.test")), elsewhere)).toBe("unstorable");
    // 9,999,999 days on (the year 29,405) is a moment a Date holds: whether a row keeps it is the store's to say, not the mapper's.
    expect(reasonOf(upsert("d.ics", "v1", lasting("d@x.test", 18, "P9999999D")))).toBe("kept");
    // A version is handed back to its provider letter for letter: one the store cannot hold is kept as none, and the object is kept.
    const versionOf = (version: string): unknown => {
      const mapped = rowsOfObject([upsert("v.ics", version, single("v@x.test", 18)) as never], { zones: ZONES, ownAddresses: new Set() });
      return mapped.ok ? mapped.rows[0]?.values.versionTag : mapped.reason;
    };
    expect([versionOf("v1"), versionOf(`v${nul}1`), versionOf("v\ud800")]).toEqual(["v1", null, null]);
  });

  it("what a page names by a text no row can hold is left out alone and counted: a removal, a cancelled day, an object's id; the page beside it is written and the reading ends", async () => {
    const nul = String.fromCharCode(0);
    const captured = capturedLog();
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const cancelled = (uid: string, zone = "Europe/Zurich"): ChangeItem => ({ kind: "cancelled_occurrence", uid, originalStart: zoned(wall(2026, 11, 24, 18), zone) });
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("a", "e1", single("a@x.test", 17)), upsert("wheel", "e1", wheel())] }]],
      ["g1", [{ items: [
        { kind: "gone", id: `go${nul}ne` },
        cancelled(`se${nul}ries@x.test`),
        // The series is stored, but the day is named in a zone whose name no row holds.
        cancelled("wheel@x.test", `Europe/${nul}Zurich`),
        upsert(`ba${nul}d`, "e1", single("bad@x.test", 18)),
        { kind: "gone", id: "go\ud800ne" },
        upsert("b", "e1", single("b@x.test", 19)),
        { kind: "gone", id: "a" },
      ] }]],
    ]);
    const reader = scriptedReader("google", { readings, endToken: (since) => (since === null ? "g1" : "g2") });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null }, log: captured.log });
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", changed: 3 });
    await makeDue(seeded.accountId);
    // The page's two that can be kept: the new event, and the removal of the first.
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", changed: 2 });
    expect((await eventsOf(w, seeded.accountId)).map((e) => ({ id: e.providerId, excluded: e.excluded }))).toEqual([{ id: "b", excluded: [] }, { id: "wheel", excluded: [] }]);
    expect((await calendarsOf(w, seeded.accountId))[0]).toMatchObject({ syncToken: "g2", errorCode: null });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });
    // Said as a count, and as nothing else: the five that were left out.
    const refused = captured.lines.map((l) => JSON.parse(l) as { event?: string; count?: number }).filter((l) => l.event === "calendar_objects_refused");
    expect(refused.map((l) => l.count)).toEqual([5]);
  }, 60_000);

  it("an event whose start derives no moment is left out and counted: the events beside it are stored and the reading ends", async () => {
    const captured = capturedLog();
    const t = await caldavWorld(new Map([["", [{ items: [
      upsert("a.ics", "v1", single("a@x.test", 17)), upsert("far.ics", "v1", startsElsewhere("far@x.test")), upsert("b.ics", "v1", single("b@x.test", 19)),
    ] }]]]), () => "after");
    // The calendar's row, and the two events.
    expect(await calendarSyncPass({ ...t.deps, zones: elsewhere, log: captured.log }, t.due, never)).toMatchObject({ kind: "synced", changed: 3 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId)).toEqual(["a.ics", "b.ics"]);
    expect((await calendarsOf(w, t.accountId))[0]).toMatchObject({ syncToken: "after", errorCode: null });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
    expect(refusedCounts(captured.lines)).toEqual([1]);
  }, 60_000);

  it("a changed day whose replaced day derives no moment is left out and counted: its series and the event beside it are stored and the reading ends", async () => {
    const captured = capturedLog();
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    const readings = new Map<string, readonly ScriptedPage[]>([["", [{ items: [
      upsert("wheel", "e1", wheel()), upsert("wheel_far", "e1", { ...wheelMoved, recurrenceId: pastTheLastMoment }), upsert("solo", "e1", single("solo@x.test", 19)),
    ] }]]]);
    const reader = scriptedReader("google", { readings, endToken: () => "g1" });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null }, log: captured.log });
    // The calendar's row, the series and the event beside it.
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", changed: 3 });
    expect((await eventsOf(w, seeded.accountId)).map((e) => e.providerId)).toEqual(["solo", "wheel"]);
    expect((await calendarsOf(w, seeded.accountId))[0]).toMatchObject({ syncToken: "g1", errorCode: null });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });
    expect(refusedCounts(captured.lines)).toEqual([1]);
  }, 60_000);

  it("a cancelled day in a zone the platform knows under a vendor's prefix keeps that name in the excluded days: one the store cannot hold is refused by the day's own statement, that day alone left out and counted", async () => {
    const nul = String.fromCharCode(0);
    const captured = capturedLog();
    const seeded = await seedConnection(w, { provider: "google", credential: google });
    // `/mozilla.org/<x>/Europe/Zurich` is Europe/Zurich to the platform: the day's key is its moment, whatever `<x>` holds.
    const cancelled = (day: number, month: number, x: string): ChangeItem =>
      ({ kind: "cancelled_occurrence", uid: "wheel@x.test", originalStart: zoned(wall(2026, month, day, 18), `/mozilla.org/${x}/Europe/Zurich`) });
    const readings = new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel", "e1", wheel()), upsert("a", "e1", single("a@x.test", 17))] }]],
      ["g1", [{ items: [cancelled(24, 11, nul), cancelled(1, 12, "\ud800"), cancelled(8, 12, "20050126_1"), upsert("b", "e1", single("b@x.test", 19))] }]],
    ]);
    const reader = scriptedReader("google", { readings, endToken: (since) => (since === null ? "g1" : "g2") });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null }, log: captured.log });
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", changed: 3 });
    await makeDue(seeded.accountId);
    // The new event, and the series' one day the store can hold, kept under the zone's name as the provider wrote it.
    expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", changed: 2 });
    const [series] = await w.db.select({ excluded: calEvents.excludedDates }).from(calEvents)
      .where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.providerId, "wheel")));
    expect(series?.excluded).toEqual([{ kind: "zoned", value: "20261208T180000", zone: "/mozilla.org/20050126_1/Europe/Zurich" }]);
    expect((await eventsOf(w, seeded.accountId)).map((e) => e.providerId)).toEqual(["a", "b", "wheel"]);
    expect((await calendarsOf(w, seeded.accountId))[0]).toMatchObject({ syncToken: "g2", errorCode: null });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });
    expect(refusedCounts(captured.lines)).toEqual([2]);
  }, 60_000);

  it("a reading's end the store cannot hand back is kept as none, and a listed calendar it cannot name is not kept; its name, colour and zone are kept as the store keeps them", async () => {
    const nul = String.fromCharCode(0);
    const listed = [
      { id: "cal-1", name: `Stu${nul}dio`, color: `#aa${nul}bbcc`, writable: true, byToken: true, zone: `Europe/${nul}Zurich` },
      { id: `cal${nul}2`, name: "No row can name it", color: null, writable: true, byToken: true, zone: null },
      { id: "cal-3", name: "Mar\ud800ket", color: null, writable: true, byToken: true, zone: null },
    ];
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { calendars: listed, readings: new Map([["", eventsInPages("e", 2, 2)]]), endToken: () => `to${nul}ken` });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    const turn = async () => {
      deps.memory.listedAt.clear();
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", calendars: 2 });
      return (await calendarsOf(w, seeded.accountId)).map((c) => ({ id: c.providerId, name: c.name, color: c.color, zone: c.timeZone, token: c.syncToken }));
    };
    expect(await turn()).toEqual([
      { id: "cal-1", name: "Studio", color: "#aabbcc", zone: "Europe/Zurich", token: null },
      { id: "cal-3", name: "Mar\ufffdket", color: null, zone: null, token: null },
    ]);
    expect((await eventsOf(w, seeded.accountId)).length).toBe(4);
    // No token: each round reads the calendar whole again, which is slow and never wrong. And a name kept as the
    // store keeps it is the same name at the next listing: nothing is written for it again.
    const before = await changesOf(w, seeded.accountId);
    reader.calls.length = 0;
    await turn();
    expect(reader.calls.map((c) => c.since)).toEqual([null, null]);
    expect(await changesOf(w, seeded.accountId)).toEqual({ ...before, "calendar_connection:update": before["calendar_connection:update"]! + 1 });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });
  }, 60_000);

  it("a row the store refuses for what it holds is left out by itself: the rest of its transaction is written", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("r", 1, 1)]]));
    await calendarSyncPass(t.deps, t.due, never);
    const [cal] = await calendarsOf(w, t.accountId);
    const apply = {
      db: passDb(calendarPool(w.db), t.accountId), key: { accountId: t.accountId, id: t.connectionId },
      calendar: { id: cal!.id, providerId: cal!.providerId }, zones: ZONES, unite: false, shown: null, halted: () => false,
    };
    const rowsOf = (id: string, day: number) => {
      const mapped = rowsOfObject([upsert(id, "v1", single(`${id}@x.test`, day)) as never], { zones: ZONES, ownAddresses: new Set() });
      if (!mapped.ok) throw new Error("the test's object did not map");
      return mapped.rows;
    };
    // An event that neither ends nor repeats is one the store's own rule refuses, whatever let it through.
    const refused = rowsOf("refused.ics", 12).map((r) => ({ ...r, values: { ...r.values, endsAt: null } }));
    const works: Work[] = [objectWrite("x.ics", rowsOf("x.ics", 11), [], false), objectWrite("refused.ics", refused, [], false), objectWrite("y.ics", rowsOf("y.ics", 13), [], false)];
    expect(await applyChunks(apply, chunksOf(works))).toEqual({ ok: true, changed: 2, refused: 1 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId).sort()).toEqual(["r0.ics", "x.ics", "y.ics"]);
    // A fault that is not about a row's content is nobody's object to leave out: it is thrown, and the turn with it.
    const broken = { ...apply, db: passDb(calendarPool({} as never), t.accountId) };
    await expect(applyChunks(broken, chunksOf(works))).rejects.toThrow();
    // So is a required column left empty: that is this program's omission (or a newer table's), and leaving
    // every object out for it would empty a calendar without a word.
    const unfilled = rowsOf("unfilled.ics", 14).map((r) => ({ ...r, values: { ...r.values, startLocal: null as never } }));
    await expect(applyChunks(apply, chunksOf([objectWrite("unfilled.ics", unfilled, [], false), objectWrite("z.ics", rowsOf("z.ics", 15), [], false)]))).rejects.toThrow();
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId).sort()).toEqual(["r0.ics", "x.ics", "y.ics"]);
  }, 60_000);

  it("a refusal of the store that no object's own rows raised is nobody's object to leave out: with the change log's counter at its end the turn is thrown, and the token stays", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("o", 2, 2)], ["tok", eventsInPages("late", 3, 3)]]), (since) => (since === null ? "tok" : "tok-2"));
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", changed: 3 });
    const [cal] = await calendarsOf(w, t.accountId);
    const apply = {
      db: passDb(calendarPool(w.db), t.accountId), key: { accountId: t.accountId, id: t.connectionId },
      calendar: { id: cal!.id, providerId: cal!.providerId }, zones: ZONES, unite: false, shown: null, halted: () => false,
    };
    const write = (id: string, day: number, title?: string): Work => {
      const mapped = rowsOfObject([upsert(id, "v1", single(`${id}@x.test`, day)) as never], { zones: ZONES, ownAddresses: new Set() });
      if (!mapped.ok) throw new Error("the test's object did not map");
      return objectWrite(id, mapped.rows.map((r) => (title === undefined ? r : { ...r, values: { ...r.values, title } })), [], false);
    };
    // A value no column takes, in one object's own row (whatever let it past the mapper): that object's alone.
    const works = [write("x.ics", 11), write("nul.ics", 12, `Kiln${String.fromCharCode(0)}day`), write("y.ics", 13)];
    expect(await applyChunks(apply, chunksOf(works))).toEqual({ ok: true, changed: 2, refused: 1 });

    // A refusal of the same class (22) from the change log's own statement: the account's counter stands at the end of its numbers.
    const moved = await w.sql`update account_sync_state set next_seq = 9223372036854775807 where account_id = ${t.accountId} returning account_id`;
    expect(moved.length).toBe(1);
    await makeDue(t.accountId);
    // No object raised it, so none is left out for it: counted as theirs, every object of the page would be, and the token would move on past them.
    const thrown = await calendarSyncPass(t.deps, t.due, never).then(() => null, (e: unknown) => e);
    const codes: unknown[] = [];
    for (let e = thrown as { code?: unknown; cause?: unknown } | null | undefined; e; e = e.cause as typeof e) codes.push(e.code);
    expect({
      thrown: codes.includes("22003"), token: (await calendarsOf(w, t.accountId))[0]?.syncToken, events: (await eventsOf(w, t.accountId)).map((e) => e.providerId),
    }).toEqual({ thrown: true, token: "tok", events: ["o0.ics", "o1.ics", "x.ics", "y.ics"] });
  }, 60_000);

  it("a page of more ids than one statement carries, and an event of more invitees, are read in slices", async () => {
    const many = 66_000;
    const invited = Array.from({ length: 12_000 }, (_, i) => `ATTENDEE:mailto:guest${i}@x.test`);
    const second: ChangeItem[] = [upsert("crowd.ics", "v1", single("crowd@x.test", 20, "Crowd", invited))];
    for (let i = 0; i < many; i++) second.push({ kind: "gone", id: `never-stored-${i}.ics` });
    for (let i = 0; i < many; i++) second.push({ kind: "cancelled_occurrence", uid: `no-series-${i}@x.test`, originalStart: zoned(wall(2026, 11, 24, 18), "Europe/Zurich") });
    const t = await caldavWorld(new Map([["", eventsInPages("i", 2, 2)], ["tok", [{ items: second }]]]), () => "tok");
    await calendarSyncPass(t.deps, t.due, never);
    await makeDue(t.accountId);
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", changed: 1 });
    expect((await eventsOf(w, t.accountId)).map((e) => e.providerId).sort()).toEqual(["crowd.ics", "i0.ics", "i1.ics"]);
    expect((await childrenOf(w, t.accountId)).invitees).toBe(12_000);
  }, 120_000);

  it("a calendar the account switched off, or a provider not served, is not read and nothing is opened", async () => {
    const off = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER, calendarOn: false });
    const reader = scriptedReader("caldav", { readings: new Map([["", eventsInPages("o", 2, 2)]]) });
    let opened = 0;
    const keys = Object.assign(Object.create(Object.getPrototypeOf(w.keys)), w.keys, {
      decrypt: async (...a: Parameters<typeof w.keys.decrypt>) => { opened += 1; return w.keys.decrypt(...a); },
    }) as typeof w.keys;
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { keys });
    expect(await calendarSyncPass(deps, off.due, never)).toEqual({ kind: "off", why: "calendar_off" });
    const unserved = await seedConnection(w, { provider: "ics", credential: { kind: "address", url: new Secret("https://feeds.example.test/a.ics") } });
    expect(await calendarSyncPass(deps, unserved.due, never)).toEqual({ kind: "off", why: "provider_off" });
    expect((await connectionOf(w, unserved.accountId, unserved.connectionId)).errorCode).toBe("provider_off");
    expect({ opened, lists: reader.lists, reads: reader.calls.length }).toEqual({ opened: 0, lists: 0, reads: 0 });
  }, 60_000);

  it("publishes existing event records when a calendar leaves and regains owner access", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("e", 2, 2)]]), () => "unchanged");
    let owned = true;
    t.reader.listCalendars = async () => ({ ok: true, value: [
      { id: "cal-1", name: "Studio", color: null, writable: true, owned, byToken: true, zone: null },
    ] });
    const relist = async () => {
      t.deps.memory.listedAt.clear();
      await makeDue(t.accountId);
      expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced" });
      return await changesOf(w, t.accountId);
    };
    const first = await relist();
    const count = (await eventsOf(w, t.accountId)).length;
    expect(count).toBeGreaterThan(0);
    owned = false;
    const shared = await relist();
    expect(shared["calendar_event:update"] ?? 0).toBe((first["calendar_event:update"] ?? 0) + count);
    owned = true;
    const regained = await relist();
    expect(regained["calendar_event:update"]).toBe(shared["calendar_event:update"]! + count);
  });

  it("a calendar the listing stops naming goes at the second listing in a row; a listing that names none removes nothing", async () => {
    const two = [
      { id: "cal-1", name: "Studio", color: null, writable: true, byToken: true, zone: null },
      { id: "cal-2", name: "Market", color: null, writable: true, byToken: true, zone: null },
    ];
    let listed: typeof two = two;
    const t = await caldavWorld(new Map([["", eventsInPages("l", 2, 2)]]));
    t.reader.listCalendars = async () => ({ ok: true, value: listed });
    const relist = async () => {
      t.deps.memory.listedAt.clear();
      await makeDue(t.accountId);
      expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced" });
      return (await calendarsOf(w, t.accountId)).map((c) => c.providerId);
    };
    expect(await relist()).toEqual(["cal-1", "cal-2"]);
    listed = [];
    expect(await relist()).toEqual(["cal-1", "cal-2"]);
    expect(await relist()).toEqual(["cal-1", "cal-2"]);
    listed = [two[0]!];
    expect(await relist()).toEqual(["cal-1", "cal-2"]);
    expect(await relist()).toEqual(["cal-1"]);
    // The calendar went with its own delete, and each of its two events with one.
    expect(await changesOf(w, t.accountId)).toMatchObject({ "calendar:delete": 1, "calendar_event:delete": 2 });
    // A calendar the listing renames is written with its change.
    const updates = (await changesOf(w, t.accountId))["calendar:update"] ?? 0;
    listed = [{ ...two[0]!, name: "Studio, upstairs" }];
    expect(await relist()).toEqual(["cal-1"]);
    expect((await calendarsOf(w, t.accountId))[0]?.name).toBe("Studio, upstairs");
    expect((await changesOf(w, t.accountId))["calendar:update"]).toBe(updates + 1);
  }, 60_000);

  it("a removed calendar of more events than one transaction records goes in parts, each event with its delete", async () => {
    const two = [
      { id: "cal-1", name: "Studio", color: null, writable: true, byToken: true, zone: null },
      { id: "cal-2", name: "Market", color: null, writable: true, byToken: true, zone: null },
    ];
    let listed: typeof two = two;
    const t = await caldavWorld(new Map([["", eventsInPages("z", 450, 250)]]), () => null);
    t.reader.listCalendars = async () => ({ ok: true, value: listed });
    const relist = async () => {
      t.deps.memory.listedAt.clear();
      await makeDue(t.accountId);
      const turns = await turnsUntilDone(t.deps, t.due);
      expect(turns.at(-1)).toMatchObject({ kind: "synced", more: false });
    };
    await relist();
    expect((await eventsOf(w, t.accountId)).length).toBe(900);
    listed = [two[0]!];
    await relist();
    await relist();
    expect((await calendarsOf(w, t.accountId)).map((c) => c.providerId)).toEqual(["cal-1"]);
    expect((await eventsOf(w, t.accountId)).length).toBe(450);
    expect(await changesOf(w, t.accountId)).toMatchObject({ "calendar:delete": 1, "calendar_event:delete": 450 });
    const per = await w.db.select({ n: sql<number>`count(*)::int` }).from(changeLog).where(eq(changeLog.accountId, t.accountId)).groupBy(changeLog.createdAt);
    expect(Math.max(...per.map((r) => Number(r.n)))).toBeLessThanOrEqual(200);
  }, 120_000);

  it("a calendar's removal the worker's stop cut short leaves no token behind: listed again, the calendar is read whole and its events come back", async () => {
    const two = [
      { id: "cal-1", name: "Studio", color: null, writable: true, byToken: true, zone: null },
      { id: "cal-2", name: "Market", color: null, writable: true, byToken: true, zone: null },
    ];
    // Read by token: a reading from the token shows nothing new.
    const t = await caldavWorld(new Map([["", eventsInPages("c", 450, 250)], ["tok", [{ items: [] }]]]), () => "tok");
    t.reader.listCalendars = async () => ({ ok: true, value: two });
    await turnsUntilDone(t.deps, t.due);
    expect((await eventsOf(w, t.accountId)).length).toBe(900);
    const market = (await calendarsOf(w, t.accountId)).find((c) => c.providerId === "cal-2")!;
    expect(market.syncToken).toBe("tok");
    // The calendar waits, as one does that stands at a word: on its own time it would not be asked again for a day.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await w.db.update(calCalendars).set({ nextPollAt: tomorrow }).where(eq(calCalendars.accountId, t.accountId));
    // Its removal, as two listings in a row begin it, cut by the stop after its first two hundred events.
    let rounds = 0;
    const cut = await removeCalendar({
      db: passDb(calendarPool(w.db), t.accountId), key: { accountId: t.accountId, id: t.connectionId }, memory: t.deps.memory, halted: () => ++rounds > 1,
    }, market.id);
    expect(cut).toEqual({ ok: false, why: "halted" });
    expect((await eventsOf(w, t.accountId)).length).toBe(700);
    // Its copy is no longer whole, so its row says what a calendar nobody has read says: no token, and due at once.
    expect((await calendarsOf(w, t.accountId)).map((c) => ({ id: c.providerId, token: c.syncToken, at: c.nextPollAt }))).toEqual([
      { id: "cal-1", token: "tok", at: tomorrow }, { id: "cal-2", token: null, at: null },
    ]);
    // A new process, and the provider lists the calendar again: it alone is read, whole, and its events come back.
    const fresh = depsFor(w, providersOf({ caldav: { reader: t.reader, http: silentHttp() } }));
    t.reader.calls.length = 0;
    await turnsUntilDone(fresh, t.due);
    expect(t.reader.calls).toEqual([{ since: null, cursor: null }, { since: null, cursor: "1" }]);
    expect((await eventsOf(w, t.accountId)).length).toBe(900);
    expect((await calendarsOf(w, t.accountId)).map((c) => c.syncToken)).toEqual(["tok", "tok"]);
  }, 120_000);

  it("a calendar's removal that its own bound cut short leaves no reading behind in a process that lives on: the calendar is read again from its first page", async () => {
    // A first reading of twelve pages, eight of them read and its place kept.
    const t = await caldavWorld(new Map([["", eventsInPages("k", 12, 1)]]), () => "tok");
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced", pages: 8, more: true });
    const [cal] = await calendarsOf(w, t.accountId);
    // Its removal begins, and somebody writes into the calendar ahead of each of the removal's transactions: the bound ends it with the row still there.
    let transactions = 0;
    const meanwhile = dbWith(async () => {
      transactions += 1;
      if (transactions > 1) await strangersEvent(t.accountId, cal!.id, transactions);
    });
    const cut = await removeCalendar({
      db: passDb(calendarPool(meanwhile.db), t.accountId), key: { accountId: t.accountId, id: t.connectionId }, memory: t.deps.memory, halted: () => false,
    }, cal!.id).finally(() => meanwhile.end());
    expect(cut).toMatchObject({ ok: true, whole: false });
    expect(await eventsOf(w, t.accountId)).toEqual([]);
    // The same process goes on: the first eight pages' events are gone from the store, so the reading that named them is no reading to go on with.
    t.reader.calls.length = 0;
    await turnsUntilDone(t.deps, t.due);
    expect(t.reader.calls.map((c) => c.cursor)).toEqual([null, ...Array.from({ length: 11 }, (_, i) => String(i + 1))]);
    expect((await eventsOf(w, t.accountId)).length).toBe(12);
    expect((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe("tok");
  }, 120_000);

  it("a calendar's removal takes one transaction more than the events it held at its start need, and no more: written into meanwhile, it stops with the row still there, and the next listing ends it", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("b", 2, 2)]]), () => "tok");
    await calendarSyncPass(t.deps, t.due, never);
    const [cal] = await calendarsOf(w, t.accountId);
    const removal = (db: World["db"]) => removeCalendar({
      db: passDb(calendarPool(db), t.accountId), key: { accountId: t.accountId, id: t.connectionId }, memory: t.deps.memory, halted: () => false,
    }, cal!.id);
    // Somebody writes an event into the calendar ahead of each of the removal's transactions, six times over.
    let transactions = 0;
    const meanwhile = dbWith(async () => {
      transactions += 1;
      if (transactions > 1 && transactions <= 7) await strangersEvent(t.accountId, cal!.id, transactions);
    });
    // Two events at its count: one transaction for them and one more. Not a third, whatever was written since.
    expect(await removal(meanwhile.db).finally(() => meanwhile.end())).toEqual({ ok: true, changed: 4, whole: false });
    expect(transactions).toBe(3);
    expect((await calendarsOf(w, t.accountId)).length).toBe(1);
    // The row stays for the next listing, which goes on and ends it.
    expect(await removal(w.db)).toEqual({ ok: true, changed: 1, whole: true });
    expect(await calendarsOf(w, t.accountId)).toEqual([]);
  }, 60_000);

  it("a cancelled day's work removes as many changed rows of that day as it was counted for, never more: no transaction passes its count", async () => {
    // Three objects of their own for the one evening of one series: their ids differ, the UID and the day are one.
    const t = await googleWorld(new Map<string, readonly ScriptedPage[]>([
      ["", [{ items: [upsert("wheel_a", "e1", wheelMoved), upsert("wheel_b", "e1", wheelMoved), upsert("wheel_c", "e1", wheelMoved)] }]],
    ]));
    expect(await t.turn()).toEqual(["wheel_a", "wheel_b", "wheel_c"]);
    const [cal] = await calendarsOf(w, t.accountId);
    const apply = {
      db: passDb(calendarPool(w.db), t.accountId), key: { accountId: t.accountId, id: t.connectionId },
      calendar: { id: cal!.id, providerId: cal!.providerId }, zones: ZONES, unite: true, shown: null, halted: () => false,
    };
    const time = zoned(wall(2026, 11, 24, 18), "Europe/Zurich");
    // Counted while one such row was stored: one change for the series, one for that row. Two more were written since.
    const work: Work = { kind: "cancelled", uid: "wheel@x.test", key: occurrenceKey(time, ZONES), time, changes: 2 };
    expect(await applyChunks(apply, chunksOf([work]))).toEqual({ ok: true, changed: 1, refused: 0 });
    expect((await eventsOf(w, t.accountId)).length).toBe(2);
  }, 60_000);

  it("CalDAV: a changed day that leaves its object goes with its delete, and the object's own excluded days replace the stored ones", async () => {
    const text = "BEGIN:VCALENDAR";
    const series = (more: readonly string[] = []) => eventOf(["UID:dav@x.test", "DTSTAMP:20261113T120000Z", "DTSTART;TZID=Europe/Zurich:20261117T180000",
      "DTEND;TZID=Europe/Zurich:20261117T190000", "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:Wheel class", ...more]);
    const moved = (day: string) => eventOf(["UID:dav@x.test", "DTSTAMP:20261113T130000Z", `RECURRENCE-ID;TZID=Europe/Zurich:${day}T180000`,
      `DTSTART;TZID=Europe/Zurich:${day}T200000`, `DTEND;TZID=Europe/Zurich:${day}T210000`, "SUMMARY:Wheel class, later"]);
    const version = (v: string, events: readonly ReturnType<typeof series>[]): ScriptedPage[] => [{ items: events.map((e) => upsert("wheel.ics", v, e, text)) }];
    const readings = new Map<string, readonly ScriptedPage[]>([["", version("v1", [series(), moved("20261124"), moved("20261201")])]]);
    const t = await caldavWorld(readings, () => "tok");
    const turn = async () => {
      await makeDue(t.accountId);
      expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced" });
      return (await eventsOf(w, t.accountId)).map((e) => ({ day: e.recurrenceId === "" ? "series" : "changed", excluded: e.excluded }));
    };
    expect(await turn()).toEqual([{ day: "series", excluded: [] }, { day: "changed", excluded: [] }, { day: "changed", excluded: [] }]);
    // The evening of 24 November is cancelled in the object itself: its changed day is gone from the text, and the series excludes it.
    readings.set("tok", version("v2", [series(["EXDATE;TZID=Europe/Zurich:20261124T180000"]), moved("20261201")]));
    expect(await turn()).toEqual([{ day: "series", excluded: ["20261124T180000"] }, { day: "changed", excluded: [] }]);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(1);
    // And brought back in the object: the stored excluded day is replaced, not kept.
    readings.set("tok", version("v3", [series(), moved("20261201")]));
    expect(await turn()).toEqual([{ day: "series", excluded: [] }, { day: "changed", excluded: [] }]);
  }, 60_000);

  it("a reading that never ends is ended: after four hundred pages, or more ids than a reading may name, the calendar says so and waits a day", async () => {
    const endless = async () => {
      const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
      const reader = scriptedReader("caldav", { readings: new Map() });
      const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { turn: { pages: 150, ms: 600_000 } });
      const turns = async (): Promise<(boolean | string)[]> => {
        const out: (boolean | string)[] = [];
        for (let i = 0; i < 6; i++) {
          await makeDue(seeded.accountId);
          const o = await calendarSyncPass(deps, seeded.due, never);
          out.push(o.kind === "synced" ? o.more : o.kind);
          if (o.kind !== "synced" || !o.more) break;
        }
        return out;
      };
      const calendar = async () => (await calendarsOf(w, seeded.accountId))[0]!;
      return { reader, deps, turns, calendar };
    };
    const page = (items: ChangeItem[], next: string) => ({
      ok: true as const,
      value: { mode: "whole" as const, unchanged: false, items, left: [], expanded: null, refreshMs: null, cursor: { kind: "more" as const, value: next } },
    });

    // A provider that always has one more page.
    const pages = await endless();
    let asked = 0;
    pages.reader.readChanges = async (_c, _cal, _since, request) => {
      asked += 1;
      return page([], String(Number(request.cursor ?? "0") + 1));
    };
    expect(await pages.turns()).toEqual([true, true, false]);
    expect(asked).toBe(400);
    const stopped = await pages.calendar();
    expect(stopped).toMatchObject({ errorCode: "too_large", syncToken: null });
    expect(stopped.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(pages.deps.memory.readings.size).toBe(0);

    // One that names more objects than a reading may remember: nothing is dropped on the word of a reading that could not hold its own names.
    const names = await endless();
    names.reader.readChanges = async () => page(Array.from({ length: 100_001 }, (_, i) => ({ kind: "gone" as const, id: `named-${i}.ics` })), "1");
    expect(await names.turns()).toEqual([false]);
    expect(await names.calendar()).toMatchObject({ errorCode: "too_large", syncToken: null });
  }, 120_000);

  describe("a CalDAV server that lists its calendars at another of its hosts", () => {
    const at = (host: string, slug: string) => `https://${host}-caldav.example.test/123/calendars/${slug}/`;
    const SLUGS = ["family", "privat", "work"] as const;
    const listingAt = (host: string) => SLUGS.map((slug) => ({ id: at(host, slug), name: slug, color: null, writable: true, byToken: true, zone: null }));
    async function listedAndRead() {
      const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
      const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("kiln.ics", "v1", single("kiln", 1))] }]]]), endToken: () => null });
      let host = "p01";
      reader.listCalendars = async () => ({ ok: true, value: listingAt(host) });
      const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
      await turnsUntilDone(deps, seeded.due);
      const rows = async () => w.db.select({ id: calCalendars.id, providerId: calCalendars.providerId }).from(calCalendars)
        .where(eq(calCalendars.accountId, seeded.accountId)).orderBy(calCalendars.createdAt, calCalendars.providerId);
      const eventsIn = async (calendarId: string) => (await w.db.select({ id: calEvents.id }).from(calEvents)
        .where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.calendarId, calendarId)))).length;
      /** The next turn lists, at this host. */
      const listAt = async (next: string) => {
        host = next;
        deps.memory.listedAt.delete(seeded.connectionId);
        await makeDue(seeded.accountId);
        return turnsUntilDone(deps, seeded.due);
      };
      return { seeded, reader, deps, rows, eventsIn, listAt };
    }

    it("keeps each calendar's one row, under the address it was stored at, with its events", async () => {
      const t = await listedAndRead();
      const before = await t.rows();
      expect(before.map((r) => r.providerId)).toEqual(SLUGS.map((slug) => at("p01", slug)));
      expect(await t.listAt("p02")).toEqual([expect.objectContaining({ kind: "synced" })]);
      expect(await t.rows()).toEqual(before);
      for (const row of before) expect(await t.eventsIn(row.id)).toBe(1);
      expect(await connectionOf(w, t.seeded.accountId, t.seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });
    }, 60_000);

    it("merges rows an earlier listing stored twice: the one with the person's choice, owed writes or events stays, a row owing a write is never removed", async () => {
      const t = await listedAndRead();
      const first = await t.rows();
      const [family, privat, work] = first;
      // As an earlier build stored them: the same three calendars again, at the host the server names today.
      const again = await w.db.insert(calCalendars).values(SLUGS.map((slug) => ({
        accountId: t.seeded.accountId, connectionId: t.seeded.connectionId, providerId: at("p02", slug), name: slug, access: "owner", nextPollAt: new Date(Date.now() + WAIT_DAY_MS),
      }))).returning({ id: calCalendars.id, providerId: calCalendars.providerId });
      const [familyAgain, privatAgain, workAgain] = SLUGS.map((slug) => again.find((r) => r.providerId === at("p02", slug))!);
      // The person chose the second Privat for new events; the second Work owes a write. The second Family holds only a write
      // already applied, which is history and weighs nothing; the person hid the first Family, and the second came in shown.
      await w.db.update(calSettings).set({ newEventsCalendarId: privatAgain!.id }).where(eq(calSettings.accountId, t.seeded.accountId));
      await w.db.insert(calWrites).values([
        { accountId: t.seeded.accountId, calendarId: workAgain!.id, op: "create", payload: {}, idempotencyKey: `owed-${workAgain!.id}` },
        { accountId: t.seeded.accountId, calendarId: familyAgain!.id, op: "create", payload: {}, idempotencyKey: `applied-${familyAgain!.id}`, state: "applied" },
      ]);
      await w.db.update(calCalendars).set({ shown: false }).where(eq(calCalendars.id, family!.id));

      await t.listAt("p02");
      expect((await t.rows()).map((r) => r.id).sort()).toEqual([family!.id, privatAgain!.id, workAgain!.id].sort());
      expect(await t.eventsIn(family!.id)).toBe(1);
      // A person's hide wins over a second row stored with the default: the kept row keeps its own choice.
      expect((await w.db.select({ shown: calCalendars.shown }).from(calCalendars).where(eq(calCalendars.id, family!.id)))[0]).toEqual({ shown: false });
      // The kept rows read the calendar again; the second Family and the first Privat and Work went with their copies.
      expect(await t.eventsIn(privatAgain!.id)).toBe(1);
      expect(await t.eventsIn(workAgain!.id)).toBe(1);
      for (const gone of [familyAgain!, privat!, work!]) expect(await t.eventsIn(gone.id)).toBe(0);
      expect((await w.db.select({ id: calWrites.id }).from(calWrites).where(eq(calWrites.calendarId, workAgain!.id))).length).toBe(1);

      // A merge's removal leaves a row that came to owe a write after the merge looked, with its events, and says it was not whole.
      const ctx = { db: passDb(calendarPool(w.db), t.seeded.accountId), key: { accountId: t.seeded.accountId, id: t.seeded.connectionId }, memory: t.deps.memory, halted: () => false };
      expect(await removeCalendar(ctx, workAgain!.id, { unlessOwed: true })).toEqual({ ok: true, changed: 0, whole: false });
      expect((await t.rows()).map((r) => r.id)).toContain(workAgain!.id);
      expect(await t.eventsIn(workAgain!.id)).toBe(1);
    }, 60_000);

    it("a merge's removal leaves a row the person made the calendar for new events, or that a waiting or refused move goes to, after the merge looked, with its events", async () => {
      const t = await listedAndRead();
      const [family, privat, work] = await t.rows();
      const ctx = { db: passDb(calendarPool(w.db), t.seeded.accountId), key: { accountId: t.seeded.accountId, id: t.seeded.connectionId }, memory: t.deps.memory, halted: () => false };
      const held = { ok: true, changed: 0, whole: false };
      await w.db.update(calSettings).set({ newEventsCalendarId: privat!.id }).where(eq(calSettings.accountId, t.seeded.accountId));
      expect(await removeCalendar(ctx, privat!.id, { unlessOwed: true })).toEqual(held);
      expect(await t.eventsIn(privat!.id)).toBe(1);
      for (const state of ["pending", "refused"]) {
        await w.db.delete(calWrites).where(eq(calWrites.accountId, t.seeded.accountId));
        await w.db.insert(calWrites).values({
          accountId: t.seeded.accountId, calendarId: family!.id, op: "move", state, idempotencyKey: `move-${state}`,
          payload: { act: { kind: "calendar_event_move", toCalendarId: work!.id } },
        });
        expect(await removeCalendar(ctx, work!.id, { unlessOwed: true })).toEqual(held);
        expect(await t.eventsIn(work!.id)).toBe(1);
      }
      // A move already applied is history: the row goes.
      await w.db.update(calWrites).set({ state: "applied" }).where(eq(calWrites.accountId, t.seeded.accountId));
      expect(await removeCalendar(ctx, work!.id, { unlessOwed: true })).toEqual({ ok: true, changed: 2, whole: true });
      expect((await t.rows()).map((r) => r.id)).not.toContain(work!.id);
    }, 60_000);
  });

  it.each([false, true])("uses the appropriate wait when CalDAV refuses a host (continuation: %s)", async (continuation) => {
    const refusal = { refuse: { ok: false as const, reason: "host_changed" as const, retryAfterMs: null } };
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const first = { items: [upsert("first.ics", "v1", single("first", 1))] };
    const reader = scriptedReader("caldav", { readings: new Map([["", continuation ? [first, refusal] : [refusal]]]) });
    const now = Date.now();
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { clock: { now: () => now }, turn: { pages: 1, ms: 30_000 } });
    if (continuation) expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", pages: 1, more: true });
    const untilMs = now + (continuation ? RETRY_FLOOR_MS : WAIT_DAY_MS);
    expect(await calendarSyncPass(deps, seeded.due, never)).toEqual({ kind: "backed_off", word: "host_changed", untilMs });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ errorCode: "host_changed", nextPollAt: new Date(untilMs) });
  }, 60_000);

  it("backs off for a day after three CalDAV continuation refusals and retries sooner after a completed reading", async () => {
    const refusal = { refuse: { ok: false as const, reason: "host_changed" as const, retryAfterMs: null } };
    const first = { items: [upsert("first.ics", "v1", single("first", 1))] };
    const readings = new Map<string, readonly (ScriptedPage | typeof refusal)[]>([["", [first, refusal]]]);
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { readings, endToken: () => null });
    const now = Date.now();
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { clock: { now: () => now }, turn: { pages: 1, ms: 30_000 } });
    const turn = () => calendarSyncPass(deps, seeded.due, never);
    const refusalAfterFirstPage = async () => {
      await makeDue(seeded.accountId);
      expect(await turn()).toMatchObject({ kind: "synced", pages: 1, more: true });
      const outcome = await turn();
      expect(outcome).toMatchObject({ kind: "backed_off", word: "host_changed" });
      return (await connectionOf(w, seeded.accountId, seeded.connectionId)).nextPollAt!.getTime() - now;
    };

    const waits = [await refusalAfterFirstPage(), await refusalAfterFirstPage(), await refusalAfterFirstPage()];
    expect(waits).toEqual([RETRY_FLOOR_MS, 2 * RETRY_FLOOR_MS, WAIT_DAY_MS]);
    expect(reader.calls.map(({ cursor }) => cursor)).toEqual([null, "1", null, "1", null, "1"]);
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "failing", errorCode: "host_changed" });

    readings.set("", [first]);
    await makeDue(seeded.accountId);
    expect(await turn()).toMatchObject({ kind: "synced", pages: 1, more: false });
    readings.set("", [first, refusal]);
    expect(await refusalAfterFirstPage()).toBe(RETRY_FLOOR_MS);
  }, 60_000);

  it("keeps a CalDAV continuation's backoff when another calendar finishes reading", async () => {
    const refusal = { refuse: { ok: false as const, reason: "host_changed" as const, retryAfterMs: null } };
    const first = { items: [upsert("first.ics", "v1", single("first", 1))] };
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const affected = { id: "family", name: "Family", color: null, writable: true, byToken: true, zone: null };
    const other = { ...affected, id: "personal", name: "Personal" };
    const readings = new Map<string, readonly (ScriptedPage | typeof refusal)[]>([["", [first]]]);
    const reader = scriptedReader("caldav", {
      calendars: [affected, other], readings, endToken: () => null,
    });
    const personal = scriptedReader("caldav", { readings: new Map([["", [{ items: [] }]]]), endToken: () => null });
    const read = reader.readChanges;
    reader.readChanges = (c, cal, since, page) => cal.id === other.id
      ? personal.readChanges(c, cal, since, page)
      : read(c, cal, since, page);
    const now = Date.now();
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), { clock: { now: () => now }, turn: { pages: 1, ms: 30_000 } });
    const turn = () => calendarSyncPass(deps, seeded.due, never);
    const holdOther = async (providerId: string) => {
      await makeDue(seeded.accountId);
      await w.db.update(calCalendars).set({ nextPollAt: new Date(now + WAIT_DAY_MS) })
        .where(and(eq(calCalendars.accountId, seeded.accountId), eq(calCalendars.providerId, providerId)));
    };

    await turnsUntilDone(deps, seeded.due);
    readings.set("", [first, refusal]);
    for (const wait of [RETRY_FLOOR_MS, 2 * RETRY_FLOOR_MS, WAIT_DAY_MS]) {
      await holdOther(other.id);
      expect(await turn()).toMatchObject({ kind: "synced", calendars: 0, pages: 1, more: true });
      expect(await turn()).toEqual({ kind: "backed_off", word: "host_changed", untilMs: now + wait });
      await holdOther(affected.id);
      expect(await turn()).toMatchObject({ kind: "synced", calendars: 1, pages: 1, more: false });
    }
  }, 60_000);

  it("a calendar's refusal is its word and its wait, recorded; a retry that keeps failing is bounded; the next good reading clears the word", async () => {
    const refuse = (reason: "forbidden" | "page_link_refused" | "token_gone") => ({ refuse: { ok: false as const, reason, retryAfterMs: null } });
    const readings = new Map<string, readonly (ScriptedPage | ReturnType<typeof refuse>)[]>([["", [refuse("forbidden")]]]);
    const seeded = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    const reader = scriptedReader("caldav", { readings, endToken: () => "tok" });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    const turn = async () => {
      await makeDue(seeded.accountId);
      reader.calls.length = 0;
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", calendars: 0 });
      return { ...(await calendarsOf(w, seeded.accountId))[0]!, asked: reader.calls.length, updates: (await changesOf(w, seeded.accountId))["calendar:update"] ?? 0 };
    };
    // Not allowed to read it: the calendar says so, waits a day, and the connection stays as it was.
    const forbidden = await turn();
    expect(forbidden).toMatchObject({ errorCode: "forbidden", asked: 1, updates: 1 });
    expect(forbidden.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "active", errorCode: null });

    /** Read well: the word is cleared, with its change, and the calendar has its token again. */
    const readWell = async (updates: number) => {
      readings.set("", eventsInPages("w", 2, 2));
      await makeDue(seeded.accountId);
      expect(await calendarSyncPass(deps, seeded.due, never)).toMatchObject({ kind: "synced", calendars: 1 });
      expect((await calendarsOf(w, seeded.accountId))[0]).toMatchObject({ errorCode: null, syncToken: "tok" });
      expect((await changesOf(w, seeded.accountId))["calendar:update"]).toBe(updates);
    };
    await readWell(2);

    // A token the provider forgot, and no answer from the beginning either: asked twice in the turn, never a third time, and the calendar waits.
    readings.set("", [refuse("token_gone")]);
    expect(await turn()).toMatchObject({ errorCode: "token_gone", syncToken: null, asked: 2, updates: 3 });
    await readWell(4);

    // A page link refused: the calendar waits, and at the third refusal in a row it is read from the beginning.
    readings.set("tok", [refuse("page_link_refused")]);
    expect(await turn()).toMatchObject({ errorCode: "page_link_refused", syncToken: "tok", asked: 1, updates: 5 });
    expect(await turn()).toMatchObject({ errorCode: "page_link_refused", syncToken: "tok", asked: 1, updates: 5 });
    expect(await turn()).toMatchObject({ errorCode: "page_link_refused", syncToken: null, asked: 1, updates: 5 });
  }, 60_000);

  it("is gone, writing nothing, for a connection another account's key names", async () => {
    const a = await caldavWorld(new Map([["", eventsInPages("x", 2, 2)]]));
    const b = await seedConnection(w, { provider: "caldav", credential: caldav, serverUrl: SERVER });
    expect(await calendarSyncPass(a.deps, { ...a.due, accountId: b.accountId }, never)).toEqual({ kind: "gone" });
    expect(await eventsOf(w, b.accountId)).toEqual([]);
    expect({ reads: a.reader.calls.length, lists: a.reader.lists }).toEqual({ reads: 0, lists: 0 });
  }, 60_000);

  it("a write of the sync outside its door is refused by the store's change door, and nothing of it stays", async () => {
    const t = await caldavWorld(new Map());
    const key = { accountId: t.accountId, id: t.connectionId };
    const failing = { status: "failing", errorCode: "unknown", synced: false } as const;
    const bare = w.db as unknown as { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
    // No fence taken: the row's update and its change are one transaction, refused whole.
    await expect(bare.transaction((tx) => setConnectionState(tx, key, { status: "active", errorCode: null }, failing)))
      .rejects.toMatchObject({ name: "CalendarChangeRefused", reason: "not_fenced" });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
    expect(await changesOf(w, t.accountId)).toEqual({});
    // Through the sync's door the store's fence comes first, and the same write goes through.
    const db = passDb(calendarPool(w.db), t.accountId);
    expect(await inConnection(db, key, ({ tx, held }) => setConnectionState(tx, key, held, failing))).toBe(true);
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "failing", errorCode: "unknown" });
    expect(await changesOf(w, t.accountId)).toEqual({ "calendar_connection:update": 1 });
  }, 60_000);

  it("is gone at the store's fence for a connection riding a mailbox that was erased: nothing is asked or written", async () => {
    const t = await caldavWorld(new Map([["", eventsInPages("e", 2, 2)]]));
    const [mb] = await w.db.insert(mailboxes).values({ accountId: t.accountId, provider: "imap", address: `rides-${t.accountId}@x.test`, status: "connected" })
      .returning({ id: mailboxes.id });
    await w.db.update(calConnections).set({ mailboxId: mb!.id }).where(eq(calConnections.id, t.connectionId));
    await w.db.update(mailboxes).set({ erasedAt: new Date(), status: "disabled" }).where(eq(mailboxes.id, mb!.id));
    expect(await calendarSyncPass(t.deps, t.due, never)).toEqual({ kind: "gone" });
    expect({ calendars: await calendarsOf(w, t.accountId), events: await eventsOf(w, t.accountId) }).toEqual({ calendars: [], events: [] });
    expect({ reads: t.reader.calls.length, lists: t.reader.lists }).toEqual({ reads: 0, lists: 0 });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "active", errorCode: null });
  }, 60_000);
});
