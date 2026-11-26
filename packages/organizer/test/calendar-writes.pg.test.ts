/**
 * THE DRAIN OF THE WRITES OWED TO A PROVIDER, on this checkout's own Postgres, with a scripted
 * writer that keeps a provider's store of its own: a write recorded at the door reaches the writer
 * once per attempt under a name made from its row, settles in one transaction, and keeps the
 * queue's order, bounds and words. A real provider is never asked here.
 */
import { DEFAULT_LIMITS, readCalendar } from "@ohmail/cal-core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  BENCH_CALDAV_PLACE, PROVEN_REPEATS, proofPlaceOf, type CalendarProvider, type Connection, type ProvenRepeats, type WriteAnswer,
} from "@ohmail/cal-providers";
import { makeReader, makeWriter } from "@ohmail/cal-providers/microsoft";
import { calAttendees, calCalendars, calConnections, calEvents, calSettings, calWrites, mailboxes } from "@trafficflow/db";
import { writePayloadOf } from "@trafficflow/db/calendar";
import { calendarPool, passDb, type ConnectionKey } from "../src/calendar/index.js";
import { calendarSyncPass } from "../src/calendar/sync-pass.js";
import type { CalendarWriteDrainInput } from "../src/calendar/types.js";
import { calendarWriteDrain, WRITE_MAX_ATTEMPTS, WRITE_PRUNE_PER_TURN } from "../src/calendar/write-drain.js";
import {
  AVAILABLE, Secret, ZONES, capturedLog, connectionOf, depsFor, openWorld, providersOf, recordWrite, scriptedReader, scriptedWriter, seedConnection, single,
  upsert, type ScriptedPage, type World,
} from "./_calendar-world.js";

const never = new AbortController().signal;
/** A CalDAV account's server: not the bench's, where the repeat proof was run. */
const DAV_URL = "https://dav.studio.example.test/dav/";

