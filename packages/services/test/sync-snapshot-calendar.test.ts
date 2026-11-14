import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, recordChange } from "@trafficflow/db";
import { calAlarms, calAttendees, calCalendars, calConnections, calEvents, calSuggestions, calWrites } from "@trafficflow/db/mail";
import { calendarExport, calendarFeed, setCalendarSettings } from "@trafficflow/services/calendar";
import type { CalendarEventRecord, CalendarWindow, SnapshotResponse, SyncChange } from "@ohmail/wire";
import { SyncService, ServiceError, dbFor, namedCalendarSpan, NAMED_CALENDAR_SPAN_MAX_MS, type ServiceContext } from "../src/index.js";
import { CALENDAR_SPAN_CASES, heldBySpan, type CalendarSpan } from "@ohmail/testing/calendar-span-twin";

/**
 * THE FIRST LOAD'S CALENDAR PHASE. After every mail phase, for a request the calendar is served
 * to: the connections, the calendars and the newest open suggestions on its first page, then the
 * events of the window around today in `(starts_at, id)` order, in pages, every row at the
 * snapshot's own seq. The events are chosen by the device's own cases, written once more in SQL;
 * one table of examples holds the two the same. A server that keeps no calendar answers exactly as
 * before, and refuses a calendar cursor as it refuses any word it does not know.
 */

