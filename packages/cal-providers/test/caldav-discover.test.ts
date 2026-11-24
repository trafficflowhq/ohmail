/**
 * Finding a person's calendars on a CalDAV server from an address, a user and a password: where the
 * reader starts, whom it tells the password, and what it says when a server is none or refuses.
 *
 * Asked through the reader's own door. The server is this file's own on 127.0.0.1, written from the
 * standards (`caldav-stand-in.ts`), reached through the real request port; where a case is about
 * which addresses are asked at all, the request port is a stand-in that dials nothing.
 */
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { intlZones } from "@ohmail/cal-core";
import { pinnedHttpRequest, type HostResolver } from "@trafficflow/core/net";
import { afterEach, describe, expect, it } from "vitest";
import { calendarKey } from "../src/calendar-key.js";
import { makeReader } from "../src/caldav/index.js";
import type { CalendarReader, Connection } from "../src/port.js";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "../src/limits.js";
import type { ProviderRefusal } from "../src/refusals.js";
import { guardedRequest } from "../src/request/guarded.js";
import { namedHostRequest, type HttpAnswer, type HttpPort } from "../src/request/index.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "./caldav-stand-in.js";

const ZONES = intlZones();
const CLOCK = { now: () => Date.UTC(2026, 10, 14, 9, 0, 0) };
/** Four names for this machine: the typed host, two numbered hosts beside it, and a host of somebody else's. */
const NAMES: Record<string, string[]> = { "caldav.example.test": ["127.0.0.1"], "p01-caldav.example.test": ["127.0.0.1"], "p02-caldav.example.test": ["127.0.0.1"], "elsewhere.example.net": ["127.0.0.1"] };
const resolver: HostResolver = { resolve: async (name) => NAMES[name] ?? [] };
const ownNetwork = (): CalendarReader => makeReader({ http: namedHostRequest({ writes: false, resolver, policy: { kind: "own-network" } }), clock: CLOCK, zones: ZONES });
/**
 * The same reader for hosts that have names. The suite lets no socket open to a name, so the last
 * step is this file's: the request the gate cleared is sent to this machine's own address under
 * the name it was meant for. The gate, the sign-in's hosts and the redirects are the real ones.
 */
const ownNetworkByName = (): CalendarReader =>
  makeReader({
    clock: CLOCK,
    zones: ZONES,
    http: guardedRequest({
      writes: false,
      resolver,
      policy: { kind: "own-network" },
      hosts: null,
      limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxBodyBytes: FETCH_BODY_MAX_BYTES },
      request: (url, opts) => {
        const named = new URL(url);
        const here = new URL(url);
        here.hostname = "127.0.0.1";
        return pinnedHttpRequest(here.href, { ...opts, headers: { ...opts.headers, host: named.host } });
      },
    }),
  });
const signal = (): AbortSignal => new AbortController().signal;

