/**
 * WHO MAY ACT AT THE CONNECT DOOR, on a real Postgres with the server's own role (a request binds
 * the handle to its session's account), the routes composed as the server composes them, and the
 * worker's own roster and pass. Nothing here dials: the one resolver answers no address.
 *
 * Side by side: two checks of one connection at the same instant are one check; a removal beside a
 * sign-in typed again, or beside a second removal, leaves nothing standing; connects in flight at
 * the same instant never pass the account's ceiling.
 * Who may: signed out, nothing; another account's ids and its key, nothing of theirs and a random
 * id's answer byte for byte; the calendar off with a connection standing, nothing written and
 * nothing woken; after the account's erasure, no sealed sign-in, no connection, nothing on the
 * roster, and a turn from a roster read before dials nothing.
 *
 * A root test, because it holds the routes and the worker's pass together and neither imports the
 * other.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { makeCalendarProviders } from "@ohmail/cal-providers";
import { createLogger } from "@trafficflow/core";
import type { HostResolver } from "@trafficflow/core/net";
import { calSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import { deleteAccount } from "@trafficflow/services";
import { calendarFeed } from "@trafficflow/services/calendar";
import type { CalendarConnectionRecord } from "@ohmail/wire";
import { ROSTER_LIMIT, calendarPool, loadDueConnections } from "../packages/organizer/src/calendar/index.js";
import { accountShardFilter } from "../apps/worker/src/mailboxes.js";
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { AVAILABLE, ZONES, depsFor, openWorld, type World } from "../packages/organizer/test/_calendar-world.js";
import { makeDeps, req, seedSession } from "../packages/api/test/helpers.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const marker = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;
const NO_WAY = { on: false, configured: false };
const SHARDS = 1_000_003;
/** The connections one account may hold, as the door's contract says the number. */
const CEILING = 20;

let served: OwnedDb | null = null;

