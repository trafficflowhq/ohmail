/**
 * WHERE A CALDAV PASSWORD GOES, TURN AFTER TURN, on a real Postgres: the door seals the sign-in, the
 * organizer's own turn opens it, and the real CalDAV reader and writer ask two servers on this
 * machine through the real request port. The servers stand under two names of one parent, the way
 * a host of somebody else's stands beside a person's own at a dynamic-DNS service; each would take
 * the same password, so `WITH THE PASSWORD` in what one heard says the very sign-in arrived there.
 *
 * The password goes to the server it was sealed for, and to a host that server itself named in the
 * same turn. An address in a stored row names no host: not a calendar's, not an event's, not through
 * a redirect, not at another port of the sealed server's own host. A server that keeps its calendars
 * on a host beside the typed one is still read every turn, because the port asks it again where they
 * are; a host it no longer names is not asked, and the connection says so and waits.
 *
 * A root test, because it holds the routes and the organizer's pass together and neither imports the
 * other. Every name is on a reserved domain and resolves to this machine.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "@ohmail/cal-providers";
import { createLogger } from "@trafficflow/core";
import { pinnedHttpRequest, type HostResolver } from "@trafficflow/core/net";
import { bindDb, calSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import { calendarFeed } from "@trafficflow/services/calendar";
import { mailboxCredentials } from "@trafficflow/db/mail";
import type { CalendarConnectionRecord } from "@ohmail/wire";
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { calendarWriteDrain } from "../packages/organizer/src/calendar/write-drain.js";
import { AVAILABLE, ZONES, capturedLog, depsFor, openWorld, providersOf, recordWrite, type World } from "../packages/organizer/test/_calendar-world.js";
import { makeDeps, req, seedMailbox, seedSession } from "../packages/api/test/helpers.js";
import { makeReader, makeWriter } from "../packages/cal-providers/src/caldav/index.js";
import { guardedRequest } from "../packages/cal-providers/src/request/guarded.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "../packages/cal-providers/test/caldav-stand-in.js";

const app = createApp([...apiRoutes, ...calendarRoutes]);
const NO_WAY = { on: false, configured: false };
/** The host a person types, a host beside it under the same parent, and another such host the server may move the calendars to. */
const TYPED = "dav.home.example.test";
const BESIDE = "pool.home.example.test";
const MOVED = "pool2.home.example.test";
const resolver: HostResolver = { resolve: async (name) => ([TYPED, BESIDE, MOVED].includes(name) ? ["127.0.0.1"] : []) };
const at = (name: string, server: StandIn, path: string): string => `http://${name}:${server.port}${path}`;
const DAY_MS = 24 * 3_600_000;

/**
 * The CalDAV provider as the worker composes it, for hosts that have names. The suite lets no socket
 * open to a name, so the last step is this file's: the request the gate cleared is sent to this
 * machine's own address under the name it was meant for. The gate, the sign-in's hosts and the
 * redirects are the real ones.
 */
function caldavByName(apple?: StandIn) {
  const http = guardedRequest({
    writes: true,
    resolver: apple ? {
      resolve: (name) => name === "caldav.icloud.com" ? Promise.resolve(["127.0.0.1"]) : resolver.resolve(name),
    } : resolver,
    policy: { kind: "own-network" },
    hosts: null,
    limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxBodyBytes: FETCH_BODY_MAX_BYTES },
    request: (url, opts) => {
      const named = new URL(url);
      const here = new URL(url);
      here.hostname = "127.0.0.1";
      if (apple && named.hostname === "caldav.icloud.com") {
        here.protocol = "http:";
        here.port = String(apple.port);
      }
      return pinnedHttpRequest(here.href, { ...opts, headers: { ...opts.headers, host: named.host } });
    },
  });
  const adapter = { http, clock: { now: () => Date.now() }, zones: ZONES };
  return providersOf({ caldav: { reader: makeReader(adapter), writer: makeWriter(adapter), http } });
}

const eventText = (uid: string, title: string): string => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN",
  "BEGIN:VEVENT", `UID:${uid}@studio.example.test`, "DTSTAMP:20261113T120000Z", "DTSTART:20261118T090000Z",
  "DTEND:20261118T100000Z", `SUMMARY:${title}`, "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

