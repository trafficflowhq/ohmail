import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@trafficflow/api";
import {
  fencedAccountWrite, recordCalendarChanges, sweepMailboxData, CALENDAR_RECORD_KINDS, type CalendarChange, type LedgerTx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  accounts, calAlarms, calAttendees, calCalendars, calConnections, calEvents, calSettings, calSuggestions, calWrites, changeLog,
  mailboxes,
} from "@trafficflow/db/mail";
import { SyncService, dbFor } from "@trafficflow/services/mail";
import { calendarFeed, setCalendarSettings } from "@trafficflow/services/calendar";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { HttpAdapter, MemoryMirrorStore, NAMED_FEED_KINDS, OhmailEngine, SYNC_ENTITY_TYPES } from "@ohmail/client-engine";
import type { CalendarEventRecord, CalendarRecordKind, SyncChange, SyncResponse } from "@ohmail/wire";
import { syncRoutes } from "../../../packages/api/src/routes/sync.js";
import { makeDeps, seedMailbox, seedSession, FIXED_NOW } from "../../../packages/api/test/helpers.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CLOUD_SYNC_TYPES } from "../src/cloud-mirror.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { storeCalendarSwitch, wipeCalendarCopy } from "../src/cloud-mirror-calendar.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

/**
 * EVERY CALENDAR KIND WALKS THE WHOLE WAY: a row on the server, its change through the one door,
 * the real `/sync` route, a device's store; the desktop's copy of the Cloud account through its
 * own pull, that copy's own feed (the local door), and a second device's store reading it. The
 * two devices must hold the same records. The two silent ways a kind used to be lost are what this
 * refuses: a kind without its builder reaches a device as a deletion, and a kind without the
 * desktop's storing case is fetched and dropped.
 */

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(() => tearDown({ stop: [mirrors, sidecars], close: opens, remove: dirs }));

const OWN = "me@ohmail.test";
const at = (h: number) => new Date(FIXED_NOW.getTime() + h * 3_600_000);

/**
 * A server with a calendar (the word: its port and routes), an account that switched it on through
 * the switch's own service, one row of every kind, and their changes. `word: false` is a server
 * that keeps none: the same rows, no port, no routes.
 */