async function doorOn(w: World) {
  const { deps } = await makeDeps(new Date());
  served ??= makeOwnedDb(PG_TEST_URL, { role: "api" });
  deps.db = served.db as never;
  deps.now = () => new Date();
  deps.keyProvider = w.keys;
  deps.logger = createLogger({ service: "api", level: "debug", sink: () => {} });
  deps.services = {
    ...deps.services, calendar: calendarFeed, calendarConnect: { policy: "cloud", ceremonies: { google: NO_WAY, microsoft: NO_WAY } },
  } as never;
  const s = await seedSession(w.db as never, { now: new Date() });
  await w.db.insert(calSettings).values({ accountId: s.accountId, enabledAt: new Date() });
  const call = (method: string, path: string, o: { body?: unknown; key?: string; signedOut?: boolean } = {}): Promise<Response> =>
    app.handle(
      req(method, path, {
        ...(o.signedOut === true ? {} : { bearer: s.token }),
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        headers: { "x-requested-with": "ohmail", ...(o.key === undefined ? {} : { "idempotency-key": o.key }) },
      }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
  const connect = async (body: Record<string, unknown>): Promise<string> => {
    const res = await call("POST", "/calendar/connections", { body: { connectionId: randomUUID(), ...body }, key: randomUUID() });
    expect(res.status).toBe(202);
    return (await res.json() as CalendarConnectionRecord).id;
  };
  return { s, call, connect };
}

const codeOf = async (res: Response): Promise<[number, string | null]> => {
  const text = await res.text();
  return [res.status, text === "" ? null : (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null];
};

describe.skipIf(!AVAILABLE)("who may act at the connect door, on Postgres", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(8); }, 120_000);
  afterAll(async () => {
    await served?.close();
    await w?.close();
  });

  it("side by side: two checks are one check, and a removal beside a sign-in or a removal leaves nothing standing", async () => {
    const door = await doorOn(w);
    const icloud = () => ({ way: "icloud", user: "mila@studio.example.test", password: marker("pw") });
    const checks: string[] = [];
    for (let round = 0; round < 5; round++) {
      const id = await door.connect(icloud());
      const both = await Promise.all([1, 2].map(() => door.call("POST", `/calendar/connections/${id}/check`)));
      checks.push(both.map((x) => x.status).sort().join(","));
    }
    expect(checks).toEqual(["202,429", "202,429", "202,429", "202,429", "202,429"]);

    const left: string[] = [];
    for (let round = 0; round < 5; round++) {
      const id = await door.connect(icloud());
      const [removed, signed] = await Promise.all([
        door.call("DELETE", `/calendar/connections/${id}`),
        door.call("POST", `/calendar/connections/${id}/sign-in`, { body: { user: "mila@studio.example.test", password: marker("pw") } }),
      ]);
      const [n] = await w.sql<{ conns: number; creds: number }[]>`select
        (select count(*)::int from cal_connections where id = ${id}) as conns,
        (select count(*)::int from cal_credentials where connection_id = ${id}) as creds`;
      left.push(`${removed!.status} ${signed!.status} ${n!.conns} ${n!.creds}`);
    }
    for (const l of left) expect(l).toMatch(/^200 (202|404|409) 0 0$/);

    const twice: string[] = [];
    for (let round = 0; round < 5; round++) {
      const id = await door.connect(icloud());
      const both = await Promise.all([1, 2].map(() => door.call("DELETE", `/calendar/connections/${id}`)));
      const [n] = await w.sql<{ conns: number }[]>`select count(*)::int as conns from cal_connections where id = ${id}`;
      twice.push(`${both.map((x) => x.status).sort().join(",")} ${n!.conns}`);
    }
    for (const t of twice) expect(t).toMatch(/^(200,200|200,404) 0$/);
  }, 120_000);

  it("connects in flight at the same instant never pass the account's ceiling", async () => {
    const door = await doorOn(w);
    const subscription = () => ({ way: "ics", address: `https://feeds.example.test/${marker("mk")}/a.ics` });
    for (let n = 0; n < CEILING - 1; n++) await door.connect(subscription());
    const atOnce = await Promise.all(Array.from({ length: 8 }, () =>
      door.call("POST", "/calendar/connections", { body: { connectionId: randomUUID(), ...subscription() }, key: randomUUID() })));
    expect(atOnce.map((x) => x.status).sort()).toEqual([202, 409, 409, 409, 409, 409, 409, 409]);
    expect((await w.sql`select 1 from cal_connections where account_id = ${door.s.accountId}`).length).toBe(CEILING);
  }, 60_000);

  it("who may: signed out, another account's ids and its key, the calendar off, and after the account's erasure", async () => {
    const mine = await doorOn(w);
    const theirs = await doorOn(w);
    const accounts = [mine.s.accountId, theirs.s.accountId];
    // Theirs: a subscription with its calendar, made under a key and a body we keep.
    const theirKey = randomUUID();
    const theirBody = { way: "ics", connectionId: randomUUID(), address: `https://feeds.example.test/${marker("mk")}/a.ics` };
    expect((await theirs.call("POST", "/calendar/connections", { body: theirBody, key: theirKey })).status).toBe(202);
    const their = theirBody.connectionId;
    const theirCalendar = randomUUID();
    await w.sql`insert into cal_calendars (id, account_id, connection_id, provider_id, name, access)
      values (${theirCalendar}, ${theirs.s.accountId}, ${their}, ${"subscription"}, ${"Team"}, ${"reader"})`;
    // Mine: a CalDAV connection with its calendar.
    const myBody = { way: "caldav", connectionId: randomUUID(), server: "https://dav.studio.example.test/", user: "mila", password: marker("pw") };
    expect((await mine.call("POST", "/calendar/connections", { body: myBody, key: randomUUID() })).status).toBe(202);
    const myId = myBody.connectionId;
    const myCalendar = randomUUID();
    await w.sql`insert into cal_calendars (id, account_id, connection_id, provider_id, name, access)
      values (${myCalendar}, ${mine.s.accountId}, ${myId}, ${"/cal/work/"}, ${"Work"}, ${"owner"})`;

    /** Both accounts' connections, sealed sign-ins (by digest), calendars, changes and keys, as one text. */
    const snapshot = async (): Promise<string> => JSON.stringify([
      await w.sql`select c.account_id, c.id, c.status, c.error_code, c.next_poll_at, c.source_host, c.updated_at,
          md5(k.secret_enc) as sealed, k.key_version
        from cal_connections c left join cal_credentials k on k.connection_id = c.id and k.account_id = c.account_id
        where c.account_id in ${w.sql(accounts)} order by c.id`,
      await w.sql`select id, shown, name, color, next_poll_at, updated_at from cal_calendars where account_id in ${w.sql(accounts)} order by id`,
      await w.sql`select account_id, count(*)::int as n from change_log where account_id in ${w.sql(accounts)} group by account_id order by account_id`,
      await w.sql`select account_id, count(*)::int as n from idempotency_keys where account_id in ${w.sql(accounts)} group by account_id order by account_id`,
    ]);

    // 1. Signed out: each of the six is refused, and nothing is written.
    const before1 = await snapshot();
    const six: [string, string, unknown][] = [
      ["GET", "/calendar/connect", undefined],
      ["POST", "/calendar/connections", { way: "icloud", connectionId: randomUUID(), user: "mila", password: marker("pw") }],
      ["DELETE", `/calendar/connections/${myId}`, undefined],
      ["POST", `/calendar/connections/${myId}/check`, undefined],
      ["POST", `/calendar/connections/${myId}/sign-in`, { user: "mila", password: marker("pw") }],
      ["PATCH", `/calendar/calendars/${myCalendar}`, { shown: false }],
    ];
    const out: number[] = [];
    for (const [m, p, b] of six) out.push((await mine.call(m, p, { body: b, key: randomUUID(), signedOut: true })).status);
    expect(out).toEqual([401, 401, 401, 401, 401, 401]);
    expect(await snapshot()).toBe(before1);

    // 2. Another account's ids under the server's own role: a random id's answer, byte for byte but the request's own id.
    const whole = async (res: Response): Promise<string> =>
      JSON.stringify([res.status, [...res.headers].filter(([k]) => k !== "x-request-id"), await res.text()]);
    const named: [string, (id: string) => string, unknown, string][] = [
      ["POST", (id) => `/calendar/connections/${id}/check`, undefined, their],
      ["POST", (id) => `/calendar/connections/${id}/sign-in`, { address: "https://feeds.example.test/moved.ics" }, their],
      ["POST", (id) => `/calendar/connections/${id}/sign-in`, { user: "mila", password: marker("pw") }, their],
      ["DELETE", (id) => `/calendar/connections/${id}`, undefined, their],
      ["PATCH", (id) => `/calendar/calendars/${id}`, { shown: false }, theirCalendar],
    ];
    const before2 = await snapshot();
    for (const [m, p, b, id] of named) {
      const other = await whole(await mine.call(m, p(id), { body: b }));
      const random = await whole(await mine.call(m, p(randomUUID()), { body: b }));
      expect(other, `${m} ${p(":id")}`).toBe(random);
      expect(JSON.parse(other)[0]).toBe(404);
    }
    expect(await snapshot()).toBe(before2);

    // 3. Their key and their body, sent by me: an id that is taken, as any taken id is answered, never their record.
    const replay = await mine.call("POST", "/calendar/connections", { body: theirBody, key: theirKey });
    const replayText = await replay.text();
    const ownTaken = await mine.call("POST", "/calendar/connections", { body: myBody, key: randomUUID() });
    const ownTakenText = await ownTaken.text();
    expect([replay.status, JSON.parse(replayText).error]).toEqual([ownTaken.status, JSON.parse(ownTakenText).error]);
    expect(replay.status).toBe(400);
    expect([replayText.includes(their), replayText.includes("feeds.example.test")]).toEqual([false, false]);
    expect((await w.sql`select 1 from cal_connections where account_id = ${mine.s.accountId}`).length).toBe(1);

    // 4. My calendar off with my connection standing: every act refused, nothing written, nothing woken.
    await w.sql`update cal_settings set enabled_at = null where account_id = ${mine.s.accountId}`;
    const before4 = await snapshot();
    const offs: [number, string | null][] = [];
    for (const [m, p, b] of six.slice(1)) offs.push(await codeOf(await mine.call(m, p, { body: b, key: randomUUID() })));
    expect(offs).toEqual(Array.from({ length: 5 }, () => [409, "calendar_off"]));
    expect(await (await mine.call("GET", "/calendar/connect")).json()).toEqual({ ways: [] });
    expect(await snapshot()).toBe(before4);

    // 5. Their account erased. The controls first: their connection is due, and a turn of it does reach the dial's lookup.
    const shardIndex = Number((await w.sql<{ shard: number }[]>`
      select ((hashtext(${theirs.s.accountId}::text) % ${SHARDS}) + ${SHARDS}) % ${SHARDS} as shard`)[0]!.shard);
    const roster = async (): Promise<string[]> => (await loadDueConnections(
      calendarPool(w.db), new Date(), ROSTER_LIMIT, (column) => accountShardFilter({ shards: SHARDS, shardIndex }, column),
    )).map((d) => d.id);
    const looked: string[] = [];
    const nowhere: HostResolver = { resolve: async (name) => { looked.push(name); return []; } };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nowhere, policy: { kind: "cloud" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const stale = { accountId: theirs.s.accountId, id: their, provider: "ics" as const, status: "active" as const };
    await calendarSyncPass(depsFor(w, providers), stale, new AbortController().signal);
    expect([...new Set(looked)]).toEqual(["feeds.example.test"]);
    await w.sql`update cal_connections set next_poll_at = null, status = 'active' where id = ${their}`;
    expect(await roster()).toContain(their);

    await deleteAccount({ db: w.db, accountId: theirs.s.accountId, userId: theirs.s.userId, now: () => new Date(), requestId: "who-may" } as never);
    const [gone] = await w.sql<{ creds: number; conns: number; cals: number }[]>`select
      (select count(*)::int from cal_credentials where account_id = ${theirs.s.accountId}) as creds,
      (select count(*)::int from cal_connections where account_id = ${theirs.s.accountId}) as conns,
      (select count(*)::int from cal_calendars where account_id = ${theirs.s.accountId}) as cals`;
    expect(gone).toEqual({ creds: 0, conns: 0, cals: 0 });
    expect(await roster()).not.toContain(their);
    looked.length = 0;
    const after = await calendarSyncPass(depsFor(w, providers), stale, new AbortController().signal);
    expect([after.kind, looked]).toEqual(["gone", []]);
    // Mine stands as it stood.
    expect((await w.sql`select 1 from cal_credentials where account_id = ${mine.s.accountId}`).length).toBe(1);
  }, 180_000);
});