/** What a server heard, each request as one line: its method, the name it was meant for, its path, and whether the password came with it. */
const heard = (server: StandIn, from = 0): string[] =>
  server.seen.slice(from).map((s) => `${s.method} ${s.host.split(":")[0]} ${s.path} ${s.signedIn ? "WITH THE PASSWORD" : s.withCredential ? "with a sign-in" : "bare"}`);

describe.skipIf(!AVAILABLE)("where a CalDAV password goes, turn after turn, on Postgres", () => {
  let w: World;
  let served: OwnedDb;
  const servers: StandIn[] = [];
  const password = `pw${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    w = await openWorld(8);
    served = makeOwnedDb(PG_TEST_URL, { role: "api" });
  }, 120_000);
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await served?.close();
    await w?.close();
  });

  /** A server that takes the one password of this file, with a calendar `work` that holds one event. */
  async function server(options: StandInOptions = {}): Promise<StandIn> {
    const s = await startCalDavStandIn({ ...options, password });
    servers.push(s);
    s.addCalendar("work", { name: "Work" });
    s.put("work", "one.ics", eventText("one", "Kiln check"));
    return s;
  }

  /**
   * A person connects `start` at the door, on their own network, and a worker that keeps running
   * takes the connection's turns: one memory for all of them, so that only its first turn lists.
   */
  async function connected(start: string, options: { onePage?: boolean; apple?: StandIn } = {}) {
    const { deps } = await makeDeps(new Date());
    // The api role's pool, minted for the request as the host mints its own: bound to nothing.
    deps.db = bindDb(served.db, { account: null });
    deps.now = () => new Date();
    deps.keyProvider = w.keys;
    deps.logger = createLogger({ service: "api", level: "debug", sink: () => {} });
    deps.services = { ...deps.services, calendar: calendarFeed, calendarConnect: { policy: "own-network", ceremonies: { google: NO_WAY, microsoft: NO_WAY } } } as never;
    const s = await seedSession(w.db as never, { now: new Date(), ...(options.apple ? { lastTwofaAt: new Date() } : {}) });
    await w.db.insert(calSettings).values({ accountId: s.accountId, enabledAt: new Date() });
    const connectionId = randomUUID();
    let body: unknown = { way: "caldav", connectionId, server: start, user: "mila", password };
    if (options.apple) {
      const fromMailbox = await seedMailbox(w.db, { accountId: s.accountId, provider: "icloud" });
      const sealed = await w.keys.encrypt(`revoked-${password}`);
      await w.db.insert(mailboxCredentials).values({
        accountId: s.accountId, mailboxId: fromMailbox, transport: "imap",
        secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion,
        meta: { host: "imap.mail.me.com", user: options.apple.options.user },
      });
      body = { way: "icloud", connectionId, fromMailbox };
    }
    const made = await app.handle(
      req("POST", "/calendar/connections", {
        bearer: s.token, body: JSON.stringify(body),
        headers: { "x-requested-with": "ohmail", "idempotency-key": randomUUID() },
      }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
    expect(made.status).toBe(202);
    if (options.apple) expect((await made.clone().text()).includes(password)).toBe(false);
    const id = (await made.json() as CalendarConnectionRecord).id;
    const worker = depsFor(w, caldavByName(options.apple), { ...(options.onePage ? { turn: { pages: 1, ms: 60_000 } } : {}), drainWrites: calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log }) });
    const due = { accountId: s.accountId, id, provider: "caldav", status: "active" as const };
    return {
      id, accountId: s.accountId,
      /** One whole turn of the connection, made due first: the drain, then the readings. How it ended, and the word where it names one. */
      turn: async (): Promise<string> => {
        await w.sql`update cal_calendars set next_poll_at = null where connection_id = ${id}`;
        await w.sql`update cal_connections set next_poll_at = null where id = ${id}`;
        await w.sql`update cal_writes set next_attempt_at = null where account_id = ${s.accountId} and state = 'pending'`;
        const outcome = await calendarSyncPass(worker, due, new AbortController().signal);
        return "word" in outcome ? `${outcome.kind} ${outcome.word}` : outcome.kind;
      },
      /** The connection as its person sees it, and how long it waits. */
      stands: async () => {
        const [row] = await w.sql<{ status: string; word: string | null; waits: number }[]>`
          select status, error_code as word, extract(epoch from next_poll_at - now()) * 1000 as waits from cal_connections where id = ${id}`;
        return { status: row!.status, word: row!.word, waitsAboutADay: Number(row!.waits) > DAY_MS - 60_000 && Number(row!.waits) <= DAY_MS };
      },
      titles: async (): Promise<string[]> => (await w.sql<{ title: string }[]>`
        select e.title from cal_events e join cal_calendars k on k.id = e.calendar_id where k.connection_id = ${id} order by 1`).map((e) => e.title),
      /** The stored event of this title, as an act names it: its id, and the copy the act is made on. */
      event: async (title: string): Promise<{ eventId: string; base: string }> => {
        const [row] = await w.sql<{ id: string; at: string }[]>`
          select e.id, to_char(e.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from cal_events e
          join cal_calendars k on k.id = e.calendar_id where k.connection_id = ${id} and e.title = ${title}`;
        return { eventId: row!.id, base: row!.at };
      },
      /** ONE COLUMN, written by somebody who can write rows and holds no key: where the connection's calendar is read and written. */
      calendarMovedTo: async (address: string): Promise<void> => {
        expect((await w.sql`update cal_calendars set provider_id = ${address} where connection_id = ${id} returning id`).length).toBe(1);
      },
    };
  }

  it("asks for a new calendar sign-in when the mailbox's stored app password has been revoked", async () => {
    const apple = await server();
    const c = await connected("", { apple });
    expect(await c.turn()).toBe("stopped sign_in_refused");
    expect(await c.stands()).toMatchObject({ status: "reconnect", word: "sign_in_refused" });
    expect(apple.seen.length).toBeGreaterThan(0);
    expect(apple.seen.every(({ withCredential, signedIn }) => withCredential && !signedIn)).toBe(true);
  }, 120_000);

  it("resumes a paged first sync when the provider names the numbered host through its home redirect", async () => {
    const store = await server({ truncateAt: 1 });
    store.put("work", "two.ics", eventText("two", "Glaze firing"));
    const numbered = at(BESIDE, store, store.paths.home);
    let home = numbered;
    const alias = "/calendar-home/";
    const typed = await server({ homeHref: () => home, sendsOn: { [alias]: numbered } });
    const c = await connected(at(TYPED, typed, typed.paths.start), { onePage: true });
    expect(await c.turn()).toBe("synced");
    expect(await c.titles()).toEqual(["Kiln check"]);

    home = alias;
    expect(await c.turn()).toBe("synced");
    expect(await c.stands()).toMatchObject({ status: "active", word: null });
    expect(await c.titles()).toEqual(["Glaze firing", "Kiln check"]);
  }, 120_000);

  const REFUSED = { status: "failing", word: "host_changed", waitsAboutADay: true };

  it("the reader: a stored calendar's address names no host: not a host beside the sealed one, and not another port of the sealed host itself", async () => {
    const seen: Record<string, unknown> = {};
    for (const [arm, name] of [["a host beside the sealed one", BESIDE], ["another port of the sealed host", TYPED]] as const) {
      const typed = await server();
      const other = await server();
      const c = await connected(at(TYPED, typed, typed.paths.start));
      // The control: the typed server took the password and handed over its event; the other one heard nothing.
      expect([await c.turn(), await c.titles(), typed.seen.some((s) => s.signedIn), heard(other)]).toEqual(["synced", ["Kiln check"], true, []]);
      const asked = typed.seen.length;

      await c.calendarMovedTo(at(name, other, other.paths.collection("work")));
      const ended = await c.turn();
      seen[arm] = { ended, heard: heard(other), askedOfTheSealedServer: heard(typed, asked), stands: await c.stands(), kept: await c.titles() };
    }
    // The other server hears no request. Discovery follows the sealed server's own home once,
    // where no redirect names the other server. The connection waits a day with its copy kept.
    const refused = {
      ended: "backed_off host_changed", heard: [], stands: REFUSED, kept: ["Kiln check"],
      askedOfTheSealedServer: [
        `PROPFIND ${TYPED} /dav/ WITH THE PASSWORD`, `PROPFIND ${TYPED} /dav/principals/mila/ WITH THE PASSWORD`,
        `PROPFIND ${TYPED} /dav/calendars/mila/ WITH THE PASSWORD`,
      ],
    };
    expect(seen).toEqual({ "a host beside the sealed one": refused, "another port of the sealed host": refused });
  }, 120_000);

  it("the write drain: a stored event's address under a moved calendar sends no change, and no password, to the host beside", async () => {
    const typed = await server();
    const other = await server();
    const c = await connected(at(TYPED, typed, typed.paths.start));
    expect(await c.turn()).toBe("synced");
    const event = await c.event("Kiln check");
    const key = `retitle-${randomUUID()}`;
    await recordWrite(w, { accountId: c.accountId, key, act: { kind: "calendar_event_update", ...event, scope: { kind: "record" }, change: { title: "Glaze firing" } } });
    const asked = typed.seen.length;

    // TWO COLUMNS: the calendar's address and, under it, the event's.
    await c.calendarMovedTo(at(BESIDE, other, other.paths.collection("work")));
    expect((await w.sql`update cal_events set provider_id = ${at(BESIDE, other, other.paths.member("work", "one.ics"))} where id = ${event.eventId} returning id`).length).toBe(1);
    const ended = await c.turn();
    const [write] = await w.sql<{ state: string; refusal: string | null }[]>`select state, refusal from cal_writes where account_id = ${c.accountId} and idempotency_key = ${key}`;
    // Nothing was written at either server, the write is refused with the port's word, and the reading after it says the same on the connection.
    expect({ ended, heard: heard(other), write, written: typed.seen.slice(asked).filter((s) => s.method === "PUT" || s.method === "DELETE").length, stands: await c.stands() })
      .toEqual({ ended: "backed_off host_changed", heard: [], write: { state: "refused", refusal: "host_changed" }, written: 0, stands: REFUSED });
  }, 120_000);

  it("a redirect: an address on the sealed server that sends its caller on does not carry the password to the host beside", async () => {
    const other = await server();
    const typed = await server({ sendsOn: { "/dav/sent-on/": at(BESIDE, other, other.paths.collection("work")) } });
    const c = await connected(at(TYPED, typed, typed.paths.start));
    expect([await c.turn(), heard(other)]).toEqual(["synced", []]);

    await c.calendarMovedTo(at(TYPED, typed, "/dav/sent-on/"));
    const ended = await c.turn();
    expect({ ended, heard: heard(other), stands: await c.stands() }).toEqual({ ended: "backed_off host_changed", heard: [], stands: REFUSED });
  }, 120_000);

  it("a server whose service lives on a host beside the typed one is read turn after turn: its well-known address names that host each time", async () => {
    const service = await server();
    const typed = await server({ wellKnown: at(BESIDE, service, service.paths.start), rootStatus: 404 });
    // A host typed alone: the start is its well-known address.
    const c = await connected(at(TYPED, typed, "/"));
    expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Kiln check"]]);

    // The worker's next turn lists nothing: it reads the stored calendar, whose address is on the host beside.
    service.put("work", "two.ics", eventText("two", "Glaze firing"));
    const [atTyped, atService] = [typed.seen.length, service.seen.length];
    expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Glaze firing", "Kiln check"]]);
    // It asked the typed server first, was sent on, and only then read the calendar there: what changed, and the new event.
    expect(heard(typed, atTyped)).toEqual([`PROPFIND ${TYPED} /.well-known/caldav WITH THE PASSWORD`]);
    expect(heard(service, atService)).toEqual([
      `PROPFIND ${BESIDE} /dav/ WITH THE PASSWORD`, `PROPFIND ${BESIDE} /dav/principals/mila/ WITH THE PASSWORD`,
      `REPORT ${BESIDE} /dav/calendars/mila/work/ WITH THE PASSWORD`, `REPORT ${BESIDE} /dav/calendars/mila/work/ WITH THE PASSWORD`,
    ]);
  }, 120_000);

  describe("a server that keeps the calendars on a host beside the typed one (its home set names it)", () => {
    /** The typed server names its home where `home.at` says, asked anew each time. */
    async function homeBeside() {
      const store = await server();
      const home = { at: at(BESIDE, store, store.paths.home) };
      const typed = await server({ homeHref: () => home.at });
      const c = await connected(at(TYPED, typed, typed.paths.start));
      expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Kiln check"]]);
      return { store, home, typed, c };
    }

    it("is read turn after turn, and written: the server names that host in each turn", async () => {
      const { store, typed, c } = await homeBeside();
      store.put("work", "two.ics", eventText("two", "Glaze firing"));
      const [atTyped, atStore] = [typed.seen.length, store.seen.length];
      expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Glaze firing", "Kiln check"]]);
      // The typed server was asked first where the calendars are; then the calendar, on the host it named: what changed, and the new event.
      expect(heard(typed, atTyped)).toEqual([`PROPFIND ${TYPED} /dav/ WITH THE PASSWORD`, `PROPFIND ${TYPED} /dav/principals/mila/ WITH THE PASSWORD`]);
      expect(heard(store, atStore)).toEqual([`REPORT ${BESIDE} /dav/calendars/mila/work/ WITH THE PASSWORD`, `REPORT ${BESIDE} /dav/calendars/mila/work/ WITH THE PASSWORD`]);

      // A change of an event there is written there, in a turn whose first request is the write's.
      await recordWrite(w, {
        accountId: c.accountId, key: `retitle-${randomUUID()}`,
        act: { kind: "calendar_event_update", ...(await c.event("Kiln check")), scope: { kind: "record" }, change: { title: "Kiln check, early" } },
      });
      const before = store.seen.length;
      expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Glaze firing", "Kiln check, early"]]);
      expect(heard(store, before)[0]).toBe(`PUT ${BESIDE} /dav/calendars/mila/work/one.ics WITH THE PASSWORD`);
    }, 120_000);

    it("and when the server moves the calendars to another host beside the typed one, the stored calendar is read and written there, and the host it was stored at hears nothing", async () => {
      const { store, home, c } = await homeBeside();
      // The same server under another name: the home it names now is on that host, at the same place.
      home.at = at(MOVED, store, store.paths.home);
      store.put("work", "two.ics", eventText("two", "Glaze firing"));
      const atStore = store.seen.length;
      expect([await c.turn(), await c.titles(), await c.stands()]).toEqual(["synced", ["Glaze firing", "Kiln check"], { status: "active", word: null, waitsAboutADay: false }]);
      await recordWrite(w, {
        accountId: c.accountId, key: `retitle-${randomUUID()}`,
        act: { kind: "calendar_event_update", ...(await c.event("Kiln check")), scope: { kind: "record" }, change: { title: "Kiln check, early" } },
      });
      expect([await c.turn(), await c.titles()]).toEqual(["synced", ["Glaze firing", "Kiln check, early"]]);
      const since = heard(store, atStore);
      expect(since.filter((line) => line.includes(` ${BESIDE} `))).toEqual([]);
      expect(since).toContain(`PUT ${MOVED} /dav/calendars/mila/work/one.ics WITH THE PASSWORD`);
    }, 120_000);

    it("and a stored calendar on a host the server no longer names is not asked: the connection says so, waits a day, and reads again once the server names it again", async () => {
      const { store, home, typed, c } = await homeBeside();
      // The server keeps its calendars at home now. The stored row still names the host beside, which is another server here (another
      // port): never taken for the same place inside the home the server names, as the same server under a new name is (the case above).
      home.at = typed.paths.home;
      const [atTyped, atStore] = [typed.seen.length, store.seen.length];
      const ended = await c.turn();
      // The sealed server's own home is followed once. The host beside hears nothing.
      expect({ ended, heard: heard(store, atStore), askedOfTheSealedServer: heard(typed, atTyped), stands: await c.stands(), kept: await c.titles() }).toEqual({
        ended: "backed_off host_changed", heard: [], stands: REFUSED, kept: ["Kiln check"],
        askedOfTheSealedServer: [
          `PROPFIND ${TYPED} /dav/ WITH THE PASSWORD`, `PROPFIND ${TYPED} /dav/principals/mila/ WITH THE PASSWORD`,
          `PROPFIND ${TYPED} /dav/calendars/mila/ WITH THE PASSWORD`,
        ],
      });
      // And back: the refusal was the server's own word of this turn, not a spoiled row.
      home.at = at(BESIDE, store, store.paths.home);
      store.put("work", "two.ics", eventText("two", "Glaze firing"));
      expect([await c.turn(), await c.titles(), (await c.stands()).status]).toEqual(["synced", ["Glaze firing", "Kiln check"], "active"]);
    }, 120_000);
  });
});