async function server(events = 1, opts: { word?: boolean; marks?: boolean } = {}) {
  const word = opts.word ?? true;
  const { db, deps, clock } = await makeDeps();
  if (word) deps.services = { ...deps.services, calendar: calendarFeed } as never;
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const ids = { connection: randomUUID(), calendar: randomUUID(), suggestion: randomUUID(), events: [] as string[] };
  const ctx = { db: dbFor(db, s.accountId), accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "switch" } as never;
  await setCalendarSettings(ctx, { enabled: true });
  await db.insert(calConnections).values({
    id: ids.connection, accountId: s.accountId, provider: "caldav", label: "Work", serverUrl: "https://dav.example.test/cal/me/",
    principal: "/principals/me/", listToken: "never-sent", mailboxId,
  });
  await db.insert(calCalendars).values({
    id: ids.calendar, accountId: s.accountId, connectionId: ids.connection, providerId: "/cal/me/work/", name: "Work",
    color: "#336699", access: "owner", timeZone: "Europe/Zurich", syncToken: "never-sent",
  });
  await db.insert(calAlarms).values({ accountId: s.accountId, calendarId: ids.calendar, minutesBefore: 15 });
  for (let i = 0; i < events; i++) {
    const id = randomUUID();
    ids.events.push(id);
    const organizer = "boss" + String.fromCharCode(64) + "example.test";
    const stamp = (hour: number) => new Date(Date.UTC(2026, 6, 28, hour)).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const original = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calendar fixture//EN", "BEGIN:VEVENT",
      `UID:fixture-${i}`, `DTSTAMP:${stamp(12)}`, `DTSTART:${stamp(14)}`,
      `ORGANIZER;CN=Boss:mailto:${organizer}`, "X-PRIVATE:never-sent", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    await db.insert(calEvents).values({
      id, accountId: s.accountId, calendarId: ids.calendar, providerId: `/cal/me/work/${i}.ics`, versionTag: "never-sent",
      uid: `uid-${i}@example.test`, title: `Meeting ${i}`, notes: "Agenda", place: "Room 1",
      startKind: "zoned", startLocal: "20260728T140000", startZone: "Europe/Zurich",
      endKind: "zoned", endLocal: "20260728T150000", endZone: "Europe/Zurich",
      startsAt: at(i), endsAt: at(i + 1), organizer, organizerName: "Boss", myAnswer: "accepted",
      original, ...(i === 0 ? { repeatRule: "FREQ=WEEKLY;COUNT=4", excludedDates: [{ kind: "zoned", value: "20260804T140000", zone: "Europe/Zurich" }] } : {}),
    });
    await db.insert(calAttendees).values([
      { accountId: s.accountId, eventId: id, address: "a@example.test", name: "A", role: "chair", answer: "accepted" },
      { accountId: s.accountId, eventId: id, address: "b@example.test", name: null, role: "optional", answer: "none" },
    ]);
    await db.insert(calAlarms).values({ accountId: s.accountId, eventId: id, minutesBefore: 10 });
  }
  if (opts.marks === true) {
    // A person's change owed to the provider, and an earlier one the provider refused: both ride the event's record.
    const act = (title: string) => ({ v: 1, act: { kind: "calendar_event_update", eventId: ids.events[0]!, base: FIXED_NOW.toISOString(), scope: { kind: "record" }, change: { title } }, after: null, part: null });
    await db.insert(calWrites).values([
      { accountId: s.accountId, calendarId: ids.calendar, eventId: ids.events[0]!, op: "update", payload: act("Refused"), idempotencyKey: "press-1", state: "refused", refusal: "version_stale", createdAt: at(-2) },
      { accountId: s.accountId, calendarId: ids.calendar, eventId: ids.events[0]!, op: "update", payload: act("Owed"), idempotencyKey: "press-2", state: "pending", createdAt: at(-1) },
    ]);
  }
  await db.insert(calSuggestions).values({
    id: ids.suggestion, accountId: s.accountId, messageId: randomUUID(), mailboxId, evidence: "dates",
    proposed: { title: "Lunch", start: { kind: "date", value: "20260801" }, end: null, place: null }, sourceWords: "lunch on Saturday",
  });
  const changes: CalendarChange[] = [
    { kind: "calendar_connection", id: ids.connection, op: "create" },
    { kind: "calendar", id: ids.calendar, op: "create" },
    ...ids.events.map((id): CalendarChange => ({ kind: "calendar_event", id, op: "create" })),
    { kind: "calendar_suggestion", id: ids.suggestion, op: "create" },
  ];
  for (let i = 0; i < changes.length; i += 200) {
    await fencedAccountWrite(db as never, { accountId: s.accountId }, (tx) => recordCalendarChanges(tx as never, s.accountId, changes.slice(i, i + 200)));
  }
  const app = createApp(word ? [...syncRoutes, ...calendarRoutes] : syncRoutes);
  const route = (path: string, init: RequestInit = {}): Promise<Response> => app.handle(
    new Request(`http://localhost${path}`, {
      ...init, headers: { authorization: `Bearer ${s.token}`, "x-requested-with": "ohmail", "content-type": "application/json" },
    }),
    { ...deps, session: null, idempotency: null } as never,
  );
  /** The account's switch, flipped a minute later through its own route, as a person's press does. */
  const flip = async (enabled: boolean): Promise<void> => {
    clock.advance(60_000);
    const res = await route("/calendar/settings", { method: "PATCH", body: JSON.stringify({ enabled }) });
    expect(res.status).toBe(200);
  };
  return { db, s, mailboxId, ids, route, flip };
}

const TYPES = `types=${CLOUD_SYNC_TYPES.join(",")}`;

