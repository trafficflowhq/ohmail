/**
 * WHAT WAS TYPED AT THE CONNECT DOOR IS FOUND IN THE SEALED SIGN-IN ALONE, on a real Postgres and
 * with the worker's own passes reading stand-in servers on this machine. A password and a
 * subscription's address, each carrying a marker, go through every route of the door; the worker's
 * runner then dials with them (a CalDAV server that takes the password, a file behind the secret
 * address, a port nobody listens on, an address that redirects to a metadata host, and, after a
 * sign-in typed again wrongly, a refused one). Afterwards the markers are looked for in every
 * table's every column, every log line of the server and the worker, the console, the feed and
 * every answer: none is there, and the opened `secret_enc` holds them.
 *
 * A root test, because it holds the routes and the worker's passes together and neither imports
 * the other. No provider is real: every address is this machine's own or a name no resolver knows.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { makeCalendarProviders } from "@ohmail/cal-providers";
import { createLogger } from "@trafficflow/core";
import type { HostResolver } from "@trafficflow/core/net";
import { bindDb, calSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import { calendarFeed } from "@trafficflow/services/calendar";
import type { CalendarConnectionRecord } from "@ohmail/wire";
import { ROSTER_LIMIT, calendarPool, loadDueConnections } from "../packages/organizer/src/calendar/index.js";
import { accountShardFilter } from "../apps/worker/src/mailboxes.js";
import { calendarSyncPass, calendarTurnFailed } from "../packages/organizer/src/calendar/sync-pass.js";
import { startCalendarRunner } from "../apps/worker/src/start/calendar.js";
import { AVAILABLE, ZONES, capturedLog, depsFor, openWorld, type World } from "../packages/organizer/test/_calendar-world.js";
import { makeDeps, req, seedSession } from "../packages/api/test/helpers.js";
import { startCalDavStandIn, type StandIn } from "../packages/cal-providers/test/caldav-stand-in.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A value nobody wrote down, of letters and digits only, so it reads the same in JSON, in a path and in a log. */
const marker = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;
const NO_WAY = { on: false, configured: false };
const FILE = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//connect door test//EN", "X-WR-CALNAME:Team",
  "BEGIN:VEVENT", "UID:standup@studio.example.test", "DTSTAMP:20261113T120000Z", "DTSTART:20261117T090000Z",
  "DTEND:20261117T100000Z", "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");
const MEMBER = FILE.replace("standup@", "kiln@").replace("SUMMARY:Standup", "SUMMARY:Kiln").replace("X-WR-CALNAME:Team\r\n", "");

/** The one handle this file's doors share, of the server's own kind: a request binds it to its session's account. */
let served: OwnedDb | null = null;

