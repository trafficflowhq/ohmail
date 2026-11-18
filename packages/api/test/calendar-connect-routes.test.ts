import { randomUUID } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { createLogger } from "@trafficflow/core";
import { CALENDAR_TABLES } from "@trafficflow/db/calendar";
import {
  calAlarms, calAttendees, calCalendars, calConnections, calCredentials, calEvents, calSettings, calWrites, changeLog, idempotencyKeys,
} from "@trafficflow/db/mail";
import type {
  CalendarConnectionRecord,
  CalendarConnectWire,
  CalendarRecord,
  SyncResponse,
} from "@ohmail/wire";
import { deleteAccount, type Db } from "@trafficflow/services";
import { calendarFeed } from "@trafficflow/services/calendar";
import { CALENDAR_CONNECTION_CEILING, offeredWays } from "@trafficflow/services/calendar-connect";
import { makeDeps, req, seedSession, FIXED_NOW, type SeededSession } from "./helpers.js";

/**
 * THE CALENDAR'S CONNECT DOOR, through the composed pipeline: what a person types is checked by
 * its shape, sealed and written in one transaction, and nothing is dialled. The cases are the
 * door's refusals: a forbidden address, another account's id, a way that is switched off, a key
 * used twice, the calendar off, and what an erasure and a look through the whole store find.
 */

const app = createApp([...apiRoutes, ...calendarRoutes]);
const plain = createApp(apiRoutes);

interface Port {
  policy: "cloud" | "own-network";
  ceremonies: Record<"google" | "microsoft", { on: boolean; configured: boolean }>;
}
const OFF = { on: false, configured: false };
const portOf = (over: Partial<Port> = {}): Port => ({ policy: "cloud", ceremonies: { google: OFF, microsoft: OFF }, ...over });

/** A value nobody wrote down: a fixture's sign-in is made at run time and never stands in this file. */
const made = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;

