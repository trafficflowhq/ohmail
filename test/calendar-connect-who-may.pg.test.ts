/**
 * WHO MAY ACT AT THE CONNECT DOOR, on a real Postgres with the server's own role (a request binds
 * the handle to its session's account), the routes composed as the server composes them, and the
 * worker's own roster and pass. Nothing here dials: the one resolver answers no address.
 *
 * Side by side: two checks of one connection at the same instant are one check; a removal beside a
 * sign-in typed again, or beside a second removal, leaves nothing standing; connects in flight at
 * the same instant never pass the account's ceiling.
 * Who may: signed out, nothing; another account's ids and its key, nothing of theirs and a random
 * id's answer byte for byte; the calendar off with connections standing, nothing written and
 * nothing woken, but that a removal is let through and takes the sealed sign-in with it; after
 * the account's erasure, no sealed sign-in, no connection, nothing on the roster, and a turn from
 * a roster read before dials nothing.
 * Whose sign-in: a sealed sign-in opens for the connection it was typed for and for no other row.
 * Where it goes: a CalDAV password is sent to the server it was typed for and to no other. A row
 * whose server somebody moved holds no sign-in: nothing is dialled for it, and a password typed
 * again for it is sealed for nobody.
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
import { startCalDavStandIn, type StandIn } from "../packages/cal-providers/test/caldav-stand-in.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const marker = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;
const NO_WAY = { on: false, configured: false };
const SHARDS = 1_000_003;
/** The connections one account may hold, as the door's contract says the number. */
const CEILING = 20;

let served: OwnedDb | null = null;