/** A door over this world's Postgres: one account with its calendar on, and everything it said. */
async function doorOn(w: World, policy: "cloud" | "own-network") {
  const { deps } = await makeDeps(new Date());
  const lines: string[] = [];
  served ??= makeOwnedDb(PG_TEST_URL, { role: "api" });
  // The api role's pool, minted for the request as the host mints its own: bound to nothing.
  deps.db = bindDb(served.db, { account: null });
  // The door's own clock, which a case may move on: a connection's minute is counted by it.
  let ahead = 0;
  deps.now = () => new Date(Date.now() + ahead);
  deps.keyProvider = w.keys;
  deps.logger = createLogger({ service: "api", level: "debug", sink: (l: string) => { lines.push(l); } });
  deps.services = { ...deps.services, calendar: calendarFeed, calendarConnect: { policy, ceremonies: { google: NO_WAY, microsoft: NO_WAY } } } as never;
  const s = await seedSession(w.db as never, { now: new Date() });
  await w.db.insert(calSettings).values({ accountId: s.accountId, enabledAt: new Date() });
  const answers: string[] = [];
  /** `key`: `true` for a key of this call's own, or the key itself where two calls share one. */
  const ask = async (method: string, path: string, body?: unknown, key: boolean | string = false): Promise<Response> => {
    const res = await app.handle(
      req(method, path, {
        bearer: s.token, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { "x-requested-with": "ohmail", ...(key === false ? {} : { "idempotency-key": key === true ? randomUUID() : key }) },
      }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
    answers.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.clone().text()}`);
    return res;
  };
  const connect = async (body: Record<string, unknown>): Promise<string> => {
    const res = await ask("POST", "/calendar/connections", { connectionId: randomUUID(), ...body }, true);
    // A refusal here is the server's own, so its last log line says which: closed words, never what was typed.
    expect(res.status, lines.slice(-1).join("").slice(0, 900)).toBe(202);
    return (await res.json() as CalendarConnectionRecord).id;
  };
  return { accountId: s.accountId, lines, answers, ask, connect, later: (ms: number): void => { ahead += ms; } };
}

/** A connection's row as the worker left it. */
async function standing(w: World, id: string): Promise<{ status: string; word: string | null; host: string | null } | null> {
  const [row] = await w.sql<{ status: string; word: string | null; host: string | null }[]>`
    select status, error_code as word, source_host as host from cal_connections where id = ${id}`;
  return row ?? null;
}

/** The roster is held to one account by the worker's own shard rule: each account is a shard of its own among a million. */
const SHARDS = 1_000_003;
async function shardOf(w: World, accountId: string): Promise<number> {
  const [own] = await w.sql<{ shard: number }[]>`select ((hashtext(${accountId}::text) % ${SHARDS}) + ${SHARDS}) % ${SHARDS} as shard`;
  return Number(own!.shard);
}

/** In how many rows of the whole store one of these texts stands, by table. Looked for by the database itself. */
async function foundInStore(w: World, texts: readonly string[]): Promise<Record<string, number>> {
  const tables = await w.sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  expect(tables.map((t) => t.tablename)).toContain("cal_credentials");
  const found: Record<string, number> = {};
  for (const { tablename } of tables) {
    const [hit] = await w.sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from "${tablename}" x where row_to_json(x)::text like any($1::text[])`, [texts.map((t) => `%${t}%`)],
    );
    if (Number(hit?.n ?? 0) > 0) found[tablename] = Number(hit!.n);
  }
  return found;
}