async function rig(o: { port?: Port | null; on?: boolean; verified?: boolean } = {}) {
  const { db, deps, clock } = await makeDeps();
  const lines: string[] = [];
  deps.logger = createLogger({ service: "api", level: "debug", sink: (l: string) => { lines.push(l); } });
  deps.services = {
    ...deps.services, calendar: calendarFeed, ...(o.port === null ? {} : { calendarConnect: o.port ?? portOf() }),
  } as never;
  const s = await seedSession(db, { now: FIXED_NOW, ...(o.verified === false ? { emailVerified: false } : {}) });
  if (o.on !== false) await db.insert(calSettings).values({ accountId: s.accountId, enabledAt: FIXED_NOW });
  /** Every answer this rig gave, whole: status, headers and body. */
  const answers: string[] = [];
  const ask = async (
    method: string, path: string, body?: unknown, headers: Record<string, string> = {}, as: SeededSession = s,
  ): Promise<Response> => {
    const res = await app.handle(
      req(method, path, {
        bearer: as.token, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { "x-requested-with": "ohmail", ...headers },
      }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
    answers.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.clone().text()}`);
    return res;
  };
  /** A second account in the same store, its calendar on. */
  const other = async (): Promise<SeededSession> => {
    const o2 = await seedSession(db, { now: FIXED_NOW });
    await db.insert(calSettings).values({ accountId: o2.accountId, enabledAt: FIXED_NOW });
    return o2;
  };
  return { db, deps, clock, s, ask, lines, answers, other };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const key = (): Record<string, string> => ({ "idempotency-key": randomUUID() });
/** An address with a sign-in inside it, put together here so that no line of this file is shaped like one. */
const withSignIn = (rest: string): string => ["https://", "mila", ":", made("pw"), "@", rest].join("");
const icloud = (connectionId = randomUUID(), password = made("pw")) =>
  ({ way: "icloud", connectionId, user: "mila@studio.example.test", password });
const caldav = (server: string, connectionId = randomUUID(), password = made("pw")) =>
  ({ way: "caldav", connectionId, server, user: "mila", password });
const ics = (address: string, connectionId = randomUUID()) => ({ way: "ics", connectionId, address });

const errorOf = async (res: Response): Promise<[number, string, unknown]> => {
  const body = await res.json() as { error: { code: string; details?: { fault?: unknown } } };
  return [res.status, body.error.code, body.error.details?.fault ?? null];
};
/** An answer's status and our server's word, whatever it is: `null` where the answer is no refusal. */
const codeOf = async (res: Response): Promise<[number, string | null]> => {
  const text = await res.text();
  const body = text === "" ? null : JSON.parse(text) as { error?: { code?: string } };
  return [res.status, body?.error?.code ?? null];
};
const connectionsOf = (db: Db, accountId: string) =>
  db.select({ id: calConnections.id, provider: calConnections.provider, status: calConnections.status, serverUrl: calConnections.serverUrl,
    sourceHost: calConnections.sourceHost, nextPollAt: calConnections.nextPollAt, errorCode: calConnections.errorCode })
    .from(calConnections).where(eq(calConnections.accountId, accountId));
const credentialsOf = (db: Db, accountId: string) =>
  db.select({ connectionId: calCredentials.connectionId, kind: calCredentials.kind, secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion })
    .from(calCredentials).where(eq(calCredentials.accountId, accountId));
const changesOf = async (db: Db, accountId: string): Promise<string[]> =>
  (await db.select({ kind: changeLog.entityType, op: changeLog.op }).from(changeLog).where(eq(changeLog.accountId, accountId))
    .orderBy(changeLog.seq)).map((c) => `${c.kind}:${c.op}`).filter((c) => c.startsWith("calendar"));
/** Everything the account's sealed sign-ins open to, as one text. */
async function opened(r: Rig, accountId: string): Promise<string> {
  const rows = await credentialsOf(r.db, accountId);
  return (await Promise.all(rows.map((c) => r.deps.keyProvider.decrypt(c.secretEnc, c.keyVersion)))).join("\n");
}
/** Every row of every table, as text. */
async function wholeStore(db: Db): Promise<string> {
  const rowsOf = (res: unknown): Record<string, unknown>[] =>
    (Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows);
  const tables = rowsOf(await db.execute(sql.raw(`select tablename from pg_tables where schemaname = 'public' order by tablename`)))
    .map((t) => String(t.tablename));
  expect(tables).toContain("cal_credentials");
  const out: string[] = [];
  for (const table of tables) {
    const res = rowsOf(await db.execute(sql.raw(`select coalesce(string_agg(row_to_json(t)::text, E'\\n'), '') as text from "${table}" t`)));
    out.push(`-- ${table}\n${String(res[0]?.text ?? "")}`);
  }
  return out.join("\n");
}
const connect = async (r: Rig, body: unknown, as?: SeededSession): Promise<CalendarConnectionRecord> => {
  const res = await r.ask("POST", "/calendar/connections", body, key(), as);
  expect(res.status).toBe(202);
  return await res.json() as CalendarConnectionRecord;
};

describe("POST /calendar/connections", () => {
  it("takes the three ways, answers 202 with the record, and writes the connection, its sealed sign-in and one change", async () => {
    const r = await rig();
    const a = await connect(r, icloud());
    const b = await connect(r, caldav("dav.studio.example.test/remote.php/dav"));
    const c = await connect(r, ics("webcal://feeds.example.test/team/holidays.ics"));
    expect([a, b, c].map((x) => [x.provider, x.status, x.errorCode, x.serverHost, x.grantMailboxId]))
      .toEqual([
        ["caldav", "active", null, "caldav.icloud.com", null],
        ["caldav", "active", null, "dav.studio.example.test", null],
        ["ics", "active", null, "feeds.example.test", null],
      ]);
    const rows = await connectionsOf(r.db, r.s.accountId);
    // Due at once: written with no time, then pulled to the store's own now by the wake.
    const due = (at: Date | null): boolean => at === null || at.getTime() <= Date.now() + 1_000;
    expect(new Map(rows.map((x) => [x.id, [x.serverUrl, x.sourceHost, due(x.nextPollAt)]]))).toEqual(new Map([
      [a.id, ["https://caldav.icloud.com/", "caldav.icloud.com", true]],
      [b.id, ["https://dav.studio.example.test/remote.php/dav", "dav.studio.example.test", true]],
      [c.id, [null, "feeds.example.test", true]],
    ]));
    expect((await credentialsOf(r.db, r.s.accountId)).map((x) => [x.connectionId, x.kind]).sort())
      .toEqual([[a.id, "basic"], [b.id, "basic"], [c.id, "address"]].sort());
    expect(await changesOf(r.db, r.s.accountId)).toEqual(["calendar_connection:create", "calendar_connection:create", "calendar_connection:create"]);
  });

  it("1. refuses a forbidden address with its word, and writes no row", async () => {
    const r = await rig();
    const refused: [unknown, string][] = [
      [ics("http://feeds.example.test/a.ics"), "address_not_allowed"],
      [ics("https://169.254.169.254/latest/meta-data/a.ics"), "address_not_allowed"],
      [ics("https://localhost/a.ics"), "address_not_allowed"],
      [ics("https://printer.local/a.ics"), "address_not_allowed"],
      [ics("https://10.0.0.5/a.ics"), "address_not_allowed"],
      [ics("webcal://192.168.1.20/a.ics"), "address_not_allowed"],
      [ics("https://[2001:db8::1]/a.ics"), "address_not_allowed"],
      [ics("https://feeds.example.test:25/a.ics"), "port_not_allowed"],
      [ics(withSignIn("feeds.example.test/a.ics")), "address_invalid"],
      [ics("ftp://feeds.example.test/a.ics"), "address_invalid"],
      [ics("feeds.example.test/a.ics"), "address_invalid"],
      [caldav("http://dav.studio.example.test/"), "address_not_allowed"],
      [caldav("https://127.0.0.1/dav"), "address_not_allowed"],
      [caldav("https://metadata.google.internal/"), "address_not_allowed"],
      [caldav("https://dav.studio.example.test/dav?token=abc"), "address_invalid"],
      [caldav(withSignIn("dav.studio.example.test/")), "address_invalid"],
    ];
    for (const [body, word] of refused) {
      const res = await r.ask("POST", "/calendar/connections", body, key());
      expect(await errorOf(res), JSON.stringify((body as { way: string }).way)).toEqual([400, "validation_failed", word]);
    }
    expect(await connectionsOf(r.db, r.s.accountId)).toEqual([]);
    expect(await credentialsOf(r.db, r.s.accountId)).toEqual([]);
    expect(await changesOf(r.db, r.s.accountId)).toEqual([]);
    expect(await r.db.select({ key: idempotencyKeys.key }).from(idempotencyKeys).where(eq(idempotencyKeys.accountId, r.s.accountId))).toEqual([]);
    // The policy is a branch that runs: a person's own server takes an address of its own network, by shape.
    const own = await rig({ port: portOf({ policy: "own-network" }) });
    expect((await connect(own, ics("http://192.168.1.20/a.ics"))).serverHost).toBe("192.168.1.20");
    expect(await errorOf(await own.ask("POST", "/calendar/connections", ics("https://169.254.169.254/a.ics"), key())))
      .toEqual([400, "validation_failed", "address_not_allowed"]);
  });

  it("2. answers 202 while every way out of this process throws: nothing is dialled and no name is looked up", async () => {
    const r = await rig();
    const tried: string[] = [];
    const shut = (what: string) => (): never => {
      tried.push(what);
      throw new Error(`the test lets nothing out: ${what}`);
    };
    const spies = [
      vi.spyOn(globalThis, "fetch").mockImplementation(shut("fetch")),
      vi.spyOn(http, "request").mockImplementation(shut("http.request")), vi.spyOn(http, "get").mockImplementation(shut("http.get")),
      vi.spyOn(https, "request").mockImplementation(shut("https.request")), vi.spyOn(https, "get").mockImplementation(shut("https.get")),
      vi.spyOn(net, "connect").mockImplementation(shut("net.connect")), vi.spyOn(net, "createConnection").mockImplementation(shut("net.createConnection")),
      vi.spyOn(tls, "connect").mockImplementation(shut("tls.connect")),
      vi.spyOn(dns, "lookup").mockImplementation(shut("dns.lookup") as never), vi.spyOn(dns, "resolve").mockImplementation(shut("dns.resolve") as never),
      vi.spyOn(dns, "resolve4").mockImplementation(shut("dns.resolve4") as never), vi.spyOn(dns, "resolve6").mockImplementation(shut("dns.resolve6") as never),
      vi.spyOn(dns.promises, "lookup").mockImplementation(shut("dns.promises.lookup")), vi.spyOn(dns.promises, "resolve").mockImplementation(shut("dns.promises.resolve")),
      vi.spyOn(dns.promises, "resolve4").mockImplementation(shut("dns.promises.resolve4")), vi.spyOn(dns.promises, "resolve6").mockImplementation(shut("dns.promises.resolve6")),
    ];
    syncBuiltinESMExports();
    try {
      await connect(r, icloud());
      await connect(r, caldav("https://dav.studio.example.test/"));
      const sub = await connect(r, ics("https://feeds.example.test/holidays.ics"));
      expect((await r.ask("POST", `/calendar/connections/${sub.id}/check`)).status).toBe(202);
      expect((await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://feeds.example.test/other.ics" })).status).toBe(202);
      expect((await r.ask("DELETE", `/calendar/connections/${sub.id}`)).status).toBe(200);
      // The doubles bite: a call through one of them is counted.
      expect(() => http.request("http://feeds.example.test/")).toThrow();
      expect(tried).toEqual(["http.request"]);
    } finally {
      for (const s of spies) s.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("3. keeps what was typed in the sealed sign-in alone: not in the store, a log, the feed, the ledger or an answer", async () => {
    const r = await rig();
    const pw = made("mkpw");
    const pwAgain = made("mkpwtwo");
    const path = made("mkpath");
    const query = made("mkquery");
    const pathAgain = made("mkpathtwo");
    // The name a server signs in is typed too, and at iCloud it is an Apple Account's address: looked for like the rest.
    const user = made("mkuser");
    const userAgain = made("mkusertwo");
    const dav = await connect(r, { ...caldav("https://dav.studio.example.test/dav", randomUUID(), pw), user });
    const sub = await connect(r, ics(`https://feeds.example.test/${path}/basic.ics?key=${query}`));
    expect(await opened(r, r.s.accountId)).toContain(pw);
    // The check first: a sign-in typed again takes the connection's minute, so a check after one is refused inside it.
    expect((await r.ask("POST", `/calendar/connections/${dav.id}/check`)).status).toBe(202);
    expect((await r.ask("POST", `/calendar/connections/${dav.id}/sign-in`, { user: userAgain, password: pwAgain })).status).toBe(202);
    expect((await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: `https://feeds.example.test/${pathAgain}/basic.ics` })).status).toBe(202);
    expect((await errorOf(await r.ask("POST", `/calendar/connections/${sub.id}/check`))).slice(0, 2)).toEqual([429, "rate_limited"]);
    // What the account holds is listed by the read, and the read's answer is searched like every other.
    expect(((await (await r.ask("GET", "/calendar/connect")).json()) as CalendarConnectWire).connections.map((c) => c.id)).toEqual([dav.id, sub.id]);
    // A refusal of the door's own, and a host fault while a sign-in is in hand: each names nothing typed.
    const badWay = made("mkrefused");
    expect((await r.ask("POST", "/calendar/connections", ics(`https://10.0.0.5/${badWay}.ics`), key())).status).toBe(400);
    const faulted = made("mkfault");
    const keys = r.deps.keyProvider;
    r.deps.keyProvider = { ...keys, encrypt: async (text: string) => { throw new Error(`the key service refused: ${text}`); } } as never;
    expect((await r.ask("POST", "/calendar/connections", icloud(randomUUID(), faulted), key())).status).toBe(500);
    r.deps.keyProvider = keys;
    const feed = await (await r.ask("GET", "/sync?since=0&types=settings,calendar_connection,calendar,calendar_event,calendar_suggestion")).text();
    const everywhere = [await wholeStore(r.db), r.lines.join("\n"), feed, r.answers.join("\n")].join("\n");
    for (const marker of [pw, pwAgain, path, query, pathAgain, badWay, faulted, user, userAgain]) expect(everywhere.includes(marker), marker.slice(0, 9)).toBe(false);
    // The control: the same search finds a host, which is the one part of an address that is kept in the clear.
    expect(everywhere).toContain("feeds.example.test");
    const sealed = await opened(r, r.s.accountId);
    for (const marker of [pwAgain, pathAgain, userAgain]) expect(sealed).toContain(marker);
    for (const marker of [pw, path, query, user]) expect(sealed).not.toContain(marker);
  });

  it("5. google and microsoft are unlisted and refused: with the switch off, with a configured client alone, and while their sign-in is not built", async () => {
    const ON = { on: true, configured: true };
    const settings: Port["ceremonies"][] = [
      { google: OFF, microsoft: OFF },
      { google: { on: false, configured: true }, microsoft: { on: false, configured: true } },
      { google: { on: true, configured: false }, microsoft: { on: true, configured: false } },
      { google: ON, microsoft: ON },
    ];
    for (const ceremonies of settings) {
      const r = await rig({ port: portOf({ ceremonies }) });
      expect(await (await r.ask("GET", "/calendar/connect")).json() as CalendarConnectWire).toEqual({ ways: ["icloud", "caldav", "ics"], connections: [] });
      for (const way of ["google", "microsoft"]) {
        expect(await errorOf(await r.ask("POST", "/calendar/connections", { way, connectionId: randomUUID() }, key())))
          .toEqual([400, "validation_failed", "provider_off"]);
      }
      expect(await connectionsOf(r.db, r.s.accountId)).toEqual([]);
    }
    // All three are needed, and a composition that hands no port offers nothing at all.
    const built = { google: true, microsoft: true };
    expect(offeredWays(portOf({ ceremonies: { google: ON, microsoft: OFF } }), built)).toEqual(["icloud", "caldav", "ics", "google"]);
    expect(offeredWays(portOf({ ceremonies: { google: { on: true, configured: false }, microsoft: { on: false, configured: true } } }), built))
      .toEqual(["icloud", "caldav", "ics"]);
    const bare = await rig({ port: null });
    expect(await (await bare.ask("GET", "/calendar/connect")).json()).toEqual({ ways: [], connections: [] });
    expect(await errorOf(await bare.ask("POST", "/calendar/connections", icloud(), key()))).toEqual([400, "validation_failed", "provider_off"]);
    expect(await connectionsOf(bare.db, bare.s.accountId)).toEqual([]);
  });

  it("6. one key makes one connection: a second arrival answers the first, another body under the key is refused", async () => {
    const r = await rig();
    const k = key();
    const body = icloud();
    const first = await r.ask("POST", "/calendar/connections", body, k);
    const again = await r.ask("POST", "/calendar/connections", body, k);
    expect([first.status, again.status]).toEqual([202, 202]);
    expect(first.headers.get("x-sync-seq")).toMatch(/^\d+$/);
    expect(again.headers.get("x-sync-seq")).toBe(first.headers.get("x-sync-seq"));
    expect(await again.json()).toEqual(await first.json());
    expect(await errorOf(await r.ask("POST", "/calendar/connections", icloud(), k))).toEqual([409, "idempotency_replay", null]);
    // The id is the row's own key: a second key cannot make a second connection of it.
    expect((await errorOf(await r.ask("POST", "/calendar/connections", body, key()))).slice(0, 2)).toEqual([400, "validation_failed"]);
    expect((await errorOf(await r.ask("POST", "/calendar/connections", icloud()))).slice(0, 2)).toEqual([400, "idempotency_key_required"]);
    expect((await connectionsOf(r.db, r.s.accountId)).map((c) => c.id)).toEqual([body.connectionId]);
    expect((await credentialsOf(r.db, r.s.accountId)).length).toBe(1);
    expect(await changesOf(r.db, r.s.accountId)).toEqual(["calendar_connection:create"]);
  });

  it("7. while the account's calendar is off: nothing is connected, asked, signed in or set, and no way is offered; what stands is listed and can be removed, its sealed sign-in with it", async () => {
    // Off from the beginning: no way, nothing held, and a removal of nothing is what it is while on.
    const never = await rig({ on: false });
    expect(await (await never.ask("GET", "/calendar/connect")).json()).toEqual({ ways: [], connections: [] });
    expect((await errorOf(await never.ask("POST", "/calendar/connections", icloud(), key()))).slice(0, 2)).toEqual([409, "calendar_off"]);
    expect(await codeOf(await never.ask("DELETE", `/calendar/connections/${randomUUID()}`))).toEqual([404, "not_found"]);
    expect([await connectionsOf(never.db, never.s.accountId), await credentialsOf(never.db, never.s.accountId)]).toEqual([[], []]);

    // Switched off with two connections standing.
    const r = await rig();
    const dav = await connect(r, caldav("https://dav.studio.example.test/"));
    const sub = await connect(r, ics("https://feeds.example.test/a.ics"));
    const calendarId = randomUUID();
    await r.db.insert(calCalendars).values({ id: calendarId, accountId: r.s.accountId, connectionId: sub.id, providerId: "subscription", name: "Team", access: "reader" });
    await r.db.update(calSettings).set({ enabledAt: null }).where(eq(calSettings.accountId, r.s.accountId));
    const standing = async (): Promise<unknown[]> =>
      [await connectionsOf(r.db, r.s.accountId), await credentialsOf(r.db, r.s.accountId), await changesOf(r.db, r.s.accountId)];
    const before = await standing();
    const refused: [string, string, unknown][] = [
      ["POST", "/calendar/connections", icloud()],
      ["POST", `/calendar/connections/${dav.id}/check`, undefined],
      ["POST", `/calendar/connections/${dav.id}/sign-in`, { user: "mila", password: made("pw") }],
      ["POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://feeds.example.test/b.ics" }],
      ["PATCH", `/calendar/calendars/${calendarId}`, { shown: false }],
    ];
    for (const [method, path, body] of refused) {
      expect((await errorOf(await r.ask(method, path, body, key()))).slice(0, 2), `${method} ${path}`).toEqual([409, "calendar_off"]);
    }
    // No way is offered. What the account holds is still listed: the feed sends no calendar record while the calendar is off.
    expect(await (await r.ask("GET", "/calendar/connect")).json()).toEqual({ ways: [], connections: [dav, sub] });
    expect(await standing()).toEqual(before);

    // A removal is let through: the connection and its sealed sign-in are gone, each record's deletion recorded.
    const removed = await r.ask("DELETE", `/calendar/connections/${dav.id}`);
    expect([removed.status, await removed.json()]).toEqual([200, { removed: true }]);
    expect((await credentialsOf(r.db, r.s.accountId)).map((c) => c.connectionId)).toEqual([sub.id]);
    // Nothing else moved and nothing was made due: the connection beside it stands as it stood.
    expect(await connectionsOf(r.db, r.s.accountId)).toEqual((before[0] as { id: string }[]).filter((c) => c.id === sub.id));
    expect((await changesOf(r.db, r.s.accountId)).slice((before[2] as string[]).length)).toEqual(["calendar_connection:update", "calendar_connection:delete"]);
    expect(((await (await r.ask("GET", "/calendar/connect")).json()) as CalendarConnectWire).connections).toEqual([sub]);
    // The subscription goes the same way, with its calendar.
    expect(await codeOf(await r.ask("DELETE", `/calendar/connections/${sub.id}`))).toEqual([200, null]);
    expect([await connectionsOf(r.db, r.s.accountId), await credentialsOf(r.db, r.s.accountId)]).toEqual([[], []]);
    expect(await r.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, r.s.accountId))).toEqual([]);
  });

  it("8. an erasure leaves no sealed sign-in and no connection", async () => {
    const r = await rig();
    await connect(r, icloud());
    await connect(r, ics("https://feeds.example.test/holidays.ics"));
    const kept = await r.other();
    await connect(r, icloud(), kept);
    expect((await credentialsOf(r.db, r.s.accountId)).length).toBe(2);
    await deleteAccount({ db: r.db, accountId: r.s.accountId, userId: r.s.userId, now: r.deps.now, requestId: "erase" } as never);
    expect(await credentialsOf(r.db, r.s.accountId)).toEqual([]);
    expect(await connectionsOf(r.db, r.s.accountId)).toEqual([]);
    expect((await credentialsOf(r.db, kept.accountId)).length).toBe(1);
  });

  it("is refused to an unverified account, is no route where the composition keeps no calendar, and holds an account to its ceiling", async () => {
    const unverified = await rig({ verified: false });
    expect((await unverified.ask("POST", "/calendar/connections", icloud(), key())).status).toBe(403);
    expect(await connectionsOf(unverified.db, unverified.s.accountId)).toEqual([]);
    const { deps, db } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const bare = (method: string, path: string) => plain.handle(
      req(method, path, { bearer: s.token, headers: { "x-requested-with": "ohmail", ...key() }, ...(method === "GET" ? {} : { body: "{}" }) }),
      { ...deps, session: null, idempotency: null } as ApiDeps);
    expect((await bare("GET", "/calendar/connect")).status).toBe(404);
    expect((await bare("POST", "/calendar/connections")).status).toBe(404);
    const r = await rig();
    for (let i = 0; i < CALENDAR_CONNECTION_CEILING; i++) await connect(r, ics(`https://feeds.example.test/${i}.ics`));
    expect((await errorOf(await r.ask("POST", "/calendar/connections", icloud(), key()))).slice(0, 2)).toEqual([409, "conflict"]);
    expect((await connectionsOf(r.db, r.s.accountId)).length).toBe(CALENDAR_CONNECTION_CEILING);
  });
});

