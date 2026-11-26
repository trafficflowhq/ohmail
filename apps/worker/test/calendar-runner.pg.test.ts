/**
 * THE CALENDAR'S PASSES ON THE WORKER'S OWN CLOCK, composed as the worker composes them
 * (`calendarSection` over a scope), on a real Postgres. Two things only a running worker shows:
 * a calendar call that hangs holds nothing of the mail's queue, and no log line carries a value of
 * the person's (a password, a server's address, a provider's id, a title, a token).
 *
 * The roster is held to this file's own accounts by the worker's shard rule: each account here is
 * given a shard of its own among a million, so no other file's rows are dialled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { and, eq, ne, sql } from "drizzle-orm";
import { Secret, type HttpPort, type StoredCredential } from "@ohmail/cal-providers";
import { makeReader as microsoftReader, MS_GRAPH_BASE } from "@ohmail/cal-providers/microsoft";
import { StaticKeyProvider, silentLogger } from "@trafficflow/core";
import { calCalendars, calConnections, calWrites } from "@trafficflow/db";
import { CALENDAR_RING_GAP_MS, CALENDAR_TICK_MS, ROSTER_LIMIT, calendarPool, loadDueConnections } from "@ohmail/organizer/calendar-sync";
import { calendarSyncPass, calendarTurnFailed } from "@ohmail/organizer/calendar-sync-pass";
import { calendarSection, startCalendarRunner } from "../src/start/calendar.js";
import { queueSection } from "../src/start/queue.js";
import type { WorkerScope } from "../src/start/scope.js";
import type { WorkerCalendarConfig } from "../src/config.js";
import { startCalDavStandIn, type StandIn } from "../../../packages/cal-providers/test/caldav-stand-in.js";
import {
  AVAILABLE, ZONES, calendarsOf, capturedLog, depsFor, eventsOf, openWorld, providersOf, recordWrite, scriptedReader, sealCredential, seedConnection, silentHttp, single,
  upsert, type World,
} from "../../../packages/organizer/test/_calendar-world.js";

const SHARDS = 1_000_003;
const OWN_NETWORK: WorkerCalendarConfig = { policy: "own-network", google: null, microsoft: null, noticeOrigin: null };

/** A server that takes a connection and never answers it. */
async function silentServer(): Promise<{ port: number; opened: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let opened = 0;
  const server: Server = createServer((s) => { opened += 1; sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    port, opened: () => opened,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

/** Every value reachable from `root` through properties, arrays, maps and sets (not through closures). */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0 && seen.size < 200_000) {
    const v = stack.pop();
    if (v === null || (typeof v !== "object" && typeof v !== "function")) {
      out.push(v);
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (v instanceof Map) for (const [k, x] of v) stack.push(k, x);
    else if (v instanceof Set) for (const x of v) stack.push(x);
    for (const key of Object.keys(v as object)) {
      try { stack.push((v as Record<string, unknown>)[key]); } catch { /* a getter that throws holds nothing */ }
    }
  }
  return out;
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("the condition never held");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!AVAILABLE)("the calendar's passes in the worker", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  /** A scope as the worker's start file makes it, with what the calendar's section and the queue read. */
  async function scopeFor(accountId: string, calendar: WorkerCalendarConfig, log = capturedLog().log): Promise<WorkerScope> {
    const [row] = await w.db.execute(sql`select ((hashtext(${accountId}::text) % ${SHARDS}) + ${SHARDS}) % ${SHARDS} as shard`) as unknown as Array<{ shard: number }>;
    const scope = {
      config: { calendar }, roster: w.db, keyProvider: w.keys, log, stopped: false, wakeHub: null, parkedAccountsReader: null,
      selection: { shards: SHARDS, shardIndex: Number(row!.shard) },
      msRegistration: async () => ({ clientId: "", clientSecret: "" }),
    } as unknown as WorkerScope;
    queueSection(scope);
    return scope;
  }

  it("a calendar call that hangs holds nothing of the mail's queue, and the worker's stop ends it", async () => {
    const silent = await silentServer();
    try {
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: "mila", password: new Secret(["silent", "server"].join("-")) },
        serverUrl: `http://127.0.0.1:${silent.port}/dav/`,
      });
      const scope = await scopeFor(t.accountId, OWN_NETWORK);
      calendarSection(scope);
      expect(scope.calendar).not.toBeNull();
      scope.calendar!.ring();
      await until(() => silent.opened() > 0 && scope.calendar!.load().running === 1);
      // The mail's queue: a cycle's entry and a marker both run while the calendar's call hangs.
      let cycled = false;
      void scope.serialize(async () => { cycled = true; });
      const marker = await Promise.race([scope.serialize(async () => "served"), new Promise((r) => setTimeout(() => r("held"), 2_000))]);
      expect({ marker, cycled }).toEqual({ marker: "served", cycled: true });
      scope.stopped = true;
      scope.calendar!.stop();
      await Promise.race([scope.calendar!.settled(), new Promise((_, no) => setTimeout(() => no(new Error("the turn did not end")), 5_000))]);
      expect(scope.calendar!.load()).toEqual({ running: 0, queued: 0 });
    } finally {
      await silent.close();
    }
  }, 60_000);

  it("lets another due calendar run while Outlook resolves a dense page", async () => {
    const dense = await seedConnection(w, { provider: "microsoft", credential: {
      kind: "oauth", provider: "microsoft", refreshToken: new Secret(["worker", "fixture"].join("-")),
    } });
    const server = "https://dav.example.test/dav/";
    const healthy = await seedConnection(w, { provider: "caldav", serverUrl: server, credential: {
      kind: "basic", server, user: "worker-fixture", password: new Secret(["local", "fixture"].join("-")),
    } });
    let now = Date.UTC(2026, 10, 25);
    const masters: string[] = [];
    const records = Array.from({ length: 250 }, (_, i) => ({
      id: `day-${i}`, type: "occurrence", seriesMasterId: `master-${i}`, originalStart: "2026-11-20T10:00:00Z",
    }));
    const http: HttpPort = {
      async request(url) {
        now += 400;
        const id = new URL(url).pathname.split("/").at(-1)!;
        let body;
        if (id === "token") {
          body = { access_token: "synthetic-calendar-grant", token_type: "Bearer", expires_in: 3600 };
        } else if (id === "calendars") {
          body = { value: [{ id: "cal-1", canEdit: true }] };
        } else if (id === "delta") {
          body = { value: records, "@odata.deltaLink": `${MS_GRAPH_BASE}/me/calendars/cal-1/calendarView/delta?complete=1` };
        } else {
          masters.push(id);
          body = { id, type: "seriesMaster", changeKey: "fixture-version", originalStartTimeZone: "UTC",
            start: { dateTime: "2026-11-20T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-20T11:00:00", timeZone: "UTC" },
            recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-11-20" } },
          };
        }
        return { arrived: true, status: 200, header: () => null, body: new TextEncoder().encode(JSON.stringify(body)), location: null, url, hops: 0 };
      },
    };
    const clock = { now: () => now };
    const providers = providersOf({
      microsoft: { reader: microsoftReader({ http, clock, zones: ZONES, graphBase: MS_GRAPH_BASE }), http },
      caldav: { reader: scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("ready.ics", "v1", single("ready", 20))] }]]]) }), http: silentHttp() },
    });
    const deps = depsFor(w, providers, { clock, oauth: {
      google: null, microsoft: async () => ({ clientId: "calendar-client", clientSecret: ["local", "registration"].join("-"), defaultTenant: "common", kind: "confidential" }),
    } });
    let registered = false;
    let seenWhenHealthyFinished: number | null = null;
    const requestsPerTurn: number[] = [];
    const runner = startCalendarRunner({
      roster: async () => {
        if (registered) return [];
        registered = true;
        return [dense.due, healthy.due];
      },
      turn: async (due, signal) => {
        const before = masters.length;
        const result = await calendarSyncPass(deps, due, signal);
        if (due.id === dense.connectionId) requestsPerTurn.push(masters.length - before);
        if (due.id === healthy.connectionId) seenWhenHealthyFinished = masters.length;
        return result;
      },
      lanes: 1, floorMs: 600_000, gapMs: 0, turnMs: 60_000, now: clock.now, isStopped: () => false, log: silentLogger,
    });
    try {
      runner.ring();
      await until(() => seenWhenHealthyFinished !== null);
      expect(seenWhenHealthyFinished).toBeGreaterThan(0);
      expect(seenWhenHealthyFinished).toBeLessThan(records.length);
      await until(async () => runner.load().running + runner.load().queued === 0 &&
        (await calendarsOf(w, dense.accountId)).some((calendar) => calendar.syncToken !== null), 15_000);
      expect(Math.max(...requestsPerTurn)).toBeLessThanOrEqual(24);
      expect(masters).toEqual(records.map((record) => record.seriesMasterId));
      expect((await eventsOf(w, dense.accountId)).length).toBe(records.length);
      expect((await eventsOf(w, healthy.accountId)).map((event) => event.providerId)).toEqual(["ready.ics"]);
    } finally {
      runner.stop();
      await runner.settled();
    }
  }, 60_000);

  it("sixty-four connections whose turn throws do not keep another connection from being read, whether or not their rows can be moved", async () => {
    const basic: StoredCredential = { kind: "basic", server: "https://dav.example.test/dav/", user: "mila", password: new Secret(["kiln", "wheel"].join("-")) };
    /** A key the worker's ring does not hold: every turn of a connection sealed under it throws before anything is asked. */
    const foreign = new StaticKeyProvider({ 7: Buffer.alloc(32, 77) });
    const scenario = async (rowsCanBeMoved: boolean) => {
      const healthy = await seedConnection(w, { provider: "caldav", credential: basic, serverUrl: "https://dav.example.test/dav/" });
      const hourAgo = new Date(Date.now() - 3_600_000);
      for (let i = 0; i < ROSTER_LIMIT; i++) {
        const [row] = await w.db.insert(calConnections).values({
          accountId: healthy.accountId, provider: "caldav", label: "", status: "active", serverUrl: "https://dav.example.test/dav/", nextPollAt: hourAgo,
        }).returning({ id: calConnections.id });
        await sealCredential(w, healthy.accountId, row!.id, basic, null, foreign);
      }
      // The healthy one is due too, a second ago: behind all sixty-four in the roster's order.
      await w.db.update(calConnections).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(calConnections.id, healthy.connectionId));
      const reader = scriptedReader("caldav", { readings: new Map([["", [{ items: [upsert("a.ics", "v1", single("a@x.test", 17))] }]]]) });
      const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
      const pool = calendarPool(w.db);
      let thrown = 0;
      const runner = startCalendarRunner({
        roster: (now, except) => loadDueConnections(pool, now, ROSTER_LIMIT, (column) => eq(column, healthy.accountId), except),
        turn: async (c, signal) => {
          try { return await calendarSyncPass(deps, c, signal); } catch (err) { thrown += 1; throw err; }
        },
        ...(rowsCanBeMoved ? { failed: (c, err) => calendarTurnFailed(deps, c, err) } : {}),
        lanes: 1, floorMs: 600_000, gapMs: 0, isStopped: () => false, now: () => Date.now(), log: silentLogger,
      });
      try {
        runner.ring();
        await until(() => thrown === ROSTER_LIMIT && runner.load().running === 0 && runner.load().queued === 0);
        // One tick later: the sixty-four are waiting, and the roster's cut reaches the healthy one.
        runner.ring();
        await until(async () => (await eventsOf(w, healthy.accountId)).length === 1, 5_000);
      } finally {
        runner.stop();
        await runner.settled();
      }
      const broken = await w.db.select({ status: calConnections.status, errorCode: calConnections.errorCode, nextPollAt: calConnections.nextPollAt })
        .from(calConnections).where(and(eq(calConnections.accountId, healthy.accountId), ne(calConnections.id, healthy.connectionId)));
      return { thrown, broken };
    };

    const moved = await scenario(true);
    // The host's key ring is nobody's sign-in: no word on the row, only its wait.
    expect(moved.broken.every((r) => r.status === "active" && r.errorCode === null && r.nextPollAt!.getTime() > Date.now() + 30_000)).toBe(true);
    const held = await scenario(false);
    expect(held.broken.every((r) => r.nextPollAt!.getTime() < Date.now())).toBe(true);
    expect({ moved: moved.thrown, held: held.thrown }).toEqual({ moved: ROSTER_LIMIT, held: ROSTER_LIMIT });
  }, 120_000);

  it("drains a recorded write in the worker's own composition at once: rung once as the door rings, it is carried out before the floor's next tick, and says it composed the drain", async () => {
    const dav: StandIn = await startCalDavStandIn();
    try {
      dav.addCalendar("drain-calendar", { name: "Studio" });
      const t = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: dav.options.user, password: new Secret(dav.options.password) },
        serverUrl: `http://127.0.0.1:${dav.port}${dav.paths.start}`,
      });
      const { log, lines } = capturedLog();
      const scope = await scopeFor(t.accountId, OWN_NETWORK, log);
      const startedAt = Date.now();
      calendarSection(scope);
      const calendar = async () => (await w.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, t.accountId)))[0];
      // The connection's first turn, rung once, and over: a press during a turn is the turn's close's to keep.
      const rungAt = Date.now();
      scope.calendar!.ring();
      await until(async () => (await calendar()) !== undefined && scope.calendar!.load().running + scope.calendar!.load().queued === 0);
      // The bell idle, as a quiet server's is: the gap since its last read long passed, so a ring is read at once.
      await new Promise((r) => setTimeout(r, Math.max(0, rungAt + CALENDAR_RING_GAP_MS + 500 - Date.now())));
      // The floor reads the roster every CALENDAR_TICK_MS from the section's start. The press is made at least five
      // seconds before its next tick and must be carried out before it: only the press's own ring can do that.
      const untilTick = () => CALENDAR_TICK_MS - ((Date.now() - startedAt) % CALENDAR_TICK_MS);
      if (untilTick() < 5_000) await new Promise((r) => setTimeout(r, untilTick() + 200));
      const floorTick = Date.now() + untilTick();
      await recordWrite(w, { accountId: t.accountId, key: "press-in-the-worker", act: {
        kind: "calendar_event_create", eventId: crypto.randomUUID(), calendarId: (await calendar())!.id,
        event: {
          title: "Glaze firing", start: { kind: "instant", value: "20261117T090000Z" }, end: { kind: "instant", value: "20261117T100000Z" },
          notes: null, place: null, callLink: null, busy: true, private: false, repeat: null, invitees: [], alarms: [],
        },
      } });
      // As the door does it: the act's commit rings the bell once (the change log's signal), and the connection is
      // woken to now in a transaction of its own a few milliseconds after that commit.
      scope.calendar!.ring();
      await new Promise((r) => setTimeout(r, 20));
      await w.db.update(calConnections).set({ nextPollAt: sql`now()` }).where(eq(calConnections.accountId, t.accountId));
      const state = async () => (await w.db.select({ state: calWrites.state, refusal: calWrites.refusal }).from(calWrites).where(eq(calWrites.accountId, t.accountId)))[0];
      await until(async () => (await state())?.state !== "pending", floorTick - 200 - Date.now());
      expect(await state()).toEqual({ state: "applied", refusal: null });
      // The server holds one new member, made with the precondition that it be new.
      expect(dav.seen.filter((s) => s.method === "PUT").map((s) => s.headers["if-none-match"])).toEqual(["*"]);
      expect(lines.some((l) => l.includes("calendar_started") && l.includes('"phase":"writes"'))).toBe(true);
      scope.stopped = true;
      scope.calendar!.stop();
      await scope.calendar!.settled();
    } finally {
      await dav.close();
    }
  }, 60_000);

  it("no log line of a running worker carries a password, a server's address, a provider's id, a title or a token", async () => {
    const dav: StandIn = await startCalDavStandIn();
    try {
      dav.addCalendar("marker-calendar-path", { name: "Marker calendar name" });
      dav.put("marker-calendar-path", "marker-member.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "BEGIN:VEVENT",
        "UID:marker-uid@studio.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261119T090000Z", "DTEND:20261119T100000Z",
        "SUMMARY:Marker title of the event", "ATTENDEE;CN=Marker Person:mailto:marker-person@studio.example.test", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
      // A member the store cannot keep: it is left out, and nothing of it is said in a log.
      dav.put("marker-calendar-path", "marker-refused.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "BEGIN:VEVENT",
        "UID:marker-refused@studio.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261120T090000Z", "DTEND:20261120T100000Z",
        `SUMMARY:Marker refused${String.fromCharCode(0)}title`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
      const good = await seedConnection(w, {
        provider: "caldav", credential: { kind: "basic", user: dav.options.user, password: new Secret(dav.options.password) },
        serverUrl: `http://127.0.0.1:${dav.port}${dav.paths.start}`,
      });
      // A second connection of the account whose every turn throws (sealed under a key this worker does not hold):
      // the worker as it is composed makes it wait on its row, and says in its log only that a turn failed.
      const [unopenable] = await w.db.insert(calConnections).values({
        accountId: good.accountId, provider: "caldav", label: "", status: "active", serverUrl: `http://127.0.0.1:${dav.port}${dav.paths.start}`,
      }).returning({ id: calConnections.id });
      await sealCredential(w, good.accountId, unopenable!.id, {
        kind: "basic", server: `http://127.0.0.1:${dav.port}${dav.paths.start}`, user: dav.options.user, password: new Secret(dav.options.password),
      }, null,
        new StaticKeyProvider({ 7: Buffer.alloc(32, 77) }));
      const { log, lines } = capturedLog();
      const scope = await scopeFor(good.accountId, OWN_NETWORK, log);
      calendarSection(scope);
      // The token is written in the reading's last transaction, after the page's own: the reading has ended once it is there.
      const tokenNow = async (): Promise<string | null> => {
        const [stored] = await w.db.execute(sql`select sync_token from cal_calendars where account_id = ${good.accountId}`) as unknown as Array<{ sync_token: string | null }>;
        return stored?.sync_token ?? null;
      };
      await until(async () => { scope.calendar!.ring(); return (await tokenNow()) !== null; });
      const token = await tokenNow();
      expect(token).not.toBeNull();
      expect((await eventsOf(w, good.accountId)).length).toBe(1);
      const waiting = async () => (await w.db.select({ status: calConnections.status, errorCode: calConnections.errorCode, nextPollAt: calConnections.nextPollAt })
        .from(calConnections).where(eq(calConnections.id, unopenable!.id)))[0]!;
      await until(async () => { scope.calendar!.ring(); return ((await waiting()).nextPollAt?.getTime() ?? 0) > Date.now() + 30_000; });
      expect(await waiting()).toMatchObject({ status: "active", errorCode: null });
      expect(lines.some((l) => l.includes("calendar_turn_failed") && l.includes("CalendarKeyRingFault"))).toBe(true);
      // A turn that fails: the server refuses the password, and the connection stops for the person.
      dav.answerNext(401);
      await w.db.execute(sql`update cal_calendars set next_poll_at = null where account_id = ${good.accountId}`);
      await w.db.execute(sql`update cal_connections set next_poll_at = null where account_id = ${good.accountId}`);
      await until(() => { scope.calendar!.ring(); return lines.some((l) => l.includes("\"outcome\":\"stopped\"")); });
      scope.stopped = true;
      scope.calendar!.stop();
      await scope.calendar!.settled();

      const all = lines.join("\n");
      expect(lines.some((l) => l.includes("calendar_started"))).toBe(true);
      expect(lines.some((l) => l.includes("calendar_turn"))).toBe(true);
      for (const planted of [dav.options.password, `${dav.port}`, "marker-calendar-path", "marker-member", "Marker title", "Marker calendar name",
        "marker-uid", "marker-person", "Marker Person", "marker-refused", "Marker refused", "127.0.0.1", "/dav/", token!]) {
        expect(all.includes(planted), `a log line carries ${JSON.stringify(planted)}`).toBe(false);
      }
      expect(lines.filter((l) => l.includes("droppedFields"))).toEqual([]);
      // Nothing of a turn's sign-in stays where the worker keeps things: no secret holder, no password, on the scope.
      expect(reachable(scope).filter((v) => v instanceof Secret || (typeof v === "string" && v.includes(dav.options.password)))).toEqual([]);
    } finally {
      await dav.close();
    }
  }, 60_000);
});
