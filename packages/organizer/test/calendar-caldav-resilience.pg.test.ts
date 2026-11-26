import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { MAX_UID_CHARS } from "@ohmail/cal-core";
import { makeReader, makeWriter } from "@ohmail/cal-providers/caldav";
import { namedHostRequest, textOf, type HttpPort } from "@ohmail/cal-providers/request";
import { calCalendars, calConnections, calEvents, calWrites } from "@trafficflow/db";
import { startCalDavStandIn, type StandIn } from "../../cal-providers/test/caldav-stand-in.js";
import { newCalendarSyncMemory } from "../src/calendar/index.js";
import { calendarSyncPass } from "../src/calendar/sync-pass.js";
import { calendarWriteDrain } from "../src/calendar/write-drain.js";
import {
  AVAILABLE,
  Secret,
  ZONES,
  calendarsOf,
  capturedLog,
  changesOf,
  depsFor,
  eventsOf,
  openWorld,
  providersOf,
  recordWrite,
  seedConnection,
  type World,
} from "./_calendar-world.js";

const never = new AbortController().signal;
const clock = { now: () => Date.now() };
const network = namedHostRequest({
  writes: true,
  resolver: { resolve: async () => [] },
  policy: { kind: "own-network" },
});
const encoder = new TextEncoder();

function event(uid: string, title: string, day: number, originalDay?: number): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261101T000000Z",
    `DTSTART:202611${day}T090000Z`,
    `DTEND:202611${day}T100000Z`,
    `SUMMARY:${title}`,
    ...(originalDay === undefined ? [] : [`RECURRENCE-ID:202611${originalDay}T090000Z`]),
    "END:VEVENT",
  ];
}

