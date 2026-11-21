import { randomUUID } from "node:crypto";
import { dbFor } from "../src/context.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { accounts, calAlarms, calAttendees, calCalendars, calConnections, calEvents, calSettings, calWrites, changeLog, mailboxes } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { CALENDAR_WRITE_LIMITS } from "@trafficflow/db/calendar";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { CalendarEventAct, CalendarEventFields } from "@ohmail/wire";
import { BENCH_CALDAV_PLACE, PROVEN_REPEATS, proofPlaceOf } from "@ohmail/cal-providers";
import {
  CALENDAR_BUILDERS, checkedAct, cutToFit, dismissCalendarWrite, recordCalendarWrite as record, retryCalendarWrite,
} from "@trafficflow/services/calendar";
import { ServiceError, type ServiceContext } from "../src/index.js";

/** A CalDAV account's server in these cases, taken as the one the bench's repeat proof was run at: its row is the bench's. */
const DAV_URL = "https://dav.example.test/";
const DAV_PROVEN = { [proofPlaceOf("caldav", DAV_URL)!]: PROVEN_REPEATS[BENCH_CALDAV_PLACE]! };
/** The door as the routes call it, but for the repeats it takes as proven: the bench's row at the CalDAV server of these cases. */
const recordCalendarWrite = (c: ServiceContext, key: string, body: unknown) => record(c, key, body, { proven: DAV_PROVEN });

/**
 * THE CALENDAR'S WRITE DOOR, on a real Postgres: an act recorded once under its key, on the copy it
 * was made on, for what the account may write, within its bounds; the event's record carrying what
 * waits; and the two words a person has for a refused write. Nothing here reaches a provider: the
 * door records, the worker's drain writes. Every value is invented.
 */
const PG_UP = await realPgAvailable();
let owned: OwnedDb;
let db: OwnedDb["db"];

const ctx = (accountId: string): ServiceContext => ({
  db: dbFor(db, accountId), accountId, userId: null, now: () => new Date(), requestId: `cw-${randomUUID().slice(0, 8)}`,
});

const FIELDS: CalendarEventFields = {
  title: "Glaze firing", start: { kind: "zoned", value: "20261117T090000", zone: "Europe/Zurich" },
  end: { kind: "zoned", value: "20261117T100000", zone: "Europe/Zurich" }, notes: null, place: "Studio 2", callLink: null,
  busy: true, private: false, repeat: null, invitees: [], alarms: [15],
};

interface World {
  readonly accountId: string;
  readonly connectionId: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly updatedAt: string;
}

