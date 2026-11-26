import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, type HttpPort } from "@ohmail/cal-providers";
import { makeReader as googleReader } from "@ohmail/cal-providers/google";
import { makeReader as outlookReader } from "@ohmail/cal-providers/microsoft";
import { calAttendees, calCalendars, calConnections, calEvents, calWrites, mailboxes } from "@trafficflow/db";
import { dbFor, type Db } from "@trafficflow/services";
import { calendarFeed, recordCalendarWrite } from "@trafficflow/services/calendar";
import { keepCalendarConnection, signInCalendarAgain } from "@trafficflow/services/calendar-connect";
import { calendarSyncPass } from "@ohmail/organizer/calendar-sync-pass";
import { calendarWriteDrain } from "@ohmail/organizer/calendar/write-drain";
import {
  AVAILABLE,
  ZONES,
  capturedLog,
  changesOf,
  depsFor,
  eq,
  openWorld,
  providersOf,
  recordWrite,
  scriptedReader,
  scriptedWriter,
  seedConnection,
  silentHttp,
  single,
  upsert,
  type World,
} from "../packages/organizer/test/_calendar-world.js";

const signal = new AbortController().signal;
const start = "https://dav.example.test/dav/";
const original = `${start}principals/first/`;
const login = "calendar-user";
const policy = {
  policy: "cloud",
  ceremonies: {
    google: { on: true, configured: true },
    microsoft: { on: false, configured: false },
  },
} as const;