/** Every page of the route from `since`, applied to a device's store as the engine applies them. */
async function drain(route: (p: string) => Promise<Response>, limit = 500): Promise<{ store: MemoryMirrorStore; pages: SyncResponse[] }> {
  const store = new MemoryMirrorStore();
  await store.load();
  const pages: SyncResponse[] = [];
  let since = "0";
  for (let n = 0; n < 50; n++) {
    const res = await route(`/sync?since=${since}&limit=${limit}&${TYPES}`);
    expect(res.status).toBe(200);
    const page = await res.json() as SyncResponse;
    pages.push(page);
    await store.applyResponse(page as never);
    since = page.cursor;
    if (!page.hasMore) break;
  }
  return { store, pages };
}

const held = (store: MemoryMirrorStore, kind: CalendarRecordKind) =>
  store.entries(kind).filter((r) => r.entity !== null).map((r) => r.entity as Record<string, unknown>)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** The desktop's copy of the Cloud account: its own pull against the real route. */
async function desktopCopy(route: (p: string) => Promise<Response>, mailboxId: string) {
  const dataDir = await freshDataDir("ohmail-cal-walk-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  const auth: CloudAuth = {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return new Response(JSON.stringify(mailboxList([hostedMailbox(mailboxId, OWN)])), { status: 200 });
      // No first load of the calendar here: the whole log is read from the start.
      if (path.startsWith("/sync/snapshot")) {
        return new Response(JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } }), { status: 200 });
      }
      if (path.startsWith("/sync")) return route(path);
      if (path.startsWith("/messages/bodies")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as unknown as CloudAuth;
  const cursorPath = join(dataDir, "cloud-cursor.json");
  /** A mirror over this copy, as a launch makes one: it reads its cursor file afresh. */
  const launch = () => createCloudMirror({ db: opened.db, world, cursorPath, now: () => new Date(), auth });
  const mirror = launch();
  await mirror.pullOnce();
  await mirror.pullOnce();
  // The account's switch came with the settings record, which the copy's settings arm stores.
  expect((await opened.db.select({ at: calSettings.enabledAt }).from(calSettings))[0]?.at).toEqual(FIXED_NOW);
  // THE LOCAL DOOR: the copy's own feed, which the desktop's window reads.
  const local = await new SyncService().getChanges(
    { db: dbFor(opened.db, world.accountId), accountId: world.accountId, userId: null, now: () => new Date(), requestId: "local", storeGeneration: undefined } as never,
    { since: "0", limit: 2000, types: [...CALENDAR_RECORD_KINDS, "settings"], calendar: calendarFeed },
  );
  const second = new MemoryMirrorStore();
  await second.load();
  await second.applyResponse(local as never);
  return { db: opened.db, world, second, mirror, launch, cursorPath };
}