/** An account with its calendar on, one Google connection, one calendar it owns, and one event the provider holds. */
async function world(o: { provider?: string; access?: string; status?: string; organizer?: string | null; myAnswer?: string | null } = {}): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cw-${accountId.slice(0, 8)}` });
  await db.insert(calSettings).values({ accountId, enabledAt: new Date() });
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: `mila-${accountId.slice(0, 6)}@example.test`, status: "connected" });
  const [conn] = await db.insert(calConnections).values({
    accountId, provider: o.provider ?? "google", label: "", status: o.status ?? "active", nextPollAt: new Date(Date.now() + 3_600_000),
    serverUrl: o.provider === "caldav" ? DAV_URL : null,
  }).returning({ id: calConnections.id });
  const [cal] = await db.insert(calCalendars).values({
    accountId, connectionId: conn!.id, providerId: `cal-${accountId.slice(0, 6)}`, name: "Studio", access: o.access ?? "owner",
  }).returning({ id: calCalendars.id });
  const [ev] = await db.insert(calEvents).values({
    accountId, calendarId: cal!.id, providerId: "evt-1", versionTag: '"v1"', uid: "uid-1", title: "Kiln check",
    startKind: "instant", startLocal: "20261118T090000Z", endKind: "instant", endLocal: "20261118T100000Z",
    startsAt: new Date("2026-11-18T09:00:00Z"), endsAt: new Date("2026-11-18T10:00:00Z"),
    organizer: o.organizer ?? null, myAnswer: o.myAnswer ?? null,
  }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
  return { accountId, connectionId: conn!.id, calendarId: cal!.id, eventId: ev!.id, updatedAt: ev!.updatedAt.toISOString() };
}

const create = (w: World, over: Partial<CalendarEventFields> = {}, eventId: string = randomUUID()): CalendarEventAct =>
  ({ kind: "calendar_event_create", eventId, calendarId: w.calendarId, event: { ...FIELDS, ...over } });
const update = (w: World, change: Partial<CalendarEventFields>, base = w.updatedAt, after?: string): CalendarEventAct =>
  ({ kind: "calendar_event_update", eventId: w.eventId, base, ...(after === undefined ? {} : { after }), scope: { kind: "record" }, change });

const weeklyOriginal = (start: string, end: string, rule: string, changed: readonly string[] = []) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//EN",
  "BEGIN:VEVENT", "UID:weekly@example.test", "DTSTAMP:20261101T000000Z",
  `DTSTART;TZID=Europe/Zurich:${start}`, `DTEND;TZID=Europe/Zurich:${end}`, `RRULE:${rule}`,
  "END:VEVENT", ...changed, "END:VCALENDAR", "",
].join("\r\n");

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "accepted";
  } catch (err) {
    return err instanceof ServiceError ? `${err.httpStatus} ${err.code}` : `threw ${String(err)}`;
  }
};

const rowsOf = (accountId: string) => db.select({
  id: calWrites.id, key: calWrites.idempotencyKey, op: calWrites.op, state: calWrites.state, refusal: calWrites.refusal,
  base: calWrites.baseVersionTag, eventId: calWrites.eventId, payload: calWrites.payload,
}).from(calWrites).where(eq(calWrites.accountId, accountId)).orderBy(asc(calWrites.createdAt), asc(calWrites.idempotencyKey));

const eventRows = (accountId: string) => db.select({ id: calEvents.id, providerId: calEvents.providerId, uid: calEvents.uid, title: calEvents.title, versionTag: calEvents.versionTag })
  .from(calEvents).where(eq(calEvents.accountId, accountId)).orderBy(asc(calEvents.title));

const pollOf = async (w: World) => (await db.select({ at: calConnections.nextPollAt }).from(calConnections).where(eq(calConnections.id, w.connectionId)))[0]!.at!;

describe.skipIf(!PG_UP)("the calendar's write door", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); });

  it("records one act once under its key: the press twice is one row, one event and one answer; another act under the key is refused", async () => {
    const w = await world();
    const act = create(w);
    const first = await recordCalendarWrite(ctx(w.accountId), "press-1", act);
    const again = await recordCalendarWrite(ctx(w.accountId), "press-1", act);
    expect(first.answer.write).toEqual({ id: expect.any(String), key: "press-1", state: "pending", reason: null });
    expect(again.answer.write).toEqual(first.answer.write);
    expect([first.seq === null, again.seq]).toEqual([false, null]);
    expect((await rowsOf(w.accountId)).length).toBe(1);
    expect((await eventRows(w.accountId)).filter((e) => e.title === "Glaze firing").length).toBe(1);
    expect(await refusal(recordCalendarWrite(ctx(w.accountId), "press-1", create(w, { title: "Another" }, (act as { eventId: string }).eventId))))
      .toBe("409 idempotency_replay");
    expect((await rowsOf(w.accountId)).length).toBe(1);
  });

  it("makes one row of two arrivals at once under one key", async () => {
    const w = await world();
    const act = update(w, { title: "Kiln check, moved" });
    const both = await Promise.all([1, 2, 3].map(() => recordCalendarWrite(ctx(w.accountId), "press-at-once", act)));
    expect(new Set(both.map((b) => b.answer.write!.id)).size).toBe(1);
    expect((await rowsOf(w.accountId)).map((r) => r.state)).toEqual(["pending"]);
  });

  it("records presses on several events of one connection at once, each its own row: none waits on another's hold of the connection", async () => {
    const w = await world();
    const others = await Promise.all(Array.from({ length: 5 }, async (_, i) => (await db.insert(calEvents).values({
      accountId: w.accountId, calendarId: w.calendarId, providerId: `evt-${i + 2}`, versionTag: '"v1"', uid: `uid-${i + 2}`, title: "Kiln check",
      startKind: "instant", startLocal: "20261118T090000Z", endKind: "instant", endLocal: "20261118T100000Z",
      startsAt: new Date("2026-11-18T09:00:00Z"), endsAt: new Date("2026-11-18T10:00:00Z"),
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt }))[0]!));
    const events = [{ id: w.eventId, base: w.updatedAt }, ...others.map((e) => ({ id: e.id, base: e.updatedAt.toISOString() }))];
    for (let round = 0; round < 3; round++) {
      const all = await Promise.allSettled(events.map((e, i) => recordCalendarWrite(ctx(w.accountId), `at-once-${round}-${i}`, {
        kind: "calendar_event_update", eventId: e.id, base: e.base, scope: { kind: "record" }, change: { title: `Round ${round}` },
      })));
      expect(all.map((r) => (r.status === "fulfilled" ? r.value.answer.write!.state : String(r.reason)))).toEqual(Array(events.length).fill("pending"));
      await db.delete(calWrites).where(eq(calWrites.accountId, w.accountId));
    }
  });

  it("stands a new event in the store as wanted, named by its write, with its invitees and reminders, and wakes its connection", async () => {
    const w = await world();
    const act = create(w, { invitees: [{ address: "Giulia@Example.TEST", name: " Giulia ", role: "optional" }] });
    const before = await pollOf(w);
    const { answer } = await recordCalendarWrite(ctx(w.accountId), "press-new", act);
    const id = answer.write!.id;
    const event = (await eventRows(w.accountId)).find((e) => e.title === "Glaze firing")!;
    expect(event).toEqual({ id: (act as { eventId: string }).eventId, providerId: `pending:${id}`, uid: `pending:${id}`, title: "Glaze firing", versionTag: null });
    expect(await db.select({ address: calAttendees.address, name: calAttendees.name, role: calAttendees.role }).from(calAttendees).where(eq(calAttendees.eventId, event.id)))
      .toEqual([{ address: "giulia@example.test", name: "Giulia", role: "optional" }]);
    expect((await db.select({ m: calAlarms.minutesBefore }).from(calAlarms).where(eq(calAlarms.eventId, event.id))).map((a) => a.m)).toEqual([15]);
    expect(answer.events.map((e) => [e.id, e.title, e.writes.map((m) => [m.id, m.state, m.act?.kind])])).toEqual([
      [event.id, "Glaze firing", [[id, "pending", "calendar_event_create"]]],
    ]);
    expect((await pollOf(w)).getTime()).toBeLessThan(before.getTime());
  });

  it("leaves a connection that waits on a provider's word where it is: a press never pulls it inside the provider's wish", async () => {
    const w = await world();
    await db.update(calConnections).set({ errorCode: "throttled" }).where(eq(calConnections.id, w.connectionId));
    const before = await pollOf(w);
    const { answer } = await recordCalendarWrite(ctx(w.accountId), "press-waits", update(w, { title: "Later" }));
    expect(answer.write).toMatchObject({ state: "pending" });
    expect((await pollOf(w)).getTime()).toBe(before.getTime());
  });

  it("records a change made on an older copy as refused, version_stale, and wakes nothing", async () => {
    const w = await world();
    const before = await pollOf(w);
    const stale = new Date(Date.parse(w.updatedAt) - 60_000).toISOString();
    const { answer } = await recordCalendarWrite(ctx(w.accountId), "press-stale", update(w, { title: "Mine" }, stale));
    expect(answer.write).toMatchObject({ state: "refused", reason: "version_stale" });
    expect(answer.events[0]!.title).toBe("Kiln check");
    expect(answer.events[0]!.writes.map((m) => [m.state, m.reason, m.act?.kind])).toEqual([["refused", "version_stale", "calendar_event_update"]]);
    expect((await pollOf(w)).getTime()).toBe(before.getTime());
  });

  it("chains a change behind the device's own write still owed, and refuses one behind a refused write", async () => {
    const w = await world();
    await recordCalendarWrite(ctx(w.accountId), "press-a", update(w, { title: "One" }));
    const second = await recordCalendarWrite(ctx(w.accountId), "press-b", update(w, { title: "Two" }, w.updatedAt, "press-a"));
    const rows = await rowsOf(w.accountId);
    expect(second.answer.write!.state).toBe("pending");
    expect((rows[1]!.payload as { after: string }).after).toBe(rows[0]!.id);
    const v = await world();
    const stale = new Date(Date.parse(v.updatedAt) - 60_000).toISOString();
    await recordCalendarWrite(ctx(v.accountId), "press-c", update(v, { title: "Stale" }, stale));
    const next = await recordCalendarWrite(ctx(v.accountId), "press-d", update(v, { title: "After" }, stale, "press-c"));
    expect(next.answer.write).toMatchObject({ state: "refused", reason: "earlier_refused" });
  });

  it("refuses what the account may not write, and writes nothing for it", async () => {
    const w = await world();
    const other = await world();
    const cases: [string, () => Promise<unknown>][] = [
      ["another account's calendar", () => recordCalendarWrite(ctx(w.accountId), "k1", create(other))],
      ["another account's event", () => recordCalendarWrite(ctx(w.accountId), "k2", update(other, { title: "x" }))],
      ["a calendar shared to look at", async () => { const r = await world({ access: "reader" }); return recordCalendarWrite(ctx(r.accountId), "k3", create(r)); }],
      ["a subscription", async () => { const r = await world({ provider: "ics" }); return recordCalendarWrite(ctx(r.accountId), "k4", create(r)); }],
      ["someone else's invitation", async () => { const r = await world({ organizer: "anna@example.test", myAnswer: "none" }); return recordCalendarWrite(ctx(r.accountId), "k5", update(r, { title: "x" })); }],
      ["an answer to the account's own event", () => recordCalendarWrite(ctx(w.accountId), "k6", { kind: "calendar_event_answer", eventId: w.eventId, base: w.updatedAt, scope: { kind: "record" }, answer: "accepted" })],
      ["a connection signed out", async () => { const r = await world({ status: "reconnect" }); return recordCalendarWrite(ctx(r.accountId), "k7", create(r)); }],
      ["a connection being removed", async () => { const r = await world({ status: "removing" }); return recordCalendarWrite(ctx(r.accountId), "k8", create(r)); }],
    ];
    const got: [string, string][] = [];
    for (const [name, p] of cases) got.push([name, await refusal(p())]);
    expect(got).toEqual([
      ["another account's calendar", "404 not_found"],
      ["another account's event", "404 not_found"],
      ["a calendar shared to look at", "409 calendar_read_only"],
      ["a subscription", "409 calendar_read_only"],
      ["someone else's invitation", "409 calendar_read_only"],
      ["an answer to the account's own event", "409 calendar_read_only"],
      ["a connection signed out", "409 calendar_connection_stopped"],
      ["a connection being removed", "409 calendar_connection_stopped"],
    ]);
    expect((await rowsOf(w.accountId)).length + (await rowsOf(other.accountId)).length).toBe(0);
  });

  it("records an act on a whole series and an answer to a repeating invitation, and refuses every act no series write makes: one changed day as a record of its own, a new start or repeat for a series with changed days, a series of listed days", async () => {
    const w = await world({ provider: "caldav" });
    const member = `https://dav.example.test/cal/${w.accountId.slice(0, 6)}/weekly.ics`;
    const stored = (values: Partial<typeof calEvents.$inferInsert>) => db.insert(calEvents).values({
      accountId: w.accountId, calendarId: w.calendarId, providerId: member, versionTag: '"w1"', uid: "weekly@example.test", title: "Weekly kiln",
      startKind: "instant", startLocal: "20261118T090000Z", endKind: "instant", endLocal: "20261118T100000Z",
      startsAt: new Date("2026-11-18T09:00:00Z"), endsAt: new Date("2026-11-18T10:00:00Z"), ...values,
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt }).then((r) => r[0]!);
    // A series in a shape its server was proven to keep: Wednesdays at 10:00 in Zurich (09:00 UTC).
    const zurich = { startKind: "zoned", startLocal: "20261118T100000", startZone: "Europe/Zurich", endKind: "zoned", endLocal: "20261118T110000", endZone: "Europe/Zurich" };
    const original = weeklyOriginal("20261118T100000", "20261118T110000", "FREQ=WEEKLY", [
      "BEGIN:VEVENT", "UID:weekly@example.test", "DTSTAMP:20261101T000000Z",
      "RECURRENCE-ID;TZID=Europe/Zurich:20261125T100000", "DTSTART:20261125T140000Z", "DTEND:20261125T150000Z",
      "END:VEVENT",
    ]);
    const series = await stored({ repeatRule: "FREQ=WEEKLY", endsAt: null, original, ...zurich });
    const day = await stored({
      recurrenceId: "20261125T090000Z", occurrenceAt: new Date("2026-11-25T09:00:00Z"), title: "Weekly kiln, moved",
      startLocal: "20261125T140000Z", endLocal: "20261125T150000Z", startsAt: new Date("2026-11-25T14:00:00Z"), endsAt: new Date("2026-11-25T15:00:00Z"),
    });
    const dated = await stored({ providerId: `${member}.dates`, uid: "dates@example.test", addedDates: [{ kind: "instant", value: "20261202T090000Z" }] });
    const on = (e: { id: string; updatedAt: Date }) => ({ eventId: e.id, base: e.updatedAt.toISOString() });
    const later: Partial<CalendarEventFields> = { start: { kind: "instant", value: "20261118T110000Z" }, end: { kind: "instant", value: "20261118T120000Z" } };
    const acts: [string, CalendarEventAct][] = [
      ["one changed day removed", { kind: "calendar_event_delete", ...on(day), scope: { kind: "record" } }],
      ["one changed day retitled", { kind: "calendar_event_update", ...on(day), scope: { kind: "record" }, change: { title: "Only that day" } }],
      ["the series at a new time", { kind: "calendar_event_update", ...on(series), scope: { kind: "record" }, change: later }],
      ["the series' repeat taken off", { kind: "calendar_event_update", ...on(series), scope: { kind: "record" }, change: { repeat: null } }],
      ["the series removed", { kind: "calendar_event_delete", ...on(series), scope: { kind: "record" } }],
      ["an event with days added retitled", { kind: "calendar_event_update", ...on(dated), scope: { kind: "record" }, change: { title: "x" } }],
    ];
    const got: [string, string][] = [];
    for (const [name, act] of acts) got.push([name, await refusal(recordCalendarWrite(ctx(w.accountId), `s-${got.length}`, act))]);
    // The whole series removed, changed days and all, is recorded: the drain sends it where the series' repeat is proven at its provider.
    expect(got).toEqual(acts.map(([name]) => [name, name === "the series removed" ? "accepted" : "400 validation_failed"]));
    // An invitation to a repeating event is answered, for the whole series and for one day of it.
    const inv = await world({ provider: "caldav", organizer: "anna@example.test", myAnswer: "none" });
    await db.update(calEvents).set({ repeatRule: "FREQ=DAILY;COUNT=5", ...zurich }).where(eq(calEvents.id, inv.eventId));
    const answer = (scope: { kind: "record" } | { kind: "occurrence"; at: string }): CalendarEventAct =>
      ({ kind: "calendar_event_answer", eventId: inv.eventId, base: inv.updatedAt, scope, answer: "accepted" });
    expect(await refusal(recordCalendarWrite(ctx(inv.accountId), "s-answer", answer({ kind: "record" })))).toBe("accepted");
    expect(await refusal(recordCalendarWrite(ctx(inv.accountId), "s-answer-day", answer({ kind: "occurrence", at: String(Date.UTC(2026, 10, 19, 9)) })))).toBe("accepted");
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.op, r.state])).toEqual([["s-4", "delete", "pending"]]);
    expect((await rowsOf(inv.accountId)).map((r) => [r.key, r.op, r.state])).toEqual([["s-answer", "answer", "pending"], ["s-answer-day", "answer", "pending"]]);
  });

  it("records a day's change, a day's removal and the removal of a day with the days after it on a series' own row, and refuses a day of one event, a day's repeat or invitees, and a day named by no key", async () => {
    const w = await world({ provider: "caldav" });
    const [series] = await db.insert(calEvents).values({
      accountId: w.accountId, calendarId: w.calendarId, providerId: `https://dav.example.test/cal/${w.accountId.slice(0, 6)}/weekly.ics`, versionTag: '"w1"',
      uid: "weekly@example.test", title: "Weekly kiln", startKind: "zoned", startLocal: "20261123T090000", startZone: "Europe/Zurich",
      endKind: "zoned", endLocal: "20261123T100000", endZone: "Europe/Zurich", startsAt: new Date("2026-11-23T08:00:00Z"), endsAt: null, repeatRule: "FREQ=WEEKLY;BYDAY=MO",
      original: weeklyOriginal("20261123T090000", "20261123T100000", "FREQ=WEEKLY;BYDAY=MO"),
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    const on = (e: { id: string; updatedAt: Date | string }) => ({ eventId: e.id, base: typeof e.updatedAt === "string" ? e.updatedAt : e.updatedAt.toISOString() });
    const day = String(Date.UTC(2026, 11, 7, 8));
    const taken: [string, CalendarEventAct][] = [
      ["a day changed", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: day }, change: { title: "Glaze day" } }],
      ["a day removed", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "occurrence", at: day } }],
      ["a day and the days after it removed", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "following", at: day } }],
    ];
    const refused: [string, CalendarEventAct][] = [
      ["a day of one event", { kind: "calendar_event_update", ...on({ id: w.eventId, updatedAt: w.updatedAt }), scope: { kind: "occurrence", at: day }, change: { title: "x" } }],
      ["a day's repeat", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: day }, change: { repeat: "FREQ=DAILY" } }],
      ["a day's invitees", { kind: "calendar_event_update", ...on(series!), scope: { kind: "occurrence", at: day }, change: { invitees: [] } }],
      ["a day named by no key", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "occurrence", at: "next monday" } }],
    ];
    const got: [string, string][] = [];
    for (const [name, act] of [...taken, ...refused]) got.push([name, await refusal(recordCalendarWrite(ctx(w.accountId), `d-${got.length}`, act))]);
    expect(got).toEqual([...taken.map(([name]) => [name, "accepted"]), ...refused.map(([name]) => [name, "400 validation_failed"])]);
    expect((await rowsOf(w.accountId)).map((r) => [r.op, r.state, r.base, r.eventId])).toEqual([
      ["update", "pending", '"w1"', series!.id], ["delete", "pending", '"w1"', series!.id], ["delete", "pending", '"w1"', series!.id],
    ]);
  });

  /** A CalDAV series of ten Mondays at 09:00 in Zurich from 23 November 2026, a reminder 15 minutes before, as a reading stored it. */
  async function weekly(w: World, more: Partial<typeof calEvents.$inferInsert> = {}) {
    const [series] = await db.insert(calEvents).values({
      accountId: w.accountId, calendarId: w.calendarId, providerId: `https://dav.example.test/cal/${w.accountId.slice(0, 6)}/term.ics`, versionTag: '"w1"',
      uid: `term-${w.accountId.slice(0, 6)}@example.test`, title: "Wheel class", place: "Studio 2", startKind: "zoned", startLocal: "20261123T090000", startZone: "Europe/Zurich",
      endKind: "zoned", endLocal: "20261123T100000", endZone: "Europe/Zurich", startsAt: new Date("2026-11-23T08:00:00Z"), endsAt: new Date("2027-01-25T09:00:00Z"),
      repeatRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", ...more,
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    await db.insert(calAlarms).values({ accountId: w.accountId, eventId: series!.id, calendarId: null, minutesBefore: 15, method: "notice" });
    return series!;
  }
  const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
  const following = (series: { id: string; updatedAt: Date }, newEventId: string, change: Partial<CalendarEventFields>, base = series.updatedAt.toISOString()): CalendarEventAct =>
    ({ kind: "calendar_event_update", eventId: series.id, base, scope: { kind: "following", at: DEC_14, newEventId }, change });

  it.each(["caldav", "google", "microsoft"])("records the three scopes of a timed series owned by this account on %s", async (provider) => {
    const w = await world({ provider });
    const owner = ["owner", "example.test"].join("@");
    const guest = ["guest", "example.test"].join("@");
    await db.update(calConnections).set({ principal: owner }).where(eq(calConnections.id, w.connectionId));
    const series = await weekly(w, { organizer: owner });
    await db.insert(calAttendees).values({ accountId: w.accountId, eventId: series.id, address: guest, name: "Guest", role: "required", answer: "accepted" });
    const c = ctx(w.accountId);
    const act = { kind: "calendar_event_update" as const, eventId: series.id, base: series.updatedAt.toISOString(),
      change: { title: "New firing" }, audience: { organizer: owner, guests: [guest] } };
    const wrong = await record(c, "wrong-audience", { ...act, scope: { kind: "occurrence", at: DEC_14 }, audience: { organizer: owner, guests: [] } });
    expect(wrong.answer.write).toMatchObject({ state: "refused", reason: "version_stale" });
    const scopes = [{ kind: "record" }, { kind: "occurrence", at: DEC_14 }, { kind: "following", at: DEC_14, newEventId: randomUUID() }];
    for (const scope of scopes) {
      const sent = await record(c, scope.kind, { ...act, scope });
      expect(sent.answer.write).toMatchObject({ state: "pending", reason: null });
      expect((await record(c, scope.kind, { ...act, scope })).answer.write).toEqual(sent.answer.write);
    }
  });

  async function weeklyWithException(
    w: World, provider: string, people: Pick<Partial<typeof calEvents.$inferInsert>, "organizer" | "myAnswer"> = {},
  ) {
    const uid = "weekly-clay";
    const shared = provider === "caldav" ? "weekly-member" : "master";
    const series = await weekly(w, { uid, providerId: shared, ...people });
    const day = "2026-12-14T08:00:00Z";
    const child = await weekly(w, {
      uid, providerId: provider === "caldav" ? shared : "exception", ...people,
      versionTag: provider === "caldav" ? '"w1"' : '"changed-1"',
      recurrenceId: DEC_14, occurrenceAt: new Date(day), repeatRule: null,
      startLocal: "20261214T110000", endLocal: "20261214T120000",
      startsAt: new Date("2026-12-14T10:00:00Z"), endsAt: new Date("2026-12-14T11:00:00Z"),
    });
    return { series, child };
  }

  it.each(["caldav", "google", "microsoft"])("binds each edit of a changed occurrence to its reviewed version on %s", async (provider) => {
    const w = await world({ provider });
    const c = ctx(w.accountId);
    const { series, child } = await weeklyWithException(w, provider);
    const base = child.updatedAt.toISOString();
    const reviewed = `${base}/${series.updatedAt.toISOString()}`;
    const act = { kind: "calendar_event_update", eventId: child.id, change: { title: "Clay lesson" }, audience: { organizer: null, guests: [] } };
    for (const [scope, named] of [
      [{ kind: "occurrence", at: DEC_14 }, base],
      [{ kind: "record" }, reviewed],
      [{ kind: "following", at: DEC_14, newEventId: randomUUID() }, reviewed],
    ] as const) {
      const request = { ...act, scope, base: named };
      const answer = await record(c, scope.kind, request);
      expect(answer.answer.write).toMatchObject({ state: "pending", reason: null });
      expect((await record(c, scope.kind, request)).answer.write).toEqual(answer.answer.write);
    }
    const stale = new Date(series.updatedAt.getTime() + 10_000);
    await db.update(calEvents).set({ updatedAt: stale }).where(eq(calEvents.id, series.id));
    expect((await record(c, "stale-master", { ...act, scope: { kind: "record" }, base: reviewed })).answer.write)
      .toMatchObject({ state: "refused", reason: "version_stale" });
    const forged = { ...act, scope: { kind: "occurrence", at: String(+DEC_14 + 86_400_000) }, base };
    expect(await refusal(record(c, "wrong-day", forged))).toBe("400 validation_failed");
  });

  it.each(["caldav", "google", "microsoft"])("keeps an invitee from writing any scope of a timed series or its exception on %s", async (provider) => {
    const w = await world({ provider });
    const organizer = ["organizer", "example.test"].join("@");
    const invitee = ["invitee", "example.test"].join("@");
    await db.update(calConnections).set({ principal: invitee }).where(eq(calConnections.id, w.connectionId));
    const { series, child } = await weeklyWithException(w, provider, { organizer, myAnswer: "none" });
    await db.insert(calAttendees).values([series, child].map((event) => ({
      accountId: w.accountId, eventId: event.id, address: invitee, name: "Guest", role: "required", answer: "none",
    })));

    const earlier = series.updatedAt.toISOString();
    const selected = child.updatedAt.toISOString();
    const audience = { organizer, guests: [invitee] };
    const scopes = [{ kind: "record" }, { kind: "occurrence", at: DEC_14 }, { kind: "following", at: DEC_14, newEventId: randomUUID() }];
    for (const scope of scopes) {
      const act = { kind: "calendar_event_update", scope, audience, change: { title: "Unapproved change" } };
      expect(await refusal(record(ctx(w.accountId), `series-${scope.kind}`, { ...act, eventId: series.id, base: earlier })))
        .toBe("409 calendar_read_only");
      expect(await refusal(record(ctx(w.accountId), `exception-${scope.kind}`, {
        ...act, eventId: child.id, base: scope.kind === "occurrence" ? selected : `${selected}/${earlier}`,
      }))).toBe("409 calendar_read_only");
    }
    expect(await rowsOf(w.accountId)).toEqual([]);
  });

  it.each([["google", "reader"], ["ics", "owner"]])("refuses a paired edit on a calendar that takes no writes (%s, %s)", async (provider, access) => {
    const w = await world({ provider, access });
    const { series, child } = await weeklyWithException(w, provider);
    const act = {
      kind: "calendar_event_update", eventId: child.id, scope: { kind: "record" },
      base: `${child.updatedAt.toISOString()}/${series.updatedAt.toISOString()}`,
      audience: { organizer: null, guests: [] }, change: { title: "Unapproved change" },
    };
    expect(await refusal(record(ctx(w.accountId), "edit-read-only", act))).toBe("409 calendar_read_only");
    expect(await rowsOf(w.accountId)).toEqual([]);
  });

  it("cannot write another account's exception even with both of its versions", async () => {
    const caller = await world();
    const owner = await world();
    const { series, child } = await weeklyWithException(owner, "google");
    const act = {
      kind: "calendar_event_update", eventId: child.id, scope: { kind: "record" },
      base: `${child.updatedAt.toISOString()}/${series.updatedAt.toISOString()}`,
      audience: { organizer: null, guests: [] }, change: { title: "Unapproved change" },
    };
    expect(await refusal(record(ctx(caller.accountId), "edit-other-account", act))).toBe("404 not_found");
    expect(await rowsOf(caller.accountId)).toEqual([]);
    expect(await rowsOf(owner.accountId)).toEqual([]);
  });

  it("cannot borrow the master of an exception from a different calendar", async () => {
    const w = await world();
    const { series, child } = await weeklyWithException(w, "google");
    const [calendar] = await db.insert(calCalendars).values({
      accountId: w.accountId, connectionId: w.connectionId, providerId: "another-calendar",
      name: "Another calendar", access: "owner",
    }).returning({ id: calCalendars.id });
    const [moved] = await db.update(calEvents).set({ calendarId: calendar!.id }).where(eq(calEvents.id, child.id))
      .returning({ updatedAt: calEvents.updatedAt });
    const act = {
      kind: "calendar_event_update", eventId: child.id, scope: { kind: "record" },
      base: `${moved!.updatedAt.toISOString()}/${series.updatedAt.toISOString()}`,
      audience: { organizer: null, guests: [] }, change: { title: "Unapproved change" },
    };
    expect(await refusal(record(ctx(w.accountId), "edit-unrelated-series", act))).toBe("409 calendar_read_only");
    expect(await rowsOf(w.accountId)).toEqual([]);
  });

  it("shows scopes only on a proven personal series and keeps that condition on both parts of a split", async () => {
    const w = await world({ provider: "caldav" });
    const original = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//EN", "BEGIN:VEVENT", "UID:term",
      "DTSTAMP:20261101T000000Z", "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117",
      "RRULE:FREQ=WEEKLY;COUNT=5", "SUMMARY:Kiln check", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const series = await weekly(w, { uid: "term", original, startKind: "date", endKind: "date", startZone: null, endZone: null,
      startLocal: "20261116", endLocal: "20261117", startsAt: new Date("2026-11-16T00:00:00Z"), repeatRule: "FREQ=WEEKLY;COUNT=5" });
    const c = ctx(w.accountId);
    const visible = async () => (await CALENDAR_BUILDERS.calendar_event(c.db, w.accountId, [series.id])).get(series.id)?.personalSeries;
    expect(await visible()).toBeUndefined();
    await db.update(calConnections).set({ serverUrl: BENCH_CALDAV_PLACE.replace("caldav:", "http://") }).where(eq(calConnections.id, w.connectionId));
    expect(await visible()).toBe(true);
    const at = String(Date.UTC(2026, 10, 30));
    const act = { kind: "calendar_event_update", eventId: series.id, base: series.updatedAt.toISOString(),
      scope: { kind: "following", at, newEventId: randomUUID() }, change: { notes: "New time for firing" }, personalSeries: true };
    expect((await record(c, "split", act)).answer.write?.state).toBe("pending");
    const rows = await rowsOf(w.accountId);
    expect(rows.map((row) => row.payload)).toMatchObject([
      { act, part: { n: 1 } }, { part: { n: 2, from: { eventId: series.id, at, personalSeries: true } } },
    ]);
    await db.update(calEvents).set({ original: original.replace("END:VEVENT", "ATTENDEE:urn:uuid:aa\r\nEND:VEVENT") }).where(eq(calEvents.id, series.id));
    expect(await visible()).toBeUndefined();
    expect(await refusal(record(c, "another", act))).toBe("409 calendar_read_only");
    expect(await rowsOf(w.accountId)).toHaveLength(2);
  });

  it("records a press on a day and the days after it as two rows: the series' end, then the new series under the device's id, standing as wanted", async () => {
    const w = await world({ provider: "caldav" });
    const series = await weekly(w);
    const newEventId = randomUUID();
    const act = following(series, newEventId, { title: "Wheel class, the new term" });
    const { answer } = await recordCalendarWrite(ctx(w.accountId), "split-1", act);
    expect(answer.write).toMatchObject({ key: "split-1", state: "pending", reason: null });
    const rows = await rowsOf(w.accountId);
    expect(rows.map((r) => [r.key, r.op, r.state, r.base, r.eventId, (r.payload as { part: unknown }).part])).toEqual([
      ["split-1", "update", "pending", '"w1"', series.id, { of: "split-1", n: 1 }],
      // The second names where it comes from, so that the new series is made from the series' own component: the series, the day, the title named.
      ["split-1:2", "create", "pending", null, newEventId, { of: "split-1", n: 2, from: { eventId: series.id, at: DEC_14, named: ["title"], confirmed: true } }],
    ]);
    expect((rows[1]!.payload as { after: string }).after).toBe(rows[0]!.id);
    // The new series as the person wants it: from that day, its title changed, what is left of the count, the series' reminder.
    const [made] = await db.select({ providerId: calEvents.providerId, title: calEvents.title, place: calEvents.place, startLocal: calEvents.startLocal, repeatRule: calEvents.repeatRule })
      .from(calEvents).where(eq(calEvents.id, newEventId));
    expect(made).toEqual({ providerId: `pending:${rows[1]!.id}`, title: "Wheel class, the new term", place: "Studio 2", startLocal: "20261214T090000", repeatRule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" });
    expect((await db.select({ m: calAlarms.minutesBefore }).from(calAlarms).where(eq(calAlarms.eventId, newEventId))).map((a) => a.m)).toEqual([15]);
    expect(answer.events.map((e) => [e.id, e.writes.map((m) => [m.key, m.part])])).toEqual([[series.id, [["split-1", 1]]], [newEventId, [["split-1:2", 2]]]]);
    // The same press again is the same receipt, and nothing more.
    expect((await recordCalendarWrite(ctx(w.accountId), "split-1", act)).answer.write).toEqual(answer.write);
    expect((await rowsOf(w.accountId)).length).toBe(2);
  });

  it("refuses a press on the series' first day and under a key with no room for its second part; carries a series' invitees to the new series; a stale press is its first part refused, and nothing is made", async () => {
    const w = await world({ provider: "caldav" });
    const series = await weekly(w);
    const first = { ...following(series, randomUUID(), { title: "x" }), scope: { kind: "following" as const, at: String(Date.UTC(2026, 10, 23, 8)), newEventId: randomUUID() } };
    expect(await refusal(recordCalendarWrite(ctx(w.accountId), "first-day", first))).toBe("400 validation_failed");
    expect(await refusal(recordCalendarWrite(ctx(w.accountId), "k".repeat(CALENDAR_WRITE_LIMITS.keyChars - 1), following(series, randomUUID(), { title: "x" })))).toBe("400 idempotency_key_required");
    const v = await world({ provider: "caldav" });
    const owner = ["owner", "example.test"].join("@");
    const guest = ["anna", "example.test"].join("@");
    await db.update(calConnections).set({ principal: owner }).where(eq(calConnections.id, v.connectionId));
    const invited = await weekly(v, { organizer: owner });
    await db.insert(calAttendees).values({ accountId: v.accountId, eventId: invited.id, address: guest, name: null, role: "required", answer: "accepted" });
    const carried = randomUUID();
    const invitedAct = { ...following(invited, carried, { title: "x" }), audience: { organizer: owner, guests: [guest] } };
    expect(await refusal(recordCalendarWrite(ctx(v.accountId), "with-invitees", invitedAct))).toBe("accepted");
    expect(await db.select({ address: calAttendees.address, role: calAttendees.role, answer: calAttendees.answer }).from(calAttendees).where(eq(calAttendees.eventId, carried)))
      .toEqual([{ address: guest, role: "required", answer: "none" }]);
    const newEventId = randomUUID();
    const stale = await recordCalendarWrite(ctx(w.accountId), "stale", following(series, newEventId, { title: "x" }, new Date(series.updatedAt.getTime() - 60_000).toISOString()));
    expect(stale.answer.write).toMatchObject({ state: "refused", reason: "version_stale" });
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state])).toEqual([["stale", "refused"]]);
    expect(await db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.id, newEventId))).toEqual([]);
    expect((await rowsOf(v.accountId)).map((r) => r.key)).toEqual(["with-invitees", "with-invitees:2"]);
  });

  it("never puts a press's second part back, nor lets it go alone, while its first is not done: retry the first, or let it go with both", async () => {
    const w = await world({ provider: "caldav" });
    const series = await weekly(w);
    await recordCalendarWrite(ctx(w.accountId), "pair", following(series, randomUUID(), { title: "New term" }));
    const [first, second] = await rowsOf(w.accountId);
    expect(await refusal(dismissCalendarWrite(ctx(w.accountId), second!.id))).toBe("409 calendar_write_left");
    await db.update(calWrites).set({ state: "refused", refusal: "unavailable", attempts: 8 }).where(eq(calWrites.id, first!.id));
    await db.update(calWrites).set({ state: "refused", refusal: "earlier_refused" }).where(eq(calWrites.id, second!.id));
    expect(await refusal(retryCalendarWrite(ctx(w.accountId), second!.id))).toBe("409 calendar_write_left");
    expect(await refusal(dismissCalendarWrite(ctx(w.accountId), second!.id))).toBe("409 calendar_write_left");
    await retryCalendarWrite(ctx(w.accountId), first!.id);
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state])).toEqual([["pair", "pending"], ["pair:2", "pending"]]);
  });

  it("retries the second part of a half-done press, and lets it go with the new series' row; a first part let go takes the second with it", async () => {
    const w = await world({ provider: "caldav" });
    const series = await weekly(w);
    const newEventId = randomUUID();
    await recordCalendarWrite(ctx(w.accountId), "half", following(series, newEventId, { title: "New term" }));
    // As the drain leaves it: the series ended, the new one refused.
    await db.update(calWrites).set({ state: "applied", payload: {} }).where(and(eq(calWrites.accountId, w.accountId), eq(calWrites.idempotencyKey, "half")));
    await db.update(calWrites).set({ state: "refused", refusal: "read_only", attempts: 1 }).where(and(eq(calWrites.accountId, w.accountId), eq(calWrites.idempotencyKey, "half:2")));
    const second = (await rowsOf(w.accountId)).find((r) => r.key === "half:2")!;
    expect((await retryCalendarWrite(ctx(w.accountId), second.id)).answer.write).toMatchObject({ key: "half:2", state: "pending" });
    await db.update(calWrites).set({ state: "refused", refusal: "read_only", attempts: 1 }).where(eq(calWrites.id, second.id));
    await dismissCalendarWrite(ctx(w.accountId), second.id);
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state])).toEqual([["half", "applied"]]);
    expect(await db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.id, newEventId))).toEqual([]);
    expect((await db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.id, series.id))).length).toBe(1);
    // A first part refused, the second refused with it: letting the first go takes both, and the new series' row.
    const other = randomUUID();
    await recordCalendarWrite(ctx(w.accountId), "both", following(series, other, { title: "Another term" }));
    await db.update(calWrites).set({ state: "refused", refusal: "unavailable", attempts: 8 }).where(and(eq(calWrites.accountId, w.accountId), eq(calWrites.idempotencyKey, "both")));
    await db.update(calWrites).set({ state: "refused", refusal: "earlier_refused" }).where(and(eq(calWrites.accountId, w.accountId), eq(calWrites.idempotencyKey, "both:2")));
    const head = (await rowsOf(w.accountId)).find((r) => r.key === "both")!;
    await dismissCalendarWrite(ctx(w.accountId), head.id);
    expect((await rowsOf(w.accountId)).map((r) => r.key)).toEqual(["half"]);
    expect(await db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.id, other))).toEqual([]);
  });

  it("answers an invitation, and the calendar off refuses everything", async () => {
    const r = await world({ organizer: "anna@example.test", myAnswer: "none" });
    const { answer } = await recordCalendarWrite(ctx(r.accountId), "ans", { kind: "calendar_event_answer", eventId: r.eventId, base: r.updatedAt, scope: { kind: "record" }, answer: "tentative" });
    expect(answer.write!.state).toBe("pending");
    await db.update(calSettings).set({ enabledAt: null }).where(eq(calSettings.accountId, r.accountId));
    expect(await refusal(recordCalendarWrite(ctx(r.accountId), "off", update(r, { title: "x" })))).toBe("409 calendar_off");
  });

  it("holds the bounds: every act past one is a refusal with its word, never a fault", async () => {
    const w = await world();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `p${i}@example.test`, name: null, role: "required" as const }));
    const bodies: [string, unknown][] = [
      ["101 invitees", create(w, { invitees: many(101) })],
      ["6 reminders", create(w, { alarms: [1, 2, 3, 4, 5, 6] })],
      ["a reminder five weeks ahead", create(w, { alarms: [50_400] })],
      ["U+0000 in a title", create(w, { title: "a\u0000b" })],
      ["half a pair in a place", create(w, { place: "\ud800x" })],
      ["a link that is no https", create(w, { callLink: "javascript:alert(1)" })],
      ["a link to plain http", create(w, { callLink: "http://example.test/call" })],
      ["an end before the start", create(w, { end: { kind: "zoned", value: "20261117T080000", zone: "Europe/Zurich" } })],
      ["a zone nobody knows", create(w, { start: { kind: "zoned", value: "20261117T090000", zone: "Mars/Olympus" }, end: { kind: "zoned", value: "20261117T100000", zone: "Mars/Olympus" } })],
      ["a repeat no rule", create(w, { repeat: "FREQ=SOMETIMES" })],
      ["an unknown key", { ...create(w), extra: 1 }],
      ["an unknown key in the event", { ...create(w), event: { ...FIELDS, colour: "red" } }],
      ["a body past its size", create(w, { notes: "x".repeat(CALENDAR_WRITE_LIMITS.payloadBytes) })],
      ["a day's change of one day", { ...update(w, { title: "x" }), scope: { kind: "occurrence", at: "1763456400000" } }],
    ];
    // Each under a key the door takes, so that what refuses it is the body alone.
    const got = await Promise.all(bodies.map(async ([name, body]) => [name, await refusal(recordCalendarWrite(ctx(w.accountId), `b-${name.length}-${name.slice(0, 8).replace(/[^\x21-\x7e]/g, "_")}`, body))]));
    for (const [name, word] of got) expect([name, word]).toEqual([name, expect.stringMatching(/^4\d\d (validation_failed|payload_too_large)$/)]);
    expect(await refusal(recordCalendarWrite(ctx(w.accountId), "k".repeat(CALENDAR_WRITE_LIMITS.keyChars + 1), create(w)))).toBe("400 idempotency_key_required");
    expect((await rowsOf(w.accountId)).length).toBe(0);
  });

  it("keeps at most eight writes of one event waiting, and two hundred of an account", async () => {
    const w = await world();
    for (let i = 0; i < CALENDAR_WRITE_LIMITS.openPerEvent; i++) await recordCalendarWrite(ctx(w.accountId), `e-${i}`, update(w, { title: `t${i}` }));
    expect(await refusal(recordCalendarWrite(ctx(w.accountId), "e-over", update(w, { title: "over" })))).toBe("409 calendar_writes_full");
    const v = await world();
    const rows = Array.from({ length: CALENDAR_WRITE_LIMITS.openPerAccount }, (_, i) => ({
      accountId: v.accountId, calendarId: v.calendarId, eventId: null, op: "update", payload: {}, idempotencyKey: `seed-${i}`, state: i % 2 === 0 ? "pending" : "refused",
    }));
    await db.insert(calWrites).values(rows);
    expect(await refusal(recordCalendarWrite(ctx(v.accountId), "a-over", create(v)))).toBe("409 calendar_writes_full");
  });

  it("carries the marks oldest first in the record, and a record cut to fit keeps its marks without their acts", async () => {
    const w = await world();
    await recordCalendarWrite(ctx(w.accountId), "m1", update(w, { title: "One" }));
    await recordCalendarWrite(ctx(w.accountId), "m2", update(w, { place: "Two" }, w.updatedAt, "m1"));
    const built = (await CALENDAR_BUILDERS.calendar_event(db as never, w.accountId, [w.eventId])).get(w.eventId)!;
    expect(built.writes.map((m) => m.key)).toEqual(["m1", "m2"]);
    const heavy = cutToFit({ ...built, notes: "x".repeat(300 * 1024) });
    expect([heavy.cut, heavy.writes.map((m) => [m.key, m.act])]).toEqual([true, [["m1", null], ["m2", null]]]);
  });

  it("never sends again a change refused for the copy it was made on, nor what waited for it: 'keep mine' is a new act on the copy the store holds", async () => {
    const w = await world();
    const stale = new Date(Date.parse(w.updatedAt) - 60_000).toISOString();
    const head = await recordCalendarWrite(ctx(w.accountId), "k1", update(w, { title: "Mine" }, stale));
    const next = await recordCalendarWrite(ctx(w.accountId), "k2", update(w, { title: "Mine, later" }, stale, "k1"));
    const behind = await recordCalendarWrite(ctx(w.accountId), "k3", update(w, { place: "Studio 3" }, stale, "k2"));
    // A change the provider refused for its version is the same word, and the same answer.
    const v = await world();
    const sent = await recordCalendarWrite(ctx(v.accountId), "k4", update(v, { title: "Mine" }));
    await db.update(calWrites).set({ state: "refused", refusal: "version_stale", attempts: 1 }).where(eq(calWrites.id, sent.answer.write!.id));
    const got: string[] = [];
    for (const [a, id] of [[w, head], [w, next], [w, behind], [v, sent]] as const) got.push(await refusal(retryCalendarWrite(ctx(a.accountId), id.answer.write!.id)));
    expect(got).toEqual(Array(4).fill("409 calendar_write_left"));
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state, r.refusal]))
      .toEqual([["k1", "refused", "version_stale"], ["k2", "refused", "earlier_refused"], ["k3", "refused", "earlier_refused"]]);
    // Keep mine: the change made again on the copy the store holds now, under a key of its own.
    const mine = await recordCalendarWrite(ctx(w.accountId), "k5", update(w, { title: "Mine" }));
    expect(mine.answer.write).toMatchObject({ state: "pending", reason: null });
  });

  it("never sends alone a write refused only because the one it waited for was, while that one stays refused: it goes again with it", async () => {
    const w = await world();
    const head = await recordCalendarWrite(ctx(w.accountId), "f1", update(w, { title: "Mine, first" }));
    // The provider kept refusing the first until its last attempt (the drain's own words).
    await db.update(calWrites).set({ state: "refused", refusal: "unavailable", attempts: 8 }).where(eq(calWrites.id, head.answer.write!.id));
    // Someone else changes the event, and a reading stores their copy; the device, still on the first copy, presses again after its first act.
    await db.update(calEvents).set({ versionTag: '"v2"', title: "Theirs", updatedAt: new Date(Date.parse(w.updatedAt) + 60_000) }).where(eq(calEvents.id, w.eventId));
    const follower = await recordCalendarWrite(ctx(w.accountId), "f2", update(w, { title: "Mine, second" }, w.updatedAt, "f1"));
    expect(follower.answer.write).toMatchObject({ state: "refused", reason: "earlier_refused" });
    // Alone it would be sent on the copy the store holds now, which its device never held: refused, and nothing is owed.
    expect(await refusal(retryCalendarWrite(ctx(w.accountId), follower.answer.write!.id))).toBe("409 calendar_write_left");
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state, r.refusal])).toEqual([["f1", "refused", "unavailable"], ["f2", "refused", "earlier_refused"]]);
    // With the one it waited for, both are owed again, the second behind the first.
    expect((await retryCalendarWrite(ctx(w.accountId), head.answer.write!.id)).answer.write).toMatchObject({ state: "pending" });
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state])).toEqual([["f1", "pending"], ["f2", "pending"]]);
  });

  it("puts a refused write and those refused with it back, and lets a refused or untried one go", async () => {
    const w = await world();
    const head = await recordCalendarWrite(ctx(w.accountId), "r1", update(w, { title: "One" }));
    await recordCalendarWrite(ctx(w.accountId), "r2", update(w, { title: "Next" }, w.updatedAt, "r1"));
    // The provider kept refusing the first until its last attempt, and the second was refused with it (the drain's words).
    await db.update(calWrites).set({ state: "refused", refusal: "unavailable", attempts: 8 }).where(eq(calWrites.id, head.answer.write!.id));
    await db.update(calWrites).set({ state: "refused", refusal: "earlier_refused" }).where(and(eq(calWrites.accountId, w.accountId), eq(calWrites.idempotencyKey, "r2")));
    const again = await retryCalendarWrite(ctx(w.accountId), head.answer.write!.id);
    expect(again.answer.write).toMatchObject({ state: "pending", reason: null });
    expect((await rowsOf(w.accountId)).map((r) => [r.key, r.state, r.refusal])).toEqual([["r1", "pending", null], ["r2", "pending", null]]);

    // Under way: tried once, not let go.
    await db.update(calWrites).set({ attempts: 1 }).where(eq(calWrites.idempotencyKey, "r1"));
    expect(await refusal(dismissCalendarWrite(ctx(w.accountId), head.answer.write!.id))).toBe("409 calendar_write_left");
    await db.update(calWrites).set({ attempts: 0 }).where(eq(calWrites.idempotencyKey, "r1"));
    const gone = await dismissCalendarWrite(ctx(w.accountId), head.answer.write!.id);
    expect([gone.answer.write, gone.answer.events[0]!.writes]).toEqual([null, []]);
    expect(await rowsOf(w.accountId)).toEqual([]);

    const made = await recordCalendarWrite(ctx(w.accountId), "r3", create(w));
    await dismissCalendarWrite(ctx(w.accountId), made.answer.write!.id);
    expect((await eventRows(w.accountId)).map((e) => e.title)).toEqual(["Kiln check"]);
    const deletes = await db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "delete")));
    expect(deletes.map((d) => d.id)).toEqual([made.answer.events[0]!.id]);
    expect(await refusal(retryCalendarWrite(ctx((await world()).accountId), made.answer.write!.id))).toBe("404 not_found");
  });

  it("checks an act without a database: one spelling of the repeat and the invitees", () => {
    const w = { calendarId: randomUUID() } as World;
    const act = checkedAct(create(w, { repeat: "freq=weekly;byday=tu,th", invitees: [{ address: " Anna@Example.TEST ", name: "", role: "required" }] }));
    expect(act.kind === "calendar_event_create" && [act.event.repeat, act.event.invitees]).toEqual([
      "FREQ=WEEKLY;BYDAY=TU,TH", [{ address: "anna@example.test", name: null, role: "required" }],
    ]);
  });
});