const svc = new SyncService();
const NOW = new Date("2026-07-27T12:00:00.000Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() + n * DAY);
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function world(opts: { on?: boolean } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `snap-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x.example" }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  if (opts.on ?? true) await setCalendarSettings(ctx, { enabled: true });
  const connectionId = randomUUID();
  const calendarId = randomUUID();
  await db.insert(calConnections).values({ id: connectionId, accountId, provider: "google", label: "Personal" });
  await db.insert(calCalendars).values({ id: calendarId, accountId, connectionId, providerId: "primary", name: "Home", access: "owner" });
  return { db, accountId, mailboxId: mb!.id, ctx, connectionId, calendarId };
}

interface Facts { startsAt: Date; endsAt: Date | null; occurrenceAt?: Date | null; thisAndFuture?: boolean }

async function event(db: Db, w: { accountId: string; calendarId: string }, f: Facts): Promise<string> {
  const id = randomUUID();
  await db.insert(calEvents).values({
    id, accountId: w.accountId, calendarId: w.calendarId, providerId: `p-${id}`, uid: `${id}@example.test`,
    startKind: "instant", startLocal: "20260727T120000Z", startsAt: f.startsAt, endsAt: f.endsAt,
    recurrenceId: f.occurrenceAt ? "20260801T120000Z" : "", occurrenceAt: f.occurrenceAt ?? null,
    thisAndFuture: f.thisAndFuture ?? false, ...(f.endsAt === null ? { repeatRule: "FREQ=DAILY" } : {}),
  });
  return id;
}

/** Every page of a snapshot walk, from page 1 or a given first page's options. */
async function walk(ctx: ServiceContext, opts: Parameters<SyncService["getSnapshot"]>[1] = {}): Promise<SnapshotResponse[]> {
  const pages: SnapshotResponse[] = [];
  let cursor: string | undefined;
  // Later pages carry what page 1 asked for in their cursor; only the kinds and the port go on.
  const { phase: _phase, span: _span, ...later } = opts;
  for (let n = 0; n < 100; n++) {
    const page = await svc.getSnapshot(ctx, cursor === undefined ? opts : { ...later, cursor });
    pages.push(page);
    if (page.nextCursor === null || page.nextCursor === undefined) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("the walk never ended");
}

const NAMED = ["message", "settings", "calendar_connection", "calendar", "calendar_event", "calendar_suggestion"] as const;
const served = { types: [...NAMED], calendar: calendarFeed };
const ofKind = (pages: SnapshotResponse[], kind: string): string[] =>
  pages.flatMap((p) => p.changes.filter((c: SyncChange) => c.type === kind).map((c) => c.id));

describe("the calendar's phase follows the mail's", () => {
  it("in order, after the mail, its first page leading with the small state, every row at the snapshot's seq", async () => {
    const w = await world();
    const suggestion = randomUUID();
    await w.db.insert(calSuggestions).values({
      id: suggestion, accountId: w.accountId, messageId: randomUUID(), mailboxId: w.mailboxId, evidence: "dates",
      proposed: { title: "Lunch", start: { kind: "date", value: "20260801" }, end: null, place: null },
    });
    const e = await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const pages = await walk(w.ctx, served);
    expect(pages.length).toBe(2);
    const [mail, calendar] = pages as [SnapshotResponse, SnapshotResponse];
    expect(mail.changes.some((c) => c.type.startsWith("calendar"))).toBe(false);
    // The page whose next cursor opens the calendar's phase says the span a device keeps.
    expect(mail.calendarWindow).toEqual(calendarFeed.window);
    expect(calendar.changes.map((c) => c.type)).toEqual(["calendar_connection", "calendar", "calendar_suggestion", "calendar_event"]);
    expect(calendar.changes.map((c) => c.id)).toEqual([w.connectionId, w.calendarId, suggestion, e]);
    for (const p of pages) for (const c of p.changes) expect(c.seq).toBe(mail.asOfSeq);
    expect(calendar.calendarWindow).toEqual(calendarFeed.window);
  });

  it("projects only times and recurrence from a calendar that now grants availability alone", async () => {
    const w = await world();
    const master = await event(w.db, w, { startsAt: NOW, endsAt: null });
    const other = await event(w.db, w, { startsAt: day(1), endsAt: day(1.1), occurrenceAt: day(1) });
    const details = {
      uid: "private-series@example.invalid", title: "Private appointment", notes: "Private notes",
      place: "Private room", callLink: "https://room.example.invalid/meeting",
      organizer: "owner@example.invalid", organizerName: "Private organizer", myAnswer: "accepted", private: true,
    };
    for (const id of [master, other]) await w.db.update(calEvents).set(details).where(eq(calEvents.id, id));
    await w.db.insert(calAttendees).values({ accountId: w.accountId, eventId: master, address: "guest@example.invalid" });
    await w.db.insert(calAlarms).values({ accountId: w.accountId, eventId: master, minutesBefore: 15, method: "notice" });
    await w.db.insert(calWrites).values({
      accountId: w.accountId, eventId: master, calendarId: w.calendarId, idempotencyKey: "private-key",
      op: "update", payload: {}, state: "pending",
    });
    await w.db.update(calEvents).set({
      repeatRule: "FREQ=DAILY\nX-PRIVATE=Private custom recurrence",
      addedDates: [{ kind: "date", value: "20260806", source: "Private stored extension" }],
    }).where(eq(calEvents.id, master));
    const projection = async () => (await walk(w.ctx, served)).flatMap((page) =>
      page.changes.filter((row) => row.type === "calendar_event").map((row) => row.entity as CalendarEventRecord));
    const full = (await projection()).find((row) => row.id === master)!;
    expect(full).toMatchObject({ uid: details.uid, title: details.title, notes: details.notes, place: details.place,
      callLink: details.callLink, organizer: { address: details.organizer }, myAnswer: "accepted",
      invitees: [{ address: "guest@example.invalid" }], alarms: [{ minutesBefore: 15 }], writes: [{ key: "private-key" }] });
    await w.db.update(calCalendars).set({ access: "busy" }).where(eq(calCalendars.id, w.calendarId));
    const limited = await projection();
    expect(limited.map((row) => row.id).sort()).toEqual([master, other].sort());
    const series = limited.find((row) => row.id === master)!;
    const exception = limited.find((row) => row.id === other)!;
    expect(series).toMatchObject({ title: "", notes: null, place: null, callLink: null, organizer: null, myAnswer: null,
      private: false, invitees: [], alarms: [], writes: [], start: full.start, repeat: { rules: ["FREQ=DAILY"], added: [{ kind: "date", value: "20260806" }] }, startsAt: full.startsAt });
    expect(series).not.toHaveProperty("personalSeries");
    expect(series.uid).not.toBe(details.uid);
    expect(exception.uid).toBe(series.uid);
    expect(exception.occurrenceAt).toBe(day(1).toISOString());
    expect(JSON.stringify(limited)).not.toMatch(/Private|private-|example\.invalid/);
    // A delta carrying just an exception must use its master's same opaque identity.
    await w.db.transaction((tx) => recordChange(tx as never, { accountId: w.accountId, entityType: "calendar_event", entityId: other, op: "update" }));
    const delta = await svc.getChanges(w.ctx, { since: "0", ...served });
    const echoed = [...delta.changes.creates, ...delta.changes.updates].find((row) => row.id === other);
    expect(echoed?.entity).toEqual(exception);
    await w.db.update(calCalendars).set({ access: "reader" }).where(eq(calCalendars.id, w.calendarId));
    expect((await projection()).find((row) => row.id === master)).toEqual(full);
  });

  it("keeps an exception with the same busy series when the master arrives later", async () => {
    const w = await world();
    await w.db.update(calCalendars).set({ access: "busy" }).where(eq(calCalendars.id, w.calendarId));
    const one = async (id: string) => (await calendarFeed.build(w.ctx.db, w.accountId, "calendar_event", [id])).get(id)!;
    const uid = "same-provider-series";
    const changed = await event(w.db, w, { startsAt: day(1.1), endsAt: day(1.2), occurrenceAt: day(1) });
    await w.db.update(calEvents).set({ uid, recurrenceId: String(day(1).getTime()) }).where(eq(calEvents.id, changed));
    const first = await one(changed);
    const master = await event(w.db, w, { startsAt: NOW, endsAt: null });
    await w.db.update(calEvents).set({ uid }).where(eq(calEvents.id, master));
    expect((await one(master)).uid).toBe(first.uid);
    expect(first.uid).not.toBe(uid);
    await w.db.delete(calEvents).where(eq(calEvents.id, master));
    expect(await one(changed)).toEqual(first);
  });

  it("keeps busy time zones usable while discarding provider text from dates and occurrence keys", async () => {
    const w = await world();
    const master = await event(w.db, w, { startsAt: NOW, endsAt: null });
    const other = await event(w.db, w, { startsAt: day(1.1), endsAt: day(1.2), occurrenceAt: day(1) });
    const known = "/mozilla.org/Private provider/Europe/Zurich";
    const unknown = "Private custom zone";
    await w.db.update(calCalendars).set({ access: "busy", timeZone: known }).where(eq(calCalendars.id, w.calendarId));
    await w.db.update(calEvents).set({
      uid: "series", startKind: "zoned", startLocal: "20260727T140000", startZone: known,
      endKind: "zoned", endLocal: "20260727T150000", endZone: known,
      excludedDates: [{ kind: "zoned", value: "20260728T140000", zone: unknown, original: "Private original" }],
      addedDates: [{ kind: "zoned", value: "20260729T140000", zone: unknown }, null],
    }).where(eq(calEvents.id, master));
    await w.db.update(calEvents).set({
      uid: "series", recurrenceId: unknown + "|20260728T1400|false", startKind: "zoned", startLocal: "20260728T143000", startZone: unknown,
    }).where(eq(calEvents.id, other));
    const pages = await walk(w.ctx, served);
    const changes = pages.flatMap((page) => page.changes);
    const series = changes.find((row) => row.id === master)!.entity as CalendarEventRecord;
    const exception = changes.find((row) => row.id === other)!.entity as CalendarEventRecord;
    const zone = series.repeat?.excluded[0]?.zone;
    expect(series.start).toEqual({ kind: "zoned", value: "20260727T140000", zone: "Europe/Zurich" });
    expect(series.end).toEqual({ kind: "zoned", value: "20260727T150000", zone: "Europe/Zurich" });
    expect(zone).toMatch(/^Unresolved\/[a-f0-9]+$/);
    expect(series.repeat?.added).toEqual([{ kind: "zoned", value: "20260729T140000", zone }]);
    expect(exception).toMatchObject({ uid: series.uid, recurrenceId: zone + "|20260728T1400|false", start: { zone } });
    expect(changes.find((row) => row.id === w.calendarId)?.entity).toMatchObject({ timeZone: "Europe/Zurich" });
    expect(JSON.stringify(changes)).not.toContain("Private");
    const exported = () => calendarExport(w.ctx.db, w.accountId);
    expect((await exported())?.connections[0]?.calendars[0]?.timeZone).toBe("Europe/Zurich");
    await w.db.update(calCalendars).set({ timeZone: unknown }).where(eq(calCalendars.id, w.calendarId));
    expect((await exported())?.connections[0]?.calendars[0]?.timeZone).toBe(zone);
    await w.db.update(calCalendars).set({ access: "reader" }).where(eq(calCalendars.id, w.calendarId));
    expect((await exported())?.connections[0]?.calendars[0]?.timeZone).toBe(unknown);
  });

  it("where none is kept, byte for byte the mail's, whatever the request names and the account's row says", async () => {
    const w = await world();
    await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const bare = await walk(w.ctx);
    expect(JSON.stringify(await walk(w.ctx, { types: [...NAMED] }))).toBe(JSON.stringify(bare));
    expect(ofKind(bare, "calendar_event")).toEqual([]);
    expect(JSON.stringify(bare)).not.toContain("calendar");
  });

  it("not while the switch is off, nor to a request that names no calendar kind or not the switch", async () => {
    const off = await world({ on: false });
    await event(off.db, off, { startsAt: day(1), endsAt: day(1.1) });
    const on = await world();
    await event(on.db, on, { startsAt: day(1), endsAt: day(1.1) });
    // The calendar's kinds without the settings record: a device that would never hear the switch go off.
    const deaf = NAMED.filter((t) => t !== "settings");
    for (const pages of [
      await walk(off.ctx, served), await walk(on.ctx, { types: ["message", "settings"], calendar: calendarFeed }),
      await walk(on.ctx, { types: [...deaf], calendar: calendarFeed }),
      await walk(on.ctx, { types: [...deaf], calendar: calendarFeed, phase: "calendar" }),
    ]) {
      expect(pages).toHaveLength(1);
      expect(pages[0]).not.toHaveProperty("calendarWindow");
      expect(pages[0]!.nextCursor).toBeNull();
      expect(pages[0]!.changes.filter((c) => c.type.startsWith("calendar"))).toEqual([]);
    }
  });

  it("many events go in pages, each under the page's bytes, every event once and in order", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await event(w.db, w, { startsAt: day(i % 5), endsAt: day((i % 5) + 0.1) }));
    const pages = await walk(w.ctx, { ...served, limit: 4 });
    const events = ofKind(pages, "calendar_event");
    expect(events).toHaveLength(25);
    expect(new Set(events).size).toBe(25);
    const starts = pages.flatMap((p) => p.changes.filter((c) => c.type === "calendar_event"))
      .map((c) => `${(c.entity as { startsAt: string }).startsAt}|${c.id}`);
    expect(starts).toEqual([...starts].sort());
    expect(pages.filter((p) => p.changes.some((c) => c.type === "calendar_event")).length).toBeGreaterThanOrEqual(7);
    // The small state rides the phase's first page only.
    expect(ofKind(pages, "calendar_connection")).toEqual([w.connectionId]);
  });

  it("past its row ceiling the window leaves out the events farthest from today first", async () => {
    const w = await world();
    const near = [await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) }), await event(w.db, w, { startsAt: day(-2), endsAt: day(-1.9) })];
    const far = [await event(w.db, w, { startsAt: day(200), endsAt: day(200.1) }), await event(w.db, w, { startsAt: day(-300), endsAt: day(-299.9) })];
    const narrow: CalendarWindow = { ...calendarFeed.window, maxRows: 2 };
    const pages = await walk(w.ctx, { ...served, calendar: { ...calendarFeed, window: narrow } });
    expect(ofKind(pages, "calendar_event").sort()).toEqual([...near].sort());
    expect(ofKind(pages, "calendar_event")).not.toContain(far[0]);
  });
});

describe("one table of cases, held by the device and by the server's SQL", () => {
  const SPAN: CalendarSpan = { fromMs: day(0).getTime(), toMs: day(10).getTime() };
  /** Each example: an event's facts and whether a span of days 0 to 10 holds it. */
  const TABLE: Array<{ name: string; f: Facts; held: boolean }> = [
    { name: "inside", f: { startsAt: day(2), endsAt: day(2.1) }, held: true },
    { name: "across the start", f: { startsAt: day(-1), endsAt: day(1) }, held: true },
    { name: "across the end", f: { startsAt: day(9), endsAt: day(12) }, held: true },
    { name: "over the whole span", f: { startsAt: day(-5), endsAt: day(20) }, held: true },
    { name: "a series that never ends, begun before", f: { startsAt: day(-50), endsAt: null }, held: true },
    { name: "a series begun after", f: { startsAt: day(15), endsAt: null }, held: false },
    { name: "long before", f: { startsAt: day(-20), endsAt: day(-19) }, held: false },
    { name: "long after", f: { startsAt: day(20), endsAt: day(21) }, held: false },
    { name: "moved out, its original inside", f: { startsAt: day(30), endsAt: day(30.1), occurrenceAt: day(3) }, held: true },
    { name: "moved in from outside", f: { startsAt: day(4), endsAt: day(4.1), occurrenceAt: day(40) }, held: true },
    { name: "moved, both outside", f: { startsAt: day(30), endsAt: day(30.1), occurrenceAt: day(40) }, held: false },
    { name: "this and later ones, from before the end", f: { startsAt: day(30), endsAt: day(30.1), occurrenceAt: day(-30), thisAndFuture: true }, held: true },
    { name: "this and later ones, from after the end", f: { startsAt: day(30), endsAt: day(30.1), occurrenceAt: day(25), thisAndFuture: true }, held: false },
    { name: "within the slack before the start", f: { startsAt: day(-1), endsAt: new Date(day(0).getTime() - 10 * 3_600_000) }, held: true },
  ];

  it("the device's predicate answers the table", () => {
    for (const row of TABLE) {
      const facts = {
        startsAt: row.f.startsAt.getTime(), endsAt: row.f.endsAt?.getTime() ?? null,
        occurrenceAt: row.f.occurrenceAt?.getTime() ?? null, thisAndFuture: row.f.thisAndFuture ?? false,
      };
      expect(heldBySpan(facts, [SPAN]), row.name).toBe(row.held);
    }
    expect(Object.keys(CALENDAR_SPAN_CASES)).toHaveLength(3);
  });

  it("and the server's first load serves exactly the rows it holds", async () => {
    const w = await world();
    const byId = new Map<string, string>();
    for (const row of TABLE) byId.set(await event(w.db, w, row.f), row.name);
    const pages = await walk(w.ctx, { ...served, phase: "calendar", span: SPAN });
    const sent = ofKind(pages, "calendar_event").map((id) => byId.get(id)).sort();
    expect(sent).toEqual(TABLE.filter((r) => r.held).map((r) => r.name).sort());
  });
});

describe("the phase alone, and a named span", () => {
  it("?phase=calendar on page 1 is the calendar's phase and nothing of the mail", async () => {
    const w = await world();
    const e = await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const pages = await walk(w.ctx, { ...served, phase: "calendar" });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.changes.map((c) => c.id)).toEqual([w.connectionId, w.calendarId, e]);
    expect(pages[0]!.calendarWindow).toEqual(calendarFeed.window);
  });

  it("a named span serves its own days, and is cut to a year from its start", async () => {
    const w = await world();
    const early = await event(w.db, w, { startsAt: day(-600), endsAt: day(-599.9) });
    await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const span = namedCalendarSpan(day(-700).toISOString(), day(-500).toISOString())!;
    expect(ofKind(await walk(w.ctx, { ...served, phase: "calendar", span }), "calendar_event")).toEqual([early]);
    const long = namedCalendarSpan(day(-700).toISOString(), day(700).toISOString())!;
    expect(long.toMs - long.fromMs).toBe(NAMED_CALENDAR_SPAN_MAX_MS);
    for (const [from, to] of [[day(1).toISOString(), day(0).toISOString()], ["yesterday", day(0).toISOString()], [day(0).toISOString(), null]]) {
      expect(() => namedCalendarSpan(from, to), `${from} → ${to}`).toThrow(ServiceError);
    }
    expect(namedCalendarSpan(null, null)).toBeUndefined();
  });

  it("the switch off: the phase alone is an empty last page", async () => {
    const w = await world({ on: false });
    await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const pages = await walk(w.ctx, { ...served, phase: "calendar" });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.changes).toEqual([]);
    expect(pages[0]).not.toHaveProperty("calendarWindow");
  });
});

describe("the cursors", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const id = "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

  it("today's three shapes decode as they always did", () => {
    expect(svc.decodeSnapshotCursor(b64({ v: 2, s: "12", n: 3, d: 1_700_000_000_000, i: id })))
      .toEqual({ asOfSeq: 12n, generation: null, date: 1_700_000_000_000, id, emitted: 3 });
    expect(svc.decodeSnapshotCursor(b64({ v: 2, s: "12", n: 3, g: 4, d: 1_700_000_000_000, i: id, p: "tail", da: 1_699_000_000_000, di: id })))
      .toEqual({ asOfSeq: 12n, generation: 4, date: 1_700_000_000_000, id, emitted: 3, phase: "tail", draft: { updatedAt: 1_699_000_000_000, id } });
    expect(svc.decodeSnapshotCursor(b64({ v: 2, s: "12", n: 3, p: "drafts", da: 1_699_000_000_000, di: id })))
      .toEqual({ asOfSeq: 12n, generation: null, emitted: 3, phase: "drafts", draft: { updatedAt: 1_699_000_000_000, id } });
  });

  it("refuses a calendar cursor no server issued", () => {
    for (const bad of [
      { v: 2, s: "1", n: 0, p: "calendar", d: 1 },
      { v: 2, s: "1", n: 0, p: "calendar", f: 1 },
      { v: 2, s: "1", n: 0, p: "calendar", d: 1, i: id },
      { v: 2, s: "1", n: 0, p: "calendar", f: 2, t: 1 },
      { v: 2, s: "1", n: 0, p: "calendar", f: 0, t: 10 * 366 * DAY },
      { v: 2, s: "1", n: 0, p: "calendar", da: 1, di: id },
      { v: 2, s: "1", n: 0, p: "calendar", d: 1, i: "x", f: 0, t: 1 },
    ]) expect(() => svc.decodeSnapshotCursor(b64(bad)), JSON.stringify(bad)).toThrow(ServiceError);
  });

  it("a server that keeps no calendar refuses one, 410, as it refuses any word it does not know", async () => {
    const w = await world();
    await event(w.db, w, { startsAt: day(1), endsAt: day(1.1) });
    const calendarCursor = (await svc.getSnapshot(w.ctx, served)).nextCursor!;
    expect(calendarCursor).toEqual(expect.any(String));
    const refused = await svc.getSnapshot(w.ctx, { cursor: calendarCursor }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).httpStatus).toBe(410);
  });
});