describe("the routes that name a connection or a calendar", () => {
  /** A calendar with one event and one invitee under a connection, as a reading would have left them. */
  async function planted(r: Rig, accountId: string, connectionId: string): Promise<{ calendar: string; event: string }> {
    const calendar = randomUUID();
    const event = randomUUID();
    await r.db.insert(calCalendars).values({ id: calendar, accountId, connectionId, providerId: `cal-${calendar}`, name: "Studio", access: "owner", nextPollAt: new Date(FIXED_NOW.getTime() + 3_600_000) });
    await r.db.insert(calEvents).values({
      id: event, accountId, calendarId: calendar, providerId: `ev-${event}`, uid: `uid-${event}`, title: "Glaze firing",
      startKind: "instant", startLocal: "20261117T090000Z", startsAt: new Date("2026-11-17T09:00:00Z"),
      endKind: "instant", endLocal: "20261117T100000Z", endsAt: new Date("2026-11-17T10:00:00Z"),
    });
    await r.db.insert(calAttendees).values({ accountId, eventId: event, address: "guest@studio.example.test", role: "required", answer: "none" });
    // A reminder of the event's own and one the calendar starts new events with, and a change the person made that is still owed.
    await r.db.insert(calAlarms).values([{ accountId, eventId: event, minutesBefore: 15 }, { accountId, calendarId: calendar, minutesBefore: 30 }]);
    await r.db.insert(calWrites).values({
      accountId, calendarId: calendar, eventId: event, op: "update", idempotencyKey: `press-${event}`, payload: { v: 1, act: { title: "Glaze firing, moved" } },
    });
    return { calendar, event };
  }

  it("lists what the account holds as the feed's records, in the order it was connected, and nothing of another account's", async () => {
    const r = await rig();
    const o = await r.other();
    const first = await connect(r, caldav("https://dav.studio.example.test/"));
    const theirs = await connect(r, ics("https://feeds.example.test/theirs.ics"), o);
    const second = await connect(r, ics("https://feeds.example.test/mine.ics"));
    expect(await (await r.ask("GET", "/calendar/connect")).json()).toEqual({ ways: ["icloud", "caldav", "ics"], connections: [first, second] });
    expect(await (await r.ask("GET", "/calendar/connect", undefined, {}, o)).json()).toEqual({ ways: ["icloud", "caldav", "ics"], connections: [theirs] });
    // A record is what the feed sends of a connection: its host, and nothing that signs in.
    expect(Object.keys(first).sort()).toEqual([
      "consentedAt", "createdAt", "errorCode", "grantMailboxId", "id", "label", "lastSyncedAt", "provider", "serverHost", "status", "updatedAt",
    ]);
  });

  it("4. another account's id answers byte for byte as a random id does, and changes nothing of theirs", async () => {
    const r = await rig();
    const theirs = await r.other();
    const their = await connect(r, ics("https://feeds.example.test/theirs.ics"), theirs);
    const { calendar: theirCalendar } = await planted(r, theirs.accountId, their.id);
    const mine = await connect(r, ics("https://feeds.example.test/mine.ics"));
    const { calendar: myCalendar } = await planted(r, r.s.accountId, mine.id);
    const before = JSON.stringify([await connectionsOf(r.db, theirs.accountId), await credentialsOf(r.db, theirs.accountId), await changesOf(r.db, theirs.accountId)]);
    const calls: [string, (id: string) => string, unknown][] = [
      ["POST", (id) => `/calendar/connections/${id}/check`, undefined],
      ["POST", (id) => `/calendar/connections/${id}/sign-in`, { address: "https://feeds.example.test/moved.ics" }],
      ["POST", (id) => `/calendar/connections/${id}/sign-in`, { user: "mila", password: made("pw") }],
      ["DELETE", (id) => `/calendar/connections/${id}`, undefined],
    ];
    for (const [method, path, body] of calls) {
      const other = await r.ask(method, path(their.id), body);
      const random = await r.ask(method, path(randomUUID()), body);
      expect([other.status, await other.text()], `${method} ${path(":id")}`).toEqual([404, await random.text()]);
      expect(random.status).toBe(404);
    }
    const otherCal = await r.ask("PATCH", `/calendar/calendars/${theirCalendar}`, { shown: false });
    const randomCal = await r.ask("PATCH", `/calendar/calendars/${randomUUID()}`, { shown: false });
    expect([otherCal.status, await otherCal.text()]).toEqual([404, await randomCal.text()]);
    expect(JSON.stringify([await connectionsOf(r.db, theirs.accountId), await credentialsOf(r.db, theirs.accountId), await changesOf(r.db, theirs.accountId)])).toBe(before);
    expect((await r.db.select({ shown: calCalendars.shown }).from(calCalendars).where(eq(calCalendars.id, theirCalendar)))[0]!.shown).toBe(true);
    // The control: each route is there and answers its owner.
    expect((await r.ask("POST", `/calendar/connections/${mine.id}/check`)).status).toBe(202);
    expect((await r.ask("POST", `/calendar/connections/${mine.id}/sign-in`, { address: "https://feeds.example.test/moved.ics" })).status).toBe(202);
    expect((await r.ask("PATCH", `/calendar/calendars/${myCalendar}`, { shown: false })).status).toBe(200);
    expect((await r.ask("DELETE", `/calendar/connections/${mine.id}`)).status).toBe(200);
    // And theirs is theirs to remove.
    expect((await r.ask("DELETE", `/calendar/connections/${their.id}`, undefined, {}, theirs)).status).toBe(200);
  });

  it("checks a connection once a minute: the first is taken and makes it due, a second inside the minute is refused", async () => {
    const r = await rig();
    const c = await connect(r, caldav("https://dav.studio.example.test/"));
    const { calendar } = await planted(r, r.s.accountId, c.id);
    await r.db.update(calConnections).set({ nextPollAt: new Date(FIXED_NOW.getTime() + 6 * 3_600_000), status: "failing", errorCode: "connection_failed" }).where(eq(calConnections.id, c.id));
    const first = await r.ask("POST", `/calendar/connections/${c.id}/check`);
    expect([first.status, (await first.json() as CalendarConnectionRecord).status, first.headers.get("x-sync-seq") !== null]).toEqual([202, "failing", true]);
    expect((await connectionsOf(r.db, r.s.accountId))[0]!.nextPollAt).toBeNull();
    expect((await r.db.select({ at: calCalendars.nextPollAt }).from(calCalendars).where(eq(calCalendars.id, calendar)))[0]!.at).toBeNull();
    const second = await r.ask("POST", `/calendar/connections/${c.id}/check`);
    expect([...(await errorOf(second)).slice(0, 2), second.headers.get("retry-after")]).toEqual([429, "rate_limited", "60"]);
    // The minute is the connection's, however its id is spelled: the same id in capitals is the same connection.
    expect((await r.ask("POST", `/calendar/connections/${c.id.toUpperCase()}/check`)).status).toBe(429);
    // Another connection has a minute of its own, and this one's passes.
    const d = await connect(r, ics("https://feeds.example.test/a.ics"));
    expect((await r.ask("POST", `/calendar/connections/${d.id}/check`)).status).toBe(202);
    r.clock.advance(61_000);
    expect((await r.ask("POST", `/calendar/connections/${c.id}/check`)).status).toBe(202);
    // A connection that waits for its person is not asked.
    await r.db.update(calConnections).set({ status: "reconnect", errorCode: "sign_in_refused" }).where(eq(calConnections.id, d.id));
    r.clock.advance(61_000);
    expect((await errorOf(await r.ask("POST", `/calendar/connections/${d.id}/check`))).slice(0, 2)).toEqual([409, "calendar_connection_stopped"]);
  });

  it("no route makes a connection due again once its check was taken (a turn has since read it)", async () => {
    const r = await rig();
    const password = made("pw");
    const dav = (await connect(r, caldav("https://dav.studio.example.test/", randomUUID(), password))).id;
    const file = (await connect(r, ics("https://feeds.example.test/a.ics"))).id;
    /** As a worker's turn leaves a connection it has just read: not due for six hours. */
    const read = async (id: string): Promise<void> => {
      await r.db.update(calConnections).set({ nextPollAt: new Date(FIXED_NOW.getTime() + 6 * 3_600_000) }).where(eq(calConnections.id, id));
    };
    const dueNow = async (id: string): Promise<boolean> => {
      const [row] = await r.db.select({ at: calConnections.nextPollAt }).from(calConnections).where(eq(calConnections.id, id));
      return row!.at === null || row!.at.getTime() <= FIXED_NOW.getTime();
    };
    const pulled: string[] = [];
    for (const id of [dav, file]) {
      await read(id);
      expect((await r.ask("POST", `/calendar/connections/${id}/check`)).status).toBe(202);
      await read(id);
      // The bound holds for the check itself.
      expect((await r.ask("POST", `/calendar/connections/${id}/check`)).status).toBe(429);
      expect(await dueNow(id)).toBe(false);
      for (let round = 0; round < 3; round++) {
        const body = id === dav ? { user: "mila", password } : { address: `https://target-${round}.example.test/a.ics` };
        const res = await r.ask("POST", `/calendar/connections/${id}/sign-in`, body);
        if (await dueNow(id)) pulled.push(`${id === dav ? "caldav, the same password" : "subscription, a new host"}: round ${round} answered ${res.status} and is due now`);
        await read(id);
      }
    }
    expect(pulled).toEqual([]);
  });

  it("a sign-in typed again inside that minute is kept and used within a minute: sealed, active, and never due at once", async () => {
    const r = await rig();
    const c = await connect(r, caldav("https://dav.studio.example.test/"));
    const { calendar } = await planted(r, r.s.accountId, c.id);
    // The next reading is written by the store's own clock, so the times planted here are this machine's.
    const far = new Date(Date.now() + 6 * 3_600_000);
    const over = randomUUID();
    await r.db.insert(calCalendars).values({
      id: over, accountId: r.s.accountId, connectionId: c.id, providerId: `cal-${over}`, name: "Old", access: "owner", errorCode: "ended", nextPollAt: far,
    });
    const timesOf = async (): Promise<(Date | null)[]> => [
      (await connectionsOf(r.db, r.s.accountId))[0]!.nextPollAt,
      ...(await Promise.all([calendar, over].map(async (id) =>
        (await r.db.select({ at: calCalendars.nextPollAt }).from(calCalendars).where(eq(calCalendars.id, id)))[0]!.at))),
    ];
    expect((await r.ask("POST", `/calendar/connections/${c.id}/check`)).status).toBe(202);
    // A turn has read it since and was refused: the connection waits for its person, far from its next reading.
    await r.db.update(calConnections).set({ status: "reconnect", errorCode: "sign_in_refused", nextPollAt: far }).where(eq(calConnections.id, c.id));
    await r.db.update(calCalendars).set({ nextPollAt: far }).where(eq(calCalendars.id, calendar));
    const pw = made("pw");
    const before = Date.now();
    const res = await r.ask("POST", `/calendar/connections/${c.id}/sign-in`, { user: "mila", password: pw });
    expect([res.status, await res.json()]).toMatchObject([202, { id: c.id, status: "active", errorCode: null }]);
    expect((await opened(r, r.s.accountId)).includes(pw)).toBe(true);
    // A minute from the sign-in at the latest, and not before: the connection and the calendar that is still read.
    const [connectionAt, calendarAt, overAt] = await timesOf();
    for (const at of [connectionAt, calendarAt]) {
      expect(at !== null && at.getTime() >= before + 59_000 && at.getTime() <= Date.now() + 60_000, String(at?.toISOString())).toBe(true);
    }
    expect(overAt).toEqual(far);
    // One that is due already stays due: a sign-in inside the minute moves nothing a minute off.
    await r.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.id, c.id));
    await r.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.id, calendar));
    expect((await r.ask("POST", `/calendar/connections/${c.id}/sign-in`, { user: "mila", password: made("pw") })).status).toBe(202);
    expect(await timesOf()).toEqual([null, null, far]);
  });

  it("signs a connection in again: the sealed sign-in is replaced, the connection is active and due, and one change says so", async () => {
    const r = await rig();
    const c = await connect(r, caldav("https://dav.studio.example.test/"));
    await r.db.update(calConnections).set({ status: "reconnect", errorCode: "sign_in_refused", nextPollAt: new Date(FIXED_NOW.getTime() + 86_400_000) })
      .where(eq(calConnections.id, c.id));
    const was = await opened(r, r.s.accountId);
    const pw = made("pw");
    const res = await r.ask("POST", `/calendar/connections/${c.id}/sign-in`, { user: "mila", password: pw });
    expect([res.status, res.headers.get("x-sync-seq") !== null]).toEqual([202, true]);
    expect(await res.json()).toMatchObject({ id: c.id, status: "active", errorCode: null });
    expect((await connectionsOf(r.db, r.s.accountId))[0]).toMatchObject({ status: "active", errorCode: null, nextPollAt: null });
    const now = await opened(r, r.s.accountId);
    expect([now.includes(pw), now === was, (await credentialsOf(r.db, r.s.accountId)).length]).toEqual([true, false, 1]);
    expect(await changesOf(r.db, r.s.accountId)).toEqual(["calendar_connection:create", "calendar_connection:update"]);
    // A sign-in of the other kind is not this connection's, and a forbidden address is refused here as at the connect.
    expect((await errorOf(await r.ask("POST", `/calendar/connections/${c.id}/sign-in`, { address: "https://feeds.example.test/a.ics" }))).slice(0, 2))
      .toEqual([400, "validation_failed"]);
    const sub = await connect(r, ics("https://feeds.example.test/a.ics"));
    expect(await errorOf(await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "http://10.0.0.5/a.ics" })))
      .toEqual([400, "validation_failed", "address_not_allowed"]);
    const moved = await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://calendars.example.test/a.ics" });
    expect((await moved.json() as CalendarConnectionRecord).serverHost).toBe("calendars.example.test");
  });

  it("a server's sign-in typed again is sealed for the server its connect typed, never for one read off its row: where the row's server was moved, or the kept sign-in does not open for this connection, nothing is sealed and the person connects again", async () => {
    const r = await rig();
    const START = "https://dav.studio.example.test/remote.php/dav";
    const APPLE = "https://caldav.icloud.com/";
    const ELSEWHERE = "https://dav.elsewhere.example.net/";
    const dav = await connect(r, caldav(START));
    const cloud = await connect(r, icloud());
    const beside = await connect(r, caldav("https://dav.beside.example.test/"));
    const keptOf = async (id: string) => (await credentialsOf(r.db, r.s.accountId)).filter((c) => c.connectionId === id)[0]!;
    const openedOf = async (id: string): Promise<Record<string, unknown>> => {
      const k = await keptOf(id);
      return JSON.parse(await r.deps.keyProvider.decrypt(k.secretEnc, k.keyVersion)) as Record<string, unknown>;
    };
    // Sealed at the connect: the start as it was placed, beside what was typed. At iCloud it is Apple's own.
    expect([(await openedOf(dav.id)).server, (await openedOf(cloud.id)).server]).toEqual([START, APPLE]);
    // Typed again: what was typed replaces what was typed, and the server is the one the kept sign-in was sealed for.
    const pw = made("pw");
    expect((await r.ask("POST", `/calendar/connections/${dav.id}/sign-in`, { user: "mila-again", password: pw })).status).toBe(202);
    expect(await openedOf(dav.id)).toEqual({ v: 2, account: r.s.accountId, connection: dav.id, kind: "basic", server: START, user: "mila-again", password: pw });

    /** The connection's row, its sealed sign-in's row and the account's changes: what a refused sign-in leaves as it stood. */
    const standing = async (id: string): Promise<string> => JSON.stringify([
      await r.db.select().from(calConnections).where(eq(calConnections.id, id)),
      await r.db.select().from(calCredentials).where(eq(calCredentials.connectionId, id)),
      await changesOf(r.db, r.s.accountId),
    ]);
    const typed: string[] = [];
    /** The sign-in typed again as the row stands now: refused with the door's word, and nothing written. */
    const refused = async (id: string, why: string): Promise<void> => {
      const before = await standing(id);
      typed.push(made("mkpw"));
      const res = await r.ask("POST", `/calendar/connections/${id}/sign-in`, { user: "mila", password: typed[typed.length - 1] });
      expect([why, ...await errorOf(res)]).toEqual([why, 400, "validation_failed", "sign_in_incomplete"]);
      expect([why, await standing(id) === before]).toEqual([why, true]);
    };
    const serverIs = (id: string, serverUrl: string | null) => r.db.update(calConnections).set({ serverUrl }).where(eq(calConnections.id, id));
    const keptIs = (id: string, k: { secretEnc: string; keyVersion: number }) =>
      r.db.update(calCredentials).set({ secretEnc: k.secretEnc, keyVersion: k.keyVersion }).where(eq(calCredentials.connectionId, id));

    // The row's server written by somebody who holds no key: to another host, to another path of the same host, to none.
    for (const [id, own] of [[dav.id, START], [cloud.id, APPLE]] as const) {
      for (const to of [ELSEWHERE, `${own}/elsewhere`, null]) {
        await serverIs(id, to);
        await refused(id, `the row's server reads ${to === null ? "nothing" : to === ELSEWHERE ? "another host" : "another path"}`);
      }
      await serverIs(id, own);
    }
    // The kept sign-in is another connection's, is opened by no key of this host, or is gone.
    const own = await keptOf(dav.id);
    await keptIs(dav.id, await keptOf(beside.id));
    await refused(dav.id, "the kept sign-in is another connection's");
    await keptIs(dav.id, { secretEnc: "sealed-by-nobody", keyVersion: own.keyVersion });
    await refused(dav.id, "the kept sign-in opens with no key of this host");
    await r.db.delete(calCredentials).where(eq(calCredentials.connectionId, dav.id));
    await refused(dav.id, "the kept sign-in is gone");
    // No refusal carried what was typed, in its answer or in a line of the log.
    const said = [r.answers.join("\n"), r.lines.join("\n")].join("\n");
    expect(typed.filter((t) => said.includes(t))).toEqual([]);
    // The controls: the connection beside it was never touched and takes its sign-in, and so does iCloud's with its row as it was.
    for (const id of [beside.id, cloud.id]) {
      expect((await r.ask("POST", `/calendar/connections/${id}/sign-in`, { user: "mila", password: made("pw") })).status).toBe(202);
    }
    expect([(await openedOf(beside.id)).server, (await openedOf(cloud.id)).server]).toEqual(["https://dav.beside.example.test/", APPLE]);
  });

  it("a subscription's address typed again forgets where the old address's reading stood, with the address and never without it; a server's sign-in typed again forgets nothing", async () => {
    const r = await rig();
    const sub = await connect(r, ics("https://feeds.example.test/a.ics"));
    const dav = await connect(r, caldav("https://dav.studio.example.test/"));
    // Where a reading stands is the calendar's token: for a subscription, the old address's validators and the hash of its text.
    const stood = JSON.stringify({ v: 1, e: '"v7"', m: "Fri, 13 Nov 2026 08:00:00 GMT", h: "the-old-text-hashed", r: 3_600_000 });
    const [feed, work] = [randomUUID(), randomUUID()];
    await r.db.insert(calCalendars).values([
      { id: feed, accountId: r.s.accountId, connectionId: sub.id, providerId: "subscription", name: "Team", access: "reader", syncToken: stood },
      { id: work, accountId: r.s.accountId, connectionId: dav.id, providerId: "/cal/work/", name: "Work", access: "owner", syncToken: "sync:token-7" },
    ]);
    const tokens = async (): Promise<Record<string, string | null>> => Object.fromEntries((await r.db.select({ id: calCalendars.id, token: calCalendars.syncToken })
      .from(calCalendars).where(eq(calCalendars.accountId, r.s.accountId))).map((c) => [c.id, c.token]));
    const sealedNow = async (): Promise<string> => JSON.stringify(await credentialsOf(r.db, r.s.accountId));

    // An address that is refused replaces nothing and forgets nothing.
    expect((await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "http://10.0.0.5/a.ics" })).status).toBe(400);
    expect(await tokens()).toEqual({ [feed]: stood, [work]: "sync:token-7" });

    // One transaction: a sign-in that dies on its way is neither kept nor has it forgotten anything.
    const before = await sealedNow();
    await r.db.execute(sql.raw("create function sign_in_cut_short() returns trigger language plpgsql as $$ begin raise exception 'cut short'; end $$"));
    await r.db.execute(sql.raw("create trigger sign_in_cut_short before insert on change_log for each row execute function sign_in_cut_short()"));
    const cut = await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://calendars.example.test/a.ics" });
    await r.db.execute(sql.raw("drop trigger sign_in_cut_short on change_log"));
    expect(cut.status).toBe(500);
    expect([await tokens(), await sealedNow() === before]).toEqual([{ [feed]: stood, [work]: "sync:token-7" }, true]);

    // The new address is kept: the old address's validators and text hash are gone with the old address.
    expect((await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://calendars.example.test/a.ics" })).status).toBe(202);
    expect([await tokens(), await sealedNow() === before]).toEqual([{ [feed]: null, [work]: "sync:token-7" }, false]);
    // Inside the connection's minute a sign-in is kept all the same, and forgets all the same.
    await r.db.update(calCalendars).set({ syncToken: stood }).where(eq(calCalendars.id, feed));
    expect((await r.ask("POST", `/calendar/connections/${sub.id}/sign-in`, { address: "https://third.example.test/a.ics" })).status).toBe(202);
    expect(await tokens()).toEqual({ [feed]: null, [work]: "sync:token-7" });
    // A server's address does not change with its sign-in: where its calendars' readings stand is kept.
    expect((await r.ask("POST", `/calendar/connections/${dav.id}/sign-in`, { user: "mila", password: made("pw") })).status).toBe(202);
    expect(await tokens()).toEqual({ [feed]: null, [work]: "sync:token-7" });
  });

  it("removes a connection with everything that hangs on it, each record's deletion recorded, and leaves the others", async () => {
    const r = await rig();
    const gone = await connect(r, caldav("https://dav.studio.example.test/"));
    const stays = await connect(r, ics("https://feeds.example.test/a.ics"));
    const a = await planted(r, r.s.accountId, gone.id);
    const b = await planted(r, r.s.accountId, stays.id);
    await r.db.update(calSettings).set({ newEventsCalendarId: a.calendar }).where(eq(calSettings.accountId, r.s.accountId));
    const res = await r.ask("DELETE", `/calendar/connections/${gone.id}`);
    expect([res.status, await res.json(), res.headers.get("x-sync-seq") !== null]).toEqual([200, { removed: true }, true]);
    expect((await connectionsOf(r.db, r.s.accountId)).map((c) => c.id)).toEqual([stays.id]);
    expect((await credentialsOf(r.db, r.s.accountId)).map((c) => c.connectionId)).toEqual([stays.id]);
    expect((await r.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, r.s.accountId))).map((c) => c.id)).toEqual([b.calendar]);
    expect((await r.db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.accountId, r.s.accountId))).map((e) => e.id)).toEqual([b.event]);
    expect((await r.db.select({ id: calAttendees.eventId }).from(calAttendees).where(eq(calAttendees.accountId, r.s.accountId))).map((e) => e.id)).toEqual([b.event]);
    expect((await r.db.select({ event: calAlarms.eventId, calendar: calAlarms.calendarId }).from(calAlarms).where(eq(calAlarms.accountId, r.s.accountId)))
      .map((x) => x.event ?? x.calendar).sort()).toEqual([b.event, b.calendar].sort());
    expect((await r.db.select({ id: calWrites.calendarId }).from(calWrites).where(eq(calWrites.accountId, r.s.accountId))).map((x) => x.id)).toEqual([b.calendar]);
    // Every table the store says goes with its connection was planted above and is looked at here: a
    // seventh one makes this line red until a removal is shown to take it.
    expect(Object.entries(CALENDAR_TABLES).filter(([, t]) => t.sweep === "connection").map(([name]) => name).sort())
      .toEqual(["cal_alarms", "cal_attendees", "cal_calendars", "cal_credentials", "cal_events", "cal_writes"]);
    expect((await r.db.select({ id: calSettings.newEventsCalendarId }).from(calSettings).where(eq(calSettings.accountId, r.s.accountId)))[0]!.id).toBeNull();
    const deletes = await r.db.select({ kind: changeLog.entityType, id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, r.s.accountId), eq(changeLog.op, "delete"))).orderBy(changeLog.seq);
    expect(deletes.map((d) => [d.kind, d.id])).toEqual([["calendar_event", a.event], ["calendar", a.calendar], ["calendar_connection", gone.id]]);
    expect((await r.ask("DELETE", `/calendar/connections/${gone.id}`)).status).toBe(404);
  });

  it("a removal cut short keeps no sealed sign-in, lets nothing but the removal act on the connection, and the removal asked again finishes", async () => {
    const r = await rig();
    const c = await connect(r, caldav("https://dav.studio.example.test/"));
    const calendar = randomUUID();
    await r.db.insert(calCalendars).values({
      id: calendar, accountId: r.s.accountId, connectionId: c.id, providerId: `cal-${calendar}`, name: "Studio", access: "owner",
    });
    await r.db.insert(calEvents).values({
      accountId: r.s.accountId, calendarId: calendar, providerId: `ev-${calendar}`, uid: `uid-${calendar}`, title: "Glaze firing",
      startKind: "instant", startLocal: "20261117T090000Z", startsAt: new Date("2026-11-17T09:00:00Z"),
      endKind: "instant", endLocal: "20261117T100000Z", endsAt: new Date("2026-11-17T10:00:00Z"),
    });
    const sealed = () => r.db.select({ kind: calCredentials.kind }).from(calCredentials)
      .where(and(eq(calCredentials.accountId, r.s.accountId), eq(calCredentials.connectionId, c.id)));
    const statusOf = async () => (await r.db.select({ status: calConnections.status }).from(calConnections)
      .where(eq(calConnections.id, c.id)))[0]?.status ?? null;
    expect((await sealed()).length).toBe(1);

    // The request dies where the connection's own row would go: a trigger of this test's own store, dropped before anything is read.
    await r.db.execute(sql.raw(
      "create function removal_cut_short() returns trigger language plpgsql as $$ begin raise exception 'cut short'; end $$",
    ));
    await r.db.execute(sql.raw(
      "create trigger removal_cut_short before delete on cal_connections for each row execute function removal_cut_short()",
    ));
    const cut = await r.ask("DELETE", `/calendar/connections/${c.id}`);
    await r.db.execute(sql.raw("drop trigger removal_cut_short on cal_connections"));
    expect(cut.status).toBe(500);

    // What the first transaction left: the connection marked, and its sealed sign-in already gone.
    expect(await statusOf()).toBe("removing");
    expect(await sealed()).toEqual([]);

    // Nothing but the removal acts on it: no check, no sign-in typed again, nothing of a calendar's own.
    const acted = [
      await codeOf(await r.ask("POST", `/calendar/connections/${c.id}/check`)),
      await codeOf(await r.ask("POST", `/calendar/connections/${c.id}/sign-in`, { user: "mila", password: made("pw") })),
      await codeOf(await r.ask("PATCH", `/calendar/calendars/${calendar}`, { shown: false })),
    ];
    expect(acted).toEqual([
      [409, "calendar_connection_stopped"], [409, "calendar_connection_stopped"], [409, "calendar_connection_stopped"],
    ]);
    expect([await statusOf(), await sealed()]).toEqual(["removing", []]);

    // The removal asked again goes on where the first stopped, and ends with nothing of the connection left.
    const again = await r.ask("DELETE", `/calendar/connections/${c.id}`);
    expect([again.status, await again.json()]).toEqual([200, { removed: true }]);
    expect(await statusOf()).toBeNull();
    expect(await r.db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.accountId, r.s.accountId))).toEqual([]);
    expect(await r.db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.accountId, r.s.accountId))).toEqual([]);
  });

  it("sets what is the person's own of a calendar: shown always, a name and a colour on a subscription's calendar only", async () => {
    const r = await rig();
    const dav = await connect(r, caldav("https://dav.studio.example.test/"));
    const sub = await connect(r, ics("https://feeds.example.test/a.ics"));
    const listed = (await planted(r, r.s.accountId, dav.id)).calendar;
    const file = (await planted(r, r.s.accountId, sub.id)).calendar;
    const hidden = await r.ask("PATCH", `/calendar/calendars/${listed}`, { shown: false });
    expect([hidden.status, (await hidden.json() as CalendarRecord).shown, hidden.headers.get("x-sync-seq") !== null]).toEqual([200, false, true]);
    const same = await r.ask("PATCH", `/calendar/calendars/${listed}`, { shown: false });
    expect([same.status, same.headers.get("x-sync-seq")]).toEqual([200, null]);
    expect((await errorOf(await r.ask("PATCH", `/calendar/calendars/${listed}`, { name: "Mine" }))).slice(0, 2)).toEqual([409, "calendar_read_only"]);
    const named = await r.ask("PATCH", `/calendar/calendars/${file}`, { name: "  Holidays  ", color: "#AA3311" });
    const record = await named.json() as CalendarRecord;
    expect(record).toMatchObject({ id: file, name: "Holidays", color: "#aa3311", shown: true });
    // A calendar's record says nothing of being the default: which calendar new events go to is the settings' one member.
    expect(Object.keys(record).sort()).toEqual([
      "access", "color", "connectionId", "defaultAlarms", "errorCode", "id", "lastSyncedAt", "name", "shown", "timeZone", "updatedAt", "window",
    ]);
    for (const bad of [{}, { shown: "no" }, { name: "" }, { name: "x".repeat(300) }, { color: "red" }, { isDefault: true }]) {
      expect((await errorOf(await r.ask("PATCH", `/calendar/calendars/${file}`, bad))).slice(0, 2), JSON.stringify(bad)).toEqual([400, "validation_failed"]);
    }
    const feed = await (await r.ask("GET", "/sync?since=0&types=settings,calendar")).json() as SyncResponse;
    expect([...feed.changes.creates, ...feed.changes.updates].filter((c) => c.type === "calendar").map((c) => c.id).sort()).toEqual([listed, file].sort());
  });
});