describe("every calendar kind walks from a row to two devices", () => {
  it("a device and the desktop's copy hold the same four records, and nothing the record never carries", async () => {
    const srv = await server();
    const { store } = await drain(srv.route);
    for (const kind of CALENDAR_RECORD_KINDS) expect(held(store, kind), kind).toHaveLength(1);
    const [event] = held(store, "calendar_event");
    expect(event).toMatchObject({
      title: "Meeting 0", start: { kind: "zoned", value: "20260728T140000", zone: "Europe/Zurich" },
      repeat: { rules: ["FREQ=WEEKLY;COUNT=4"] }, organizer: { address: "boss@example.test", name: "Boss" },
      invitees: [{ address: "a@example.test", role: "chair" }, { address: "b@example.test", role: "optional" }],
      alarms: [{ minutesBefore: 10, method: "notice" }], cut: false,
    });
    expect(held(store, "calendar")[0]).toMatchObject({ defaultAlarms: [{ minutesBefore: 15, method: "notice" }], access: "owner" });
    expect(held(store, "calendar_connection")[0]).toMatchObject({ serverHost: "dav.example.test", grantMailboxId: srv.mailboxId });
    const wire = JSON.stringify([...CALENDAR_RECORD_KINDS].flatMap((k) => held(store, k)));
    for (const secret of ["never-sent", "/principals/", "/cal/me/", "BEGIN:VEVENT"]) expect(wire).not.toContain(secret);

    const desk = await desktopCopy(srv.route, srv.mailboxId);
    expect(held(desk.second, "calendar_connection")[0]).toMatchObject({
      serverHost: "dav.example.test", repeatShapes: expect.arrayContaining(["weekly/never"]),
    });
    for (const kind of CALENDAR_RECORD_KINDS) {
      expect(held(desk.second, kind), `${kind} through the desktop's copy`).toEqual(held(store, kind));
    }
  }, 120_000);

  it("an event's writes, owed and refused, ride its record through the desktop's copy and are served again as they left", async () => {
    const srv = await server(1, { marks: true });
    const { store } = await drain(srv.route);
    const [event] = held(store, "calendar_event") as unknown as CalendarEventRecord[];
    expect(event!.writes.map((w) => [w.key, w.state, w.reason, w.act?.kind])).toEqual([
      ["press-1", "refused", "version_stale", "calendar_event_update"], ["press-2", "pending", null, "calendar_event_update"],
    ]);
    const desk = await desktopCopy(srv.route, srv.mailboxId);
    expect(held(desk.second, "calendar_event")).toEqual(held(store, "calendar_event"));
  }, 120_000);

  it("many rows arrive in pages and converge under a repeated and a reordered page", async () => {
    const srv = await server(30);
    const { store, pages } = await drain(srv.route, 10);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(held(store, "calendar_event")).toHaveLength(30);
    const again = new MemoryMirrorStore();
    await again.load();
    for (const p of [...pages].reverse()) await again.applyResponse(p as never);
    for (const p of pages) await again.applyResponse(p as never);
    for (const kind of CALENDAR_RECORD_KINDS) expect(held(again, kind)).toEqual(held(store, kind));
  }, 120_000);

  it("a removed calendar reaches both devices as deletions, children first, and the copy keeps no orphan", async () => {
    const srv = await server(2);
    await fencedAccountWrite(srv.db as never, { accountId: srv.s.accountId }, async (tx) => {
      const t = tx as never as typeof srv.db;
      await t.delete(calAttendees);
      await t.delete(calAlarms);
      await t.delete(calEvents);
      await t.delete(calCalendars);
      return recordCalendarChanges(tx as never, srv.s.accountId, [
        ...srv.ids.events.map((id): CalendarChange => ({ kind: "calendar_event", id, op: "delete" })),
        { kind: "calendar", id: srv.ids.calendar, op: "delete" },
      ]);
    });
    const { store } = await drain(srv.route);
    expect(held(store, "calendar_event")).toEqual([]);
    expect(held(store, "calendar")).toEqual([]);
    expect(held(store, "calendar_connection")).toHaveLength(1);
    const desk = await desktopCopy(srv.route, srv.mailboxId);
    expect(await desk.db.select().from(calEvents)).toEqual([]);
    expect(await desk.db.select().from(calCalendars)).toEqual([]);
    expect(held(desk.second, "calendar_connection")).toHaveLength(1);
    void dialect;
  }, 120_000);

  it("a re-bootstrap's sweep takes the calendar's records the replay never named, each as its own deletion", async () => {
    const srv = await server(2);
    const desk = await desktopCopy(srv.route, srv.mailboxId);
    // An event the account no longer holds, its deletion compacted away while this copy was gone.
    const ghost = randomUUID();
    await desk.db.insert(calEvents).values({
      id: ghost, accountId: desk.world.accountId, calendarId: srv.ids.calendar, providerId: ghost, uid: `${ghost}@example.test`,
      startKind: "instant", startLocal: "20260728T140000Z", startsAt: at(5), endsAt: at(6),
    });
    await desk.db.insert(calAttendees).values({ accountId: desk.world.accountId, eventId: ghost, address: "x@example.test", role: "required", answer: "none" });
    // The cursor gone, the next launch replays the account from the start and sweeps what it never named.
    await desk.mirror.stop();
    unlinkSync(desk.cursorPath);
    const relaunched = desk.launch();
    await relaunched.pullOnce();
    await relaunched.pullOnce();
    expect((await desk.db.select({ id: calEvents.id }).from(calEvents)).map((r) => r.id).sort()).toEqual([...srv.ids.events].sort());
    expect(await desk.db.select().from(calAttendees).where(eq(calAttendees.eventId, ghost))).toEqual([]);
    expect((await desk.db.select({ id: calConnections.id }).from(calConnections)).map((r) => r.id)).toEqual([srv.ids.connection]);
    const gone = await desk.db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.entityType, "calendar_event"), eq(changeLog.op, "delete")));
    expect(gone.map((r) => r.id)).toEqual([ghost]);
  }, 120_000);

  it("signing out takes the whole calendar copy, and the local feed serves none of it again", async () => {
    const srv = await server(2, { marks: true });
    const desk = await desktopCopy(srv.route, srv.mailboxId);
    const before = await new SyncService().getChanges(
      { db: desk.db, accountId: desk.world.accountId, userId: null, now: () => new Date(), requestId: "local" } as never,
      { since: "0", limit: 2000, types: [...CALENDAR_RECORD_KINDS, "settings"], calendar: calendarFeed },
    );
    // A device that names the calendar's kinds and not the settings record is sent none to keep.
    const deafBefore = (await new SyncService().getChanges(
      { db: desk.db, accountId: desk.world.accountId, userId: null, now: () => new Date(), requestId: "local" } as never,
      { since: "0", limit: 2000, types: [...SYNC_ENTITY_TYPES], calendar: calendarFeed },
    )).changes.creates.filter((c) => c.type.startsWith("calendar"));
    await desk.db.transaction((tx) => wipeCalendarCopy(tx, desk.world.accountId));
    for (const table of [calConnections, calCalendars, calEvents, calAttendees, calAlarms, calSuggestions, calSettings, calWrites]) {
      expect(await desk.db.select().from(table)).toEqual([]);
    }
    // Past the cursor it had, a device is told the settings moved (its switch is gone with the
    // copy) and is sent no calendar change at all: what it held, it lets go on that word.
    const after = await new SyncService().getChanges(
      { db: desk.db, accountId: desk.world.accountId, userId: null, now: () => new Date(), requestId: "local" } as never,
      { since: before.cursor, limit: 2000, types: [...CALENDAR_RECORD_KINDS, "settings"], calendar: calendarFeed },
    );
    const told = [...after.changes.creates, ...after.changes.updates, ...after.changes.deletes];
    expect(told.map((c) => c.type)).toEqual(["settings"]);
    // The word a device lets the calendar go on: the switch, off.
    expect(told[0]?.entity).toMatchObject({ calendarEnabledAt: null });
    expect(deafBefore).toEqual([]);
  }, 120_000);
});