describe.skipIf(!AVAILABLE)("the drain of the writes owed to a provider", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(6); }, 120_000);
  afterAll(async () => { await w?.close(); });

  /** A press recorded as the door records it; `after`: the key of the write it waits for. */
  const press = async (accountId: string, key: string, act: unknown, after?: string) => {
    const prior = after === undefined ? null : (await w.db.select({ id: calWrites.id }).from(calWrites)
      .where(and(eq(calWrites.accountId, accountId), eq(calWrites.idempotencyKey, after))))[0]?.id ?? null;
    return recordWrite(w, { accountId, key, act, after: prior });
  };
  const connection = (tag: string, word: "google" | "microsoft" | "caldav" = "google"): Connection => ({
    provider: word, start: null,
    credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: `token-${tag}` }) },
  });

  /** An account with its calendar on, a connection (Google's unless named), one calendar, and one event the provider holds at version 1. */
  async function account(word: "google" | "microsoft" | "caldav" = "google") {
    const seeded = await seedConnection(w, { provider: word, credential: null, serverUrl: word === "caldav" ? DAV_URL : null });
    const [cal] = await w.db.insert(calCalendars).values({
      accountId: seeded.accountId, connectionId: seeded.connectionId, providerId: `cal-${seeded.accountId.slice(0, 6)}`, name: "Studio", access: "owner",
    }).returning({ id: calCalendars.id });
    const [ev] = await w.db.insert(calEvents).values({
      accountId: seeded.accountId, calendarId: cal!.id, providerId: "evt-1", versionTag: '"v1"', uid: "uid-1", title: "Kiln check",
      startKind: "instant", startLocal: "20261118T090000Z", endKind: "instant", endLocal: "20261118T100000Z",
      startsAt: new Date("2026-11-18T09:00:00Z"), endsAt: new Date("2026-11-18T10:00:00Z"),
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    const key: ConnectionKey = { accountId: seeded.accountId, id: seeded.connectionId };
    return { ...seeded, key, calendarId: cal!.id, eventId: ev!.id, base: ev!.updatedAt.toISOString() };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  const create = (a: Pick<Account, "calendarId">, title = "Glaze firing", eventId: string = randomUUID()) => ({
    kind: "calendar_event_create", eventId, calendarId: a.calendarId,
    event: {
      title, start: { kind: "instant", value: "20261117T090000Z" }, end: { kind: "instant", value: "20261117T100000Z" },
      notes: null, place: null, callLink: null, busy: true, private: false, repeat: null, invitees: [], alarms: [],
    },
  });
  const update = (a: Account, title: string, base = a.base, after?: string) =>
    ({ kind: "calendar_event_update", eventId: a.eventId, base, ...(after === undefined ? {} : { after }), scope: { kind: "record" }, change: { title } });

  const provider = (writer: CalendarProvider["writer"], word: "google" | "microsoft" | "caldav" = "google"): CalendarProvider =>
    ({ reader: scriptedReader(word, { readings: new Map() }), writer, notices: null, http: { request: async () => ({ arrived: false, reason: "unknown" }) } });

  const run = (a: Account, writer: CalendarProvider["writer"], o: { tag?: string; clock?: () => number; turnMs?: number; signal?: AbortSignal; word?: "google" | "microsoft" | "caldav"; proven?: ProvenRepeats; moveDestination?: CalendarWriteDrainInput["moveDestination"] } = {}) =>
    calendarWriteDrain({
      clock: { now: o.clock ?? (() => Date.now()) }, zones: ZONES, log: capturedLog().log, ...(o.turnMs === undefined ? {} : { turnMs: o.turnMs }),
      ...(o.proven === undefined ? {} : { proven: o.proven }),
    })({
      db: passDb(calendarPool(w.db), a.accountId), key: a.key, provider: provider(writer, o.word), connection: connection(o.tag ?? a.accountId, o.word), signal: o.signal ?? never, moveDestination: o.moveDestination,
    });

  const rows = (a: Account) => w.db.select({
    id: calWrites.id, key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts,
    base: calWrites.baseVersionTag, payload: calWrites.payload, next: calWrites.nextAttemptAt,
  }).from(calWrites).where(eq(calWrites.accountId, a.accountId)).orderBy(asc(calWrites.createdAt), asc(calWrites.idempotencyKey));
  const events = (a: Account) => w.db.select({ id: calEvents.id, providerId: calEvents.providerId, title: calEvents.title, versionTag: calEvents.versionTag })
    .from(calEvents).where(eq(calEvents.accountId, a.accountId)).orderBy(asc(calEvents.title));
  /** Make an owed write due now: its wait, or its claim's lease, is over. */
  const dueNow = (a: Pick<Account, "accountId">) => w.db.update(calWrites).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(and(eq(calWrites.accountId, a.accountId), eq(calWrites.state, "pending")));

  /**
   * A CalDAV account whose turns run as the worker runs them (the drain composed, then the reading),
   * read and written by the test's scripted hands. `due()` makes its calendars and its connection due.
   */
  async function davAccount(reader: ReturnType<typeof scriptedReader>, writer: ReturnType<typeof scriptedWriter>) {
    const t = await seedConnection(w, { provider: "caldav", credential: { kind: "basic", user: "mila", password: new Secret(`pw-${randomUUID().slice(0, 8)}`) }, serverUrl: "http://127.0.0.1:1/dav/" });
    const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log });
    const deps = depsFor(w, providersOf({ caldav: { reader, writer, http: { request: async () => ({ arrived: false as const, reason: "unknown" as const }) } } }), { drainWrites: drain });
    const due = async () => {
      await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, t.accountId));
      await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
    };
    const stored = async (providerId: string) => (await w.db.select({ id: calEvents.id, updatedAt: calEvents.updatedAt, versionTag: calEvents.versionTag, title: calEvents.title })
      .from(calEvents).where(and(eq(calEvents.accountId, t.accountId), eq(calEvents.providerId, providerId))))[0]!;
    const writes = () => w.db.select({ key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal })
      .from(calWrites).where(eq(calWrites.accountId, t.accountId)).orderBy(asc(calWrites.createdAt));
    return { ...t, due, stored, writes, turn: () => calendarSyncPass(deps, t.due, never) };
  }
  const retitle = (e: { id: string; updatedAt: Date }, title: string) =>
    ({ kind: "calendar_event_update", eventId: e.id, base: e.updatedAt.toISOString(), scope: { kind: "record" }, change: { title } });

  it.each(["different mailbox", "matching mailbox", "no verified address"])(
    "creates a CalDAV invitation only with a verified scheduling organizer (%s)", async (identity) => {
      const a = await account("caldav");
      const first = ["calendar", "example.test"].join("@");
      const mailbox = ["mail", "example.test"].join("@");
      const guest = ["guest", "example.test"].join("@");
      const expected = identity === "matching mailbox" ? mailbox : first;
      const addresses = identity === "no verified address" ? [] : identity === "matching mailbox" ? [first, mailbox] : [first];
      await w.db.update(calConnections).set({ principal: "/dav/principal/", organizerAddresses: addresses })
        .where(eq(calConnections.id, a.connectionId));
      await w.db.insert(mailboxes).values({ accountId: a.accountId, provider: "imap", address: mailbox, status: "connected" });
      const act = create(a);
      await press(a.accountId, "make-invitation", {
        ...act, event: { ...act.event, invitees: [{ address: guest, name: null, role: "required" }] },
      });
      const writer = scriptedWriter("caldav", {
        answer: ({ draft }) => draft?.organizer === expected ? "default" : { ok: false, reason: "read_only" },
      });
      await run(a, writer, { word: "caldav" });
      if (addresses.length === 0) {
        expect(await rows(a)).toMatchObject([{ state: "refused", refusal: "invitees_unsupported" }]);
        expect(writer.calls).toHaveLength(0);
      } else {
        expect(await rows(a)).toMatchObject([{ state: "applied" }]);
        expect(writer.calls).toMatchObject([{ draft: { organizer: expected, attendees: [{ email: guest }] } }]);
      }
    },
  );

  it.each(["new organizer", "verified organizer", "unverified organizer"])(
    "checks the scheduling organizer before changing CalDAV guests (%s)", async (identity) => {
      const a = await account("caldav");
      const calendar = ["calendar", "example.test"].join("@");
      const mailbox = ["mail", "example.test"].join("@");
      const guest = ["guest", "example.test"].join("@");
      await w.db.update(calConnections).set({ organizerAddresses: [calendar] }).where(eq(calConnections.id, a.connectionId));
      await w.db.insert(mailboxes).values({ accountId: a.accountId, provider: "imap", address: mailbox, status: "connected" });
      const organizer = identity === "verified organizer" ? calendar : identity === "unverified organizer" ? mailbox : null;
      await w.db.update(calEvents).set({ organizer }).where(eq(calEvents.id, a.eventId));
      await press(a.accountId, "invite-guest", {
        kind: "calendar_event_update", eventId: a.eventId, base: a.base, scope: { kind: "record" },
        change: { invitees: [{ address: guest, name: null, role: "required" }] },
      });
      const writer = scriptedWriter("caldav");
      await run(a, writer, { word: "caldav" });
      if (identity === "unverified organizer") {
        expect(await rows(a)).toMatchObject([{ state: "refused", refusal: "invitees_unsupported" }]);
        expect(writer.calls).toHaveLength(0);
      } else {
        expect(await rows(a)).toMatchObject([{ state: "applied" }]);
        expect(writer.calls).toMatchObject([{ change: { organizer: calendar, attendees: [{ email: guest }] } }]);
      }
    },
  );

  it.each(["reader", "capability lost", "capability kept", "organizer unverified"] as const)(
    "checks a queued native move before contacting the provider (%s)",
    async (condition) => {
      const word = condition.startsWith("capability") ? "caldav" : "google";
      const a = await account(word);
      if (condition === "reader") {
        const principal = "connected@example.test";
        await w.db.update(calConnections).set({ principal }).where(eq(calConnections.id, a.connectionId));
        await w.db.update(calEvents).set({ organizer: principal }).where(eq(calEvents.id, a.eventId));
      }
      if (condition === "organizer unverified") {
        await w.db.update(calCalendars).set({ access: "writer" }).where(eq(calCalendars.id, a.calendarId));
      }
      if (word === "caldav") {
        await w.db.update(calEvents).set({ original: [
          "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:uid-1", "DTSTAMP:20261101T000000Z",
          "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z", "END:VEVENT", "END:VCALENDAR", "",
        ].join("\r\n") }).where(eq(calEvents.id, a.eventId));
      }
      await w.db.update(calCalendars).set({ nativeMove: true }).where(eq(calCalendars.id, a.calendarId));
      const [destination] = await w.db.insert(calCalendars).values({
        accountId: a.accountId, connectionId: a.connectionId, providerId: "destination",
        name: "Workshop", access: "owner", nativeMove: true,
      }).returning({ id: calCalendars.id });
      const act = { kind: "calendar_event_move", eventId: a.eventId, base: a.base, toCalendarId: destination!.id };
      await press(a.accountId, "move", act);
      if (condition === "reader" || condition === "capability lost") {
        await w.db.update(calCalendars).set(condition === "reader" ? { access: "reader" } : { nativeMove: false })
          .where(eq(calCalendars.id, destination!.id));
      }
      const moved: string[] = [];
      const writer = { ...scriptedWriter(word), moveEvent: async (_connection: Connection, _source: { id: string }, target: { id: string }): Promise<WriteAnswer> => {
        moved.push(target.id);
        return { ok: true, items: [] };
      } };
      await run(a, writer, { word });
      if (condition === "capability kept") {
        expect(moved).toEqual(["destination"]);
        expect(await rows(a)).toMatchObject([{ state: "applied" }]);
      } else {
        expect(moved).toEqual([]);
        expect(await rows(a)).toMatchObject([{ state: "refused" }]);
      }
    },
  );

  it("refuses queued guest replacement on a shared calendar before calling the provider", async () => {
    const a = await account("caldav");
    await w.db.update(calCalendars).set({ access: "writer" }).where(eq(calCalendars.id, a.calendarId));
    const act = { ...update(a, "Changed"), change: { invitees: [{ address: "guest@example.test", name: null, role: "required" }] } };
    await press(a.accountId, "change-guests", act);
    const writer = scriptedWriter("caldav");
    await run(a, writer, { word: "caldav" });
    expect(writer.calls).toHaveLength(0);
    expect(await rows(a)).toMatchObject([{ state: "refused" }]);
  });

  it("settles a personal move after a lost original-removal response without making a second copy", async () => {
    const a = await account();
    const [calendar] = await w.db.insert(calCalendars).values({
      accountId: a.accountId, connectionId: a.connectionId, providerId: "other-calendar", name: "Personal", access: "owner",
    }).returning({ id: calCalendars.id, providerId: calCalendars.providerId });
    const { id } = await press(a.accountId, "move", {
      kind: "calendar_event_move", eventId: a.eventId, base: a.base, toCalendarId: calendar!.id, copyThenRemove: true,
    });
    const payload = (await rows(a))[0]!.payload as object;
    const fields = { ...create(a, "Kiln check").event,
      start: { kind: "instant", value: "20261118T090000Z" }, end: { kind: "instant", value: "20261118T100000Z" } };
    await w.db.update(calWrites).set({ payload: { ...payload, transfer: { source: "evt-1", fields } } }).where(eq(calWrites.id, id));
    const original = { ...upsert("evt-1", '"v1"', single("uid-1", 18, "Kiln check")), portableCopy: true as const };
    const copy = { ...upsert("copy", '"copy"', single("copy-uid", 18, "Kiln check")), portableCopy: true as const };
    let originalGone = false;
    let copies = 0;
    let removedCopies = 0;
    let wakes = 0;
    const source = {
      ...scriptedWriter("google"),
      readForMove: async (): Promise<WriteAnswer> => ({ ok: true, items: originalGone ? [{ kind: "gone", id: "evt-1" }] : [original] }),
      remove: async (_c: Connection, _cal: unknown, target: { version: string }): Promise<WriteAnswer> => {
        expect(target.version).toBe('"v1"');
        originalGone = true;
        return { ok: false, reason: "timeout", retryAfterMs: null };
      },
    };
    const dest = {
      ...scriptedWriter("microsoft"),
      readForMove: async (): Promise<WriteAnswer> => ({ ok: true, items: [copy] }),
      create: async (): Promise<WriteAnswer> => { copies++; return { ok: true, items: [copy] }; },
      remove: async (): Promise<WriteAnswer> => { removedCopies++; return { ok: true, items: [] }; },
    };
    const moveDestination = async () => ({ writer: dest, connection: connection("destination", "microsoft"), cal: { id: calendar!.providerId }, markDue: async () => { wakes++; } });
    await run(a, source, { moveDestination });
    expect((await rows(a))[0]).toMatchObject({ state: "pending", payload: { transfer: { progress: { phase: "removing", id: "copy", version: '"copy"' } } } });
    expect(wakes).toBe(1);
    await dueNow(a);
    await run(a, source, { moveDestination });
    expect((await rows(a))[0]).toMatchObject({ state: "applied", payload: {} });
    expect(await events(a)).toEqual([]);
    expect({ copies, removedCopies }).toEqual({ copies: 1, removedCopies: 0 });
  });

  it.each(["unavailable", "expired"] as const)("settles a %s move and drains a later write on the same connection", async (state) => {
    const a = await account();
    const [calendar] = await w.db.insert(calCalendars).values({
      accountId: a.accountId, connectionId: a.connectionId, providerId: "other-calendar", name: "Personal", access: "owner",
    }).returning({ id: calCalendars.id, providerId: calCalendars.providerId });
    const { id } = await press(a.accountId, "move", {
      kind: "calendar_event_move", eventId: a.eventId, base: a.base, toCalendarId: calendar!.id, copyThenRemove: true,
    });
    const payload = (await rows(a))[0]!.payload as object;
    const fields = { ...create(a, "Kiln check").event,
      start: { kind: "instant", value: "20261118T090000Z" }, end: { kind: "instant", value: "20261118T100000Z" } };
    const original = { ...upsert("evt-1", '"v1"', single("uid-1", 18, "Kiln check")), portableCopy: true as const };
    const copy = { ...upsert("copy", '"copy"', single("copy-uid", 18, "Kiln check")), portableCopy: true as const };
    let removedOriginal = false;
    let woke = 0;
    let copies = 0;
    let removedCopies = 0;
    const source = {
      ...scriptedWriter("google"),
      readForMove: async (): Promise<WriteAnswer> => ({ ok: true, items: [original] }),
      remove: async (_c: Connection, _cal: unknown, target: { version: string }): Promise<WriteAnswer> => {
        expect(target.version).toBe('"v1"');
        removedOriginal = true;
        return { ok: false, reason: "timeout", retryAfterMs: null };
      },
    };
    const dest = {
      ...scriptedWriter("microsoft"),
      readForMove: async (): Promise<WriteAnswer> => ({ ok: true, items: [copy] }),
      create: async (): Promise<WriteAnswer> => { copies++; return { ok: true, items: [copy] }; },
      remove: async (): Promise<WriteAnswer> => { removedCopies++; return { ok: false, reason: "read_only", retryAfterMs: null }; },
    };
    const moveDestination = async () => {
      const [to] = await w.db.select({ access: calCalendars.access }).from(calCalendars).where(eq(calCalendars.id, calendar!.id));
      return to?.access === "owner" ? { writer: dest, connection: connection("destination", "microsoft"),
        cal: { id: calendar!.providerId }, markDue: async () => { woke++; } } : null;
    };
    await w.db.update(calWrites).set({ payload: { ...payload, transfer: { source: "evt-1", fields, progress: { phase: "verifying", id: "copy", version: '"copy"' } } } }).where(eq(calWrites.id, id));
    await press(a.accountId, "later", create(a));
    if (state === "unavailable") {
      await w.db.update(calCalendars).set({ access: "reader" }).where(eq(calCalendars.id, calendar!.id));
    } else {
      await w.db.update(calWrites).set({ attempts: WRITE_MAX_ATTEMPTS }).where(eq(calWrites.id, id));
    }
    await run(a, source, { moveDestination });
    expect((await rows(a)).map(({ key, state, refusal }) => [key, state, refusal])).toEqual([
      ["move", "refused", state === "expired" ? "move_copy_left" : "move_destination_unavailable"], ["later", "applied", null],
    ]);
    expect((await rows(a))[0]!.payload).toMatchObject({ transfer: { progress: { id: "copy" } } });
    expect(removedOriginal).toBe(false);
    expect(copies).toBe(0);
    expect(removedCopies).toBe(state === "expired" ? 1 : 0);
    expect(woke).toBe(state === "expired" ? 1 : 0);
  });

  it.each(["google", "microsoft"] as const)("passes the saved creation version through both rows of a %s split", async (word) => {
    const a = await account(word);
    await w.db.update(calEvents).set({ repeatRule: "FREQ=DAILY;COUNT=5" }).where(eq(calEvents.id, a.eventId));
    const at = String(Date.UTC(2026, 10, 20, 9));
    const next = randomUUID();
    const first = await recordWrite(w, {
      accountId: a.accountId, key: "split", part: { of: "split", n: 1 },
      act: { ...update(a, "Continued"), scope: { kind: "following", at, newEventId: next }, audience: { organizer: null, guests: [] } },
    });
    const continuation = create(a, "Continued", next);
    await recordWrite(w, {
      accountId: a.accountId, key: "split:2", after: first.id,
      part: { of: "split", n: 2, from: { eventId: a.eventId, at, named: ["title"], confirmed: true } },
      act: { ...continuation, event: { ...continuation.event, repeat: "FREQ=DAILY;COUNT=3",
        start: { kind: "instant", value: "20261120T090000Z" }, end: { kind: "instant", value: "20261120T100000Z" } } },
    });
    const seen: (string | undefined)[] = [];
    const version = '"created-copy"';
    await run(a, {
      ...scriptedWriter(word),
      endSeries: async (_connection, _calendar, _target, request) => {
        await request.then?.rememberCreatedVersion?.(version);
        return { ok: true, items: [] };
      },
      continueSeries: async (_connection, _calendar, request) => {
        seen.push(request.createdVersion);
        return { ok: true, items: [] };
      },
    }, { word });
    expect((await rows(a)).map((row) => [row.state, row.refusal, row.base])).toEqual([
      ["applied", null, '"v1"'], ["applied", null, version],
    ]);
    expect(seen).toEqual([version]);
  });

  it.each([false, true])("answers only the connected attendee on an ordinary occurrence (reversed: %s)", async (reverse) => {
    const a = await account();
    const attendee = ["second", "example.test"].join("@");
    const other = ["first", "example.test"].join("@");
    const organizer = ["host", "example.test"].join("@");
    await w.db.update(calConnections).set({ principal: attendee }).where(eq(calConnections.id, a.connectionId));
    await w.db.insert(mailboxes).values([attendee, other].map((address) => ({
      accountId: a.accountId, provider: "imap", address, status: "connected",
    })));
    await w.db.update(calEvents).set({ repeatRule: "FREQ=DAILY;COUNT=5", organizer, myAnswer: "accepted" })
      .where(eq(calEvents.id, a.eventId));
    const people = [other, attendee];
    await w.db.insert(calAttendees).values((reverse ? people.reverse() : people).map((address) => ({
      eventId: a.eventId, accountId: a.accountId, address, role: "required", answer: "accepted",
    })));
    const start = Date.UTC(2026, 10, 20, 9);
    await press(a.accountId, "answer-one", { kind: "calendar_event_answer", eventId: a.eventId, base: a.base,
      scope: { kind: "occurrence", at: String(start) }, answer: "declined" });
    const calls: unknown[] = [];
    const writer = { ...scriptedWriter("google"), answer: async (_c, _cal, target, request) => {
      calls.push({ sameAttendee: request.as === attendee, reply: request.reply, occurrence: target.occurrence });
      return { ok: true as const, items: [] };
    } } satisfies NonNullable<CalendarProvider["writer"]>;
    await run(a, writer);
    await run(a, writer);
    expect(calls).toEqual([{ sameAttendee: true, reply: "DECLINED", occurrence: { kind: "instant", epochMs: start } }]);
    expect(await rows(a)).toMatchObject([{ state: "applied", attempts: 1 }]);
  });

  async function quarterlyWorld() {
    const address = "guest@example.test";
    const seeded = await seedConnection(w, {
      provider: "microsoft", principal: address,
      credential: { kind: "oauth", provider: "microsoft", refreshToken: new Secret("refresh-fixture") },
    });
    const start = { dateTime: "2026-10-06T07:30:00", timeZone: "UTC" };
    const end = { dateTime: "2026-10-06T08:30:00", timeZone: "UTC" };
    const series = {
      id: "series", type: "seriesMaster", changeKey: "series-original", iCalUId: "workshop-series",
      isOrganizer: false, subject: "Workshop planning", start, end,
      organizer: { emailAddress: { address: "host@example.test" } },
      attendees: [{ emailAddress: { address }, type: "required", status: { response: "none" } }],
      responseStatus: { response: "notResponded" },
      originalStartTimeZone: "W. Europe Standard Time", originalEndTimeZone: "W. Europe Standard Time",
      recurrence: {
        pattern: { type: "relativeMonthly", interval: 3, index: "first", daysOfWeek: ["tuesday"] },
        range: { type: "numbered", numberOfOccurrences: 2, startDate: "2026-10-06", recurrenceTimeZone: "W. Europe Standard Time" },
      },
    };
    const response = {
      master: "notResponded", masterVersion: "series-original", current: "notResponded", revision: 0,
      delta: undefined as { response: string; revision: number; copies?: number } | undefined,
      competing: undefined as { response: string; revision: number } | undefined,
      modification: "ordered" as "ordered" | "tied" | "absent",
      pointFailure: false,
      pointRetryAfter: null as number | null,
      omitPointResponse: false,
      masterPointFailure: false,
      split: false as boolean | number,
      deltaIncludesDays: true,
      withholdDaysOnCursor: false,
      includeLaterInstance: false,
      omitDeltaResponse: false,
      tombstone: false,
      splitTombstone: false,
      pointOutside: false,
      replacement: false,
      instanceReplacement: false,
      upperCaseReplacementOrganizer: false,
      replacementPointMatches: true,
      pointReads: 0,
      next: undefined as string | undefined, removeMaster: false as false | "delta" | "whole",
      missing: false, removed: false as false | "delta" | "whole",
      beforePost: async () => {},
      beforePoint: async () => {},
      stopBeforeTransport: false,
      send: async (): Promise<number | "timeout"> => 202,
    };
    const posts: string[] = [];
    const http: CalendarProvider["http"] = {
      async request(url, req) {
        const path = new URL(url).pathname;
        const master = { ...series, changeKey: response.masterVersion, responseStatus: { response: response.master } };
        const day = (revision: number, status: string) => ({
          ...series, id: "first-day", seriesMasterId: series.id, recurrence: null,
          type: revision ? "exception" : "occurrence", changeKey: `day-${revision}`,
          originalStart: "2026-10-06T07:30:00Z", responseStatus: { response: status },
          ...(response.modification !== "absent" && {
            lastModifiedDateTime: new Date(Date.UTC(2026, 9, 1 + (response.modification === "tied" ? 0 : revision))).toISOString(),
          }),
        });
        const current = day(response.revision, response.current);
        const replacement = {
          ...current, id: "replacement-day",
          ...(response.upperCaseReplacementOrganizer && {
            organizer: { emailAddress: { address: series.organizer.emailAddress.address.toUpperCase() } },
          }),
        };
        const point = response.pointOutside ? {
          ...current,
          start: { dateTime: "2037-10-06T07:30:00", timeZone: "UTC" },
          end: { dateTime: "2037-10-06T08:30:00", timeZone: "UTC" },
        } : response.omitPointResponse ? { ...current, responseStatus: undefined } : current;
        const listed = response.delta ? day(response.delta.revision, response.delta.response) : current;
        const delta = response.omitDeltaResponse ? { ...listed, responseStatus: undefined } : listed;
        const later = { ...day(0, response.master), id: "later-day", originalStart: "2027-01-05T08:30:00Z",
          start: { dateTime: "2027-01-05T08:30:00", timeZone: "UTC" },
          end: { dateTime: "2027-01-05T09:30:00", timeZone: "UTC" } };
        const next = new URL(url);
        if (response.next) next.searchParams.set("cursor", response.next);
        const second = next.searchParams.has("splitPage");
        next.searchParams.delete("splitPage");
        const more = new URL(next);
        more.searchParams.set("splitPage", "next");
        const splitAfter = typeof response.split === "number" ? response.split : 1;
        const newEvent = { ...series, id: "workshop-addition", type: "singleInstance", iCalUId: "addition", recurrence: null };
        const records = response.removeMaster === "delta" ? [{ id: series.id, "@removed": { reason: "deleted" } }] :
          response.removeMaster === "whole" ? [] :
          response.removed === "delta" ? [later, { id: current.id, "@removed": { reason: "deleted" } }] :
          response.removed === "whole" ? [later] : !response.deltaIncludesDays ||
          (response.withholdDaysOnCursor && new URL(url).searchParams.has("cursor")) ? [] : [
            ...Array(response.delta?.copies ?? 1).fill(delta),
            ...(response.competing ? [day(response.competing.revision, response.competing.response)] : []),
            ...(response.tombstone ? [{ id: current.id, "@removed": { reason: "deleted" } }] : []),
            ...(response.replacement ? [replacement] : []),
            later,
          ];
        if (path.endsWith("/calendar/events/first-day")) response.pointReads += 1;
        const tombstone = { id: current.id, "@removed": { reason: "deleted" } };
        const trade = path.endsWith("/token");
        const body = trade ? { access_token: "short-fixture", expires_in: 3600 } :
          path.endsWith("/series") ? master :
          path.endsWith("/instances") ? { value: response.includeLaterInstance ? [later] : [response.instanceReplacement ? replacement : current] } :
          path.endsWith("/replacement-day") ? response.replacementPointMatches ? replacement : {
            ...replacement, originalStart: "2026-10-07T07:30:00Z",
          } :
          path.endsWith("/delta") ? (response.split || response.splitTombstone) && !second
            ? { value: records.slice(0, splitAfter), "@odata.nextLink": more.href }
            : { value: response.splitTombstone ? [tombstone] : response.split ? [...records.slice(splitAfter), newEvent] : records, "@odata.deltaLink": next.href }
            :
          path.endsWith("/calendars") ? {
            value: [{ id: "calendar", isDefaultCalendar: true, canEdit: true, owner: { address } }],
          } : point;
        const answer = req.method === "POST" && !trade;
        if (path.endsWith("/me/events/first-day")) await response.beforePoint();
        if (answer) {
          await response.beforePost();
          await req.beforeDispatch?.();
          if (response.stopBeforeTransport) return { arrived: false, reason: "timeout", notDispatched: true };
          posts.push(path);
        }
        const missing = path.endsWith("/first-day") && response.missing || path.endsWith("/series") && response.removeMaster;
        const failed = path.endsWith("/first-day") && response.pointFailure || path.endsWith("/series") && response.masterPointFailure;
        const retryAfter = path.endsWith("/me/events/first-day") ? response.pointRetryAfter : null;
        const status = answer ? await response.send() : missing ? 404 : retryAfter !== null ? 429 : failed ? 503 : 200;
        if (status === "timeout") return { arrived: false, reason: "timeout" };
        return { arrived: true, status, header: (name) => name.toLowerCase() === "retry-after" && retryAfter !== null ? String(retryAfter) : null, location: null,
          hops: 0, body: new TextEncoder().encode(JSON.stringify(body)), url };
      },
    };
    const clock = { now: () => Date.now() };
    const graph = { http, graphBase: "https://graph.example.invalid/v1.0", zones: ZONES, clock };
    const makeDeps = () => depsFor(w, providersOf({ microsoft: { reader: makeReader(graph), writer: makeWriter(graph), http } }), {
      oauth: { google: null, microsoft: async () => ({ clientId: "fixture", clientSecret: "fixture-value", defaultTenant: "common", kind: "confidential" }) },
      drainWrites: calendarWriteDrain({ clock, zones: ZONES, log: capturedLog().log }),
    });
    let deps = makeDeps();
    const read = () => w.db.select({
      id: calEvents.id, providerId: calEvents.providerId, updatedAt: calEvents.updatedAt,
      answer: calEvents.myAnswer, version: calEvents.versionTag,
    }).from(calEvents).where(eq(calEvents.accountId, seeded.accountId));
    const turn = async (kind: "synced" | "either" = "synced") => {
      await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, seeded.accountId));
      await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.id, seeded.connectionId));
      const outcome = await calendarSyncPass(deps, seeded.due, never);
      if (kind !== "either") expect(outcome).toMatchObject({ kind });
      return outcome;
    };
    const queue = async (answer: string, whole = false, key = "quarterly-answer", after?: string) => {
      const master = (await read()).find(({ providerId }) => providerId === series.id)!;
      return press(seeded.accountId, key, {
        kind: "calendar_event_answer", eventId: master.id, base: master.updatedAt.toISOString(),
        scope: whole ? { kind: "record" } : { kind: "occurrence", at: String(Date.UTC(2026, 9, 6, 7, 30)) }, answer,
      }, after);
    };
    const writes = () => w.db.select({ state: calWrites.state, reason: calWrites.refusal }).from(calWrites).where(eq(calWrites.accountId, seeded.accountId)).orderBy(asc(calWrites.createdAt));
    const due = () => dueNow(seeded);
    const restart = () => { deps = makeDeps(); };
    return { seeded, response, posts, read, turn, queue, writes, due, restart };
  }

  it.each([
    ["accepted", "accepted", "accept"],
    ["tentative", "tentativelyAccepted", "tentativelyAccept"],
    ["declined", "declined", "decline"],
  ] as const)("keeps an acknowledged quarterly answer (%s) through worker turns and the next reading", async (reply, status, action) => {
    const { response, posts, read, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    const [master] = await read();
    expect(master).toMatchObject({ providerId: "series", answer: "none" });
    await queue(reply);
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    const posted = [`/v1.0/me/events/first-day/${action}`];
    expect(posts).toEqual(posted);
    expect(await read()).toEqual([master]);
    response.pointFailure = true;
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    expect(posts).toEqual(posted);
    response.pointFailure = false;
    response.revision = 1;
    response.current = status;
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect((await read()).find((event) => event.providerId === "first-day")).toMatchObject({ answer: reply, version: "day-1" });
    response.revision = 2;
    await turn();
    expect((await read()).find((event) => event.providerId === "first-day")).toMatchObject({ answer: reply, version: "day-2" });
    expect((await read()).find((event) => event.providerId === "series")).toMatchObject({ answer: "none" });
    expect(posts).toEqual(posted);
  });

  it.each(["timeout", "worker stop"] as const)("sends one answer when a %s interrupts delivery before the status becomes visible", async (condition) => {
    const { seeded, response, posts, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    const write = await queue("accepted");
    response.send = async () => {
      const [row] = await w.db.select({ payload: calWrites.payload }).from(calWrites)
        .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, write.id)));
      expect(row?.payload).toMatchObject({ answerDispatch: { phase: "sending", id: "first-day", source: "series" } });
      if (condition === "worker stop") throw new Error("worker stopped in the dispatch");
      return "timeout";
    };
    await turn();
    await due();
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await w.db.update(calWrites).set({ attempts: WRITE_MAX_ATTEMPTS }).where(eq(calWrites.id, write.id));
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    await w.db.update(calWrites).set({ state: "pending", refusal: null, attempts: 0 }).where(eq(calWrites.id, write.id));
    response.revision = 1;
    response.current = "accepted";
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
  });

  it.each(["during request setup", "at the transport handoff"])(
    "resumes an Outlook reply when the worker stops %s before a POST can leave", async (when) => {
      const { seeded, response, posts, turn, queue, writes, due, restart } = await quarterlyWorld();
      await turn();
      const write = await queue("accepted");
      if (when === "during request setup") {
        response.beforePost = async () => { throw new Error("worker stopped during request setup"); };
      } else {
        response.stopBeforeTransport = true;
      }
      await turn();
      expect(posts).toEqual([]);
      expect(await writes()).toEqual([{ state: "pending", reason: null }]);
      const [pending] = await w.db.select({ payload: calWrites.payload }).from(calWrites)
        .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, write.id)));
      expect(pending?.payload).toMatchObject({ answerDispatch: { phase: "ready" } });
      restart();
      response.beforePost = async () => {};
      response.stopBeforeTransport = false;
      response.send = async () => {
        response.current = "accepted";
        response.revision = 1;
        return 202;
      };
      await due();
      await turn();
      expect(await writes()).toEqual([{ state: "applied", reason: null }]);
      expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
    },
  );

  it("checks an uncertain Outlook reply on completed syncs and confirms a replacement even after showing the notice", async () => {
    const { response, posts, read, turn, queue, writes, restart } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => { throw new Error("worker stopped at transport"); };
    await turn();
    restart();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);

    response.pointFailure = true;
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.pointFailure = false;
    response.omitPointResponse = true;
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.omitPointResponse = false;
    response.master = "accepted";
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);

    response.missing = true;
    response.instanceReplacement = true;
    response.revision = 1;
    response.current = "accepted";
    response.replacementPointMatches = false;
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    response.replacementPointMatches = true;
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "replacement-day")).toMatchObject({ answer: "accepted" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("lets another calendar write through when Outlook removed the replied-to occurrence", async () => {
    const { seeded, response, posts, queue, read, turn, due, restart } = await quarterlyWorld();
    await turn();
    const first = await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);

    response.missing = true;
    response.removed = "delta";
    response.send = async () => 400;
    const [calendar] = await w.db.select({ calendarId: calCalendars.id })
      .from(calCalendars).where(eq(calCalendars.accountId, seeded.accountId));
    const sameDay = await queue("tentative", false, "same-day");
    const master = (await read()).find(({ id }) => id === first.eventId)!;
    const anotherDay = await press(seeded.accountId, "another-day", {
      kind: "calendar_event_answer", eventId: master.id, base: master.updatedAt.toISOString(),
      scope: { kind: "occurrence", at: String(Date.UTC(2027, 0, 5, 8, 30)) }, answer: "tentative",
    }, "quarterly-answer");
    const creation = await press(seeded.accountId, "unrelated-create", create(calendar!));
    const whole = await queue("tentative", true, "whole-series");
    const stateOf = async (id: string) => (await w.db.select({ state: calWrites.state, refusal: calWrites.refusal })
      .from(calWrites).where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, id))))[0];

    restart();
    response.includeLaterInstance = true;
    await due();
    await turn();
    expect(await stateOf(first.id)).toMatchObject({ state: "pending" });
    expect(await stateOf(sameDay.id)).toMatchObject({ state: "pending" });
    expect(await stateOf(whole.id)).toEqual({ state: "refused", refusal: "field_unwritable" });
    expect(await stateOf(creation.id)).toMatchObject({ state: "refused" });
    expect(await stateOf(anotherDay.id)).toMatchObject({ state: "refused" });
    const requests = ["/v1.0/me/events/first-day/accept", "/v1.0/me/events/later-day/tentativelyAccept",
      "/v1.0/me/calendars/calendar/events", "/v1.0/me/events/series/tentativelyAccept"];
    expect(posts).toEqual(requests);

    await turn();
    expect(await stateOf(first.id)).toEqual({ state: "refused", refusal: "answer_unconfirmed" });
    expect(posts).toEqual(requests);
  });

  it.each([false, true])("sends an explicit Outlook resend to the verified replacement occurrence (organizer case differs: %s)", async (upperCase) => {
    const { seeded, response, posts, queue, writes, read, turn, due } = await quarterlyWorld();
    await turn();
    const first = await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    await turn();
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    response.missing = true;
    response.tombstone = true;
    response.replacement = true;
    response.instanceReplacement = true;
    response.upperCaseReplacementOrganizer = upperCase;
    response.revision = 1;
    await turn();
    const rows = await read();
    const day = rows.find(({ providerId }) => providerId === "replacement-day");
    expect(day).toMatchObject({ answer: "none" });

    const master = rows.find(({ id }) => id === first.eventId)!;
    const occurrence = String(Date.UTC(2026, 9, 6, 7, 30));
    const [calendar] = await w.db.select({ id: calCalendars.id }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId));
    // The resend service records the reviewed day on the series' queue with both base stamps.
    await w.db.insert(calWrites).values({
      accountId: seeded.accountId, calendarId: calendar!.id, eventId: master.id, op: "answer",
      baseVersionTag: master.version, idempotencyKey: "explicit-replacement-resend",
      payload: {
        ...writePayloadOf({
          kind: "calendar_event_answer", eventId: day!.id, base: `${day!.updatedAt.toISOString()}/${master.updatedAt.toISOString()}`,
          answer: "accepted", scope: { kind: "occurrence", at: occurrence },
        }, null, null, { id: day!.id, providerId: "replacement-day", version: day!.version!, occurrence }),
        answerDispatch: { phase: "ready" }, resendsReply: true,
      },
    });
    response.send = async () => {
      response.current = "accepted";
      response.revision = 2;
      return 202;
    };
    await due();
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept", "/v1.0/me/events/replacement-day/accept"]);
    expect((await writes()).at(-1)).toEqual({ state: "applied", reason: null });
    expect((await read()).find(({ providerId }) => providerId === "replacement-day")).toMatchObject({ answer: "accepted" });
  });

  it("recovers a hard stop before transport through an explicit Outlook resend", async () => {
    const { response, posts, queue, writes, turn, due, restart, seeded } = await quarterlyWorld();
    await turn();
    const first = await queue("accepted");
    // Persist the exact crash state: the guard has recorded dispatch, but Graph saw zero POSTs.
    await w.db.update(calWrites).set({
      attempts: 1,
      payload: sql`${calWrites.payload} || '{"answerDispatch":{"phase":"sending","id":"first-day","source":"series"}}'::jsonb`,
    }).where(eq(calWrites.id, first.id));
    restart();
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    expect(posts).toEqual([]);

    const resent = await queue("accepted", false, "explicit-original-resend");
    await w.db.update(calWrites).set({
      payload: sql`${calWrites.payload} || '{"answerDispatch":{"phase":"ready"},"resendsReply":true}'::jsonb`,
    }).where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, resent.id)));
    response.send = async () => {
      response.current = "accepted";
      response.revision = 2;
      return 202;
    };
    await due();
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
    expect((await writes()).at(-1)).toEqual({ state: "applied", reason: null });
  });

  async function failedOutlookResend() {
    const world = await quarterlyWorld();
    const { seeded, response, turn, queue, writes } = world;
    await turn();
    const first = await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    await turn();
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);

    const resent = await queue("accepted", false, "send-reply-again");
    await w.db.transaction(async (tx) => {
      await tx.update(calWrites).set({ state: "applied", refusal: null, payload: { replyResentAs: resent.id } })
        .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, first.id)));
      await tx.update(calWrites).set({ payload: sql`${calWrites.payload} || '{"answerDispatch":{"phase":"ready"},"resendsReply":true}'::jsonb` })
        .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, resent.id)));
    });
    response.send = async () => 400;
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }, { state: "refused", reason: "field_unwritable" }]);
    const [failed] = await w.db.select({ payload: calWrites.payload }).from(calWrites)
      .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, resent.id)));
    expect(failed?.payload).toMatchObject({ answerDispatch: { phase: "ready" }, resendsReply: true });
    return { ...world, resent };
  }

  it("confirms the original Outlook reply after a requested resend was refused", async () => {
    const { response, posts, read, turn, writes, restart } = await failedOutlookResend();
    restart();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }, { state: "refused", reason: "field_unwritable" }]);
    response.current = "accepted";
    response.revision = 1;
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }, { state: "applied", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept", "/v1.0/me/events/first-day/accept"]);
  });

  it("clears the notice for an earlier failed Outlook resend when a different choice confirms", async () => {
    const { seeded, response, posts, turn, queue, writes, resent } = await failedOutlookResend();
    await queue("tentative", false, "choose-maybe");
    response.send = async () => {
      response.current = "tentativelyAccepted";
      response.revision = 1;
      return 202;
    };
    await turn();
    expect(await writes()).toEqual([
      { state: "applied", reason: null }, { state: "refused", reason: "answer_unconfirmed" }, { state: "applied", reason: null },
    ]);
    const [archived] = await w.db.select({ payload: calWrites.payload }).from(calWrites)
      .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, resent.id)));
    expect(archived?.payload).toEqual({ fingerprint: expect.any(String), replySuperseded: true });
    expect(posts).toEqual([
      "/v1.0/me/events/first-day/accept", "/v1.0/me/events/first-day/accept", "/v1.0/me/events/first-day/tentativelyAccept",
    ]);
  });

  it("sends a newer series choice and archives the earlier unconfirmed notice on confirmation", async () => {
    const { seeded, queue, read, response, posts, turn, writes } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    await turn();
    await queue("tentative", true, "newer-answer", "quarterly-answer");
    response.send = async () => {
      response.master = "tentativelyAccepted";
      return 202;
    };
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }, { state: "applied", reason: null }]);
    const [archived] = await w.db.select({ payload: calWrites.payload }).from(calWrites)
      .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.idempotencyKey, "quarterly-answer")));
    expect(archived?.payload).toEqual({ fingerprint: expect.any(String), replySuperseded: true });
    expect((await read()).find(({ providerId }) => providerId === "series")).toMatchObject({ answer: "tentative" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept", "/v1.0/me/events/series/tentativelyAccept"]);
  });

  it("preserves a newer calendar reading that lands during an exact Outlook reply check", async () => {
    const { seeded, posts, queue, read, response, turn, writes } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.current = "accepted";
    response.revision = 1;
    response.beforePoint = async () => {
      await w.db.transaction(async (tx) => {
        await tx.update(calCalendars).set({ nextPollAt: sql`clock_timestamp() + interval '1 minute'` })
          .where(eq(calCalendars.accountId, seeded.accountId));
        await tx.update(calEvents).set({ myAnswer: "tentative", versionTag: "day-2" })
          .where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.providerId, "first-day")));
      });
    };
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "first-day"))
      .toMatchObject({ answer: "tentative", version: "day-2" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("keeps the synchronized Outlook cursor when reply verification is throttled and waits before its next poll", async () => {
    const { seeded, queue, response, turn, writes, posts } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.next = "after-throttled-reply-check";
    response.pointRetryAfter = 1_800;
    const started = Date.now();
    await turn();
    const [calendar] = await w.db.select({ cursor: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId));
    const [connection] = await w.db.select({ poll: calConnections.nextPollAt }).from(calConnections)
      .where(eq(calConnections.id, seeded.connectionId));
    expect(calendar?.cursor).toContain(response.next);
    expect(connection?.poll?.getTime()).toBeGreaterThanOrEqual(started + 1_800_000);
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("settles a reply against the exact replacement for the same Outlook occurrence", async () => {
    const { response, posts, turn, queue, writes, due, read } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.missing = true;
    response.instanceReplacement = true;
    response.replacement = true;
    response.current = "accepted";
    response.revision = 1;
    response.replacementPointMatches = false;
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.replacementPointMatches = true;
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "replacement-day")).toMatchObject({ answer: "accepted" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("can send a reply after Graph definitely refused the first request", async () => {
    const { response, posts, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => 429;
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.send = async () => {
      response.revision = 1;
      response.current = "accepted";
      return 202;
    };
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(posts).toEqual(Array(2).fill("/v1.0/me/events/first-day/accept"));
  });

  it.each([
    ["accepted", "accepted", "accept"],
    ["tentative", "tentativelyAccepted", "tentativelyAccept"],
    ["declined", "declined", "decline"],
  ] as const)("keeps a whole-series %s reply pending until the exact master confirms it", async (reply, status, action) => {
    const { response, posts, read, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    await queue(reply, true);
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.masterPointFailure = true;
    // Use a delta with no occurrences so the isolated failure is the RSVP readback.
    response.deltaIncludesDays = false;
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    response.masterPointFailure = false;
    response.master = status;
    response.masterVersion = "series-answered";
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(await read()).toMatchObject([{ providerId: "series", answer: reply }]);
    expect(posts).toEqual([`/v1.0/me/events/series/${action}`]);
  });

  it.each([1, 2])("keeps the confirmed occurrence answer over %s copies of an older delta and takes a genuine later change", async (copies) => {
    const { response, posts, read, turn, queue, writes } = await quarterlyWorld();
    response.modification = "absent";
    await turn();
    await queue("accepted");
    response.send = async () => {
      response.revision = 2;
      response.current = "accepted";
      response.delta = { revision: 1, response: "notResponded", copies };
      return 202;
    };
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.revision = 3;
    response.current = "tentativelyAccepted";
    response.delta = undefined;
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-3" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("keeps the exact answer when the list omits the response and carries a stale attendee", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    const child = (await read()).find(({ providerId }) => providerId === "first-day")!;
    response.omitDeltaResponse = true;
    await turn();
    expect((await read()).find(({ id }) => id === child.id)).toMatchObject({ answer: "accepted" });
    const guests = await w.db.select({ answer: calAttendees.answer }).from(calAttendees)
      .where(and(eq(calAttendees.accountId, seeded.accountId), eq(calAttendees.eventId, child.id)));
    expect(guests).toContainEqual({ answer: "accepted" });
  });

  it.each(["delta", "whole"] as const)("keeps a newer %s reply until the point read confirms it", async (mode) => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ value: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.value;
    if (mode === "whole") await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
    response.delta = { revision: 3, response: "tentativelyAccepted" };
    response.next = "later-response";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-2" });
    expect(await cursor()).toBeNull();
    response.revision = 3;
    response.current = "tentativelyAccepted";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-3" });
    expect(await cursor()).toContain("later-response");
  });

  it.each(["delta", "whole"] as const)("ignores a stale %s reply even when the Outlook point read also lags", async (mode) => {
    const { seeded, response, read, turn, restart } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-2" });

    restart();
    if (mode === "whole") await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
    const cursor = async () => (await w.db.select({ value: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.value;
    response.revision = 1;
    response.current = "notResponded";
    response.next = "after-older-reply";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-2" });
    expect(await cursor()).toContain("after-older-reply");

    response.revision = 3;
    response.current = "tentativelyAccepted";
    response.next = "after-newer-reply";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-3" });
    expect(await cursor()).toContain("after-newer-reply");

    response.modification = "absent";
    response.revision = 4;
    response.current = "declined";
    await turn();
    response.modification = "ordered";
    response.revision = 1;
    response.current = "notResponded";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "declined", version: "day-4" });
  });

  it.each(["ordered", "tied", "absent"] as const)("keeps an Outlook reply unresolved against a different mirrored answer with %s timestamps", async (modification) => {
    const { response, posts, queue, read, turn, writes } = await quarterlyWorld();
    response.modification = modification;
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.revision = 2;
    response.current = "tentativelyAccepted";
    // Isolate the older dated reply as the first completed confirmation check.
    response.pointFailure = modification === "ordered";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-2" });
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);

    response.revision = 1;
    response.current = "accepted";
    response.pointFailure = false;
    if (modification !== "ordered") response.deltaIncludesDays = false;
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-2" });

    response.revision = 3;
    response.deltaIncludesDays = true;
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-3" });
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it.each(["tied", "absent"] as const)("advances once the point read confirms a competing revision with %s times", async (modification) => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.modification = modification;
    response.revision = 2;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    response.delta = { revision: 2, response: "accepted" };
    response.competing = { revision: 3, response: "tentativelyAccepted" };
    response.next = "after-both-revisions";
    await turn();
    expect(await cursor()).toBeNull();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.revision = 3;
    response.current = "tentativelyAccepted";
    await turn();
    expect(await cursor()).toContain("after-both-revisions");
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative" });
  });

  it("parks an opaque reply until Outlook offers a consistent revision", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.modification = "absent";
    response.revision = 1;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    response.delta = { revision: 2, response: "tentativelyAccepted" };
    response.competing = { revision: 3, response: "declined" };
    response.revision = 2;
    response.current = "tentativelyAccepted";
    response.next = "after-three-revisions";
    await turn();
    expect(await cursor()).toBeNull();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.revision = 3;
    response.current = "declined";
    await turn();
    expect(await cursor()).toBeNull();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.delta = response.competing = undefined;
    await turn();
    expect(await cursor()).toContain("after-three-revisions");
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "declined" });
  });

  it.each([
    ["tied", false], ["tied", true], ["absent", false], ["absent", true],
  ] as const)("advances past an unchanged exact reply with %s times and reversed page order %s", async (modification, reverse) => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.modification = modification;
    response.revision = 1;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    expect(await cursor()).toEqual(expect.any(String));
    const candidate = { revision: 2, response: "tentativelyAccepted" };
    const exact = { revision: 3, response: "declined" };
    response.delta = reverse ? exact : candidate;
    response.competing = reverse ? candidate : exact;
    response.revision = exact.revision;
    response.current = exact.response;
    response.next = "after-competing";
    response.split = 2;

    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    expect((await read()).find(({ providerId }) => providerId === "workshop-addition")).toBeDefined();
    expect(await cursor()).toBeNull();
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-1" });
    expect((await read()).find(({ providerId }) => providerId === "workshop-addition")).toBeDefined();
    expect(await cursor()).toBeNull();

    // A fresh window can now confirm the reply once Outlook stops listing the older revision.
    response.delta = response.competing = undefined;
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "declined", version: "day-3" });
    response.split = false;
    response.revision = 4;
    response.current = "tentativelyAccepted";
    await turn();
    expect(await cursor()).toEqual(expect.any(String));
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-4" });
  });

  it.each(["ordered", "omitted", "newer-omitted"] as const)("still imports later pages during a persistent %s Outlook reply disagreement", async (kind) => {
    const { seeded, response, read, turn, restart } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    const original = await cursor();

    response.next = "still-imports-later-pages";
    response.split = true;
    if (kind === "ordered") {
      response.delta = { revision: 3, response: "tentativelyAccepted" };
    } else if (kind === "newer-omitted") {
      response.delta = { revision: 3, response: "tentativelyAccepted" };
      response.revision = 4;
      response.current = "declined";
      response.omitPointResponse = true;
    } else {
      response.omitDeltaResponse = response.omitPointResponse = true;
    }
    const outcomes: string[] = [];
    for (let poll = 0; poll < 6; poll++) {
      if (poll === 3) restart();
      outcomes.push((await turn("either")).kind);
    }
    const during = {
      outcomes, cursorMoved: (await cursor()) !== original, token: await cursor(),
      addition: (await read()).some(({ providerId }) => providerId === "workshop-addition"),
      answer: (await read()).find(({ providerId }) => providerId === "first-day")?.answer,
    };
    response.delta = undefined;
    response.omitDeltaResponse = response.omitPointResponse = false;
    if (kind === "ordered") {
      response.revision = 3;
      response.current = "tentativelyAccepted";
    }
    await turn();
    expect((await read()).some(({ providerId }) => providerId === "workshop-addition")).toBe(true);
    expect(during).toMatchObject({ outcomes: Array(6).fill("synced"), cursorMoved: true, token: null, addition: true, answer: "accepted" });
  });

  it("lets an unrelated Outlook write through when an uncertain whole-series reply can no longer be read", async () => {
    const { seeded, response, posts, queue, read, turn, writes, due, restart } = await quarterlyWorld();
    await turn();
    const first = await queue("accepted", true);
    response.send = async () => "timeout";
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/series/accept"]);
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await w.db.update(calWrites).set({ nextAttemptAt: sql`now() + interval '1 hour'` })
      .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, first.id)));

    response.removeMaster = "delta";
    const [calendar] = await w.db.select({ calendarId: calCalendars.id })
      .from(calCalendars).where(eq(calCalendars.accountId, seeded.accountId));
    await press(seeded.accountId, "unrelated-create-after-series", create(calendar!));
    response.send = async () => 400;
    for (let poll = 0; poll < 6; poll++) {
      if (poll === 3) restart();
      await turn();
    }
    expect((await read()).some(({ providerId }) => providerId === "series")).toBe(false);
    expect(posts).toEqual(["/v1.0/me/events/series/accept"]);
    await due();
    await turn();
    expect(posts).toEqual([
      "/v1.0/me/events/series/accept", "/v1.0/me/calendars/calendar/events",
    ]);
    expect(await writes()).toEqual([{ state: "refused", reason: "field_unwritable" }]);
  });

  it.each(["tied", "absent"] as const)("lets a newer Outlook series choice proceed when the exact old reply stays unordered with %s times", async (modification) => {
    const { response, posts, queue, read, turn, writes, restart } = await quarterlyWorld();
    response.modification = modification;
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.revision = 2;
    response.current = "tentativelyAccepted";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-2" });
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);

    response.revision = 1;
    response.current = "accepted";
    response.deltaIncludesDays = false;
    response.send = async () => {
      response.master = "declined";
      return 202;
    };
    const preceding = modification === "absent" ? "middle-occurrence" : "quarterly-answer";
    if (preceding === "middle-occurrence") await queue("tentative", false, preceding, "quarterly-answer");
    await queue("declined", true, "queued-series-reply", preceding);
    await turn();
    const nextPosts = [...posts];
    for (let poll = 1; poll < 6; poll++) {
      if (poll === 3) restart();
      await turn();
    }
    const during = { posts: [...posts], writes: await writes() };
    response.revision = 2;
    response.current = "tentativelyAccepted";
    await turn();
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept", "/v1.0/me/events/series/decline"]);
    expect(nextPosts).toEqual(posts);
    expect(during).toMatchObject({ posts: [
      "/v1.0/me/events/first-day/accept", "/v1.0/me/events/series/decline",
    ] });
    expect(during.writes.at(-1)).toEqual({ state: "applied", reason: null });
    expect(during.writes.slice(0, -1)).toEqual(Array(preceding === "middle-occurrence" ? 2 : 1)
      .fill({ state: "refused", reason: "answer_unconfirmed" }));
  });

  it("sends a newer Outlook series choice while an older series reply awaits confirmation", async () => {
    const { response, posts, queue, turn, writes } = await quarterlyWorld();
    await turn();
    await queue("accepted", true);
    response.send = async () => "timeout";
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await queue("declined", true, "new-series-choice", "quarterly-answer");
    response.send = async () => {
      response.master = "declined";
      return 202;
    };
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/series/accept", "/v1.0/me/events/series/decline"]);
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }, { state: "applied", reason: null }]);
  });

  it.each(["tied", "absent"] as const)("continues past an unlisted Outlook reply with %s timestamps", async (modification) => {
    const { seeded, response, read, turn, restart } = await quarterlyWorld();
    response.modification = modification;
    response.revision = 1;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    expect(await cursor()).toEqual(expect.any(String));

    response.delta = { revision: 2, response: "tentativelyAccepted" };
    response.revision = 3;
    response.current = "declined";
    response.next = "after-unlisted-reply";
    response.split = true;
    await turn();
    expect(await cursor()).toBeNull();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted", version: "day-1" });
    expect((await read()).find(({ providerId }) => providerId === "workshop-addition")).toBeDefined();

    restart();
    response.delta = undefined;
    await turn();
    expect(await cursor()).toContain("after-unlisted-reply");
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "declined", version: "day-3" });
  });

  it.each([["declined", "decline"], ["accepted", "accept"]] as const)("drains a later Outlook series %s reply when an older exact reply stays stale", async (reply, action) => {
    const { response, posts, queue, read, turn, writes, restart } = await quarterlyWorld();
    await turn();
    await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.revision = 2;
    response.current = "tentativelyAccepted";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-2" });
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);

    restart();
    response.revision = 1;
    response.current = "accepted";
    response.deltaIncludesDays = false;
    response.send = async () => {
      response.master = reply;
      return 202;
    };
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
    await queue(reply, true, "queued-series-reply", "quarterly-answer");
    await turn();
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept", `/v1.0/me/events/series/${action}`]);
    expect((await writes()).at(-1)).toEqual({ state: "applied", reason: null });
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative", version: "day-2" });
  });

  it("rechecks an Outlook reply whose receipt was renewed during the exact read", async () => {
    const { seeded, response, posts, queue, turn, writes } = await quarterlyWorld();
    await turn();
    const first = await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    response.current = "accepted";
    response.revision = 1;
    response.deltaIncludesDays = false;
    response.beforePoint = async () => {
      await w.db.update(calWrites).set({ updatedAt: sql`clock_timestamp()` })
        .where(and(eq(calWrites.accountId, seeded.accountId), eq(calWrites.id, first.id)));
    };
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);

    response.beforePoint = async () => {};
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it("refreshes Outlook after parking an older exact copy in a whole window", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.modification = "tied";
    response.revision = 1;
    response.current = "accepted";
    await turn();
    const clear = () => w.db.update(calCalendars).set({ syncToken: null })
      .where(eq(calCalendars.accountId, seeded.accountId));
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    const day = async () => (await read()).find(({ providerId }) => providerId === "first-day");
    await clear();

    response.revision = 2;
    response.current = "tentativelyAccepted";
    response.competing = { revision: 3, response: "declined" };
    response.next = "after-the-whole-window";
    await turn();
    expect(await day()).toMatchObject({ version: "day-1", answer: "accepted" });
    await turn();
    expect(await day()).toMatchObject({ version: "day-1", answer: "accepted" });
    expect(await cursor()).toBeNull();

    // A terminal delta starts after the provider already emitted both revisions.
    // The now-current copy is visible on a fresh whole window, but not in that delta.
    response.revision = 3;
    response.current = "declined";
    response.competing = undefined;
    response.withholdDaysOnCursor = true;
    await turn();
    expect(await day()).toMatchObject({ version: "day-3", answer: "declined" });
  });

  it("refreshes the whole Outlook window when the exact reply is newer than every listed copy", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
    response.revision = 3;
    response.current = "declined";
    response.delta = { revision: 1, response: "notResponded" };
    response.next = "after-an-old-list-copy";
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ version: "day-2", answer: "accepted" });
    const [calendar] = await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId));
    expect(calendar?.token).toBeNull();

    response.delta = undefined;
    response.withholdDaysOnCursor = true;
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ version: "day-3", answer: "declined" });
  });

  it("requires an exact missing response when a live event and its removal share a page", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    response.tombstone = true;
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.missing = true;
    await turn();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toBeUndefined();
    const [series] = await w.db.select({ excluded: calEvents.excludedDates }).from(calEvents)
      .where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.providerId, "series")));
    expect(series?.excluded ?? []).toHaveLength(1);
  });

  it("keeps a same-day replacement when the exact read confirms the old occurrence was removed", async () => {
    const { response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    response.tombstone = true;
    response.missing = true;
    response.replacement = true;
    await turn();
    const rows = await read();
    expect(rows.find(({ providerId }) => providerId === "first-day")).toBeUndefined();
    expect(rows.find(({ providerId }) => providerId === "replacement-day")).toMatchObject({ answer: "accepted" });
    const master = rows.find(({ providerId }) => providerId === "series")!;
    const [series] = await w.db.select({ excluded: calEvents.excludedDates }).from(calEvents).where(eq(calEvents.id, master.id));
    expect(series?.excluded ?? []).toHaveLength(0);
  });

  it.each(["missing", "outside"] as const)("keeps a confirmed reply over a later stale tombstone and removes it when the exact copy is %s", async (gone) => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 2;
    response.current = "accepted";
    await turn();
    response.splitTombstone = true;
    await turn();
    expect(response.pointReads).toBe(1);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    response.missing = gone === "missing";
    response.pointOutside = gone === "outside";
    await turn();
    expect(response.pointReads).toBe(2);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toBeUndefined();
    const [series] = await w.db.select({ excluded: calEvents.excludedDates }).from(calEvents)
      .where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.providerId, "series")));
    expect(series?.excluded ?? []).toHaveLength(1);
  });

  it("advances past separate stale and newer pages while the exact copy catches up", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.modification = "absent";
    response.revision = 2;
    response.current = "accepted";
    await turn();
    const cursor = async () => (await w.db.select({ token: calCalendars.syncToken }).from(calCalendars)
      .where(eq(calCalendars.accountId, seeded.accountId)))[0]?.token;
    const before = await cursor();
    response.delta = { revision: 1, response: "notResponded" };
    response.competing = { revision: 3, response: "tentativelyAccepted" };
    response.next = "after-newer-page";
    response.split = true;
    await turn();
    expect(await cursor()).toBeNull();
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "accepted" });
    expect((await read()).find(({ providerId }) => providerId === "workshop-addition")).toBeDefined();
    response.revision = 3;
    response.current = "tentativelyAccepted";
    await turn();
    expect(await cursor()).not.toBe(before);
    expect((await read()).find(({ providerId }) => providerId === "first-day")).toMatchObject({ answer: "tentative" });
    expect((await read()).find(({ providerId }) => providerId === "workshop-addition")).toBeDefined();
  });

  it("checks a dispatched reply after the original send deadline", async () => {
    const { response, posts, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    const write = await queue("accepted");
    response.send = async () => "timeout";
    await turn();
    // Check again reset the read attempts, and keeps the original queue date.
    await w.db.update(calWrites).set({ attempts: 0, createdAt: sql`now() - interval '4 days'` }).where(eq(calWrites.id, write.id));
    response.revision = 1;
    response.current = "accepted";
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/accept"]);
  });

  it.each(["delta", "whole"] as const)("settles the master decline after a %s reading removes the series", async (mode) => {
    const { seeded, response, posts, read, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    await queue("declined", true);
    response.send = async () => {
      response.removeMaster = mode;
      return 202;
    };
    if (mode === "whole") await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
    await turn();
    await due();
    await turn();
    expect(await read()).toEqual([]);
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/series/decline"]);
  });

  it.each(["delta", "whole"] as const)("settles an acknowledged master decline after exhausting confirmation and later receiving %s evidence", async (mode) => {
    const { seeded, response, posts, read, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    const write = await queue("declined", true);
    await turn();
    await turn();
    expect(await writes()).toEqual([{ state: "pending", reason: null }]);
    await w.db.update(calWrites).set({ attempts: WRITE_MAX_ATTEMPTS }).where(eq(calWrites.id, write.id));
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "refused", reason: "answer_unconfirmed" }]);
    response.removeMaster = mode;
    const master = (await read()).find(({ providerId }) => providerId === "series")!;
    await w.db.delete(calAttendees).where(and(eq(calAttendees.accountId, seeded.accountId), eq(calAttendees.eventId, master.id)));
    await w.db.delete(calEvents).where(and(eq(calEvents.accountId, seeded.accountId), eq(calEvents.id, master.id)));
    if (mode === "whole") await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
    await turn();
    await due();
    await turn();
    expect(await read()).toEqual([]);
    expect(await writes()).toEqual([{ state: "applied", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/series/decline"]);
  });

  it.each(["delta", "whole"] as const)("settles an acknowledged decline after a %s read loses that day and drains the following answer", async (mode) => {
    const { seeded, response, posts, read, turn, queue, writes, due } = await quarterlyWorld();
    await turn();
    await queue("declined");
    await queue("tentative", true, "later-answer", "quarterly-answer");
    if (mode === "whole") await w.db.update(calCalendars).set({ syncToken: null })
      .where(eq(calCalendars.accountId, seeded.accountId));
    response.send = async () => {
      if (posts.length === 1) {
        response.missing = true;
        response.removed = mode;
      } else {
        response.master = "tentativelyAccepted";
        response.masterVersion = "series-answered";
      }
      return 202;
    };
    await turn();
    if (mode === "whole") {
      await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, seeded.accountId));
      await turn();
    }
    await due();
    await turn();
    expect(await writes()).toEqual([{ state: "applied", reason: null }, { state: "applied", reason: null }]);
    expect(posts).toEqual(["/v1.0/me/events/first-day/decline", "/v1.0/me/events/series/tentativelyAccept"]);
    const [series] = await w.db.select({ excluded: calEvents.excludedDates }).from(calEvents).where(eq(calEvents.accountId, seeded.accountId));
    expect(series?.excluded).toHaveLength(1);
    expect(series?.excluded?.[0]?.value).toMatch(/^20261006T/);
    expect(await read()).toMatchObject([{ providerId: "series", answer: "tentative" }]);
  });

  it("corrects a stored unanswered attendee on the very same Graph revision", async () => {
    const { seeded, response, read, turn } = await quarterlyWorld();
    response.revision = 1;
    response.current = "accepted";
    await turn();
    const child = (await read()).find(({ providerId }) => providerId === "first-day")!;
    await w.db.update(calEvents).set({ myAnswer: "none" }).where(eq(calEvents.id, child.id));
    await w.db.update(calAttendees).set({ answer: "none" }).where(eq(calAttendees.eventId, child.id));
    await turn();
    expect((await read()).find(({ id }) => id === child.id)).toMatchObject({ answer: "accepted", version: "day-1" });
    const attendees = await w.db.select({ answer: calAttendees.answer }).from(calAttendees)
      .where(and(eq(calAttendees.accountId, seeded.accountId), eq(calAttendees.eventId, child.id)));
    expect(attendees).toContainEqual({ answer: "accepted" });
  });

  it("refuses a changed-occurrence decline without calling the provider", async () => {
    const a = await account();
    const attendee = ["guest", "example.test"].join("@");
    const organizer = ["host", "example.test"].join("@");
    await w.db.update(calConnections).set({ principal: attendee }).where(eq(calConnections.id, a.connectionId));
    const [master] = await w.db.update(calEvents).set({ repeatRule: "FREQ=DAILY;COUNT=5", organizer, myAnswer: "accepted" })
      .where(eq(calEvents.id, a.eventId)).returning({ updatedAt: calEvents.updatedAt });
    const at = String(Date.UTC(2026, 10, 20, 9));
    const [child] = await w.db.insert(calEvents).values({
      accountId: a.accountId, calendarId: a.calendarId, providerId: "changed", versionTag: '"v2"',
      uid: "uid-1", recurrenceId: at, occurrenceAt: new Date(Number(at)), title: "Moved lesson", organizer, myAnswer: "accepted",
      startKind: "instant", startLocal: "20261120T110000Z", endKind: "instant", endLocal: "20261120T120000Z",
      startsAt: new Date("2026-11-20T11:00:00Z"), endsAt: new Date("2026-11-20T12:00:00Z"),
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    await w.db.insert(calAttendees).values([a.eventId, child!.id].map((eventId) => ({
      eventId, accountId: a.accountId, address: attendee, role: "required", answer: "accepted",
    })));
    const act = { kind: "calendar_event_answer", eventId: child!.id,
      base: `${child!.updatedAt.toISOString()}/${master!.updatedAt.toISOString()}`,
      scope: { kind: "occurrence", at }, answer: "declined" };
    const row = await recordWrite(w, { accountId: a.accountId, key: "decline", act });
    const exception = { id: child!.id, providerId: "changed", version: '"v2"', occurrence: at };
    await w.db.update(calWrites).set({ eventId: a.eventId, baseVersionTag: '"v1"',
      payload: sql`${calWrites.payload} || ${JSON.stringify({ exception })}::jsonb`,
    }).where(eq(calWrites.id, row.id));
    const writer = scriptedWriter("google");
    await run(a, writer);
    expect(writer.calls).toEqual([]);
    expect(await rows(a)).toMatchObject([{ key: "decline", state: "refused", refusal: "content_refused" }]);
  });

  it.each(["google", "microsoft", "caldav"] as const)("drains the exact reviewed exception on %s and refuses a copy changed in the queue", async (word) => {
    const a = await account(word);
    await w.db.update(calEvents).set({ repeatRule: "FREQ=DAILY;COUNT=5" }).where(eq(calEvents.id, a.eventId));
    const at = String(Date.UTC(2026, 10, 20, 9));
    const version = word === "caldav" ? '"v1"' : '"exception-v3"';
    const providerId = word === "caldav" ? "evt-1" : "moved-occurrence";
    const [child] = await w.db.insert(calEvents).values({
      accountId: a.accountId, calendarId: a.calendarId, providerId, versionTag: version, uid: "uid-1", recurrenceId: at,
      occurrenceAt: new Date(Number(at)), title: "Moved lesson",
      startKind: "instant", startLocal: "20261120T110000Z", endKind: "instant", endLocal: "20261120T120000Z",
      startsAt: new Date("2026-11-20T11:00:00Z"), endsAt: new Date("2026-11-20T12:00:00Z"),
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    const act = {
      kind: "calendar_event_update", eventId: child!.id, base: child!.updatedAt.toISOString(),
      scope: { kind: "occurrence", at }, change: { title: "Confirmed firing" }, audience: { organizer: null, guests: [] },
    };
    const exception = { id: child!.id, providerId, version, occurrence: at };
    const queued = async (key: string) => {
      const row = await recordWrite(w, { accountId: a.accountId, key, act });
      await w.db.update(calWrites).set({ eventId: a.eventId, baseVersionTag: '"v1"',
        payload: sql`${calWrites.payload} || ${JSON.stringify({ exception })}::jsonb`,
      }).where(eq(calWrites.id, row.id));
    };
    const writer = scriptedWriter(word, { answer: () => ({ ok: true, items: [] }) });
    await queued("reviewed");
    await run(a, writer, { word });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({ kind: "change", change: { summary: "Confirmed firing" },
      target: { id: "evt-1", version: '"v1"', exception: { id: providerId, version, occurrence: { kind: "instant", epochMs: Number(at) } } },
    });
    expect((await rows(a)).map((r) => [r.key, r.state])).toEqual([["reviewed", "applied"]]);
    await queued("changed");
    await w.db.update(calEvents).set({ versionTag: '"newer"' }).where(eq(calEvents.id, child!.id));
    await run(a, writer, { word });
    expect(writer.calls).toHaveLength(1);
    expect((await rows(a)).at(-1)).toMatchObject({ key: "changed", state: "refused", refusal: "version_stale" });

    if (word === "caldav") return;
    const [master] = await w.db.select({ updatedAt: calEvents.updatedAt }).from(calEvents).where(eq(calEvents.id, a.eventId));
    const pressed = await recordWrite(w, { accountId: a.accountId, key: "both", act: {
      ...act, scope: { kind: "record" }, base: `${act.base}/${master!.updatedAt.toISOString()}`,
    } });
    await w.db.update(calWrites).set({ eventId: a.eventId, baseVersionTag: '"v1"',
      payload: sql`${calWrites.payload} || ${JSON.stringify({ exception: { ...exception, version: '"newer"' } })}::jsonb`,
    }).where(eq(calWrites.id, pressed.id));
    const receipt = { version: '"saved-master"', exceptionSnapshot: "2".repeat(64),
      ...(word === "microsoft" ? { exceptionEndMs: Date.UTC(2026, 10, 20, 12, 15) } : {}) };
    await run(a, { ...writer, change: async (_connection, _calendar, target) => {
      await target.rememberMasterReceipt?.(receipt);
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    } }, { word });
    expect((await rows(a)).at(-1)).toMatchObject({ key: "both", state: "pending", payload: { exception: { masterReceipt: receipt } } });
    await w.db.update(calEvents).set({ versionTag: receipt.version, updatedAt: new Date() }).where(eq(calEvents.id, a.eventId));
    // An explicit Retry resets the attempt counter while keeping the acknowledged receipt.
    await w.db.update(calWrites).set({ attempts: 0, nextAttemptAt: null }).where(eq(calWrites.id, pressed.id));
    const held: unknown[] = [];
    await run(a, { ...writer, change: async (_connection, _calendar, target) => {
      held.push(target.masterReceipt);
      return { ok: true, items: [] };
    } }, { word });
    expect(held).toEqual([receipt]);
    expect((await rows(a)).at(-1)).toMatchObject({ key: "both", state: "applied", payload: {} });
  });

  it("applies a new event once: the writer is asked under the row's own name, the row closes with nothing of the act kept, and the store holds the provider's object in the row the write stood in", async () => {
    const a = await account();
    const act = create(a);
    const recorded = await recordWrite(w, { accountId: a.accountId, key: "press-new", act });
    const writer = scriptedWriter("google");
    expect(await run(a, writer)).toEqual({ nextAttemptAt: null });
    const hex = recorded.id.replaceAll("-", "");
    expect(writer.calls.map((c) => [c.kind, c.key, c.calendar, c.draft?.summary])).toEqual([["create", hex, `cal-${a.accountId.slice(0, 6)}`, "Glaze firing"]]);
    expect((await rows(a)).map((r) => [r.state, r.payload, r.attempts])).toEqual([["applied", { fingerprint: expect.stringMatching(/^v1:[0-9a-f]{64}$/) }, 1]]);
    expect((await events(a)).find((e) => e.id === act.eventId)).toEqual({ id: act.eventId, providerId: `made-${hex}`, title: "Glaze firing", versionTag: '"v1"' });
    // Done once: a second drain asks nothing.
    await run(a, writer);
    expect(writer.calls.length).toBe(1);
  });

  it.each(["accepted", "tentative", "declined"] as const)(
    "keeps the mailed %s answer when CalDAV confirms the personal copy",
    async (mailAnswer) => {
      const a = await account("caldav");
      const act = create(a);
      act.event.busy = mailAnswer !== "declined";
      await press(a.accountId, "file-invitation", act);
      await w.db.update(calEvents).set({ mailAnswer }).where(eq(calEvents.id, act.eventId));

      const writer = scriptedWriter("caldav");
      await run(a, writer, { word: "caldav" });
      expect((await rows(a)).at(-1)).toMatchObject({ state: "applied" });
      expect(writer.calls.map(({ kind }) => kind)).toEqual(["create"]);
      expect(writer.calls[0]!.draft).toMatchObject({ attendees: [], organizer: null, busy: act.event.busy });

      const [copy] = await w.db.select({ mailAnswer: calEvents.mailAnswer, myAnswer: calEvents.myAnswer, version: calEvents.versionTag })
        .from(calEvents).where(eq(calEvents.id, act.eventId));
      expect(copy).toEqual({ mailAnswer, myAnswer: null, version: '"v1"' });
    },
  );

  it("leaves ONE event when the drain is cut after the provider took the write and before it was settled, and is run again", async () => {
    const a = await account();
    const act = create(a);
    await press(a.accountId, "press-cut", act);
    const writer = scriptedWriter("google");
    // The provider takes the write and its answer is lost on the way: the store learns nothing of it.
    let cut = true;
    const cutting = scriptedWriter("google", { answer: async (call): Promise<"default"> => {
      if (!cut) return "default";
      await writer.create(call.connection, { id: call.calendar }, { key: { hex: call.key! }, event: call.draft! }, never);
      throw new Error("the connection dropped after the provider answered");
    } });
    expect((await run(a, cutting)).nextAttemptAt).not.toBeNull();
    expect((await rows(a)).map((r) => [r.state, r.refusal, r.attempts])).toEqual([["pending", null, 1]]);
    cut = false;
    await dueNow(a);
    await run(a, writer);
    expect(writer.objects.size).toBe(1);
    expect(writer.calls.map((c) => c.key)).toEqual([cutting.calls[0]!.key, cutting.calls[0]!.key]);
    expect((await events(a)).filter((e) => e.title === "Glaze firing").length).toBe(1);
    expect((await rows(a)).map((r) => r.state)).toEqual(["applied"]);
  });

  it("refuses a change made against a version the provider moved past, overwrites nothing, makes the calendar due, and refuses what waited for it", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "Mine"));
    await press(a.accountId, "press-2", update(a, "Mine again"), "press-1");
    const writer = scriptedWriter("google");
    writer.objects.set("evt-1", { version: 2, summary: "Theirs" });
    await w.db.update(calCalendars).set({ nextPollAt: sql`now() + interval '1 hour'` }).where(eq(calCalendars.id, a.calendarId));
    await run(a, writer);
    expect(writer.objects.get("evt-1")).toEqual({ version: 2, summary: "Theirs" });
    expect((await rows(a)).map((r) => [r.key, r.state, r.refusal])).toEqual([["press-1", "refused", "version_stale"], ["press-2", "refused", "earlier_refused"]]);
    expect(writer.calls.length).toBe(1);
    const [cal] = await w.db.select({ at: calCalendars.nextPollAt }).from(calCalendars).where(eq(calCalendars.id, a.calendarId));
    expect(cal!.at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("re-bases the writes behind an applied one onto the provider's new version, and sends them in order", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "One"));
    await press(a.accountId, "press-2", update(a, "Two"), "press-1");
    const writer = scriptedWriter("google");
    writer.objects.set("evt-1", { version: 1, summary: "Kiln check" });
    await run(a, writer);
    expect(writer.calls.map((c) => [c.change?.summary, c.target?.version])).toEqual([["One", '"v1"'], ["Two", '"v2"']]);
    expect((await rows(a)).map((r) => r.state)).toEqual(["applied", "applied"]);
    expect((await events(a)).find((e) => e.id === a.eventId)).toMatchObject({ title: "Two", versionTag: '"v3"' });
  });

  it("keeps the selected series scope on its original version behind another edit", async () => {
    const a = await account("caldav");
    await w.db.update(calConnections).set({ serverUrl: BENCH_CALDAV_PLACE.replace("caldav:", "http://") }).where(eq(calConnections.id, a.connectionId));
    const original = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//EN", "BEGIN:VEVENT", "UID:uid-1",
      "DTSTAMP:20261101T000000Z", "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117",
      "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Kiln check", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    await w.db.update(calEvents).set({ original, startKind: "date", endKind: "date", startLocal: "20261116", endLocal: "20261117",
      startsAt: new Date("2026-11-16T00:00:00Z"), endsAt: new Date("2026-11-17T00:00:00Z"), repeatRule: "FREQ=DAILY;COUNT=5" }).where(eq(calEvents.id, a.eventId));
    await press(a.accountId, "first", update(a, "First"));
    await press(a.accountId, "second", { ...update(a, "Second"), personalSeries: true }, "first");
    const updated = original.replace("Kiln check", "First");
    const read = readCalendar(updated, DEFAULT_LIMITS);
    if (!read.ok) throw new Error("invalid series fixture");
    const writer = scriptedWriter("caldav", { answer: (call, n) => {
      if (n === 1) return { ok: true, written: true, items: [upsert("evt-1", '"v2"', read.calendar.events[0]!, updated)] };
      return call.target?.version !== '"v2"' ? { ok: false, reason: "version_stale", retryAfterMs: null } : "default";
    } });
    await run(a, writer, { word: "caldav" });
    expect((await rows(a)).map((row) => [row.state, row.base, row.refusal])).toEqual([
      ["applied", '"v1"', null], ["refused", '"v1"', "version_stale"],
    ]);
    expect(writer.calls.at(-1)?.target).toMatchObject({ version: '"v1"', personalSeries: true });
  });

  it("keeps the confirmed recipients when a queued edit takes the provider’s newer version", async () => {
    const a = await account();
    const audience = { organizer: "studio@example.invalid", guests: ["clay@example.invalid"] };
    await press(a.accountId, "press-1", update(a, "One"));
    await press(a.accountId, "press-2", { ...update(a, "Two"), audience }, "press-1");
    const writer = scriptedWriter("google");
    writer.objects.set("evt-1", { version: 1, summary: "Kiln check" });
    await run(a, writer);
    expect(writer.calls.map((c) => [c.target?.version, c.target?.audience])).toEqual([
      ['"v1"', undefined], ['"v2"', audience],
    ]);
  });

  it("sends a change under the version it was recorded on: a newer copy a reading stored meanwhile makes it stale, never an overwrite", async () => {
    const a = await account();
    await press(a.accountId, "press-mine", update(a, "Mine"));
    const writer = scriptedWriter("google");
    writer.objects.set("evt-1", { version: 2, summary: "Theirs" });
    // Someone else changed the event at the provider, and a reading stored that copy before the drain reached the write.
    await w.db.update(calEvents).set({ versionTag: '"v2"', title: "Theirs", updatedAt: sql`now()` }).where(eq(calEvents.id, a.eventId));
    await run(a, writer);
    expect(writer.calls.map((c) => c.target?.version)).toEqual(['"v1"']);
    expect(writer.objects.get("evt-1")).toEqual({ version: 2, summary: "Theirs" });
    expect((await rows(a)).map((r) => [r.state, r.refusal, r.base])).toEqual([["refused", "version_stale", '"v1"']]);
  });

  it("keeps a write that waited behind another on its own version, through whole turns that read the provider's newer copy", async () => {
    const reader = scriptedReader("caldav", { readings: new Map([
      ["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "First")), upsert("/cal/2.ics", '"v1"', single("u2", 19, "Kiln check"))] }]],
      ["t1", [{ items: [upsert("/cal/2.ics", '"v2"', single("u2", 19, "Theirs"))] }]],
      ["t2", [{ items: [] }]],
    ]), endToken: (since) => (since === null ? "t1" : "t2") });
    let down = true;
    const writer = scriptedWriter("caldav", { answer: () => (down ? { ok: false, reason: "unavailable", retryAfterMs: null } : "default") });
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    writer.objects.set("/cal/1.ics", { version: 1, summary: "First" });
    writer.objects.set("/cal/2.ics", { version: 1, summary: "Kiln check" });
    await recordWrite(w, { accountId: t.accountId, key: "press-1", act: retitle(await t.stored("/cal/1.ics"), "First, mine") });
    await recordWrite(w, { accountId: t.accountId, key: "press-2", act: retitle(await t.stored("/cal/2.ics"), "Mine") });
    // Someone else changes the second event; the first write is answered with a wait, and the reading of that same turn stores the newer copy.
    writer.objects.set("/cal/2.ics", { version: 2, summary: "Theirs" });
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(await t.stored("/cal/2.ics")).toMatchObject({ versionTag: '"v2"', title: "Theirs" });
    down = false;
    await dueNow(t);
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(writer.calls.map((c) => [c.target?.id, c.target?.version])).toEqual([["/cal/1.ics", '"v1"'], ["/cal/1.ics", '"v1"'], ["/cal/2.ics", '"v1"']]);
    expect(writer.objects.get("/cal/2.ics")).toEqual({ version: 2, summary: "Theirs" });
    expect((await t.writes()).map((r) => [r.key, r.state, r.refusal])).toEqual([["press-1", "applied", null], ["press-2", "refused", "version_stale"]]);
  });

  it("writes a change once when its answer was lost and a reading stored the provider's copy before it was sent again", async () => {
    const pages = new Map<string, ScriptedPage[]>([["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "Kiln check"))] }]], ["t1", [{ items: [] }]], ["t2", [{ items: [] }]]]);
    const reader = scriptedReader("caldav", { readings: pages, endToken: (since) => (since === null ? "t1" : "t2") });
    const provider = scriptedWriter("caldav");
    provider.objects.set("/cal/1.ics", { version: 1, summary: "Kiln check" });
    let cut = true;
    const writer = scriptedWriter("caldav", { answer: async (call): Promise<WriteAnswer> => {
      const done = await provider.change(call.connection, { id: call.calendar }, call.target!, call.change!, never);
      if (cut) throw new Error("the connection dropped after the provider answered");
      return done;
    } });
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    await recordWrite(w, { accountId: t.accountId, key: "press-once", act: retitle(await t.stored("/cal/1.ics"), "Mine") });
    // The provider takes the change and its answer is lost; the reading of that same turn stores the provider's new copy.
    pages.set("t1", [{ items: [upsert("/cal/1.ics", '"v2"', single("u1", 18, "Mine"))] }]);
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(await t.stored("/cal/1.ics")).toMatchObject({ versionTag: '"v2"', title: "Mine" });
    cut = false;
    await dueNow(t);
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    // Sent again under the version it was made on: the provider's compare finds it already there, and nothing is written twice.
    expect(provider.calls.map((c) => c.target?.version)).toEqual(['"v1"', '"v1"']);
    expect(provider.objects.get("/cal/1.ics")).toEqual({ version: 2, summary: "Mine" });
    expect((await t.writes()).map((r) => [r.key, r.state])).toEqual([["press-once", "applied"]]);
  });

  it("hands a write of one account only that account's connection, and holds a row to its own account's calendar", async () => {
    const a = await account();
    const b = await account();
    await press(a.accountId, "a-press", update(a, "A's"));
    await press(b.accountId, "b-press", update(b, "B's"));
    // A second connection of A's account, with a write of its own.
    const [conn2] = await w.db.insert(calConnections).values({ accountId: a.accountId, provider: "google", label: "", status: "active" }).returning({ id: calConnections.id });
    const [cal2] = await w.db.insert(calCalendars).values({ accountId: a.accountId, connectionId: conn2!.id, providerId: "other-cal", name: "Other", access: "owner" }).returning({ id: calCalendars.id });
    await press(a.accountId, "a-press-2", { ...create(a), calendarId: cal2!.id });
    const writer = scriptedWriter("google");
    await run(a, writer, { tag: "A" });
    const seen = await Promise.all(writer.calls.map(async (c) => [c.kind, c.calendar, await (c.connection.credential as { accessToken(s: AbortSignal): Promise<{ token: string }> }).accessToken(never).then((t) => t.token)]));
    expect(seen).toEqual([["change", `cal-${a.accountId.slice(0, 6)}`, "token-A"]]);
    expect((await rows(b)).map((r) => r.state)).toEqual(["pending"]);
    // The store itself refuses a write row that names another account's calendar.
    const refused = await w.db.insert(calWrites).values({
      accountId: a.accountId, calendarId: b.calendarId, op: "update", payload: {}, idempotencyKey: "cross",
    }).then(() => "inserted", (err: { code?: string; cause?: { code?: string } }) => err.code ?? err.cause?.code ?? "threw");
    expect(refused).toBe("23503");
  });

  it("sends nothing while the account's calendar is off", async () => {
    const a = await account();
    await press(a.accountId, "press-off", update(a, "Off"));
    await w.db.update(calSettings).set({ enabledAt: null }).where(eq(calSettings.accountId, a.accountId));
    const writer = scriptedWriter("google");
    await run(a, writer);
    expect(writer.calls.length).toBe(0);
    expect((await rows(a)).map((r) => [r.state, r.attempts])).toEqual([["pending", 0]]);
  });

  it("waits out a provider's word for time, sends nothing of the connection meanwhile, and refuses after its last attempt", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "One"));
    const busy: WriteAnswer = { ok: false, reason: "throttled", retryAfterMs: 300_000 };
    const writer = scriptedWriter("google", { answer: () => busy });
    const first = await run(a, writer);
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);
    // A write recorded meanwhile waits behind it: nothing of the connection is sent before the wish has passed.
    await press(a.accountId, "press-new", create(a));
    await run(a, writer);
    expect(writer.calls.length).toBe(1);
    for (let i = 1; i < WRITE_MAX_ATTEMPTS; i++) {
      await dueNow(a);
      await run(a, writer);
    }
    expect(writer.calls.length).toBe(WRITE_MAX_ATTEMPTS);
    expect((await rows(a)).map((r) => [r.key, r.state, r.refusal])).toEqual([["press-1", "refused", "throttled"], ["press-new", "pending", null]]);
  });

  it("ends the turn where a provider asks a write to wait: nothing more of the connection is asked, a reading neither, and the connection says why until the wish has passed", async () => {
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "Kiln check"))] }]], ["t1", [{ items: [] }]]]) });
    const writer = scriptedWriter("caldav", { answer: () => ({ ok: false, reason: "throttled", retryAfterMs: 300_000 }) });
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    await recordWrite(w, { accountId: t.accountId, key: "press-1", act: retitle(await t.stored("/cal/1.ics"), "Mine") });
    await t.due();
    const asked = { reads: reader.calls.length, lists: reader.lists };
    const began = Date.now();
    expect(await t.turn()).toMatchObject({ kind: "backed_off", word: "throttled" });
    expect([writer.calls.length, reader.calls.length - asked.reads, reader.lists - asked.lists]).toEqual([1, 0, 0]);
    const held = await connectionOf(w, t.accountId, t.connectionId);
    expect(held.errorCode).toBe("throttled");
    expect(held.nextPollAt!.getTime()).toBeGreaterThanOrEqual(began + 299_000);
  });

  it("keeps a press that came while its connection's turn was reading: the turn's end leaves the connection due, not at its next regular reading", async () => {
    const script = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "Kiln check"))] }]], ["t1", [{ items: [] }]]]) });
    let during: (() => Promise<void>) | null = null;
    const reader: typeof script = Object.assign(Object.create(script) as typeof script, {
      async readChanges(...args: Parameters<typeof script.readChanges>) {
        const press = during;
        during = null;
        if (press !== null) await press();
        return script.readChanges(...args);
      },
    });
    const writer = scriptedWriter("caldav");
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    const event = await t.stored("/cal/1.ics");
    await recordWrite(w, { accountId: t.accountId, key: "press-1", act: retitle(event, "One") });
    // A second press arrives while the turn that carries the first is reading: recorded, and its connection woken.
    during = async () => {
      await recordWrite(w, { accountId: t.accountId, key: "press-2", act: retitle(event, "Two") });
      await w.db.update(calConnections).set({ nextPollAt: sql`now()` }).where(eq(calConnections.accountId, t.accountId));
    };
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(during).toBeNull();
    const [schedule] = await w.db.select({ due: sql<boolean>`${calConnections.nextPollAt} <= now()` })
      .from(calConnections).where(and(eq(calConnections.accountId, t.accountId), eq(calConnections.id, t.connectionId)));
    expect(schedule?.due).toBe(true);
    expect((await t.writes()).map((r) => [r.key, r.state])).toEqual([["press-1", "applied"], ["press-2", "pending"]]);
  });

  it("reads on after a write that waits only for the queue's own backoff, so a write's trouble never holds a calendar's reading", async () => {
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "Kiln check"))] }]], ["t1", [{ items: [] }]]]) });
    const writer = scriptedWriter("caldav", { answer: () => ({ ok: false, reason: "unavailable", retryAfterMs: null }) });
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    await recordWrite(w, { accountId: t.accountId, key: "press-1", act: retitle(await t.stored("/cal/1.ics"), "Mine") });
    await t.due();
    const reads = reader.calls.length;
    expect((await t.turn()).kind).toBe("synced");
    expect([writer.calls.length, reader.calls.length - reads]).toEqual([1, 1]);
    expect((await connectionOf(w, t.accountId, t.connectionId)).errorCode).toBeNull();
    expect((await t.writes()).map((r) => r.state)).toEqual(["pending"]);
  });

  it("gives an attempt back for a word that waits for the person, and answers a writer's throw as unknown without throwing", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "One"));
    const signedOut = scriptedWriter("google", { answer: () => ({ ok: false, reason: "consent_needed", retryAfterMs: null }) });
    await run(a, signedOut);
    expect((await rows(a)).map((r) => [r.state, r.attempts])).toEqual([["pending", 0]]);
    const throwing = scriptedWriter("google", { answer: () => { throw new Error("a fault of the program"); } });
    await expect(run(a, throwing)).resolves.toMatchObject({ nextAttemptAt: expect.any(Date) });
    expect((await rows(a)).map((r) => [r.state, r.attempts])).toEqual([["pending", 1]]);
  });

  it("refuses at once a write no writer can carry, and one too old to be sent late", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "One"));
    await run(a, null);
    expect((await rows(a)).map((r) => [r.state, r.refusal])).toEqual([["refused", "unsupported"]]);
    const b = await account();
    await press(b.accountId, "press-old", update(b, "Old"));
    await w.db.update(calWrites).set({ createdAt: sql`now() - interval '73 hours'` }).where(eq(calWrites.accountId, b.accountId));
    const writer = scriptedWriter("google");
    await run(b, writer);
    expect(writer.calls.length).toBe(0);
    expect((await rows(b)).map((r) => [r.state, r.refusal])).toEqual([["refused", "expired"]]);
  });

  it("starts no write once its own time is spent, and asks to be due again as long after", async () => {
    const a = await account();
    for (const k of ["p1", "p2", "p3"]) await press(a.accountId, k, create(a, k));
    let now = Date.now();
    const writer = scriptedWriter("google", { answer: (): "default" => { now += 6_000; return "default"; } });
    const asked = await run(a, writer, { clock: () => now, turnMs: 10_000 });
    expect(writer.calls.length).toBe(2);
    expect(asked.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(now + 12_000 - 1);
    expect((await rows(a)).map((r) => r.state)).toEqual(["applied", "applied", "pending"]);
  });

  it("lets a refused write go once its event is gone from the store, where no record carries it and the account's bound would count it for good", async () => {
    const reader = scriptedReader("caldav", { readings: new Map([
      ["", [{ items: [upsert("/cal/1.ics", '"v1"', single("u1", 18, "Kiln check"))] }]],
      ["t1", [{ items: [{ kind: "gone" as const, id: "/cal/1.ics" }] }]],
      ["t2", [{ items: [] }]],
    ]), endToken: (since) => (since === null ? "t1" : "t2") });
    const writer = scriptedWriter("caldav", { answer: () => ({ ok: false, reason: "event_gone", retryAfterMs: null }) });
    const t = await davAccount(reader, writer);
    expect((await t.turn()).kind).toBe("synced");
    await recordWrite(w, { accountId: t.accountId, key: "press-gone", act: retitle(await t.stored("/cal/1.ics"), "Mine") });
    // The provider answers that the event is gone, and the reading of that same turn removes it from the store.
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(await w.db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.accountId, t.accountId))).toEqual([]);
    expect((await t.writes()).map((r) => [r.key, r.state, r.refusal])).toEqual([["press-gone", "refused", "event_gone"]]);
    await t.due();
    expect((await t.turn()).kind).toBe("synced");
    expect(await t.writes()).toEqual([]);
    // At most a bound a turn, as the applied rows; a refused write whose event is there stays, for the person to see.
    const a = await account();
    await press(a.accountId, "press-kept", update(a, "Kept"));
    await w.db.update(calWrites).set({ state: "refused", refusal: "read_only" }).where(eq(calWrites.accountId, a.accountId));
    await w.db.insert(calWrites).values(Array.from({ length: WRITE_PRUNE_PER_TURN + 1 }, (_, i) => ({
      accountId: a.accountId, calendarId: a.calendarId, eventId: randomUUID(), op: "update", payload: {}, idempotencyKey: `gone-${i}`,
      state: "refused", refusal: "event_gone",
    })));
    await run(a, scriptedWriter("google"));
    expect((await rows(a)).length).toBe(2);
    await run(a, scriptedWriter("google"));
    expect((await rows(a)).map((r) => [r.key, r.state])).toEqual([["press-kept", "refused"]]);
  });

  it("throws where a close finds no row of its claim: a write is never closed quietly", async () => {
    const a = await account();
    await press(a.accountId, "press-1", update(a, "One"));
    const meddling = scriptedWriter("google", { answer: async (): Promise<"default"> => {
      await w.db.update(calWrites).set({ attempts: 5 }).where(eq(calWrites.accountId, a.accountId));
      return "default";
    } });
    await expect(run(a, meddling)).rejects.toThrow(/changed 0 rows/);
  });

  it("keeps a refused new event through a whole reading, which names only the provider's own objects", async () => {
    const t = await seedConnection(w, { provider: "caldav", credential: { kind: "basic", user: "mila", password: new Secret("pw-x") }, serverUrl: "http://127.0.0.1:1/dav/" });
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("/cal/1.ics", '"e1"', single("u1", 18, "Theirs"))] }]], ["t1", [{ items: [] }]]]) });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: { request: async () => ({ arrived: false, reason: "unknown" }) } } }));
    expect((await calendarSyncPass(deps, t.due, never)).kind).toBe("synced");
    const [cal] = await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, t.accountId));
    await recordWrite(w, { accountId: t.accountId, key: "press-new", act: { ...create({ calendarId: cal!.id } as Account), calendarId: cal!.id }, state: "refused", refusal: "read_only" });
    // A whole reading that names only the provider's own object.
    await w.db.update(calCalendars).set({ syncToken: null, nextPollAt: null }).where(eq(calCalendars.accountId, t.accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
    expect((await calendarSyncPass(deps, t.due, never)).kind).toBe("synced");
    const titles = async () => (await w.db.select({ title: calEvents.title }).from(calEvents).where(eq(calEvents.accountId, t.accountId)).orderBy(asc(calEvents.title))).map((e) => e.title);
    // What the person dismisses then goes with its delete: the door's own proof (`calendar-writes.pg.test.ts` in the services).
    expect(await titles()).toEqual(["Glaze firing", "Theirs"]);
  });

  it.each(["google", "microsoft", "caldav"] as const)("keeps an unproven recurring meeting from reaching %s", async word => {
    const a = await account(word);
    const made = create(a);
    const rule = "FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH;COUNT=4";
    await press(a.accountId, "chosen-meeting", { ...made,
      event: { ...made.event, start: { kind: "date", value: "20261117" }, end: { kind: "date", value: "20261118" }, repeat: rule } });
    const writer = scriptedWriter(word);
    await run(a, writer, { word });
    expect(writer.calls).toEqual([]);
    expect((await rows(a)).map(row => row.refusal)).toEqual(["repeat_unsupported"]);
  });

  it("sends a new series only in a shape its provider was proven to keep, from a start the rule names, and refuses every other, sending nothing", async () => {
    const zoned = (value: string) => ({ kind: "zoned", value, zone: "Europe/Zurich" });
    const series = (a: Account, title: string, repeat: string, start: unknown = zoned("20261123T090000"), end: unknown = zoned("20261123T100000")) => ({
      kind: "calendar_event_create", eventId: randomUUID(), calendarId: a.calendarId,
      event: { title, start, end, notes: null, place: null, callLink: null, busy: true, private: false, repeat, invitees: [], alarms: [] },
    });
    const dav = await account("caldav");
    const acts: [string, unknown][] = [
      ["weekly on its Monday", series(dav, "weekly on its Monday", "FREQ=WEEKLY;BYDAY=MO")],
      ["weekly on Tuesdays, from a Monday", series(dav, "weekly on Tuesdays, from a Monday", "FREQ=WEEKLY;BYDAY=TU")],
      ["daily at a time the zone skips in March", series(dav, "daily at a time the zone skips in March", "FREQ=DAILY", zoned("20261123T023000"), zoned("20261123T033000"))],
      ["ended on a day, from a clock time", series(dav, "ended on a day, from a clock time", "FREQ=DAILY;UNTIL=20261130")],
      ["in UTC", series(dav, "in UTC", "FREQ=WEEKLY", { kind: "instant", value: "20261123T080000Z" }, { kind: "instant", value: "20261123T090000Z" })],
      ["hourly", series(dav, "hourly", "FREQ=HOURLY;COUNT=3")],
    ];
    for (const [key, act] of acts) await press(dav.accountId, key, act);
    // The shipped table proves nothing at this account's server, which is not the bench's: nothing leaves, each with its word.
    const unproven = scriptedWriter("caldav");
    await run(dav, unproven, { word: "caldav" });
    expect([unproven.calls, Object.values(Object.fromEntries((await rows(dav)).map((r) => [r.key, `${r.state} ${r.refusal}`])))]).toEqual([[], acts.map(() => "refused repeat_unsupported")]);
    await w.db.update(calWrites).set({ state: "pending", refusal: null, attempts: 0, nextAttemptAt: null }).where(eq(calWrites.accountId, dav.accountId));
    // This account's server taken as the bench's own, where the proof was run: its row is the bench's.
    const writer = scriptedWriter("caldav");
    await run(dav, writer, { word: "caldav", proven: { [proofPlaceOf("caldav", DAV_URL)!]: PROVEN_REPEATS[BENCH_CALDAV_PLACE]! } });
    expect(writer.calls.map((c) => [c.kind, c.draft?.summary, c.draft?.rule === null ? null : "a rule"])).toEqual([["create", "weekly on its Monday", "a rule"]]);
    expect(Object.fromEntries((await rows(dav)).map((r) => [r.key, [r.state, r.refusal]]))).toEqual({
      "weekly on its Monday": ["applied", null],
      "weekly on Tuesdays, from a Monday": ["refused", "repeat_unsupported"],
      "daily at a time the zone skips in March": ["refused", "repeat_unsupported"],
      "ended on a day, from a clock time": ["refused", "repeat_unsupported"],
      "in UTC": ["refused", "repeat_unsupported"],
      hourly: ["refused", "repeat_unsupported"],
    });
    // Google's row is empty until its proof is run at the test account: the same series is refused there, and nothing leaves.
    const google = await account("google");
    await press(google.accountId, "google-weekly", series(google, "weekly on its Monday", "FREQ=WEEKLY;BYDAY=MO"));
    const quiet = scriptedWriter("google");
    await run(google, quiet);
    expect([quiet.calls.length, (await rows(google)).map((r) => [r.state, r.refusal])]).toEqual([0, [["refused", "repeat_unsupported"]]]);
  });

  it("writes nothing of a whole series at a provider whose proven row holds none of its shapes: each act on it is refused with its word", async () => {
    const google = await account("google");
    const [row] = await w.db.insert(calEvents).values({
      accountId: google.accountId, calendarId: google.calendarId, providerId: "evt-series", versionTag: '"s1"', uid: "series@google.example", title: "Weekly kiln",
      startKind: "zoned", startLocal: "20261123T090000", startZone: "Europe/Zurich", endKind: "zoned", endLocal: "20261123T100000", endZone: "Europe/Zurich",
      startsAt: new Date("2026-11-23T08:00:00Z"), endsAt: null, repeatRule: "FREQ=WEEKLY;BYDAY=MO",
    }).returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    const on = { eventId: row!.id, base: row!.updatedAt.toISOString() };
    await press(google.accountId, "retitle", { kind: "calendar_event_update", ...on, scope: { kind: "record" }, change: { title: "Weekly kiln, glazes" } });
    await press(google.accountId, "remove", { kind: "calendar_event_delete", ...on, scope: { kind: "record" } });
    const quiet = scriptedWriter("google");
    await run(google, quiet);
    expect(quiet.calls.length).toBe(0);
    expect((await rows(google)).map((r) => [r.key, r.state, r.refusal])).toEqual([["retitle", "refused", "repeat_unsupported"], ["remove", "refused", "repeat_unsupported"]]);
  });

  it("is where a turn sends its writes: after the sign-in, before the reading, and never with the calendar off", async () => {
    const t = await seedConnection(w, { provider: "caldav", credential: { kind: "basic", user: "mila", password: new Secret("pw-y") }, serverUrl: "http://127.0.0.1:1/dav/" });
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("/cal/1.ics", '"e1"', single("u1", 18, "Theirs"))] }]], ["t1", [{ items: [] }]]]) });
    const writer = scriptedWriter("caldav");
    const http = { request: async () => ({ arrived: false as const, reason: "unknown" as const }) };
    const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log });
    const deps = depsFor(w, providersOf({ caldav: { reader, writer, http } }), { drainWrites: drain });
    expect((await calendarSyncPass(deps, t.due, never)).kind).toBe("synced");
    const [cal] = await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, t.accountId));
    await recordWrite(w, { accountId: t.accountId, key: "press-turn", act: { ...create({ calendarId: cal!.id } as Account), calendarId: cal!.id } });
    await w.db.update(calSettings).set({ enabledAt: null }).where(eq(calSettings.accountId, t.accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
    expect((await calendarSyncPass(deps, t.due, never)).kind).toBe("off");
    expect(writer.calls.length).toBe(0);
    await w.db.update(calSettings).set({ enabledAt: new Date() }).where(eq(calSettings.accountId, t.accountId));
    await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
    expect((await calendarSyncPass(deps, t.due, never)).kind).toBe("synced");
    expect(writer.calls.map((c) => c.kind)).toEqual(["create"]);
    expect((await w.db.select({ state: calWrites.state }).from(calWrites).where(eq(calWrites.accountId, t.accountId))).map((r) => r.state)).toEqual(["applied"]);
  });
});