async function doorOn(w: World, policy: "cloud" | "own-network" = "cloud") {
  const { deps } = await makeDeps(new Date());
  served ??= makeOwnedDb(PG_TEST_URL, { role: "api" });
  deps.db = served.db as never;
  deps.now = () => new Date();
  deps.keyProvider = w.keys;
  deps.logger = createLogger({ service: "api", level: "debug", sink: () => {} });
  deps.services = {
    ...deps.services, calendar: calendarFeed, calendarConnect: { policy, ceremonies: { google: NO_WAY, microsoft: NO_WAY } },
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

/** A refusal whole: its status, our server's word, and the closed word beside it where the door names one. */
const faultOf = async (res: Response): Promise<[number, string | null, string | null]> => {
  const error = (await res.json() as { error?: { code?: string; details?: { fault?: string } } }).error;
  return [res.status, error?.code ?? null, error?.details?.fault ?? null];
};
/** What the door answers a sign-in typed again that it can seal for no server: the person connects again. */
const CONNECT_AGAIN = [400, "validation_failed", "sign_in_incomplete"];

describe.skipIf(!AVAILABLE)("who may act at the connect door, on Postgres", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(8); }, 120_000);
  afterAll(async () => {
    await served?.close();
    await w?.close();
  });

  /** A connection's sealed sign-in as the store holds it: unchanged means nothing was sealed over it. */
  const sealedOf = async (id: string): Promise<string> =>
    JSON.stringify(await w.sql`select md5(secret_enc) as sealed, key_version, updated_at from cal_credentials where connection_id = ${id}`);
  /** A connection that waits for its person made live again by somebody who can write rows: nothing sealed changes. */
  const live = async (id: string): Promise<void> => {
    await w.sql`update cal_connections set status = 'active', error_code = null where id = ${id}`;
  };

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

  it("a sealed sign-in opens for its own connection alone: copied to another connection of the account, or to another account's, it is refused at the open", async () => {
    const mine = await doorOn(w);
    const theirs = await doorOn(w);
    const looked: string[] = [];
    const nowhere: HostResolver = { resolve: async (name) => { looked.push(name); return []; } };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nowhere, policy: { kind: "cloud" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    /** One turn of a connection: how it ended, every name it looked up on the way to a dial, and the row as it stands after. */
    const turn = async (door: typeof mine, id: string, provider: "ics" | "caldav") => {
      looked.length = 0;
      const outcome = await calendarSyncPass(depsFor(w, providers), { accountId: door.s.accountId, id, provider, status: "active" }, new AbortController().signal);
      const [row] = await w.sql<{ status: string; word: string | null }[]>`select status, error_code as word from cal_connections where id = ${id}`;
      return { ended: outcome.kind, looked: [...new Set(looked)], status: row!.status, word: row!.word };
    };
    /** The sealed text of one connection written over another's, as somebody who can write rows and holds no key would. */
    const copied = async (from: string, to: string): Promise<void> => {
      const moved = await w.sql`update cal_credentials t set secret_enc = s.secret_enc, key_version = s.key_version
        from cal_credentials s where s.connection_id = ${from} and t.connection_id = ${to} returning t.connection_id`;
      expect(moved.length).toBe(1);
    };
    const REFUSED = { ended: "stopped", looked: [], status: "reconnect", word: "sign_in_incomplete" };
    /** How the turn of each connection that holds a copied text ended. */
    const turns: Record<string, unknown> = {};

    for (const kind of ["caldav", "ics"] as const) {
      const typed = (name: string): Record<string, unknown> => (kind === "caldav"
        ? { way: "caldav", server: `https://${name}.example.test/`, user: "mila", password: marker("pw") }
        : { way: "ics", address: `https://${name}.example.test/${marker("mk")}/a.ics` });
      const source = await mine.connect(typed(`${kind}-source`));
      const beside = await mine.connect(typed(`${kind}-beside`));
      const foreign = await theirs.connect(typed(`${kind}-foreign`));
      // The controls: each connection's own sealed sign-in opens, and its turn reaches the lookup of its own host.
      expect(await turn(mine, source, kind), kind).toMatchObject({ looked: [`${kind}-source.example.test`], word: "host_unresolved" });
      expect(await turn(mine, beside, kind), kind).toMatchObject({ looked: [`${kind}-beside.example.test`], word: "host_unresolved" });
      expect(await turn(theirs, foreign, kind), kind).toMatchObject({ looked: [`${kind}-foreign.example.test`], word: "host_unresolved" });

      // Copied to another connection of the same account, and to a connection of another account.
      await copied(source, beside);
      turns[`${kind}, the same account`] = await turn(mine, beside, kind);
      await copied(source, foreign);
      turns[`${kind}, another account`] = await turn(theirs, foreign, kind);

      // The sign-in it was typed for still opens it.
      expect(await turn(mine, source, kind), kind).toMatchObject({ looked: [`${kind}-source.example.test`] });
      if (kind === "ics") {
        // An address typed again is a sign-in whole: it is the refused connection's own, and read at its own host.
        const again = { address: `https://ics-again.example.test/${marker("mk")}/a.ics` };
        expect((await mine.call("POST", `/calendar/connections/${beside}/sign-in`, { body: again })).status).toBe(202);
        expect(await turn(mine, beside, kind), kind).toMatchObject({ looked: ["ics-again.example.test"], word: "host_unresolved" });
      } else {
        // A password typed again is half of one: its server is the kept sign-in's, and the text this row holds is
        // not this connection's. Nothing is sealed for it, and nothing is dialled: the person connects again.
        const held = await sealedOf(beside);
        expect(await faultOf(await mine.call("POST", `/calendar/connections/${beside}/sign-in`, { body: { user: "mila", password: marker("pw") } }))).toEqual(CONNECT_AGAIN);
        await live(beside);
        expect([await sealedOf(beside), await turn(mine, beside, kind)]).toEqual([held, REFUSED]);
      }
    }
    // It opened for nobody: nothing was looked up on the way to a dial, and each connection waits for its person.
    expect(turns).toEqual({
      "caldav, the same account": REFUSED, "caldav, another account": REFUSED, "ics, the same account": REFUSED, "ics, another account": REFUSED,
    });
  }, 120_000);

  it("a sealed CalDAV sign-in goes to the server it was typed for and to no other: where the connection's server was moved it opens for nobody, and typed again it is sealed for nobody", async () => {
    const mine = await doorOn(w);
    const looked: string[] = [];
    const nowhere: HostResolver = { resolve: async (name) => { looked.push(name); return []; } };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nowhere, policy: { kind: "cloud" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const turn = async (id: string) => {
      looked.length = 0;
      const outcome = await calendarSyncPass(depsFor(w, providers), { accountId: mine.s.accountId, id, provider: "caldav", status: "active" }, new AbortController().signal);
      const [row] = await w.sql<{ status: string; word: string | null }[]>`select status, error_code as word from cal_connections where id = ${id}`;
      return { ended: outcome.kind, looked: [...new Set(looked)], status: row!.status, word: row!.word };
    };
    /** ONE COLUMN, written by somebody who can write rows and holds no key: where the connection's sign-in is sent. Answers what stood there. */
    const moved = async (id: string, to: string): Promise<string> => {
      const [was] = await w.sql<{ start: string }[]>`select server_url as start from cal_connections where id = ${id}`;
      expect((await w.sql`update cal_connections set server_url = ${to} where id = ${id} returning id`).length).toBe(1);
      return was!.start;
    };
    const typedAgain = async (id: string, user: string) =>
      faultOf(await mine.call("POST", `/calendar/connections/${id}/sign-in`, { body: { user, password: marker("pw") } }));
    const ELSEWHERE = "https://dav.elsewhere.example.net/";
    const REFUSED = { ended: "stopped", looked: [], status: "reconnect", word: "sign_in_incomplete" };
    const seen: Record<string, unknown> = {};

    const ways = [
      { way: "icloud", host: "caldav.icloud.com", body: { way: "icloud", user: "mila@studio.example.test", password: marker("pw") } },
      { way: "caldav", host: "dav.studio.example.test", body: { way: "caldav", server: "https://dav.studio.example.test/", user: "mila", password: marker("pw") } },
    ];
    for (const { way, host, body } of ways) {
      const id = await mine.connect(body);
      // The control: the turn asks for the host the person typed (at iCloud, Apple's own).
      expect(await turn(id), way).toMatchObject({ looked: [host], word: "host_unresolved" });
      const sealed = await sealedOf(id);
      const own = await moved(id, ELSEWHERE);
      // Typed again before any turn has seen the row: the door seals no server it read off the row.
      const first = await typedAgain(id, body.user);
      const afterMove = await turn(id);
      // The connection now waits for its person, and its record still shows the host that was typed. The person types the password again.
      const second = await typedAgain(id, body.user);
      await live(id);
      seen[way] = { first, afterMove, second, sealedOver: await sealedOf(id) !== sealed, afterAgain: await turn(id) };
      // And back: with the row's own server put back, the same sealed text opens again. The refusal was the place, not a spoiled text.
      await moved(id, own);
      await live(id);
      expect(await turn(id), way).toMatchObject({ looked: [host], word: "host_unresolved" });
    }
    // Nothing was looked up on the way to a dial, nothing was sealed over the kept sign-in, and the door said to connect again.
    const refusedEverywhere = { first: CONNECT_AGAIN, afterMove: REFUSED, second: CONNECT_AGAIN, sealedOver: false, afterAgain: REFUSED };
    expect(seen).toEqual({ icloud: refusedEverywhere, caldav: refusedEverywhere });
  }, 120_000);

  describe("the password itself, at a second server (a person's own network, numbered addresses of this machine)", () => {
    let typed: StandIn;
    let other: StandIn;
    const password = marker("pw");
    beforeAll(async () => {
      typed = await startCalDavStandIn({ password });
      typed.addCalendar("work", { name: "Work" });
      // A second server that would take the same sign-in: `signedIn` there would say the very password arrived.
      other = await startCalDavStandIn({ password });
      other.addCalendar("work", { name: "Work" });
    });
    afterAll(async () => {
      await typed?.close();
      await other?.close();
    });

    it("a server the connection's row was moved to hears nothing: not the sealed password, and not one typed again", async () => {
      const mine = await doorOn(w, "own-network");
      const nobody: HostResolver = { resolve: async () => [] };
      const providers = makeCalendarProviders({
        clock: { now: () => Date.now() }, zones: ZONES, resolver: nobody, policy: { kind: "own-network" },
        enabled: new Set(["caldav"] as const), microsoft: null, writes: true,
      });
      // A memory of its own each turn: every turn lists again, as a worker that just started would.
      const turn = async (id: string): Promise<string> =>
        (await calendarSyncPass(depsFor(w, providers), { accountId: mine.s.accountId, id, provider: "caldav", status: "active" }, new AbortController().signal)).kind;
      const id = await mine.connect({ way: "caldav", server: `http://127.0.0.1:${typed.port}${typed.paths.start}`, user: typed.options.user, password });
      await turn(id);
      // The control: the typed server took the password, and the other one heard nothing.
      expect([typed.seen.some((s) => s.signedIn), other.seen.length]).toEqual([true, 0]);
      const asked = typed.seen.length;

      await w.sql`update cal_connections set server_url = ${`http://127.0.0.1:${other.port}${other.paths.start}`} where id = ${id}`;
      const afterMove = await turn(id);
      const again = await faultOf(await mine.call("POST", `/calendar/connections/${id}/sign-in`, { body: { user: typed.options.user, password } }));
      await live(id);
      const afterAgain = await turn(id);
      // Neither turn dialled anybody, and the door sealed nothing for the moved server: it hears no request at all.
      expect({ afterMove, again, afterAgain, heard: other.seen.map((s) => `${s.method} ${s.path} signedIn=${s.signedIn}`), typedAskedAgain: typed.seen.length - asked })
        .toEqual({ afterMove: "stopped", again: CONNECT_AGAIN, afterAgain: "stopped", heard: [], typedAskedAgain: 0 });
    }, 120_000);
  });

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

    // 4. My calendar off with two connections standing. Every act but the removal is refused, no way is offered, and nothing is written.
    const kept = await mine.connect({ way: "ics", address: `https://kept.example.test/${marker("mk")}/a.ics` });
    await w.sql`update cal_settings set enabled_at = null where account_id = ${mine.s.accountId}`;
    const before4 = await snapshot();
    const offs: [number, string | null][] = [];
    for (const [m, p, b] of six.slice(1).filter(([method]) => method !== "DELETE")) offs.push(await codeOf(await mine.call(m, p, { body: b, key: randomUUID() })));
    expect(offs).toEqual(Array.from({ length: 4 }, () => [409, "calendar_off"]));
    // The read names what I hold while the feed sends no calendar record, and nothing of theirs.
    const held = await (await mine.call("GET", "/calendar/connect")).json() as { ways: string[]; connections: { id: string }[] };
    expect([held.ways, held.connections.map((c) => c.id).sort()]).toEqual([[], [myId, kept].sort()]);
    expect(await snapshot()).toBe(before4);
    // The removal is let through: my connection, its calendar and its sealed sign-in are gone.
    /** The rows a removal of `myId` must leave as they stand: my other connection's and their connection's, sealed sign-ins by digest. */
    const beside = async (): Promise<string> => JSON.stringify(await w.sql`select c.id, c.status, c.error_code, c.next_poll_at, c.updated_at,
        md5(k.secret_enc) as sealed, k.key_version
      from cal_connections c left join cal_credentials k on k.connection_id = c.id and k.account_id = c.account_id
      where c.id in ${w.sql([kept, their])} order by c.id`);
    const besideBefore = await beside();
    const removed = await mine.call("DELETE", `/calendar/connections/${myId}`);
    expect([removed.status, await removed.json()]).toEqual([200, { removed: true }]);
    const [left] = await w.sql<{ creds: number; conns: number; cals: number }[]>`select
      (select count(*)::int from cal_credentials where connection_id = ${myId}) as creds,
      (select count(*)::int from cal_connections where id = ${myId}) as conns,
      (select count(*)::int from cal_calendars where connection_id = ${myId}) as cals`;
    expect(left).toEqual({ creds: 0, conns: 0, cals: 0 });
    // It woke no reading: nothing beside it was made due or touched, and a turn of what I still hold dials nothing while the calendar is off.
    expect(await beside()).toBe(besideBefore);
    const looked: string[] = [];
    const nowhere: HostResolver = { resolve: async (name) => { looked.push(name); return []; } };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nowhere, policy: { kind: "cloud" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const offTurns = [];
    for (const [id, provider] of [[kept, "ics"], [myId, "caldav"]] as const) {
      offTurns.push((await calendarSyncPass(depsFor(w, providers), { accountId: mine.s.accountId, id, provider, status: "active" }, new AbortController().signal)).kind);
    }
    expect([offTurns, looked]).toEqual([["off", "gone"], []]);

    // 5. Their account erased. The controls first: their connection is due, and a turn of it does reach the dial's lookup.
    const shardIndex = Number((await w.sql<{ shard: number }[]>`
      select ((hashtext(${theirs.s.accountId}::text) % ${SHARDS}) + ${SHARDS}) % ${SHARDS} as shard`)[0]!.shard);
    const roster = async (): Promise<string[]> => (await loadDueConnections(
      calendarPool(w.db), new Date(), ROSTER_LIMIT, (column) => accountShardFilter({ shards: SHARDS, shardIndex }, column),
    )).map((d) => d.id);
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
    // Mine stands as it stood: the one connection I kept, with its sealed sign-in.
    expect((await w.sql<{ id: string }[]>`select connection_id as id from cal_credentials where account_id = ${mine.s.accountId}`).map((c) => c.id)).toEqual([kept]);
  }, 180_000);
});