/**
 * A DEVICE KEEPS NOTHING OF THE CALENDAR THAT THE SWITCH OR AN ERASURE TOOK. Real engines over the
 * real routes: one names every kind with the settings record (the list every engine names, the
 * phone's included), one names the calendar's kinds without it (the phone's list before it heard
 * the switch). Nothing is sent while the switch is off, deletions included, so the second could
 * never let go of what it held: it is sent no calendar record at all.
 */
describe("a device keeps no calendar record the switch or an erasure took away", () => {
  function engineOver(route: (p: string, init?: RequestInit) => Promise<Response>, types: readonly string[]) {
    const store = new MemoryMirrorStore();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return route(`${url.pathname}${url.search}`, init?.method ? { method: init.method, ...(init.body ? { body: init.body } : {}) } : {});
    }) as unknown as typeof fetch;
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store, now: () => FIXED_NOW, types: [...types],
    });
    const calendar = (): string[] => CALENDAR_RECORD_KINDS
      .flatMap((k) => store.entries(k).filter((r) => r.entity !== null).map((r) => `${k}:${r.id}`)).sort();
    return { engine, calendar };
  }

  it("one that hears the switch lets the calendar go when it goes off; one that does not is sent none", async () => {
    const srv = await server(2);
    const hearing = engineOver(srv.route, NAMED_FEED_KINDS);
    const deaf = engineOver(srv.route, SYNC_ENTITY_TYPES);
    await hearing.engine.syncOnce();
    await deaf.engine.syncOnce();
    expect(hearing.calendar()).toHaveLength(5);
    expect(deaf.calendar()).toEqual([]);
    await srv.flip(false);
    await hearing.engine.syncOnce();
    await deaf.engine.syncOnce();
    expect(hearing.calendar()).toEqual([]);
    expect(deaf.calendar()).toEqual([]);
  }, 120_000);

  it("switched off, its mailbox erased meanwhile, and on again: the device holds only what stands", async () => {
    const srv = await server(1);
    // A connection of its own, riding no mailbox, with one event: what the erasure leaves.
    const own = { connection: randomUUID(), calendar: randomUUID(), event: randomUUID() };
    await fencedAccountWrite(srv.db as never, { accountId: srv.s.accountId }, async (tx) => {
      const t = tx as never as typeof srv.db;
      await t.insert(calConnections).values({ id: own.connection, accountId: srv.s.accountId, provider: "ics", label: "Holidays" });
      await t.insert(calCalendars).values({ id: own.calendar, accountId: srv.s.accountId, connectionId: own.connection, providerId: "holidays" });
      await t.insert(calEvents).values({
        id: own.event, accountId: srv.s.accountId, calendarId: own.calendar, providerId: "h1", uid: "h1@example.test",
        startKind: "date", startLocal: "20260801", startsAt: at(24), endsAt: at(48),
      });
      return recordCalendarChanges(tx as never, srv.s.accountId, [
        { kind: "calendar_connection", id: own.connection, op: "create" }, { kind: "calendar", id: own.calendar, op: "create" },
        { kind: "calendar_event", id: own.event, op: "create" },
      ]);
    });
    const device = engineOver(srv.route, NAMED_FEED_KINDS);
    await device.engine.syncOnce();
    expect(device.calendar()).toHaveLength(7);
    await srv.flip(false);
    await device.engine.syncOnce();
    expect(device.calendar()).toEqual([]);
    await srv.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, srv.mailboxId));
    await srv.db.transaction((tx) => sweepMailboxData(tx as unknown as LedgerTx, dialect(srv.db), {
      accountId: srv.s.accountId, mailboxId: srv.mailboxId, now: FIXED_NOW,
    }));
    await srv.flip(true);
    await device.engine.syncOnce();
    expect(device.calendar()).toEqual([
      `calendar:${own.calendar}`, `calendar_connection:${own.connection}`, `calendar_event:${own.event}`,
    ]);
  }, 120_000);
});