/**
 * WHY THE DOOR ASKS NO SECOND FACTOR. A recent factor guards, at the mailbox doors, an edit that
 * keeps a stored password and moves the host it is sent to. Here no route can make that edit: of
 * the routes that name a connection that stands, none takes a server, and an address is taken
 * only as a subscription's whole sign-in. This case holds it over all six routes: whatever a body
 * names beside what its route takes, the place a connection's sign-in is sent to moves only in a
 * request that typed that sign-in whole, and then the sealed text holds what was typed. Of what
 * was kept it holds one thing: the server a CalDAV connection was typed with at its connect,
 * which no request names. The wire's own types hold the same at compile time (`routes.ts`).
 */
describe("no route sends a kept sign-in to a place a request names", () => {
  const ELSEWHERE = "https://elsewhere.example.test/";
  /** Every name a request could give a place under. */
  const PLACE_NAMES = ["server", "serverUrl", "server_url", "sourceHost", "source_host", "host", "url", "start", "address", "principal"] as const;

  it("a connection's place moves only with its sign-in typed whole in the same request, and a sign-in typed again replaces what was typed whole and is sealed for no server a request names", async () => {
    const r = await rig();
    const o = await r.other();
    /** The server the CalDAV connection is typed with at its connect: the one server its sealed sign-in ever names. */
    const CONNECTED = "https://dav.studio.example.test/dav";
    const dav = await connect(r, { ...caldav(CONNECTED), user: "mila" });
    const sub = await connect(r, ics(`https://feeds.example.test/${made("mk")}/a.ics`));
    const theirs = await connect(r, caldav("https://dav.their.example.test/"), o);
    const davCalendar = randomUUID();
    await r.db.insert(calCalendars).values({ id: davCalendar, accountId: r.s.accountId, connectionId: dav.id, providerId: "/cal/work/", name: "Work", access: "owner" });

    /** Where a connection's sign-in is sent, and the sealed sign-in opened: all a request could move. */
    const standing = async (accountId: string, id: string): Promise<{ place: unknown; sealed: Record<string, unknown> | null }> => {
      const [c] = (await connectionsOf(r.db, accountId)).filter((x) => x.id === id);
      const [k] = (await credentialsOf(r.db, accountId)).filter((x) => x.connectionId === id);
      return {
        place: c === undefined ? null : [c.serverUrl, c.sourceHost],
        sealed: k === undefined ? null : JSON.parse(await r.deps.keyProvider.decrypt(k.secretEnc, k.keyVersion)) as Record<string, unknown>,
      };
    };
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const theirsBefore = await standing(o.accountId, theirs.id);
    const answered: string[] = [];

    /**
     * One request, and the rule read off the store around it. `whole` is the sign-in the body
     * typed whole, where it typed one: only then may the place move, and the sealed text must be
     * exactly it.
     */
    const asked = async (
      id: string, method: string, path: string, body: unknown, whole: Record<string, unknown> | null = null,
    ): Promise<number> => {
      const before = await standing(r.s.accountId, id);
      const res = await r.ask(method, path, body, method === "POST" && path === "/calendar/connections" ? key() : {});
      const after = await standing(r.s.accountId, id);
      const label = `${method} ${path.replace(id, ":id")} ${JSON.stringify(Object.keys((body ?? {}) as object))}`;
      const moved = !same(after.place, before.place);
      const kept = same(after.sealed, before.sealed);
      expect([label, moved && kept], "the place moved and the sign-in was kept").toEqual([label, false]);
      if (moved || !kept) {
        // Nothing but a sign-in typed whole changes either, and then the sealed text is what was typed: no typed member of the old one stays.
        expect([label, res.status, whole !== null]).toEqual([label, 202, true]);
        expect(after.sealed, label).toEqual({ v: 2, account: r.s.accountId, connection: id, ...whole });
      }
      // Neither the place nor the sealed text ever names what a request named.
      expect(JSON.stringify([after.place, after.sealed]).includes("elsewhere.example.test"), label).toBe(false);
      answered.push(`${res.status} ${label}`);
      return res.status;
    };

    // GET: no body; a query that names a place is no part of it.
    expect(await asked(dav.id, "GET", `/calendar/connect?server=${encodeURIComponent(ELSEWHERE)}`, undefined)).toBe(200);
    // POST connect under the id of a connection that stands, mine or another account's, with another server and sign-in: the id is taken.
    for (const id of [dav.id, theirs.id]) {
      expect(await asked(dav.id, "POST", "/calendar/connections", { ...caldav(ELSEWHERE), connectionId: id, user: "mila" })).toBe(400);
      expect(await asked(sub.id, "POST", "/calendar/connections", { ...ics(`${ELSEWHERE}a.ics`), connectionId: sub.id })).toBe(400);
    }
    // A check takes no body: one that names a place under any name is not read.
    expect(await asked(dav.id, "POST", `/calendar/connections/${dav.id}/check`, Object.fromEntries(PLACE_NAMES.map((n) => [n, ELSEWHERE])))).toBe(202);

    // A sign-in typed again. A place named WITHOUT a whole sign-in is refused; the address of another kind of sign-in is refused.
    for (const name of PLACE_NAMES) {
      const signIn = `/calendar/connections/${dav.id}/sign-in`;
      for (const part of [{}, { user: "mila" }, { password: made("pw") }]) {
        expect(await asked(dav.id, "POST", signIn, { ...part, [name]: ELSEWHERE }), name).toBe(400);
      }
      // Beside a sign-in typed whole, a place under a name the door does not read moves nothing: the server stays the
      // connection's own, in its row and in the sealed text, which names the server the connect typed.
      const typed = { user: `mila-${name}`, password: made("pw") };
      const status = await asked(dav.id, "POST", signIn, { ...typed, [name]: ELSEWHERE }, { kind: "basic", server: CONNECTED, ...typed });
      expect(status, name).toBe(name === "address" ? 400 : 202);
      // A calendar's own fields: a member the door does not know is refused.
      expect(await asked(dav.id, "PATCH", `/calendar/calendars/${davCalendar}`, { shown: false, [name]: ELSEWHERE }), name).toBe(400);
    }
    expect((await standing(r.s.accountId, dav.id)).place).toEqual([CONNECTED, "dav.studio.example.test"]);

    // A subscription's address IS its sign-in: typed again it moves the host, and the sealed text is that address and nothing kept.
    const next = `https://calendars.example.test/${made("mk")}/b.ics`;
    expect(await asked(sub.id, "POST", `/calendar/connections/${sub.id}/sign-in`, { address: next }, { kind: "address", url: next })).toBe(202);
    expect((await standing(r.s.accountId, sub.id)).place).toEqual([null, "calendars.example.test"]);
    const third = `https://third.example.test/${made("mk")}/c.ics`;
    expect(await asked(sub.id, "POST", `/calendar/connections/${sub.id}/sign-in`, { address: third, server: ELSEWHERE, host: ELSEWHERE }, { kind: "address", url: third })).toBe(202);
    for (const beside of [{ user: "mila" }, { password: made("pw") }, { user: "mila", password: made("pw") }]) {
      expect(await asked(sub.id, "POST", `/calendar/connections/${sub.id}/sign-in`, { address: `${ELSEWHERE}d.ics`, ...beside })).toBe(400);
    }
    expect(await asked(sub.id, "POST", `/calendar/connections/${sub.id}/sign-in`, { user: "mila", password: made("pw") })).toBe(400);

    // A removal takes no body, and leaves no sign-in that could be sent anywhere.
    const removal = await r.ask("DELETE", `/calendar/connections/${dav.id}`, { server: ELSEWHERE });
    expect([removal.status, await standing(r.s.accountId, dav.id)]).toEqual([200, { place: null, sealed: null }]);
    // Nothing of another account's moved, and the case asked what it says: every route of the six, each kind of answer.
    expect(await standing(o.accountId, theirs.id)).toEqual(theirsBefore);
    expect([...new Set(answered.map((a) => a.split(" ").slice(0, 3).join(" ")))].sort()).toEqual([
      "200 GET /calendar/connect?server=https%3A%2F%2Felsewhere.example.test%2F", "202 POST /calendar/connections/:id/check",
      "202 POST /calendar/connections/:id/sign-in", "400 PATCH /calendar/calendars/" + davCalendar, "400 POST /calendar/connections",
      "400 POST /calendar/connections/:id/sign-in",
    ]);
  });
});
