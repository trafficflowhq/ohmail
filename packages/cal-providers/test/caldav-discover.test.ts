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
import { makeReader } from "../src/caldav/index.js";
import type { CalendarReader, Connection } from "../src/port.js";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "../src/limits.js";
import type { ProviderRefusal } from "../src/refusals.js";
import { guardedRequest } from "../src/request/guarded.js";
import { namedHostRequest, type HttpAnswer, type HttpPort } from "../src/request/index.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "./caldav-stand-in.js";

const ZONES = intlZones();
const CLOCK = { now: () => Date.UTC(2026, 10, 14, 9, 0, 0) };
/** Three names for this machine: the typed host, a numbered host beside it, and a host of somebody else's. */
const NAMES: Record<string, string[]> = { "caldav.example.test": ["127.0.0.1"], "p01-caldav.example.test": ["127.0.0.1"], "elsewhere.example.net": ["127.0.0.1"] };
const resolver: HostResolver = { resolve: async (name) => NAMES[name] ?? [] };
const ownNetwork = (): CalendarReader => makeReader({ http: namedHostRequest({ resolver, policy: { kind: "own-network" } }), clock: CLOCK, zones: ZONES });
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
    const hosted = makeReader({ http: namedHostRequest({ resolver, policy: { kind: "cloud" } }), clock: CLOCK, zones: ZONES });
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

const real = namedHostRequest({ resolver, policy: { kind: "own-network" } });
const readerOver = (http: HttpPort): CalendarReader => makeReader({ http, clock: CLOCK, zones: ZONES });
const typedBy = (start: string | null): Connection => ({ provider: "caldav", credential: { kind: "basic", user: "mila", password: () => ["any", "thing"].join("-") }, start });
const notFound = (url: string): HttpAnswer => ({ arrived: true, status: 404, header: () => null, body: new Uint8Array(), location: null, url, hops: 0 });
/** A request port that dials nothing and knows nobody: it lists what it was asked. */
function deaf(): { port: HttpPort; asked: string[] } {
  const asked: string[] = [];
  return { asked, port: { request: async (url) => (asked.push(url), notFound(url)) } };
}