describe("the copy's switch is stored behind the account's erasure stamp", () => {
  it("an erased account's copy stores no switch, whoever asks", async () => {
    const dataDir = await freshDataDir("ohmail-cal-switch-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
    const dia = dialect(opened.db);
    const on = FIXED_NOW.toISOString();
    // The control: a live account's copy keeps the instant its switch went on.
    await opened.db.transaction((tx) => storeCalendarSwitch(tx, dia, world.accountId, on));
    expect((await opened.db.select({ at: calSettings.enabledAt }).from(calSettings)).map((r) => r.at)).toEqual([FIXED_NOW]);
    await opened.db.delete(calSettings);
    await opened.db.update(accounts).set({ erasedAt: FIXED_NOW }).where(eq(accounts.id, world.accountId));
    await opened.db.transaction((tx) => storeCalendarSwitch(tx, dia, world.accountId, on));
    expect(await opened.db.select().from(calSettings)).toEqual([]);
  }, 60_000);
});

/**
 * THE DESKTOP'S DOOR, WHOLE: a Cloud-signed desktop pulling the real feed of a server, storing the
 * calendar in its copy, and serving the copy to its window through its own `/sync`. The window is
 * sent a calendar record only while the server keeps a calendar and the account's switch, as the
 * copy holds it, is on.
 */
describe("the desktop's door serves its copy's calendar by the switch it copied", () => {
  const send = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  async function door(srv: Awaited<ReturnType<typeof server>>) {
    const dataDir = await freshDataDir("ohmail-cal-door-");
    dirs.push(dataDir);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(srv.mailboxId, OWN)]));
      if (url.pathname === "/auth/session") return send({ user: { email: OWN }, scope: "full" });
      if (url.pathname === "/auth/refresh") return send({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
      if (url.pathname === "/consent") return send({ settings: {} });
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      // The account's feed and its switch, answered by the server's own routes.
      if (url.pathname.startsWith("/sync") || url.pathname.startsWith("/calendar")) {
        return srv.route(`${url.pathname}${url.search}`, init?.method ? { method: init.method, ...(init.body ? { body: init.body } : {}) } : {});
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      keks: { 1: randomBytes(32) }, fetchImpl, pollIntervalMs: 40,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    /** What the window is sent from the start: every record, by kind, under the kinds an engine names. */
    const window = async (): Promise<{ kinds: string[]; settings: Record<string, unknown> | undefined }> => {
      const res = await sidecar.handle(new Request(`http://sidecar/sync?since=0&limit=2000&types=${NAMED_FEED_KINDS.join(",")}`, {
        headers: { authorization: `Bearer ${sidecar.sessionToken}` },
      }));
      expect(res.status).toBe(200);
      const page = await res.json() as SyncResponse;
      const live = new Map<string, SyncChange>();
      for (const c of [...page.changes.creates, ...page.changes.updates, ...page.changes.moves, ...page.changes.deletes]
        .sort((a, b) => a.seq - b.seq)) live.set(`${c.type}:${c.id}`, c);
      const kept = [...live.values()].filter((c) => c.op !== "delete");
      return {
        kinds: [...new Set(kept.map((c) => c.type).filter((t) => t.startsWith("calendar")))].sort(),
        settings: kept.find((c) => c.type === "settings")?.entity as Record<string, unknown> | undefined,
      };
    };
    const copyHolds = async (): Promise<number> =>
      (await sidecar.db.select({ id: calEvents.id }).from(calEvents)).length
      + (await sidecar.db.select({ id: calConnections.id }).from(calConnections)).length;
    return { sidecar, window, copyHolds };
  }

  async function until(what: string, test: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await test())) {
      if (Date.now() > end) throw new Error(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const EVERY_KIND = ["calendar", "calendar_connection", "calendar_event", "calendar_suggestion"];

  it("a server that keeps a calendar, the switch on: the window is sent every kind and the switch", { timeout: 120_000 }, async () => {
    const srv = await server(2);
    const d = await door(srv);
    await until("the calendar in the window", async () => (await d.window()).kinds.length === 4);
    const seen = await d.window();
    expect(seen.kinds).toEqual(EVERY_KIND);
    expect(seen.settings?.calendarEnabledAt).toBe(FIXED_NOW.toISOString());
  });

  it("a server that keeps none: the copy holds nothing of the calendar and the window is sent none", { timeout: 120_000 }, async () => {
    const srv = await server(2, { word: false });
    const d = await door(srv);
    await until("a settled pull", async () => (await d.window()).settings !== undefined);
    expect((await d.window()).kinds).toEqual([]);
    expect(await d.copyHolds()).toBe(0);
  });

  it("switched off upstream, the copy lets its calendar go and the window is sent none of it", { timeout: 120_000 }, async () => {
    const srv = await server(2);
    const d = await door(srv);
    await until("the calendar in the window", async () => (await d.window()).kinds.length === 4);
    await srv.flip(false);
    await until("the copy emptied", async () => (await d.copyHolds()) === 0);
    const seen = await d.window();
    expect(seen.kinds).toEqual([]);
    expect(seen.settings?.calendarEnabledAt).toBeNull();
  });

  it("switched on again, the copy reads the calendar whole: the events nobody changed come back", { timeout: 120_000 }, async () => {
    const srv = await server(2);
    const d = await door(srv);
    await until("the calendar in the window", async () => (await d.window()).kinds.length === 4);
    await srv.flip(false);
    await until("the copy emptied", async () => (await d.copyHolds()) === 0);
    await srv.flip(true);
    await until("the copy read again", async () => (await d.copyHolds()) === 3);
    await until("the window sent it", async () => (await d.window()).kinds.length === 4);
    expect((await d.window()).settings?.calendarEnabledAt).toBe(new Date(FIXED_NOW.getTime() + 120_000).toISOString());
  });
});