describe.skipIf(!AVAILABLE)("the calendar connection's verified identity", () => {
  let w: World;
  beforeAll(async () => {
    w = await openWorld();
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  const ctxOf = (accountId: string) => ({
    accountId,
    db: dbFor(w.db as unknown as Db, accountId),
    now: () => new Date(),
    requestId: "calendar-test",
    userId: null,
  });

  it.each(["google", "microsoft"] as const)(
    "uses the primary %s identity and repairs the own answer on an unchanged revision",
    async (provider) => {
      const account = await seedConnection(w, { provider, credential: null });
      const { accountId } = account;
      const id = randomUUID();
      const ctx = ctxOf(accountId);
      const principal = ["calendar", "example.test"].join("@");
      const mailboxesOwned = ["mail", "other-mail"].map((user) => [user, "example.test"].join("@"));
      for (const address of mailboxesOwned)
        await w.db.insert(mailboxes).values({ accountId, provider: "imap", address, status: "connected" });
      await keepCalendarConnection(
        ctx,
        w.keys,
        { id, provider, serverUrl: null, sourceHost: null },
        {
          credential: { kind: "oauth", provider, refreshToken: new Secret("fixture-grant") },
        },
      );

      const due = { ...account.due, id };
      let primary = false;
      let lists = 0;
      const host = ["host", "example.test"].join("@");
      const http: HttpPort = {
        async request(url) {
          const path = new URL(url).pathname;
          const listing = path.endsWith("/calendarList") || path.endsWith("/calendars");
          if (listing) lists += 1;
          const body = path.endsWith("/token")
            ? { access_token: "fixture-bearer", expires_in: 3600 }
            : provider === "google"
              ? listing
                ? { items: [{ id: principal, primary, accessRole: "owner" }] }
                : {
                    items: [
                      {
                        id: "meeting",
                        etag: "same-revision",
                        iCalUID: "meeting",
                        summary: "Project planning",
                        start: { dateTime: "2026-11-17T09:00:00Z" },
                        end: { dateTime: "2026-11-17T10:00:00Z" },
                        organizer: { email: host },
                        attendees: [
                          { email: principal, self: true, responseStatus: "accepted" },
                          ...mailboxesOwned.map((email) => ({ email, responseStatus: "needsAction" })),
                        ],
                      },
                    ],
                    nextSyncToken: "inventory-read",
                  }
              : listing
                ? {
                    value: [
                      {
                        id: "calendar",
                        isDefaultCalendar: primary,
                        canEdit: true,
                        owner: { address: principal },
                      },
                    ],
                  }
                : {
                    value: [
                      {
                        id: "meeting",
                        changeKey: "same-revision",
                        iCalUId: "meeting",
                        type: "singleInstance",
                        isOrganizer: false,
                        subject: "Project planning",
                        start: { dateTime: "2026-11-17T09:00:00", timeZone: "UTC" },
                        end: { dateTime: "2026-11-17T10:00:00", timeZone: "UTC" },
                        organizer: { emailAddress: { address: host } },
                        responseStatus: { response: "accepted" },
                        attendees: [principal, ...mailboxesOwned].map((address) => ({
                          emailAddress: { address },
                          type: "required",
                          status: { response: "none" },
                        })),
                      },
                    ],
                    "@odata.deltaLink": url,
                  };
          return {
            arrived: true,
            status: 200,
            body: new TextEncoder().encode(JSON.stringify(body)),
            header: () => null,
            location: null,
            url,
            hops: 0,
          };
        },
      };
      const clock = { now: Date.now };
      const readerDeps = { http, zones: ZONES, clock };
      const reader =
        provider === "google"
          ? googleReader(readerDeps)
          : outlookReader({ ...readerDeps, graphBase: "https://graph.example.test/v1.0" });
      const writer = scriptedWriter(provider);
      const replies: { attendeeMatches: boolean; reply: string }[] = [];
      const providerWriter = {
        ...writer,
        async answer(...args: Parameters<NonNullable<typeof writer.answer>>) {
          const [, , , request] = args;
          replies.push({ attendeeMatches: request.as === principal, reply: request.reply });
          return { ok: true as const, items: [], written: true as const };
        },
      };
      let ambiguityBeforeClaim = false;
      const drain = calendarWriteDrain({ clock, zones: ZONES, log: capturedLog().log });
      const run = () =>
        calendarSyncPass(
          depsFor(w, providersOf({ [provider]: { reader, writer: providerWriter, http } }), {
            oauth: {
              google: { clientId: "calendar-fixture", clientSecret: "fixture-registration" },
              microsoft: async () => ({
                clientId: "calendar-fixture",
                clientSecret: "fixture-registration",
                defaultTenant: "common",
                kind: "confidential",
              }),
            },
            drainWrites: async (input) => {
              if (ambiguityBeforeClaim)
                await w.db
                  .update(calConnections)
                  .set({ organizerAddresses: [] })
                  .where(eq(calConnections.id, id));
              return drain(input);
            },
          }),
          due,
          signal,
        );
      const event = async () =>
        (
          await w.db
            .select({ id: calEvents.id, version: calEvents.versionTag, answer: calEvents.myAnswer })
            .from(calEvents)
            .where(eq(calEvents.accountId, accountId))
        )[0];

      expect(await run()).toMatchObject({ kind: "synced", calendars: 1 });
      const before = await event();
      expect(before).toMatchObject({ answer: null, version: "same-revision" });
      primary = true;
      await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.connectionId, id));
      expect(await run()).toMatchObject({ kind: "synced", calendars: 1 });
      const [stored] = await w.db
        .select({ principal: calConnections.principal })
        .from(calConnections)
        .where(eq(calConnections.id, id));
      expect(stored?.principal === principal).toBe(true);
      expect(await event()).toEqual({ ...before, answer: "accepted" });
      expect(lists).toBe(2);

      const [target] = await w.db
        .select({ id: calEvents.id, base: calEvents.updatedAt, calendarId: calEvents.calendarId })
        .from(calEvents)
        .where(eq(calEvents.accountId, accountId));
      expect(target).toBeDefined();
      const write = await recordCalendarWrite(ctx, "answer-primary", {
        kind: "calendar_event_answer",
        eventId: target!.id,
        base: target!.base.toISOString(),
        scope: { kind: "record" },
        answer: "tentative",
        copy: { calendarId: target!.calendarId, attendee: principal },
      });
      expect(write.answer.write.state).toBe("pending");
      expect(await run()).toMatchObject({ kind: "synced" });
      expect(replies).toEqual([{ attendeeMatches: true, reply: "TENTATIVE" }]);
      const [latest] = await w.db
        .select({ base: calEvents.updatedAt })
        .from(calEvents)
        .where(eq(calEvents.id, target!.id));
      const later = await recordCalendarWrite(ctx, "decline-primary", {
        kind: "calendar_event_answer",
        eventId: target!.id,
        base: latest!.base.toISOString(),
        scope: { kind: "record" },
        answer: "declined",
        copy: { calendarId: target!.calendarId, attendee: principal },
      });
      expect(later.answer.write.state).toBe("pending");
      ambiguityBeforeClaim = true;
      expect(await run()).toMatchObject({ kind: "synced" });
      expect(replies).toHaveLength(1);
      const [queued] = await w.db
        .select({ state: calWrites.state })
        .from(calWrites)
        .where(eq(calWrites.id, later.answer.write.id));
      expect(queued?.state).toBe("pending");
    },
  );

  it("keeps a legacy invitation readable when an OAuth listing cannot verify the attendee", async () => {
    const attendee = ["mail", "example.test"].join("@");
    const organizer = ["host", "example.test"].join("@");
    const seeded = await seedConnection(w, {
      provider: "google",
      mailboxAddress: attendee,
      credential: { kind: "oauth", provider: "google", refreshToken: new Secret("fixture-grant") },
    });
    const { accountId, connectionId } = seeded;
    const ctx = ctxOf(accountId);
    const [calendar] = await w.db
      .insert(calCalendars)
      .values({
        accountId,
        connectionId,
        providerId: "calendar",
        name: "Calendar",
        access: "owner",
        syncToken: "old",
        nextPollAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: calCalendars.id });
    const [event] = await w.db
      .insert(calEvents)
      .values({
        accountId,
        calendarId: calendar!.id,
        providerId: "meeting",
        uid: "meeting",
        versionTag: "v1",
        title: "Project planning",
        startKind: "instant",
        startLocal: "20261117T090000Z",
        startsAt: new Date("2026-11-17T09:00:00Z"),
        endKind: "instant",
        endLocal: "20261117T100000Z",
        endsAt: new Date("2026-11-17T10:00:00Z"),
        organizer,
        myAnswer: "none",
      })
      .returning({ id: calEvents.id, updatedAt: calEvents.updatedAt });
    await w.db
      .insert(calAttendees)
      .values({ accountId, eventId: event!.id, role: "required", address: attendee, answer: "none" });
    const build = async () =>
      (await calendarFeed.build(ctx.db, accountId, "calendar_event", [event!.id])).get(event!.id);
    expect(await build()).toMatchObject({ myAnswer: "none" });
    const before = (await changesOf(w, accountId))["calendar_event:update"] ?? 0;
    const reader = scriptedReader("google", { readings: new Map() });
    reader.listCalendars = async () => ({
      ok: true,
      principal: null,
      value: [
        {
          id: "calendar",
          name: "Calendar",
          color: null,
          writable: true,
          owned: true,
          byToken: true,
          zone: null,
        },
      ],
    });
    const deps = depsFor(w, providersOf({ google: { reader, http: silentHttp() } }), {
      oauth: {
        google: { clientId: "calendar-fixture", clientSecret: "fixture-registration" },
        microsoft: null,
      },
    });

    expect(await calendarSyncPass(deps, seeded.due, signal)).toMatchObject({ kind: "synced" });
    expect(await build()).toMatchObject({ title: "Project planning", myAnswer: null });
    expect((await changesOf(w, accountId))["calendar_event:update"]).toBe(before + 1);
    expect(reader.calls).toHaveLength(0);
    await expect(
      recordCalendarWrite(ctx, "old-answer-button", {
        kind: "calendar_event_answer",
        eventId: event!.id,
        base: event!.updatedAt.toISOString(),
        scope: { kind: "record" },
        answer: "accepted",
      }),
    ).rejects.toMatchObject({ code: "calendar_read_only" });
    expect(
      await w.db.select({ id: calWrites.id }).from(calWrites).where(eq(calWrites.accountId, accountId)),
    ).toEqual([]);
  });

  it("discards an in-flight CalDAV reading when its login is rotated", async () => {
    const credential = {
      kind: "basic" as const,
      server: start,
      user: login,
      password: new Secret("fixture-first"),
    };
    const seeded = await seedConnection(w, {
      provider: "caldav",
      credential,
      serverUrl: start,
      principal: original,
    });
    const reader = scriptedReader("caldav", {
      readings: new Map([["", [{ items: [upsert("first.ics", "v1", single("first", 17))] }]]]),
    });
    reader.checkSignIn = async () => ({ ok: true, value: { principal: original, addresses: [] } });
    const readChanges = reader.readChanges.bind(reader);
    reader.readChanges = async (...args) => {
      const page = await readChanges(...args);
      await signInCalendarAgain(
        ctxOf(seeded.accountId),
        { port: policy, keys: w.keys },
        seeded.connectionId,
        { user: login, password: randomUUID() },
      );
      return page;
    };
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    expect(await calendarSyncPass(deps, seeded.due, signal)).toEqual({ kind: "superseded" });
    expect((await changesOf(w, seeded.accountId))["calendar_event:create"]).toBeUndefined();
    const [calendar] = await w.db
      .select({ token: calCalendars.syncToken })
      .from(calCalendars)
      .where(eq(calCalendars.connectionId, seeded.connectionId));
    expect(calendar?.token).toBeNull();

    reader.readChanges = readChanges;
    expect(await calendarSyncPass(deps, seeded.due, signal)).toMatchObject({ kind: "synced", calendars: 1 });
    expect((await changesOf(w, seeded.accountId))["calendar_event:create"]).toBe(1);
  });
  it("stops before listing or draining if the stored CalDAV principal does not match discovery", async () => {
    const credential = {
      kind: "basic" as const,
      server: start,
      user: login,
      password: new Secret("fixture-first"),
    };
    const seeded = await seedConnection(w, {
      provider: "caldav",
      credential,
      serverUrl: start,
      principal: original,
    });
    const reader = scriptedReader("caldav", { readings: new Map() });
    reader.checkSignIn = async () => ({
      ok: true,
      value: { principal: `${start}principals/second/`, addresses: [] },
    });
    let drains = 0;
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }), {
      drainWrites: async () => {
        drains += 1;
        return { nextAttemptAt: null };
      },
    });
    expect(await calendarSyncPass(deps, seeded.due, signal)).toEqual({
      kind: "stopped",
      word: "sign_in_refused",
    });
    expect([reader.lists, reader.calls.length, drains]).toEqual([0, 0, 0]);
    const [held] = await w.db
      .select({ principal: calConnections.principal })
      .from(calConnections)
      .where(eq(calConnections.id, seeded.connectionId));
    expect(held?.principal).toBe(original);
  });

  it("requires separate principal evidence when a CalDAV host changes", async () => {
    const shifted = "https://other-dav.example.test/dav/principals/first/";
    const alias = ["calendar", "example.test"].join("@");
    async function discovered(addresses: readonly string[]) {
      const credential = {
        kind: "basic" as const,
        server: start,
        user: login,
        password: new Secret("fixture-first"),
      };
      const seeded = await seedConnection(w, {
        provider: "caldav",
        credential,
        serverUrl: start,
        principal: original,
      });
      await w.db
        .update(calConnections)
        .set({ organizerAddresses: [alias] })
        .where(eq(calConnections.id, seeded.connectionId));
      const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [] }]]]) });
      reader.checkSignIn = async () => ({ ok: true, value: { principal: shifted, addresses } });
      const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
      return calendarSyncPass(deps, seeded.due, signal);
    }
    expect(await discovered([])).toEqual({ kind: "stopped", word: "sign_in_refused" });
    expect(await discovered([alias])).toMatchObject({ kind: "synced", calendars: 1 });
  });

  it("keeps a claimed edit pending when the CalDAV password changes before settlement", async () => {
    const credential = {
      kind: "basic" as const,
      server: start,
      user: login,
      password: new Secret("fixture-first"),
    };
    const seeded = await seedConnection(w, { provider: "caldav", credential, serverUrl: start });
    const item = upsert("first.ics", "v1", single("first", 17, "Original meeting"));
    const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [item] }]]]) });
    reader.checkSignIn = async () => ({ ok: true, value: { principal: original, addresses: [] } });
    const writer = scriptedWriter("caldav", {
      answer: async () => {
        await signInCalendarAgain(
          ctxOf(seeded.accountId),
          { port: policy, keys: w.keys },
          seeded.connectionId,
          {
            user: login,
            password: randomUUID(),
          },
        );
        return {
          ok: true,
          items: [upsert("first.ics", "v2", single("first", 17, "Provider response"))],
          written: true,
        };
      },
    });
    const deps = depsFor(w, providersOf({ caldav: { reader, writer, http: silentHttp() } }), {
      drainWrites: calendarWriteDrain({ clock: { now: Date.now }, zones: ZONES, log: capturedLog().log }),
    });
    const run = () => calendarSyncPass(deps, seeded.due, signal);
    const read = async () =>
      (
        await w.db
          .select({
            id: calEvents.id,
            base: calEvents.updatedAt,
            title: calEvents.title,
            version: calEvents.versionTag,
          })
          .from(calEvents)
          .where(eq(calEvents.accountId, seeded.accountId))
      )[0];
    expect(await run()).toMatchObject({ kind: "synced", calendars: 1 });
    const event = await read();
    if (!event) throw new Error("the first reading did not store the event");
    const pressed = await recordWrite(w, {
      accountId: seeded.accountId,
      key: "edit-fixture",
      act: {
        kind: "calendar_event_update",
        eventId: event.id,
        base: event.base.toISOString(),
        scope: { kind: "record" },
        change: { title: "Provider response" },
      },
    });
    expect(await run()).toEqual({ kind: "superseded" });
    expect(writer.calls.map((call) => call.kind)).toEqual(["change"]);
    expect(await read()).toEqual(event);
    const [write] = await w.db
      .select({ state: calWrites.state })
      .from(calWrites)
      .where(eq(calWrites.id, pressed.id));
    expect(write?.state).toBe("pending");
  });
});
