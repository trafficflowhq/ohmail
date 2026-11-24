/**
 * A SUBSCRIPTION'S ADDRESS TYPED AGAIN WHILE ITS OLD ADDRESS IS BEING READ, on a real Postgres with
 * the door and the worker's own turn. The door forgets where the old address's reading stood, in
 * the transaction that replaces the sealed address. A reading of the old address that is under way
 * at that instant ends AFTER that, and writes where it stood (the old address's validators and the
 * hash of its text) onto the calendar that is now the new address's. What then keeps the old
 * validators from the new address is the reader's own guard: it sends a validator to no address
 * but the one it came from. This case holds that race; the reader's unit case holds the guard alone.
 *
 * A root test, because it holds the routes and the worker's pass together and neither imports the
 * other. Both addresses are this machine's own.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { AVAILABLE, ZONES, depsFor, openWorld, type World } from "../packages/organizer/test/_calendar-world.js";
import { makeDeps, req, seedSession } from "../packages/api/test/helpers.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const NO_WAY = { on: false, configured: false };
const file = (uid: string, title: string): string => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//address typed again//EN",
  "BEGIN:VEVENT", `UID:${uid}@studio.example.test`, "DTSTAMP:20261113T120000Z", "DTSTART:20261117T090000Z",
  "DTEND:20261117T100000Z", `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

describe.skipIf(!AVAILABLE)("a subscription's address typed again while its old address is being read, on Postgres", () => {
  let w: World;
  let served: OwnedDb;
  let files: Server;
  let port = 0;
  let oldAsks = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  let arrived: () => void = () => {};
  const secondOldAsk = new Promise<void>((r) => { arrived = r; });
  /** Every request the new address was sent: the validators it carried, and what it was answered. */
  const toNew: { ifNoneMatch: string | null; ifModifiedSince: string | null; status: number }[] = [];

  beforeAll(async () => {
    w = await openWorld(8);
    served = makeOwnedDb(PG_TEST_URL, { role: "api" });
    files = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/old/a.ics") {
        oldAsks += 1;
        // The first turn asks twice (its listing, its reading). The third ask is the second turn's reading: held until the address was typed again.
        if (oldAsks === 3) { arrived(); await held; }
        return void response.writeHead(200, { "content-type": "text/calendar", "last-modified": "Mon, 16 Nov 2026 08:00:00 GMT" }).end(file("old", "From the old address"));
      }
      if (url.pathname === "/new/a.ics") {
        const ifNoneMatch = (request.headers["if-none-match"] as string | undefined) ?? null;
        const ifModifiedSince = (request.headers["if-modified-since"] as string | undefined) ?? null;
        // A server that honours a date validator as servers do: its own file is older than 16 November.
        const status = ifModifiedSince !== null ? 304 : 200;
        toNew.push({ ifNoneMatch, ifModifiedSince, status });
        if (status === 304) return void response.writeHead(304).end();
        return void response.writeHead(200, { "content-type": "text/calendar", "last-modified": "Sun, 01 Nov 2026 08:00:00 GMT" }).end(file("new", "From the new address"));
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((done) => files.listen(0, "127.0.0.1", done));
    port = (files.address() as AddressInfo).port;
  }, 120_000);
  afterAll(async () => {
    // A red case must not leave the held reading open: the server would never close.
    release();
    await new Promise<void>((done) => files.close(() => done()));
    await served?.close();
    await w?.close();
  });

  it("the reading under way ends after the door's reset, and the new address is still sent no validator of the old one and read whole", async () => {
    const { deps } = await makeDeps(new Date());
    // The api role's pool, minted for the request as the host mints its own: bound to nothing.
    deps.db = bindDb(served.db, { account: null });
    deps.now = () => new Date();
    deps.keyProvider = w.keys;
    deps.logger = createLogger({ service: "api", level: "debug", sink: () => {} });
    deps.services = { ...deps.services, calendar: calendarFeed, calendarConnect: { policy: "own-network", ceremonies: { google: NO_WAY, microsoft: NO_WAY } } } as never;
    const s = await seedSession(w.db as never, { now: new Date() });
    await w.db.insert(calSettings).values({ accountId: s.accountId, enabledAt: new Date() });
    const ask = (method: string, path: string, body: unknown, key = false): Promise<Response> => app.handle(
      req(method, path, { bearer: s.token, body: JSON.stringify(body), headers: { "x-requested-with": "ohmail", ...(key ? { "idempotency-key": randomUUID() } : {}) } }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
    const made = await ask("POST", "/calendar/connections", { way: "ics", connectionId: randomUUID(), address: `http://127.0.0.1:${port}/old/a.ics` }, true);
    expect(made.status).toBe(202);
    const id = (await made.json() as CalendarConnectionRecord).id;

    const nobody: HostResolver = { resolve: async () => [] };
    const providers = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: nobody, policy: { kind: "own-network" },
      enabled: new Set(["ics", "caldav"] as const), microsoft: null, writes: true,
    });
    const due = { accountId: s.accountId, id, provider: "ics" as const, status: "active" as const };
    const tokenNow = async (): Promise<string | null> =>
      (await w.sql<{ t: string | null }[]>`select sync_token as t from cal_calendars where connection_id = ${id}`)[0]?.t ?? null;
    const titles = async (): Promise<string[]> => (await w.sql<{ title: string }[]>`
      select e.title from cal_events e join cal_calendars k on k.id = e.calendar_id where k.connection_id = ${id} order by 1`).map((e) => e.title);
    const dueAgain = async (): Promise<void> => {
      await w.sql`update cal_calendars set next_poll_at = null where connection_id = ${id}`;
      await w.sql`update cal_connections set next_poll_at = null where id = ${id}`;
    };

    // A first turn of the OLD address, whole: the calendar now stands at the old address's validators and text hash.
    await calendarSyncPass(depsFor(w, providers), due, new AbortController().signal);
    expect(await titles()).toEqual(["From the old address"]);
    await dueAgain();
    // A second turn of the OLD address begins: its reading is held at the server.
    const turn = calendarSyncPass(depsFor(w, providers), due, new AbortController().signal);
    await secondOldAsk;
    // The address is typed again while that reading is under way: sealed, and where the reading stood forgotten.
    const again = await ask("POST", `/calendar/connections/${id}/sign-in`, { address: `http://127.0.0.1:${port}/new/a.ics` });
    expect([again.status, await tokenNow()]).toEqual([202, null]);
    // The old reading ends now, after the reset.
    release();
    await turn;
    // The next reading, under the new address.
    await dueAgain();
    await calendarSyncPass(depsFor(w, providers), due, new AbortController().signal);
    // No validator of the old address went to the new one, and the new address's file was read whole.
    expect(toNew.length).toBeGreaterThan(0);
    expect(toNew.map((a) => [a.ifNoneMatch, a.ifModifiedSince, a.status])).toEqual(toNew.map(() => [null, null, 200]));
    expect(await titles()).toEqual(["From the new address"]);
  }, 120_000);
});