describe.skipIf(!AVAILABLE)("what was typed at the connect door", () => {
  let w: World;
  let dav: StandIn;
  let files: Server;
  let filesPort = 0;
  let deadPort = 0;
  const asked: string[] = [];
  const pw = marker("mkpw");
  const pwWrong = marker("mkpwtwo");
  const path = marker("mkpath");
  const query = marker("mkquery");
  const pathAgain = marker("mkpathtwo");
  const deadPath = marker("mkdead");
  const hopPath = marker("mkhop");
  // The name an account signs in with is typed too, and at iCloud it is an Apple Account's address. It is typed
  // there and not at the stand-in, whose own paths name its user as a CalDAV server's may.
  const apple = marker("mkuser");
  const pwCloud = marker("mkpwcloud");

  beforeAll(async () => {
    w = await openWorld(8);
    dav = await startCalDavStandIn({ password: pw });
    dav.addCalendar("work", { name: "Work" });
    dav.put("work", "kiln.ics", MEMBER);
    // A file behind a secret address: the path and the key must both be right, or there is nothing there.
    files = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      asked.push(`${url.pathname}${url.search}`);
      if (url.pathname === `/${hopPath}/hop.ics`) return void response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      const there = (url.pathname === `/${path}/basic.ics` && url.searchParams.get("key") === query) || url.pathname === `/${pathAgain}/basic.ics`;
      if (!there) return void response.writeHead(404).end();
      response.writeHead(200, { "content-type": "text/calendar" }).end(FILE);
    });
    await new Promise<void>((done) => files.listen(0, "127.0.0.1", done));
    filesPort = (files.address() as AddressInfo).port;
    // A port nobody listens on: taken once, and given back.
    const gone = createServer();
    await new Promise<void>((done) => gone.listen(0, "127.0.0.1", done));
    deadPort = (gone.address() as AddressInfo).port;
    await new Promise<void>((done) => gone.close(() => done()));
  }, 120_000);
  afterAll(async () => {
    await dav?.close();
    await new Promise<void>((done) => (files ? files.close(() => done()) : done()));
    await served?.close();
    await w?.close();
  });

  it("is in the sealed sign-in alone after every route and the worker's passes: not in the store, a log, the console, the feed or an answer", async () => {
    const door = await doorOn(w, "own-network");
    const worker = capturedLog();
    const consoled: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { consoled.push(parts.map(String).join(" ")); }));
    // The worker as its start file composes it: the real providers and request port, a person's own network, and no name to look up.
    const nobody: HostResolver = { resolve: async () => [] };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nobody, policy: { kind: "own-network" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const sync = depsFor(w, providers, { log: worker.log });
    const pool = calendarPool(w.db);
    const shardIndex = await shardOf(w, door.accountId);
    const runner = startCalendarRunner({
      roster: (now, except) => loadDueConnections(pool, now, ROSTER_LIMIT, (column) => accountShardFilter({ shards: SHARDS, shardIndex }, column), except),
      turn: (c, signal) => calendarSyncPass(sync, c, signal),
      failed: (c, err) => calendarTurnFailed(sync, c, err),
      lanes: 1, floorMs: 150, gapMs: 50, isStopped: () => false, now: () => Date.now(), log: worker.log,
    });
    /** Wait, at the runner's own pace, until `done` reads true. */
    const until = async (what: string, done: () => Promise<boolean>): Promise<void> => {
      for (let n = 0; !(await done()); n++) {
        if (n > 600) throw new Error(`the worker never got there: ${what}`);
        await sleep(100);
      }
    };
    try {
      expect(await (await door.ask("GET", "/calendar/connect")).json()).toEqual({ ways: ["icloud", "caldav", "ics"], connections: [] });
      const server = await door.connect({ way: "caldav", server: `http://127.0.0.1:${dav.port}${dav.paths.start}`, user: dav.options.user, password: pw });
      const file = await door.connect({ way: "ics", address: `http://127.0.0.1:${filesPort}/${path}/basic.ics?key=${query}` });
      const dead = await door.connect({ way: "ics", address: `http://127.0.0.1:${deadPort}/${deadPath}/basic.ics` });
      const hop = await door.connect({ way: "ics", address: `http://127.0.0.1:${filesPort}/${hopPath}/hop.ics` });
      const cloud = await door.connect({ way: "icloud", user: apple, password: pwCloud });

      // The worker dials: the password is taken, the file behind the secret address is read, and the two that cannot be are said.
      const eventsOf = async (id: string): Promise<number> => Number((await w.sql<{ n: number }[]>`
        select count(*)::int as n from cal_events e join cal_calendars k on k.id = e.calendar_id and k.account_id = e.account_id
        where e.account_id = ${door.accountId} and k.connection_id = ${id}`)[0]!.n);
      await until("the CalDAV server's event", async () => await eventsOf(server) === 1);
      await until("the subscription's event", async () => await eventsOf(file) === 1);
      await until("the unanswered port's word", async () => (await standing(w, dead))?.word === "connection_failed");
      await until("the redirect's word", async () => (await standing(w, hop))?.word === "connection_failed");
      // iCloud's name is one no resolver knows here: the pass with the Apple Account's sign-in ends at the lookup, and says so by a word.
      await until("the unresolved name's word", async () => (await standing(w, cloud))?.word === "host_unresolved");
      expect(await standing(w, cloud)).toMatchObject({ host: "caldav.icloud.com" });
      expect(dav.seen.some((s) => s.signedIn)).toBe(true);
      expect(asked).toContain(`/${path}/basic.ics?key=${query}`);
      // The redirect to a metadata host is refused AT THE DIAL, by the very port the worker's passes ask through: its
      // target is a second address and meets the address rule again. (The connection's own word is the last one its
      // reader met: an address typed without TLS is asked once more over TLS after a refusal, and nobody answers that here.)
      const refused = await providers.get("ics")!.http.request(`http://127.0.0.1:${filesPort}/${hopPath}/hop.ics`, {
        method: "GET", headers: {}, body: null, auth: null, validators: null, signal: new AbortController().signal,
      });
      expect(refused).toEqual({ arrived: false, reason: "address_not_allowed" });
      expect(asked).toContain(`/${hopPath}/hop.ics`);
      expect(await standing(w, hop)).toMatchObject({ word: "connection_failed", host: "127.0.0.1" });
      // A failed dial is said by a word of the closed list, and what is kept of its address is its host.
      expect(await standing(w, dead)).toMatchObject({ word: "connection_failed", host: "127.0.0.1" });

      // Every other route, with a password typed wrongly and a new address among them.
      const [calendar] = await w.sql<{ id: string }[]>`select id from cal_calendars where account_id = ${door.accountId} and connection_id = ${file}`;
      expect((await door.ask("PATCH", `/calendar/calendars/${calendar!.id}`, { name: "Holidays", shown: false })).status).toBe(200);
      // No turn is under way for either connection when its sign-in is typed again: each has been read and waits for its time.
      const resting = async (id: string): Promise<boolean> =>
        (await w.sql`select 1 from cal_connections where id = ${id} and next_poll_at > now()`).length === 1;
      await until("the two readings settled", async () => await resting(server) && await resting(file));
      const wrongBefore = dav.seen.filter((s) => s.withCredential && !s.signedIn).length;
      expect((await door.ask("POST", `/calendar/connections/${server}/sign-in`, { user: dav.options.user, password: pwWrong })).status).toBe(202);
      expect((await door.ask("POST", `/calendar/connections/${file}/sign-in`, { address: `http://127.0.0.1:${filesPort}/${pathAgain}/basic.ics` })).status).toBe(202);
      await until("the refused sign-in's word", async () => (await standing(w, server))?.word === "sign_in_refused");
      await until("the new address being asked", async () => asked.includes(`/${pathAgain}/basic.ics`));
      // A refused sign-in is asked ONCE: the connection waits for its person, and the runner's later reads dial nothing for it.
      expect(await standing(w, server)).toMatchObject({ status: "reconnect", word: "sign_in_refused" });
      await sleep(1_000);
      expect(dav.seen.filter((s) => s.withCredential && !s.signedIn).length - wrongBefore).toBe(1);
      // "Check now" makes the worker ask again, at once, where the connection was waiting out its six hours. The
      // sign-in typed again took the connection's minute, so a check inside it is refused and nothing more is asked.
      await until("the new reading settled", async () => await resting(file));
      const askedBefore = asked.filter((a) => a === `/${pathAgain}/basic.ics`).length;
      expect((await door.ask("POST", `/calendar/connections/${file}/check`)).status).toBe(429);
      expect(await resting(file)).toBe(true);
      door.later(61_000);
      expect((await door.ask("POST", `/calendar/connections/${file}/check`)).status).toBe(202);
      await until("the check being carried out", async () => asked.filter((a) => a === `/${pathAgain}/basic.ics`).length > askedBefore);
      expect((await door.ask("DELETE", `/calendar/connections/${dead}`)).status).toBe(200);
      // The read names the four that stand: its answer is among those searched below.
      const held = await (await door.ask("GET", "/calendar/connect")).json() as { connections: { id: string }[] };
      expect(held.connections.map((c) => c.id)).toEqual([server, file, hop, cloud]);
      expect((await door.ask("POST", "/calendar/connections", { way: "ics", connectionId: randomUUID(), address: `https://169.254.169.254/${hopPath}.ics` }, true)).status).toBe(400);
    } finally {
      runner.stop();
      await runner.settled();
      for (const s of spies) s.mockRestore();
    }

    const kinds = "settings,calendar_connection,calendar,calendar_event,calendar_suggestion";
    const feed = await (await door.ask("GET", `/sync?since=0&types=${kinds}`)).text();
    const first = await (await door.ask("GET", `/sync/snapshot?phase=calendar&types=${kinds}`)).text();
    expect(feed).toContain("calendar_connection");
    const markers = [pw, pwWrong, path, query, pathAgain, deadPath, hopPath, apple, pwCloud];
    expect(await foundInStore(w, markers)).toEqual({});
    const said = [door.lines.join("\n"), worker.lines.join("\n"), consoled.join("\n"), feed, first, door.answers.join("\n")].join("\n");
    for (const m of markers) expect(said.includes(m), m.slice(0, 8)).toBe(false);
    // The controls: the same searches find what IS kept in the clear, a host; and the worker did write its lines.
    expect(Object.keys(await foundInStore(w, ["127.0.0.1"]))).toContain("cal_connections");
    expect(said).toContain("127.0.0.1");
    expect(worker.lines.some((l) => l.includes("calendar_turn"))).toBe(true);
    // And the sealed sign-ins, opened, hold what was typed last, whole.
    const sealed = await w.sql<{ enc: string; v: number }[]>`select secret_enc as enc, key_version as v from cal_credentials where account_id = ${door.accountId}`;
    const clear = (await Promise.all(sealed.map((c) => w.keys.decrypt(c.enc, c.v)))).join("\n");
    expect(sealed.length).toBe(4);
    for (const m of [pwWrong, pathAgain, hopPath, apple, pwCloud]) expect(clear).toContain(m);
    for (const m of [pw, path, query, deadPath]) expect(clear).not.toContain(m);
  }, 180_000);

  it("a name that leads to a private address is taken by the door, which looks nothing up, and refused where it is dialled", async () => {
    const door = await doorOn(w, "cloud");
    const looked: string[] = [];
    const inside: HostResolver = { resolve: async (name) => { looked.push(name); return ["203.0.114.1", "10.0.0.5"]; } };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: inside, policy: { kind: "cloud" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const id = await door.connect({ way: "ics", address: `https://rebound.example.test/${marker("mk")}/basic.ics` });
    expect(looked).toEqual([]);
    const outcome = await calendarSyncPass(depsFor(w, providers), { accountId: door.accountId, id, provider: "ics", status: "active" }, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: "backed_off", word: "address_not_allowed" });
    expect(looked).toEqual(["rebound.example.test"]);
    expect(await standing(w, id)).toMatchObject({ status: "failing", word: "address_not_allowed", host: "rebound.example.test" });
  }, 60_000);

  it("two arrivals of one key at the same instant make one connection, and both are answered with it", async () => {
    const door = await doorOn(w, "cloud");
    for (let round = 0; round < 5; round++) {
      const body = { way: "icloud", connectionId: randomUUID(), user: "mila@studio.example.test", password: marker("pw") };
      const key = randomUUID();
      const both = await Promise.all([door.ask("POST", "/calendar/connections", body, key), door.ask("POST", "/calendar/connections", body, key)]);
      expect(both.map((r) => r.status), `round ${round}`).toEqual([202, 202]);
      const [one, other] = await Promise.all(both.map((r) => r.json()));
      expect(other).toEqual(one);
      expect((await w.sql`select 1 from cal_credentials where account_id = ${door.accountId} and connection_id = ${body.connectionId}`).length).toBe(1);
    }
    expect((await w.sql`select 1 from cal_connections where account_id = ${door.accountId}`).length).toBe(5);
  }, 60_000);
});