function calendar(...events: string[][]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calendar fixture//EN",
    ...events.flat(),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("CalDAV incomplete reads and concurrent edits", () => {
  let w: World;
  const servers: StandIn[] = [];
  beforeAll(async () => {
    w = await openWorld();
  }, 120_000);
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });
  afterAll(async () => {
    await w?.close();
  });

  async function account(wrap: (server: StandIn) => HttpPort = () => network, writes = false) {
    const server = await startCalDavStandIn();
    servers.push(server);
    server.addCalendar("work");
    const seeded = await seedConnection(w, {
      provider: "caldav",
      serverUrl: `http://127.0.0.1:${server.port}/`,
      credential: { kind: "basic", user: server.options.user, password: new Secret(server.options.password) },
    });
    const http = wrap(server);
    const adapter = { clock, http, zones: ZONES };
    const reader = makeReader(adapter);
    const writer = makeWriter(adapter);
    const deps = depsFor(
      w,
      providersOf({ caldav: { reader, writer, http } }),
      writes ? { drainWrites: calendarWriteDrain({ clock, zones: ZONES, log: capturedLog().log }) } : {},
    );
    const turn = async (restart = false) => {
      await w.db
        .update(calCalendars)
        .set({ nextPollAt: null })
        .where(eq(calCalendars.accountId, seeded.accountId));
      await w.db
        .update(calConnections)
        .set({ nextPollAt: null })
        .where(eq(calConnections.accountId, seeded.accountId));
      return calendarSyncPass(
        restart ? { ...deps, memory: newCalendarSyncMemory() } : deps,
        seeded.due,
        never,
      );
    };
    return { ...seeded, server, turn };
  }

  it.each([
    "missing sync token",
    "blank sync token",
    "duplicate sync token",
    "member without an address",
    "conflicting member statuses",
    "duplicate member",
    "an implicitly closed element",
    "an unbound namespace",
    "an unquoted namespace",
    "an invalid XML character",
    "an invalid member address",
    "empty tag inventory",
    "incomplete multiget",
    "bad calendar data beside a member removal",
  ] as const)("preserves a live event when CalDAV returns %s", async (failure) => {
    let degraded = false;
    const t = await account((server) => ({
      async request(url, req) {
        const response = await network.request(url, req);
        if (!response.arrived) return response;
        if (failure === "empty tag inventory" && req.body?.includes("sync-collection"))
          return { ...response, status: 405 };
        if (!degraded) return response;
        const member = server.paths.member("work", "first.ics");
        const dav = (contents: string) =>
          encoder.encode(`<multistatus xmlns="DAV:">${contents}</multistatus>`);
        const token = "<sync-token>sync-malformed-fixture</sync-token>";
        const gone = `<response><href>${member}</href><status>HTTP/1.1 404 Not Found</status></response>`;
        const malformedMultiget =
          failure === "incomplete multiget" || failure === "bad calendar data beside a member removal";
        if (req.body?.includes("calendar-multiget") && malformedMultiget) {
          const bad =
            failure === "incomplete multiget"
              ? "<response><status>HTTP/1.1 200 OK</status></response>"
              : `<response><href>${server.paths.member("work", "second.ics")}</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${String.fromCharCode(0)}</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
          return { ...response, body: dav(gone + bad) };
        }
        if (req.body?.includes("sync-collection") && !malformedMultiget) {
          if (failure === "empty tag inventory") return response;
          if (failure === "an unquoted namespace")
            return { ...response, body: encoder.encode(`<multistatus xmlns=DAV:>${token}</multistatus>`) };
          const bodies = {
            "missing sync token": "",
            "blank sync token": "<sync-token> </sync-token>",
            "duplicate sync token": token + token,
            "member without an address": token + "<response><status>HTTP/1.1 200 OK</status></response>",
            "conflicting member statuses":
              token + gone.replace("<status>", "<status>HTTP/1.1 200 OK</status><status>"),
            "duplicate member":
              token + `<response><href>${member}</href><status>HTTP/1.1 200 OK</status></response>` + gone,
            "an implicitly closed element": token + "<extension>",
            "an unbound namespace": token + `<X:response><X:href>${member}</X:href></X:response>`,
            "an invalid XML character": token + `<!--${String.fromCharCode(0)}-->`,
            "an invalid member address":
              token + "<response><href>mailto:fixture</href><status>HTTP/1.1 200 OK</status></response>",
          };
          return { ...response, body: dav(bodies[failure]) };
        }
        if (
          failure === "empty tag inventory" &&
          req.method === "PROPFIND" &&
          req.headers.depth === "1" &&
          new URL(url).pathname === server.paths.collection("work")
        ) {
          return { ...response, body: dav("") };
        }
        return response;
      },
    }));
    t.server.put("work", "first.ics", calendar(event("first", "Live event", 18)), '"first-1"');
    expect(await t.turn()).toMatchObject({ kind: "synced" });
    await w.db.update(calCalendars).set({ syncToken: null }).where(eq(calCalendars.accountId, t.accountId));
    await w.db
      .update(calEvents)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(calEvents.accountId, t.accountId));
    degraded = true;
    await t.turn(true);
    expect
      .soft((await calendarsOf(w, t.accountId))[0])
      .toMatchObject({ syncToken: null, errorCode: "unreadable" });
    expect.soft((await eventsOf(w, t.accountId)).map((row) => row.title)).toEqual(["Live event"]);
    expect.soft((await changesOf(w, t.accountId))["calendar_event:delete"] ?? 0).toBe(0);

    degraded = false;
    t.server.remove("work", "first.ics");
    expect(await t.turn(true)).toMatchObject({ kind: "synced", dropped: 1 });
    expect(await eventsOf(w, t.accountId)).toHaveLength(0);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(1);
  });

  it.each(["missing multiget", "unavailable multiget", "unavailable listing"] as const)(
    "recovers a changed member after restart with %s",
    async (failure) => {
      let degraded = false;
      const t = await account((server) => ({
        async request(url, req) {
          const response = await network.request(url, req);
          const report = failure === "unavailable listing" ? "sync-collection" : "calendar-multiget";
          if (!degraded || !response.arrived || response.status !== 207 || !req.body?.includes(report))
            return response;
          const path = server.paths.member("work", "second.ics");
          const second = `<response><href>${path}</href>`;
          const body = textOf(response.body);
          const at = body.indexOf(second);
          if (at < 0) throw new Error("missing second member in fixture response");
          const end = body.indexOf("</response>", at) + "</response>".length;
          const replacement =
            failure === "missing multiget"
              ? ""
              : `${second}<status>HTTP/1.1 503 Unavailable</status></response>`;
          return { ...response, body: encoder.encode(body.slice(0, at) + replacement + body.slice(end)) };
        },
      }));
      t.server.put("work", "first.ics", calendar(event("first", "First", 18)), '"first-1"');
      t.server.put("work", "second.ics", calendar(event("second", "Second", 19)), '"second-1"');
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      const original = (await calendarsOf(w, t.accountId))[0]?.syncToken;
      expect(original).toBeTruthy();

      t.server.put("work", "first.ics", calendar(event("first", "First moved", 20)), '"first-2"');
      t.server.put("work", "second.ics", calendar(event("second", "Second moved", 21)), '"second-2"');
      degraded = true;
      await t.turn();
      expect.soft((await calendarsOf(w, t.accountId))[0]?.syncToken).toBe(original);
      expect.soft((await eventsOf(w, t.accountId)).map((row) => row.title)).toEqual(["First", "Second"]);

      degraded = false;
      expect(await t.turn(true)).toMatchObject({ kind: "synced" });
      expect((await calendarsOf(w, t.accountId))[0]?.syncToken).not.toBe(original);
      expect
        .soft((await eventsOf(w, t.accountId)).map((row) => row.title))
        .toEqual(["First moved", "Second moved"]);
      expect.soft((await changesOf(w, t.accountId))["calendar_event:update"]).toBe(2);
      expect(await t.turn(true)).toMatchObject({ kind: "synced", changed: 0 });
      expect((await changesOf(w, t.accountId))["calendar_event:update"]).toBe(2);

      t.server.remove("work", "second.ics");
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      expect((await eventsOf(w, t.accountId)).map((row) => row.title)).toEqual(["First moved"]);
    },
  );

  it("keeps unread moved days until a complete CalDAV member authorizes their removal", async () => {
    const t = await account();
    const uid = "series";
    const master = (title: string) => {
      const base = event(uid, title, 18);
      base.splice(-1, 0, "RRULE:FREQ=DAILY;COUNT=5");
      return base;
    };
    const unread = event("x".repeat(MAX_UID_CHARS + 1), "Third day", 23, 20);
    t.server.put(
      "work",
      "series.ics",
      calendar(master("Series"), event(uid, "Second moved", 22, 19), event(uid, "Third moved", 23, 20)),
      '"initial"',
    );
    expect(await t.turn()).toMatchObject({ kind: "synced" });
    const rows = () =>
      w.db
        .select({ title: calEvents.title, partial: calEvents.partial, version: calEvents.versionTag })
        .from(calEvents)
        .where(eq(calEvents.accountId, t.accountId))
        .orderBy(asc(calEvents.recurrenceId));
    expect((await rows()).map(({ title }) => title)).toEqual(["Series", "Second moved", "Third moved"]);

    t.server.put(
      "work",
      "series.ics",
      calendar(master("Series revised"), event(uid, "Second revised", 22, 19), unread),
      '"partial"',
    );
    await t.turn();
    expect.soft(await rows()).toMatchObject([
      { title: "Series revised", partial: true },
      { title: "Second revised", partial: true },
      { title: "Third moved", partial: true },
    ]);
    expect.soft((await changesOf(w, t.accountId))["calendar_event:delete"] ?? 0).toBe(0);

    t.server.put(
      "work",
      "series.ics",
      calendar(master("Series revised"), event(uid, "Second revised", 22, 19)),
      '"complete"',
    );
    expect(await t.turn(true)).toMatchObject({ kind: "synced" });
    expect(await rows()).toEqual([
      { title: "Series revised", partial: false, version: '"complete"' },
      { title: "Second revised", partial: false, version: '"complete"' },
    ]);
    expect((await changesOf(w, t.accountId))["calendar_event:delete"]).toBe(1);
  });

  it.each(["external revision", "matching response tag", "matching headerless body"] as const)(
    "rebases a follow-up edit only on the written copy (%s)",
    async (outcome) => {
      const tags: (string | undefined)[] = [];
      const t = await account(
        (server) => ({
          async request(url, req) {
            const response = await network.request(url, req);
            if (req.method !== "PUT") return response;
            tags.push(req.precondition?.kind === "unchanged" ? req.precondition.tag : undefined);
            if (tags.length !== 1 || !response.arrived) return response;
            if (outcome === "external revision")
              server.put("work", "event.ics", calendar(event("entry", "External title", 18)), '"external"');
            if (outcome === "matching response tag") return response;
            return {
              ...response,
              header: (name) => (name.toLowerCase() === "etag" ? null : response.header(name)),
            };
          },
        }),
        true,
      );
      t.server.put("work", "event.ics", calendar(event("entry", "Original", 18)), '"original"');
      expect(await t.turn()).toMatchObject({ kind: "synced" });
      const [stored] = await w.db
        .select({ id: calEvents.id, at: calEvents.updatedAt })
        .from(calEvents)
        .where(eq(calEvents.accountId, t.accountId));
      if (stored === undefined) throw new Error("missing mirrored event");
      const edit = (title: string) => ({
        kind: "calendar_event_update",
        eventId: stored.id,
        base: stored.at.toISOString(),
        scope: { kind: "record" },
        change: { title },
      });
      const first = await recordWrite(w, { accountId: t.accountId, key: "first", act: edit("First title") });
      const second = await recordWrite(w, {
        accountId: t.accountId,
        key: "second",
        act: edit("Second title"),
        after: first.id,
      });
      await t.turn();
      const writes = async (id: string) =>
        (
          await w.db
            .select({ state: calWrites.state, refusal: calWrites.refusal })
            .from(calWrites)
            .where(eq(calWrites.id, id))
        )[0];
      expect(await writes(first.id)).toEqual({ state: "applied", refusal: null });

      if (outcome === "external revision") {
        expect.soft(await writes(second.id)).toEqual({ state: "refused", refusal: "version_stale" });
        expect
          .soft(await eventsOf(w, t.accountId))
          .toMatchObject([{ title: "External title", versionTag: '"external"' }]);
        expect(tags).not.toContain('"external"');
      } else {
        expect(await writes(second.id)).toEqual({ state: "applied", refusal: null });
        expect(await eventsOf(w, t.accountId)).toMatchObject([{ title: "Second title" }]);
        expect(tags).toHaveLength(2);
        expect(tags[1]).toBe('"work-event.ics-2"');
      }
    },
  );
});