const servers: StandIn[] = [];
async function server(options: StandInOptions = {}): Promise<StandIn> {
  const started = await startCalDavStandIn(options);
  servers.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const signIn = (s: StandIn, start: string | null, password = s.options.password): Connection => ({ provider: "caldav", credential: { kind: "basic", user: s.options.user, password: () => password }, start });
const here = (s: StandIn, path = ""): string => `http://127.0.0.1:${s.port}${path}`;
const paths = (s: StandIn): string[] => s.seen.map((r) => r.path);

describe("where the reader starts", () => {
  it("asks the well-known address of a host that was typed alone, follows its redirect, and names the principal and the person's own addresses", async () => {
    const s = await server();
    const answer = await ownNetwork().checkSignIn(signIn(s, here(s)), signal());
    // The server lists a mail address in capitals and the principal's own address; the mail address is kept, in lower case.
    expect(answer).toEqual({ ok: true, value: { principal: here(s, "/dav/principals/mila/"), addresses: ["mila@studio.example.test"] } });
    expect(s.seen.map((r) => [r.method, r.path, r.depth, r.signedIn])).toEqual([
      ["PROPFIND", "/.well-known/caldav", "0", true],
      ["PROPFIND", "/dav/", "0", true],
      ["PROPFIND", "/dav/principals/mila/", "0", true],
    ]);
  });

  it("keeps a non-Apple Apple Account email and app password when discovery redirects to a numbered host", async () => {
    const redirects: Record<string, string> = {};
    const s = await server({
      user: ["mila", "mail.example.test"].join("@"),
      password: ["blue", "hand", "clay", "kiln"].join("-"),
      sendsOn: redirects,
    });
    const start = `http://caldav.example.test:${s.port}`;
    const numbered = `http://p01-caldav.example.test:${s.port}`;
    redirects["/.well-known/caldav"] = numbered + s.paths.start;
    s.addCalendar("work");

    const reader = ownNetworkByName();
    const listed = await reader.listCalendars(signIn(s, start), signal());
    expect(listed.ok && listed.value.map((calendar) => calendar.id)).toEqual([numbered + s.paths.collection("work")]);
    expect(s.seen.map(({ host, signedIn }) => [host, signedIn])).toEqual([
      [new URL(start).host, true],
      [new URL(numbered).host, true],
      [new URL(numbered).host, true],
      [new URL(numbered).host, true],
    ]);

    s.seen.length = 0;
    const rejected = await reader.listCalendars(signIn(s, start, "incorrect"), signal());
    expect(rejected).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
    expect(s.seen.map(({ host, withCredential, signedIn }) => [host, withCredential, signedIn])).toEqual([
      [new URL(start).host, true, false],
      [new URL(numbered).host, true, false],
    ]);
  });

  it("asks the typed address first when it names a path", async () => {
    const s = await server({ wellKnown: "missing" });
    expect((await ownNetwork().checkSignIn(signIn(s, here(s, "/dav/")), signal())).ok).toBe(true);
    expect(paths(s)).toEqual(["/dav/", "/dav/principals/mila/"]);
  });

  it("goes on to the well-known address and then to the root, and says that there is no calendar service when none of the three knows the person", async () => {
    const s = await server({ wellKnown: "missing" });
    expect(await ownNetwork().checkSignIn(signIn(s, here(s, "/somewhere/else/")), signal())).toEqual({ ok: false, reason: "no_service", retryAfterMs: null });
    expect(paths(s)).toEqual(["/somewhere/else/", "/.well-known/caldav", "/"]);
  });

  it("finds a service that lives at the root of a host whose well-known address is not set up", async () => {
    const s = await server({ context: "/", wellKnown: "missing" });
    const answer = await ownNetwork().checkSignIn(signIn(s, here(s)), signal());
    expect(answer.ok && answer.value.principal).toBe(here(s, "/principals/mila/"));
    expect(paths(s)).toEqual(["/.well-known/caldav", "/", "/principals/mila/"]);
  });

  it("reads what was typed: a host alone and a host with a path are asked over TLS, a mail address gives its domain", async () => {
    for (const [typed, first] of [
      ["caldav.example.org", "https://caldav.example.org/.well-known/caldav"],
      ["  Caldav.Example.org  ", "https://caldav.example.org/.well-known/caldav"],
      ["example.org:8443/dav/mila", "https://example.org:8443/dav/mila"],
      ["https://example.org/remote.php/dav", "https://example.org/remote.php/dav"],
      ["mila@example.org", "https://example.org/.well-known/caldav"],
    ] as const) {
      const { port, asked } = deaf();
      expect([typed, (await readerOver(port).checkSignIn(typedBy(typed), signal())).ok]).toEqual([typed, false]);
      expect([typed, asked[0]]).toEqual([typed, first]);
    }
  });

  it("asks nothing at all for an address that is none: a sign-in written into it, another scheme, nothing typed", async () => {
    const withSignIn = ["https://", "mila", ":", "kiln", "@", "caldav.example.org/"].join("");
    for (const typed of [withSignIn, withSignIn.replace("https://", ""), "ftp://caldav.example.org/", "webcal://caldav.example.org/", "", "   ", `https://caldav.example.org/${"a".repeat(9000)}`, null]) {
      const { port, asked } = deaf();
      const reader = readerOver(port);
      for (const answer of [await reader.checkSignIn(typedBy(typed), signal()), await reader.listCalendars(typedBy(typed), signal())]) {
        expect(answer).toEqual({ ok: false, reason: "address_invalid", retryAfterMs: null });
      }
      expect(asked).toEqual([]);
    }
  });

  it("asks an address typed without TLS as it was typed, and over TLS only once the request port says the plain one is not allowed", async () => {
    // A request port that does not allow a plain address, as the one of a hosted server does not.
    const asked: string[] = [];
    const port: HttpPort = {
      async request(url) {
        asked.push(url);
        return url.startsWith("http://") ? { arrived: false, reason: "address_not_allowed" } : notFound(url);
      },
    };
    expect(await readerOver(port).checkSignIn(typedBy("http://nas.example.org:5232/mila/"), signal())).toEqual({ ok: false, reason: "no_service", retryAfterMs: null });
    expect(asked).toEqual(["http://nas.example.org:5232/mila/", "https://nas.example.org:5232/mila/", "https://nas.example.org:5232/.well-known/caldav", "https://nas.example.org:5232/"]);
  });

  it("never asks an address typed with TLS without it, whatever fails", async () => {
    for (const reason of ["address_not_allowed", "connection_failed", "timeout", "host_unresolved"] as const) {
      const asked: string[] = [];
      const port: HttpPort = { request: async (url) => (asked.push(url), { arrived: false, reason }) };
      expect(await readerOver(port).checkSignIn(typedBy("https://caldav.example.org/"), signal())).toEqual({ ok: false, reason, retryAfterMs: null });
      // The first start's word stands for the host: the other starts are not asked either.
      expect(asked).toEqual(["https://caldav.example.org/.well-known/caldav"]);
    }
  });

  it("is refused on a hosted server for a server on that machine's own network, before a socket opens", async () => {
    const s = await server();
    const hosted = makeReader({ http: namedHostRequest({ writes: false, resolver, policy: { kind: "cloud" } }), clock: CLOCK, zones: ZONES });
    for (const start of [here(s), `http://caldav.example.test:${s.port}/`, `https://caldav.example.test:${s.port}/`]) {
      expect(await hosted.listCalendars(signIn(s, start), signal())).toEqual({ ok: false, reason: "address_not_allowed", retryAfterMs: null });
    }
    expect(s.seen).toEqual([]);
  });
});

describe("whom the reader tells the password", () => {
  it("stops at the first refusal of the sign-in: a server that counts failures is not asked a second time", async () => {
    for (const refusedSignIn of ["status", "unauthenticated"] as const) {
      const s = await server({ refusedSignIn });
      const wrong = signIn(s, here(s), ["not", "the", "password"].join("-"));
      expect(await ownNetwork().checkSignIn(wrong, signal())).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
      expect(await ownNetwork().listCalendars(wrong, signal())).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
      // Each call: the well-known address and the service it redirects to. The root is never asked.
      expect(paths(s)).toEqual(["/.well-known/caldav", "/dav/", "/.well-known/caldav", "/dav/"]);
    }
  });

  it("keeps nothing between two calls: the same address with another password is asked anew and refused", async () => {
    const s = await server();
    const reader = ownNetwork();
    expect((await reader.checkSignIn(signIn(s, here(s)), signal())).ok).toBe(true);
    expect(await reader.checkSignIn(signIn(s, here(s), ["somebody", "else"].join("-")), signal())).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
    expect((await reader.checkSignIn(signIn(s, here(s)), signal())).ok).toBe(true);
  });

  it("asks a calendar home on a numbered host beside the typed one, with the sign-in", async () => {
    const s = await server({ homeHref: (port) => `http://p01-caldav.example.test:${port}/dav/calendars/mila/` });
    s.addCalendar("work", { name: "Work" });
    const answer = await ownNetworkByName().listCalendars(signIn(s, `http://caldav.example.test:${s.port}/`), signal());
    expect(answer.ok && answer.value.map((c) => c.id)).toEqual([`http://p01-caldav.example.test:${s.port}/dav/calendars/mila/work/`]);
    expect(s.seen.map((r) => [r.host, r.path, r.signedIn])).toEqual([
      [`caldav.example.test:${s.port}`, "/.well-known/caldav", true],
      [`caldav.example.test:${s.port}`, "/dav/", true],
      [`caldav.example.test:${s.port}`, "/dav/principals/mila/", true],
      [`p01-caldav.example.test:${s.port}`, "/dav/calendars/mila/", true],
    ]);
  });

  it("asks nothing of a host that is not the typed one's sibling, wherever the server names it", async () => {
    const elsewhere = (port: number, path: string): string => `http://elsewhere.example.net:${port}${path}`;
    for (const options of [
      { homeHref: (port: number) => elsewhere(port, "/dav/calendars/mila/") },
      { principalHref: (port: number) => elsewhere(port, "/dav/principals/mila/") },
    ] satisfies StandInOptions[]) {
      const s = await server(options);
      s.addCalendar("work");
      expect(await ownNetworkByName().listCalendars(signIn(s, `http://caldav.example.test:${s.port}/`), signal())).toEqual({ ok: false, reason: "host_changed", retryAfterMs: null });
      expect(s.seen.length).toBeGreaterThan(0);
      expect(s.seen.filter((r) => r.host.startsWith("elsewhere"))).toEqual([]);
    }
    // A well-known address that redirects there: the root is still asked, and the word says where the service went.
    const s = await server({ wellKnown: `http://elsewhere.example.net:1/dav/`, rootStatus: 404 });
    expect(await ownNetworkByName().checkSignIn(signIn(s, `http://caldav.example.test:${s.port}/`), signal())).toEqual({ ok: false, reason: "host_changed", retryAfterMs: null });
    expect(s.seen.map((r) => [r.host, r.path])).toEqual([[`caldav.example.test:${s.port}`, "/.well-known/caldav"], [`caldav.example.test:${s.port}`, "/"]]);
  });

  describe("a calendar a caller hands in names no host the password goes to", () => {
    const PAGE = { limit: 50, cursor: null, window: null };
    const typedAt = (s: StandIn): string => `http://caldav.example.test:${s.port}/`;
    const beside = (s: StandIn): { id: string } => ({ id: `http://p01-caldav.example.test:${s.port}/dav/calendars/mila/work/` });
    const asked = (s: StandIn, from = 0) => s.seen.slice(from).map((r) => [r.host.split(":")[0], r.method, r.path, r.signedIn]);
    const DISCOVERY = [
      ["caldav.example.test", "PROPFIND", "/.well-known/caldav", true],
      ["caldav.example.test", "PROPFIND", "/dav/", true],
      ["caldav.example.test", "PROPFIND", "/dav/principals/mila/", true],
    ];

    it("on a host beside the typed one it is read once the server has named that host in the same turn: the server is asked first, once a turn, and a new turn remembers nothing", async () => {
      const s = await server({ homeHref: (port) => `http://p01-caldav.example.test:${port}/dav/calendars/mila/` });
      s.addCalendar("work", { name: "Work" });
      const reader = ownNetworkByName();
      const turn = signIn(s, typedAt(s));
      expect((await reader.readChanges(turn, beside(s), null, PAGE, signal())).ok).toBe(true);
      const report = ["p01-caldav.example.test", "REPORT", "/dav/calendars/mila/work/", true];
      expect(asked(s)).toEqual([...DISCOVERY, report]);
      // The same turn knows the host: the server is not asked a second time.
      expect((await reader.readChanges(turn, beside(s), null, PAGE, signal())).ok).toBe(true);
      expect(asked(s, 4)).toEqual([report]);
      // Another turn begins from the sealed server alone.
      expect((await reader.readChanges(signIn(s, typedAt(s)), beside(s), null, PAGE, signal())).ok).toBe(true);
      expect(asked(s, 5)).toEqual([...DISCOVERY, report]);
    });

    it.each([false, true])("continues a paged read on a numbered host in a fresh turn (home alias: %s)", async (alias) => {
      const home = "/dav/calendars/mila/";
      const redirect: Record<string, string> = {};
      const s = await server({
        homeHref: (port) => alias ? "/calendar-home/" : `http://p01-caldav.example.test:${port}${home}`,
        sendsOn: redirect,
        truncateAt: 1,
      });
      if (alias) redirect["/calendar-home/"] = `http://p01-caldav.example.test:${s.port}${home}`;
      s.addCalendar("work");
      for (const uid of ["first", "second"]) {
        s.put("work", `${uid}.ics`, [
          "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "BEGIN:VEVENT", `UID:${uid}`,
          "DTSTAMP:20261113T120000Z", "DTSTART:20261119T090000Z", "DTEND:20261119T100000Z", "END:VEVENT", "END:VCALENDAR", "",
        ].join("\r\n"));
      }
      const reader = ownNetworkByName();
      const firstTurn = signIn(s, typedAt(s));
      const listed = await reader.listCalendars(firstTurn, signal());
      if (!listed.ok) throw new Error(listed.reason);
      const [calendar] = listed.value;
      if (!calendar) throw new Error("Missing calendar");
      const first = await reader.readChanges(firstTurn, calendar, null, PAGE, signal());
      if (!first.ok) throw new Error(first.reason);
      expect(first.value.items).toHaveLength(1);
      const cursor = first.value.cursor;
      if (cursor.kind !== "more") throw new Error("Missing next page");

      if (alias) {
        // An ordinary poll starts at page one on the stored calendar, without listing first.
        const pollAt = s.seen.length;
        const poll = await reader.readChanges(signIn(s, typedAt(s)), calendar, null, PAGE, signal());
        expect(poll).toMatchObject({ ok: true, value: { cursor: { kind: "more" }, items: [{ kind: "upsert", event: { uid: "first" } }] } });
        expect(asked(s, pollAt).slice(0, 5)).toEqual([
          ...DISCOVERY,
          ["caldav.example.test", "PROPFIND", "/calendar-home/", true],
          ["p01-caldav.example.test", "PROPFIND", home, true],
        ]);
      }
      const nextTurn = signIn(s, typedAt(s));
      const next = await reader.readChanges(nextTurn, calendar, null, { ...PAGE, cursor: cursor.value }, signal());
      if (!next.ok) throw new Error(next.reason);
      expect(next.value).toMatchObject({ cursor: { kind: "end" }, items: [{ kind: "upsert", event: { uid: "second" } }] });
      expect(s.seen.slice(-2).map((r) => [r.host.startsWith("p01-"), r.signedIn])).toEqual([[true, true], [true, true]]);

      // A host the server does not name is never asked. Another of its numbered hosts names the same place inside the home the server
      // names today, and is read there; a host of somebody else's is refused.
      const moved = new URL(calendar.id);
      moved.hostname = "p02-caldav.example.test";
      const movedAt = s.seen.length;
      expect(await reader.readChanges(signIn(s, typedAt(s)), { id: moved.href }, null, PAGE, signal()))
        .toMatchObject({ ok: true, value: { items: [{ kind: "upsert", id: `${moved.href}first.ics`, event: { uid: "first" } }] } });
      expect(s.seen.slice(movedAt).filter((r) => r.method === "REPORT").map((r) => [r.host.split(":")[0], r.path]))
        .toEqual([["p01-caldav.example.test", `${home}work/`], ["p01-caldav.example.test", `${home}work/`]]);
      const foreign = new URL(calendar.id);
      foreign.hostname = "elsewhere.example.net";
      expect(await reader.readChanges(signIn(s, typedAt(s)), { id: foreign.href }, null, { ...PAGE, cursor: cursor.value }, signal()))
        .toEqual({ ok: false, reason: "host_changed", retryAfterMs: null });
      expect(s.seen.some((r) => r.host === moved.host || r.host === foreign.host)).toBe(false);
    });

    it("reads a calendar stored from an earlier numbered host at the host the server names now, without asking the earlier one, and keeps its members under the stored address", async () => {
      // The principal on the typed host names a home alias; the alias sends every caller on to today's numbered host. An earlier listing stored the calendar
      // on another numbered host, as one large provider does when it moves an account between its hosts.
      const home = "/dav/calendars/mila/";
      const redirect: Record<string, string> = {};
      const s = await server({ homeHref: () => "/calendar-home/", sendsOn: redirect });
      redirect["/calendar-home/"] = `http://p02-caldav.example.test:${s.port}${home}`;
      s.addCalendar("work", { name: "Work" });
      s.put("work", "first.ics", [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "BEGIN:VEVENT", "UID:first",
        "DTSTAMP:20261113T120000Z", "DTSTART:20261119T090000Z", "DTEND:20261119T100000Z", "END:VEVENT", "END:VCALENDAR", "",
      ].join("\r\n"));
      const reader = ownNetworkByName();
      const stored = { id: `http://p01-caldav.example.test:${s.port}${home}work/` };

      const read = await reader.readChanges(signIn(s, typedAt(s)), stored, null, PAGE, signal());
      expect(read).toMatchObject({ ok: true, value: { items: [{ kind: "upsert", id: `${stored.id}first.ics`, event: { uid: "first" } }] } });
      expect(s.seen.some((r) => r.host.startsWith("p01-"))).toBe(false);
      expect(asked(s).at(-2)).toEqual(["p02-caldav.example.test", "REPORT", `${home}work/`, true]);

      // Listed today, the same calendar is named at today's host, and is the same calendar.
      const listed = await reader.listCalendars(signIn(s, typedAt(s)), signal());
      if (!listed.ok) throw new Error(listed.reason);
      expect(listed.value.map((c) => new URL(c.id).hostname)).toEqual(["p02-caldav.example.test"]);
      expect(listed.value.map((c) => calendarKey("caldav", c.id))).toEqual([calendarKey("caldav", stored.id)]);
    });

    it("knows a calendar by its place whichever host names it, and at another port or another scheme as another calendar, as it is read", () => {
      const key = (address: string) => calendarKey("caldav", address);
      const stored = "https://p01-caldav.example.test/123/calendars/work/";
      expect(key("https://p02-caldav.example.test/123/calendars/work")).toBe(key(stored));
      expect(key("https://p02-caldav.example.test:443/123/calendars/work/")).toBe(key(stored));
      expect(key("https://p02-caldav.example.test:8443/123/calendars/work/")).not.toBe(key(stored));
      expect(key("http://p02-caldav.example.test/123/calendars/work/")).not.toBe(key(stored));
      expect(key("http://p02-caldav.example.test:443/123/calendars/work/")).not.toBe(key(stored));
    });

    it("on a host the server does not name it is not asked: at a name beside the typed one it is read at the same place of the home the server names, at another port of the typed host it is refused; the server is asked about it once in the turn", async () => {
      const s = await server();
      s.addCalendar("work", { name: "Work" });
      const reader = ownNetworkByName();
      const turn = signIn(s, typedAt(s));
      const refused = { ok: false, reason: "host_changed", retryAfterMs: null };
      const report = ["caldav.example.test", "REPORT", "/dav/calendars/mila/work/", true];
      expect((await reader.readChanges(turn, beside(s), null, PAGE, signal())).ok).toBe(true);
      const discoveryWithHome = [...DISCOVERY, ["caldav.example.test", "PROPFIND", "/dav/calendars/mila/", true]];
      expect(asked(s)).toEqual([...discoveryWithHome, report]);
      expect(await reader.readChanges(turn, { id: "http://caldav.example.test:8443/dav/calendars/mila/work/" }, null, PAGE, signal())).toEqual(refused);
      expect((await reader.readChanges(turn, beside(s), null, PAGE, signal())).ok).toBe(true);
      expect(asked(s)).toEqual([...discoveryWithHome, report, report]);
      expect(s.seen.some((r) => r.host.startsWith("p01-") || r.host.endsWith(":8443"))).toBe(false);
    });

    it("where the server could not be asked, the reading says that word and not that the host changed, and asks no second time in the turn", async () => {
      const s = await server({ homeHref: (port) => `http://p01-caldav.example.test:${port}/dav/calendars/mila/` });
      s.addCalendar("work", { name: "Work" });
      const reader = ownNetworkByName();
      const turn = signIn(s, typedAt(s));
      s.answerNext(503);
      const unavailable = { ok: false, reason: "unavailable", retryAfterMs: null };
      expect(await reader.readChanges(turn, beside(s), null, PAGE, signal())).toEqual(unavailable);
      const first = s.seen.length;
      expect(await reader.readChanges(turn, beside(s), null, PAGE, signal())).toEqual(unavailable);
      expect([s.seen.length - first, s.seen.filter((r) => r.host.startsWith("p01-"))]).toEqual([0, []]);
      // The next turn asks again, and reads.
      expect((await reader.readChanges(signIn(s, typedAt(s)), beside(s), null, PAGE, signal())).ok).toBe(true);
    });
  });

  describe("a sign-in that travels with TLS is never sent without it", () => {
    // The person's own network: every name is a private address, which is where a plain request may go at all.
    // The address beside them is public and stands for a server that is not on that network. None is dialled.
    const HOME: Record<string, string[]> = { "caldav.example.test": ["192.168.1.20"], "inner.example.test": ["192.168.1.21"], "nas.example.test": ["203.0.114.1"] };
    const TYPED = "https://caldav.example.test:8443/dav/";
    const PLAIN = "http://caldav.example.test:8008/dav";
    const answerOf = (href: string, prop: string): string =>
      `<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>${href}</href><propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const principalAt = (href: string): string => answerOf("/dav/", `<current-user-principal><href>${href}</href></current-user-principal>`);
    const homeAt = (href: string): string => answerOf("/dav/principals/mila/", `<C:calendar-home-set><href>${href}</href></C:calendar-home-set>`);
    /** The real gate for a person's own network over a request that dials nothing: it answers from a table and lists what it was asked, and whether the sign-in came along. */
    function dialled(answers: Record<string, string>) {
      const asked: { url: string; signedIn: boolean }[] = [];
      const http = guardedRequest({
        writes: false,
        resolver: { resolve: async (name) => HOME[name] ?? [] },
        policy: { kind: "own-network" },
        hosts: null,
        limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxBodyBytes: FETCH_BODY_MAX_BYTES },
        request: async (url, opts) => {
          asked.push({ url, signedIn: opts.headers?.authorization !== undefined });
          const body = answers[url];
          return { status: body === undefined ? 404 : 207, headers: {}, stream: Readable.from([Buffer.from(body ?? "")]) as unknown as IncomingMessage };
        },
      });
      return { reader: readerOver(http), asked };
    }
    const notAllowed = { ok: false, reason: "address_not_allowed", retryAfterMs: null };

    it("when the server names the signed-in person at a plain address", async () => {
      const { reader, asked } = dialled({ [TYPED]: principalAt(`${PLAIN}/principals/mila/`) });
      expect(await reader.checkSignIn(typedBy(TYPED), signal())).toEqual(notAllowed);
      expect(asked).toEqual([{ url: TYPED, signedIn: true }]);
    });

    it("when the server names the calendars at a plain address", async () => {
      const { reader, asked } = dialled({ [TYPED]: principalAt("/dav/principals/mila/"), "https://caldav.example.test:8443/dav/principals/mila/": homeAt(`${PLAIN}/calendars/mila/`) });
      expect(await reader.listCalendars(typedBy(TYPED), signal())).toEqual(notAllowed);
      expect(asked).toEqual([{ url: TYPED, signedIn: true }, { url: "https://caldav.example.test:8443/dav/principals/mila/", signedIn: true }]);
    });

    it("when a calendar is handed in at a plain address", async () => {
      const { reader, asked } = dialled({});
      expect(await reader.readChanges(typedBy(TYPED), { id: `${PLAIN}/calendars/mila/work/` }, null, { limit: 50, cursor: null, window: null }, signal())).toEqual(notAllowed);
      expect(asked).toEqual([]);
    });

    it("when the address was typed without TLS and only its TLS form could be asked", async () => {
      // The typed host is not on the person's network, so its plain address is not asked; a host beside it is.
      const secured = "https://nas.example.test:5232/dav/";
      const { reader, asked } = dialled({ [secured]: principalAt("http://inner.example.test:5232/dav/principals/mila/") });
      expect(await reader.checkSignIn(typedBy("http://nas.example.test:5232/dav/"), signal())).toEqual(notAllowed);
      expect(asked).toEqual([{ url: secured, signedIn: true }]);
    });

    it("and still travels plain on the person's own network where the address was typed so", async () => {
      const typed = "http://caldav.example.test:8008/dav/";
      const { reader, asked } = dialled({ [typed]: principalAt(`${PLAIN}/principals/mila/`), [`${PLAIN}/principals/mila/`]: homeAt(`${PLAIN}/calendars/mila/`) });
      expect(await reader.checkSignIn(typedBy(typed), signal())).toEqual({ ok: true, value: { principal: `${PLAIN}/principals/mila/`, addresses: [] } });
      expect(asked).toEqual([{ url: typed, signedIn: true }, { url: `${PLAIN}/principals/mila/`, signedIn: true }]);
    });
  });

  it("refuses a sign-in that is no user and password, and asks nobody", async () => {
    const { port, asked } = deaf();
    const bearer: Connection = { provider: "caldav", credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "t" }) }, start: "https://caldav.example.org/" };
    expect(await readerOver(port).checkSignIn(bearer, signal())).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
    expect(asked).toEqual([]);
  });
});

describe("what a server says instead of an answer", () => {
  it("says how long a busy server asked to be left alone, and asks no further start", async () => {
    for (const [status, retryAfter, expected] of [[429, "120", 120_000], [503, "30", 30_000], [429, undefined, null]] as const) {
      const s = await server();
      s.answerNext(status, retryAfter);
      expect(await ownNetwork().checkSignIn(signIn(s, here(s)), signal())).toEqual({ ok: false, reason: "throttled", retryAfterMs: expected });
      expect(s.seen.length).toBe(1);
    }
  });

  it("says that a server is at fault when a start answers so and no other start knows the person", async () => {
    const s = await server({ wellKnown: "missing" });
    s.answerNext(500);
    expect(await ownNetwork().checkSignIn(signIn(s, here(s)), signal())).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(paths(s)).toEqual(["/.well-known/caldav", "/"]);
  });

  it("says that there is no calendar service when the signed-in person has no calendar home", async () => {
    const s = await server({ homeHref: () => "" });
    for (const answer of [await ownNetwork().checkSignIn(signIn(s, here(s)), signal()), await ownNetwork().listCalendars(signIn(s, here(s)), signal())]) {
      expect(answer).toEqual({ ok: false, reason: "no_service", retryAfterMs: null });
    }
  });

  it("names a principal's own refusal by its word", async () => {
    for (const [status, reason] of [[403, "forbidden"], [404, "not_found"], [401, "sign_in_refused"], [502, "unavailable"]] as const) {
      const s = await server({ wellKnown: "missing" });
      const reader = ownNetwork();
      // The typed address answers; the principal it names is what refuses.
      const refusing: HttpPort = { request: async (url, req) => (url.endsWith("/principals/mila/") ? s.answerNext(status) : undefined, real.request(url, req)) };
      expect(await readerOver(refusing).checkSignIn(signIn(s, here(s, "/dav/")), signal())).toEqual({ ok: false, reason: reason satisfies ProviderRefusal, retryAfterMs: null });
      expect((await reader.checkSignIn(signIn(s, here(s, "/dav/")), signal())).ok).toBe(true);
    }
  });
});

const real = namedHostRequest({ writes: false, resolver, policy: { kind: "own-network" } });
const readerOver = (http: HttpPort): CalendarReader => makeReader({ http, clock: CLOCK, zones: ZONES });
const typedBy = (start: string | null): Connection => ({ provider: "caldav", credential: { kind: "basic", user: "mila", password: () => ["any", "thing"].join("-") }, start });
const notFound = (url: string): HttpAnswer => ({ arrived: true, status: 404, header: () => null, body: new Uint8Array(), location: null, url, hops: 0 });
/** A request port that dials nothing and knows nobody: it lists what it was asked. */
function deaf(): { port: HttpPort; asked: string[] } {
  const asked: string[] = [];
  return { asked, port: { request: async (url) => (asked.push(url), notFound(url)) } };
}
