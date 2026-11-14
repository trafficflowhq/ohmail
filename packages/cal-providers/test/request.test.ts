/**
 * How a request leaves the package: one gate for every address, before a socket opens and again at
 * every redirect; a pinned connection; an own list of headers; ceilings on bytes and time.
 *
 * The refusals of the first two blocks are decided with a resolver and a request that are stand-ins,
 * so that "nothing was dialled" is a count. The rest runs the real pinned request against servers of
 * this file's own on 127.0.0.1.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createRawServer, type AddressInfo, type Socket } from "node:net";
import { Readable } from "node:stream";
import { pinnedHttpRequest, type HostResolver, type PinnedRequestOptions, type PinnedResponse } from "@trafficflow/core/net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FETCH_BODY_MAX_BYTES, MAX_URL_CHARS } from "../src/limits.js";
import type { ProviderRefusal } from "../src/refusals.js";
import { guardedRequest, type GuardDeps } from "../src/request/guarded.js";
import { fixedHostRequest, namedHostRequest, retryAfterMs, textOf, type HttpAnswer, type HttpPort, type HttpRequest, type HttpResponse } from "../src/request/index.js";

// A public address outside every range the gate refuses. It is only ever handed to a stand-in.
const PUBLIC = "203.0.114.1";
const LIMITS = { connectMs: 2_000, totalMs: 4_000, maxRedirects: 5, maxBodyBytes: 64 * 1024 };
const get = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: "GET", headers: {}, body: null, auth: null, validators: null, signal: new AbortController().signal, ...over });
const wordOf = (a: HttpAnswer): ProviderRefusal | "arrived" => (a.arrived ? "arrived" : a.reason);

/** A resolver that answers from a table and counts what it was asked. */
function resolverOf(table: Record<string, string[] | Error>) {
  const asked: string[] = [];
  const resolver: HostResolver = {
    async resolve(name) {
      asked.push(name);
      const answer = table[name];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
  };
  return { resolver, asked };
}

/** A request port that dials nothing: it counts its calls and answers 200 with a short body. */
function standIn(answer: { status?: number; headers?: Record<string, string>; body?: string } = {}) {
  const calls: { url: string; opts: PinnedRequestOptions }[] = [];
  const request = async (url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> => {
    calls.push({ url, opts });
    const stream = Readable.from([Buffer.from(answer.body ?? "BEGIN:VCALENDAR")]) as unknown as IncomingMessage;
    return { status: answer.status ?? 200, headers: answer.headers ?? {}, stream };
  };
  return { request, calls };
}

function guard(policy: GuardDeps["policy"], table: Record<string, string[] | Error> = {}, hosts: GuardDeps["hosts"] = null) {
  const { resolver, asked } = resolverOf(table);
  const { request, calls } = standIn();
  return { port: guardedRequest({ resolver, request, policy, limits: LIMITS, hosts }), asked, calls };
}

// Written from the rules of what the server may fetch, never from the gate's code. An address with a
// user and a password in it is put together here, so that no line of this file is shaped like one.
const WITH_USERINFO = ["https://", "u", ":", "p", "@", "feeds.example.test/"].join("");
const TOO_LONG = `https://feeds.example.test/${"a".repeat(MAX_URL_CHARS)}`;
// This machine's address as one decimal number, 2,130,706,433. Made from its hex form: written out between two
// slashes it would be a path segment of ten digits, the shape of an account's own address at a provider.
const AS_ONE_NUMBER = String(0x7f000001);
const REFUSED_EVERYWHERE: [string, ProviderRefusal][] = [
  ["https://[fe80::1%25eth0]/", "address_invalid"],
  ["https://[64:ff9b::7f00:1]/", "address_not_allowed"],
  ["https://[2002:7f00:1::]/", "address_not_allowed"],
  ["https://169.254.169.254/", "address_not_allowed"],
  ["https://100.100.100.200/", "address_not_allowed"],
  ["https://metadata.google.internal/", "address_not_allowed"],
  ["https://x.railway.internal/", "address_not_allowed"],
  ["https://hidden.onion/", "address_not_allowed"],
  [WITH_USERINFO, "address_invalid"],
  ["https://feeds.example.test:25/", "port_not_allowed"],
  ["https://feeds.example.test:993/", "port_not_allowed"],
  ["https://feeds.example.test:80/", "port_not_allowed"],
  ["ftp://feeds.example.test/", "address_invalid"],
  ["feeds.example.test/basic.ics", "address_invalid"],
  [TOO_LONG, "address_invalid"],
];
const REFUSED_ON_THE_CLOUD_ONLY: string[] = [
  "http://127.0.0.1:8821/",
  "https://localhost/",
  "https://localhost./",
  "https://[::1]/",
  "https://[::ffff:127.0.0.1]/",
  "https://0x7f000001/",
  `https://${AS_ONE_NUMBER}/`,
  "https://127.1/",
  "https://0177.0.0.1/",
  "https://10.0.0.1/",
  "https://192.168.1.20:5001/",
  "https://[fd00::1]/",
  "https://nas.local/",
];
const HOME = { "nas.local": ["192.168.1.20"], localhost: ["127.0.0.1"] };

describe("an address is decided before a socket opens", () => {
  it("refuses on a hosted server every address of its own network, of a metadata host and of no network at all", async () => {
    for (const [url, word] of [...REFUSED_EVERYWHERE, ...REFUSED_ON_THE_CLOUD_ONLY.map((u): [string, ProviderRefusal] => [u, "address_not_allowed"])]) {
      const { port, asked, calls } = guard({ kind: "cloud" }, HOME);
      expect([url.slice(0, 60), wordOf(await port.request(url, get()))]).toEqual([url.slice(0, 60), word]);
      expect([asked, calls.length]).toEqual([[], 0]);
    }
  });

  it("refuses a name when ANY address it resolves to is not public, and dials nothing", async () => {
    for (const answer of [["10.0.0.1"], ["169.254.169.254"], ["::1"], ["fd00::1"], [PUBLIC, "10.0.0.1"], ["100.100.100.200"]]) {
      const { port, asked, calls } = guard({ kind: "cloud" }, { "feeds.example.test": answer });
      expect([answer, wordOf(await port.request("https://feeds.example.test/basic.ics", get()))]).toEqual([answer, "address_not_allowed"]);
      expect([asked, calls.length]).toEqual([["feeds.example.test"], 0]);
    }
  });

  it("says that a name did not resolve, apart from one that is not allowed", async () => {
    for (const answer of [[], new Error("the resolver is down")]) {
      const { port, calls } = guard({ kind: "cloud" }, { "feeds.example.test": answer });
      expect(wordOf(await port.request("https://feeds.example.test/basic.ics", get()))).toBe("host_unresolved");
      expect(calls.length).toBe(0);
    }
  });

  it("refuses plain http on a hosted server, whatever the name resolves to", async () => {
    const { port, asked, calls } = guard({ kind: "cloud" }, { "feeds.example.test": [PUBLIC] });
    expect(wordOf(await port.request("http://feeds.example.test/basic.ics", get()))).toBe("address_not_allowed");
    expect([asked, calls.length]).toEqual([[], 0]);
  });

  it("dials a public name on a hosted server, pinned to the addresses the gate cleared, on a port a calendar server uses", async () => {
    for (const url of ["https://feeds.example.test/basic.ics", "https://feeds.example.test:8443/basic.ics", "https://feeds.example.test:5001/caldav/mila"]) {
      const { port, asked, calls } = guard({ kind: "cloud" }, { "feeds.example.test": [PUBLIC] });
      const answer = await port.request(url, get());
      expect(answer.arrived && [answer.status, textOf(answer.body), answer.url, answer.hops]).toEqual([200, "BEGIN:VCALENDAR", url, 0]);
      expect(asked).toEqual(["feeds.example.test"]);
      expect(calls.map((c) => [c.url, c.opts.pin, c.opts.method])).toEqual([[url, [PUBLIC], "GET"]]);
    }
  });

  it("pins no more addresses than the mail dial does", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `203.0.114.${i + 1}`);
    const { port, calls } = guard({ kind: "cloud" }, { "feeds.example.test": many });
    await port.request("https://feeds.example.test/", get());
    expect(calls[0]!.opts.pin).toEqual(many.slice(0, 16));
  });
});

describe("a person's own computer or server may reach the person's own network, and nothing more", () => {
  it("keeps every refusal that is not about a private address", async () => {
    for (const [url, word] of REFUSED_EVERYWHERE) {
      const { port, asked, calls } = guard({ kind: "own-network" }, HOME);
      expect([url.slice(0, 60), wordOf(await port.request(url, get()))]).toEqual([url.slice(0, 60), word]);
      expect([asked, calls.length]).toEqual([[], 0]);
    }
  });

  it("dials what a hosted server refuses: this machine, a private address, a name of the home network", async () => {
    for (const url of REFUSED_ON_THE_CLOUD_ONLY) {
      const { port, calls } = guard({ kind: "own-network" }, HOME);
      expect([url, wordOf(await port.request(url, get()))]).toEqual([url, "arrived"]);
      expect(calls.length).toBe(1);
    }
  });

  it("refuses a name that resolves to a link-local or a shared address, also beside a private one", async () => {
    for (const answer of [["169.254.169.254"], ["192.168.1.20", "169.254.169.254"], ["100.100.100.200"], ["fe80::1"]]) {
      const { port, calls } = guard({ kind: "own-network" }, { "nas.example.test": answer });
      expect([answer, wordOf(await port.request("https://nas.example.test/", get()))]).toEqual([answer, "address_not_allowed"]);
      expect(calls.length).toBe(0);
    }
  });

  it("sends nothing unencrypted unless every address of the name is private, asked again at every request", async () => {
    const table: Record<string, string[]> = { "nas.example.test": ["192.168.1.20"] };
    const { resolver, asked } = resolverOf(table);
    const { request, calls } = standIn();
    const port = guardedRequest({ resolver, request, policy: { kind: "own-network" }, limits: LIMITS, hosts: null });
    expect(wordOf(await port.request("http://nas.example.test:5232/mila/", get()))).toBe("arrived");
    table["nas.example.test"] = ["192.168.1.20", PUBLIC];
    expect(wordOf(await port.request("http://nas.example.test:5232/mila/", get()))).toBe("address_not_allowed");
    expect(wordOf(await port.request("https://nas.example.test:5232/mila/", get()))).toBe("arrived");
    expect([asked.length, calls.length]).toEqual([3, 2]);
  });
});

describe("a redirect is a second address nobody has cleared yet", () => {
  /** A request port that answers from a map of address to redirect target, and 200 for the rest. */
  function chain(redirects: Record<string, string | null>, table: Record<string, string[]>) {
    const { resolver, asked } = resolverOf(table);
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const request = async (url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> => {
      calls.push({ url, headers: opts.headers ?? {} });
      const to = redirects[url];
      const stream = Readable.from([Buffer.from("ok")]) as unknown as IncomingMessage;
      if (to === undefined) return { status: 200, headers: {}, stream };
      return { status: 302, headers: to === null ? {} : { location: to }, stream };
    };
    return { port: guardedRequest({ resolver, request, policy: { kind: "cloud" }, limits: LIMITS, hosts: null }), asked, calls };
  }
  const NAMES = { "a.example.test": [PUBLIC], "b.example.test": [PUBLIC], "inside.example.test": ["10.0.0.1"] };

  it("follows one to another public host, through the gate again", async () => {
    const { port, asked, calls } = chain({ "https://a.example.test/feed": "https://b.example.test/moved.ics" }, NAMES);
    const answer = await port.request("https://a.example.test/feed", get());
    expect(answer.arrived && [answer.url, answer.hops]).toEqual(["https://b.example.test/moved.ics", 1]);
    expect([asked, calls.map((c) => c.url)]).toEqual([["a.example.test", "b.example.test"], ["https://a.example.test/feed", "https://b.example.test/moved.ics"]]);
  });

  it("refuses one into the server's own network, to a literal or to a name, after one request and no second", async () => {
    for (const to of ["https://inside.example.test/", "https://169.254.169.254/latest/meta-data/", "https://localhost/", "https://[::1]/"]) {
      const { port, calls } = chain({ "https://a.example.test/feed": to }, NAMES);
      expect([to, wordOf(await port.request("https://a.example.test/feed", get()))]).toEqual([to, "address_not_allowed"]);
      expect(calls.length).toBe(1);
    }
  });

  it("refuses one from https to http, one with no target, one that is no address and one that is too long", async () => {
    for (const to of ["http://b.example.test/moved.ics", null, "https://[not an address", TOO_LONG]) {
      const { port, calls } = chain({ "https://a.example.test/feed": to }, NAMES);
      expect([to?.slice(0, 40), wordOf(await port.request("https://a.example.test/feed", get()))]).toEqual([to?.slice(0, 40), "redirect_invalid"]);
      expect(calls.length).toBe(1);
    }
  });

  it("resolves a relative target against the address that answered", async () => {
    const { port, calls } = chain({ "https://a.example.test/.well-known/caldav": "/dav/" }, NAMES);
    const answer = await port.request("https://a.example.test/.well-known/caldav", get());
    expect(answer.arrived && answer.url).toBe("https://a.example.test/dav/");
    expect(calls.length).toBe(2);
  });

  it("follows five and refuses the sixth", async () => {
    const hops = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://a.example.test/${i}`, `https://a.example.test/${i + 1}`]));
    const five = chain(Object.fromEntries(Object.entries(hops).slice(0, 5)), NAMES);
    const answer = await five.port.request("https://a.example.test/0", get());
    expect(answer.arrived && [answer.url, answer.hops]).toEqual(["https://a.example.test/5", 5]);
    const six = chain(hops, NAMES);
    expect(wordOf(await six.port.request("https://a.example.test/0", get()))).toBe("too_many_redirects");
    expect(six.calls.length).toBe(6);
  });

  it("sends the validators with the first request only, and the tag instead of the date when it has both", async () => {
    const { port, calls } = chain({ "https://a.example.test/feed": "https://b.example.test/moved.ics" }, NAMES);
    await port.request("https://a.example.test/feed", get({ validators: { etag: '"v7"', lastModified: "Sat, 14 Nov 2026 08:00:00 GMT" } }));
    expect(calls.map((c) => Object.keys(c.headers).sort())).toEqual([["accept", "accept-encoding", "if-none-match", "user-agent"], ["accept", "accept-encoding", "user-agent"]]);
    expect(calls[0]!.headers).toEqual({ accept: "*/*", "accept-encoding": "identity", "if-none-match": '"v7"', "user-agent": "ohmail-Calendar/2.0" });
    const dated = chain({}, NAMES);
    await dated.port.request("https://a.example.test/feed", get({ validators: { etag: null, lastModified: "Sat, 14 Nov 2026 08:00:00 GMT" } }));
    expect(dated.calls[0]!.headers["if-modified-since"]).toBe("Sat, 14 Nov 2026 08:00:00 GMT");
  });
});

describe("a credential travels only where it is admitted", () => {
  const NAMES = { "caldav.example.test": [PUBLIC], "p01-caldav.example.test": [PUBLIC], "evil.example.test": [PUBLIC] };
  const PASSWORD = ["glaze", "kiln", "slip"].join("-");
  const auth = { credential: { kind: "basic" as const, user: "mila", password: () => PASSWORD }, admits: (host: string) => host === "caldav.example.test" || host.endsWith(".example.test") && host.startsWith("p01-"), tlsOnly: false };
  function hosts(redirectTo: string | null) {
    const { resolver } = resolverOf(NAMES);
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const request = async (url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> => {
      calls.push({ url, headers: opts.headers ?? {} });
      const stream = Readable.from([Buffer.from("ok")]) as unknown as IncomingMessage;
      return calls.length === 1 && redirectTo !== null ? { status: 301, headers: { location: redirectTo }, stream } : { status: 207, headers: {}, stream };
    };
    return { port: guardedRequest({ resolver, request, policy: { kind: "cloud" }, limits: LIMITS, hosts: null }), calls };
  }
  const propfind = get({ method: "PROPFIND", headers: { depth: "0", "content-type": "application/xml; charset=utf-8" }, body: "<propfind/>", auth });
  const line = `Basic ${Buffer.from(`mila:${PASSWORD}`, "utf8").toString("base64")}`;

  it("goes to the host that was typed and to a host the caller admits, with the request's own headers and no others", async () => {
    const { port, calls } = hosts("https://p01-caldav.example.test/123/calendars/");
    const answer = await port.request("https://caldav.example.test/", propfind);
    expect(answer.arrived && answer.status).toBe(207);
    expect(calls.map((c) => c.headers.authorization)).toEqual([line, line]);
    expect(Object.keys(calls[1]!.headers).sort()).toEqual(["accept", "accept-encoding", "authorization", "content-length", "content-type", "depth", "user-agent"]);
    expect(calls[1]!.headers["content-length"]).toBe("11");
  });

  it("makes no request to any other host a redirect names, and none to one it is asked for directly", async () => {
    const redirected = hosts("https://evil.example.test/collect");
    expect(wordOf(await redirected.port.request("https://caldav.example.test/", propfind))).toBe("host_changed");
    expect(redirected.calls.map((c) => c.url)).toEqual(["https://caldav.example.test/"]);
    const direct = hosts(null);
    expect(wordOf(await direct.port.request("https://evil.example.test/principals/", propfind))).toBe("host_changed");
    expect(direct.calls.length).toBe(0);
  });

  it("carries a short sign-in as a bearer line, and refuses one that is no token before any request", async () => {
    const bearer = (token: string) => get({ auth: { credential: { kind: "bearer", token }, admits: (host) => host === "caldav.example.test", tlsOnly: true } });
    const good = hosts(null);
    await good.port.request("https://caldav.example.test/", bearer("short-lived"));
    expect(good.calls[0]!.headers.authorization).toBe("Bearer short-lived");
    const bad = hosts(null);
    expect(wordOf(await bad.port.request("https://caldav.example.test/", bearer("two\r\nlines")))).toBe("sign_in_refused");
    expect(bad.calls.length).toBe(0);
  });

  it("is not sent without TLS where the sign-in is for TLS alone: a plain address is refused before anyone is asked", async () => {
    const { resolver, asked } = resolverOf({ "caldav.example.test": ["192.168.1.20"] });
    const { request, calls } = standIn();
    const port = guardedRequest({ resolver, request, policy: { kind: "own-network" }, limits: LIMITS, hosts: null });
    const plain = "http://caldav.example.test:8008/principals/mila/";
    expect(wordOf(await port.request(plain, get({ auth: { ...auth, tlsOnly: true } })))).toBe("address_not_allowed");
    expect([asked, calls.length]).toEqual([[], 0]);
    // Typed without TLS, the same sign-in travels so to a private address: the one plain request there is.
    expect(wordOf(await port.request(plain, get({ auth })))).toBe("arrived");
    expect(wordOf(await port.request("https://caldav.example.test:8443/principals/mila/", get({ auth: { ...auth, tlsOnly: true } })))).toBe("arrived");
    expect(calls.map((c) => [c.url.split(":")[0], c.opts.headers?.authorization])).toEqual([["http", line], ["https", line]]);
  });

  it("says nothing but its word when it refuses", async () => {
    const { port } = hosts("https://evil.example.test/collect");
    const answer = await port.request("https://caldav.example.test/", propfind);
    expect(answer).toEqual({ arrived: false, reason: "host_changed" });
    expect(JSON.stringify(answer)).not.toMatch(/example|mila|glaze/);
  });

  it("lets an adapter name four headers and no other: anything else is a fault of the program", async () => {
    const { port, calls } = hosts(null);
    await expect(port.request("https://caldav.example.test/", get({ headers: { cookie: "a=b" } as never }))).rejects.toThrow(TypeError);
    await expect(port.request("https://caldav.example.test/", get({ headers: { accept: "text/calendar\r\nx-injected: 1" } }))).rejects.toThrow(TypeError);
    expect(calls.length).toBe(0);
  });

  it("keeps nothing between two calls: each asks the resolver and dials on its own", async () => {
    const { resolver, asked } = resolverOf(NAMES);
    const { request, calls } = standIn();
    const port = guardedRequest({ resolver, request, policy: { kind: "cloud" }, limits: LIMITS, hosts: null });
    await port.request("https://caldav.example.test/", propfind);
    await port.request("https://caldav.example.test/", get());
    expect([asked.length, calls.length, calls[1]!.opts.headers?.authorization]).toEqual([2, 2, undefined]);
  });
});

describe("the call's own bounds end every wait, whatever the connection does", () => {
  const NAMES = { "feeds.example.test": [PUBLIC] };
  const URL_ASKED = "https://feeds.example.test/basic.ics";
  /** A body that neither comes nor ends, whatever is done to it. It counts how often it was told to end. */
  function endless() {
    let ended = 0;
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }), destroy: () => void ended++ };
    return { stream: stream as unknown as IncomingMessage, ended: () => ended };
  }
  const over = (request: GuardDeps["request"], limits: Partial<GuardDeps["limits"]>) =>
    guardedRequest({ resolver: resolverOf(NAMES).resolver, request, policy: { kind: "cloud" }, limits: { ...LIMITS, ...limits }, hosts: null });

  it("ends as a timeout when a request neither answers nor fails: at the head's bound, and at the caller's word", { timeout: 4_000 }, async () => {
    // A request that settles never and hears no signal: what a connection ended without an answer and without an error is.
    const silent: GuardDeps["request"] = () => new Promise<PinnedResponse>(() => undefined);
    const bound = Date.now();
    expect(wordOf(await over(silent, { connectMs: 100 }).request(URL_ASKED, get()))).toBe("timeout");
    expect(Date.now() - bound).toBeLessThan(1_500);
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 60);
    const word = Date.now();
    expect(wordOf(await over(silent, {}).request(URL_ASKED, get({ signal: caller.signal })))).toBe("timeout");
    expect(Date.now() - word).toBeLessThan(1_500);
  });

  it("ends as a timeout when a body neither ends nor fails, and tells the connection to end", { timeout: 4_000 }, async () => {
    const body = endless();
    const began = Date.now();
    expect(wordOf(await over(async () => ({ status: 200, headers: {}, stream: body.stream }), { totalMs: 150 }).request(URL_ASKED, get()))).toBe("timeout");
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(body.ended()).toBe(1);
  });

  it("leaves no failure unheard when the caller gives up between an answer's head and its body", { timeout: 4_000 }, async () => {
    // A body that fails once it is told to end, as a connection's does.
    let fail: (err: Error) => void = () => undefined;
    const failing = new Promise<IteratorResult<Uint8Array>>((_next, reject) => (fail = reject));
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => failing }), destroy: () => fail(Object.assign(new Error("the connection was ended"), { code: "ECONNRESET" })) };
    const caller = new AbortController();
    const request: GuardDeps["request"] = () => {
      const answer = Promise.resolve({ status: 200, headers: {}, stream: stream as unknown as IncomingMessage });
      // The caller's word falls after the head has arrived and before the body is first read.
      void answer.then(() => queueMicrotask(() => caller.abort()));
      return answer;
    };
    const unheard: unknown[] = [];
    const hear = (reason: unknown): void => void unheard.push(reason);
    process.on("unhandledRejection", hear);
    try {
      expect(wordOf(await over(request, {}).request(URL_ASKED, get({ signal: caller.signal })))).toBe("timeout");
      // A failure nobody heard is reported once the turn is over.
      await new Promise((done) => setTimeout(done, 30));
      expect(unheard).toEqual([]);
    } finally {
      process.off("unhandledRejection", hear);
    }
  });

  it("ends the connection of an answer that comes after the wait is over", { timeout: 4_000 }, async () => {
    const body = endless();
    const late: GuardDeps["request"] = () => new Promise((answer) => setTimeout(() => answer({ status: 200, headers: {}, stream: body.stream }), 250));
    expect(wordOf(await over(late, { connectMs: 80 }).request(URL_ASKED, get()))).toBe("timeout");
    expect(body.ended()).toBe(0);
    await new Promise((done) => setTimeout(done, 350));
    expect(body.ended()).toBe(1);
  });
});

describe("a certificate the platform does not accept", () => {
  // Every code the platform's documentation lists for a certificate that failed its check, and the one it
  // gives a fault its table does not name. Written from that list, not from the port's.
  const CERTIFICATE_FAULTS = [
    "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_CRL", "UNABLE_TO_DECRYPT_CERT_SIGNATURE", "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
    "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "CERT_SIGNATURE_FAILURE", "CRL_SIGNATURE_FAILURE", "CERT_NOT_YET_VALID", "CERT_HAS_EXPIRED",
    "CRL_NOT_YET_VALID", "CRL_HAS_EXPIRED", "ERROR_IN_CERT_NOT_BEFORE_FIELD", "ERROR_IN_CERT_NOT_AFTER_FIELD",
    "ERROR_IN_CRL_LAST_UPDATE_FIELD", "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "OUT_OF_MEM", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_CHAIN_TOO_LONG",
    "CERT_REVOKED", "INVALID_CA", "PATH_LENGTH_EXCEEDED", "INVALID_PURPOSE", "CERT_UNTRUSTED", "CERT_REJECTED", "HOSTNAME_MISMATCH",
    "UNSPECIFIED", "ERR_TLS_CERT_ALTNAME_INVALID",
  ];
  const failing = (code: string) => {
    const { resolver } = resolverOf({ "feeds.example.test": [PUBLIC] });
    const request: GuardDeps["request"] = () => Promise.reject(Object.assign(new Error("the handshake failed"), { code }));
    return guardedRequest({ resolver, request, policy: { kind: "cloud" }, limits: LIMITS, hosts: null });
  };

  it("is a connection that failed, whatever is wrong with it, and never a throw", async () => {
    const answered: [string, ProviderRefusal | "arrived" | "thrown"][] = [];
    for (const code of CERTIFICATE_FAULTS) {
      answered.push([code, await failing(code).request("https://feeds.example.test/basic.ics", get()).then(wordOf, () => "thrown" as const)]);
    }
    expect(answered).toEqual(CERTIFICATE_FAULTS.map((code) => [code, "connection_failed"]));
  });

  it("still throws on what is no network's failure: a fault of the program is not answered as a server's", async () => {
    await expect(failing("ERR_INVALID_ARG_TYPE").request("https://feeds.example.test/basic.ics", get())).rejects.toThrow("the handshake failed");
  });
});

describe("a provider's fixed hosts", () => {
  it("are the only hosts dialled: any other is refused before the resolver is asked", async () => {
    const { port, asked, calls } = guard({ kind: "cloud" }, { "www.googleapis.com": [PUBLIC], "evil.example.test": [PUBLIC] }, new Set(["www.googleapis.com"]));
    expect(wordOf(await port.request("https://evil.example.test/calendar/v3/users/me/calendarList", get()))).toBe("address_not_allowed");
    expect(wordOf(await port.request("https://www.googleapis.com.evil.example.test/", get()))).toBe("address_not_allowed");
    expect([asked, calls.length]).toEqual([[], 0]);
    expect(wordOf(await port.request("https://WWW.googleapis.com./calendar/v3/users/me/calendarList", get()))).toBe("arrived");
    expect(asked).toEqual(["www.googleapis.com"]);
  });
});

// ── from here on: the real pinned request, against servers of this file's own on 127.0.0.1 ──

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end();
const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];
let connections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  server.on("connection", () => connections++);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const NOBODY: HostResolver = { resolve: async () => [] };
const real = (limits: Partial<GuardDeps["limits"]> = {}, policy: GuardDeps["policy"] = { kind: "own-network" }) =>
  guardedRequest({ resolver: NOBODY, request: pinnedHttpRequest, policy, limits: { ...LIMITS, ...limits }, hosts: null });
const serve = (h: Handler): void => {
  handler = h;
  seen.length = 0;
  connections = 0;
};

describe("on a real connection", () => {
  it("reads an answer through redirects on the person's own network, one connection a request", async () => {
    serve((req, res) => {
      if (req.url === "/a") res.writeHead(301, { location: "/b" }).end();
      else if (req.url === "/b") res.writeHead(302, { location: `${base}/c` }).end();
      else res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"' }).end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    });
    const answer = await namedHostRequest({ resolver: NOBODY, policy: { kind: "own-network" } }).request(`${base}/a`, get());
    expect(answer.arrived && [answer.status, answer.hops, answer.url, answer.header("ETag"), answer.header("x-absent"), textOf(answer.body)]).toEqual([200, 2, `${base}/c`, '"v1"', null, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"]);
    expect([seen.map((s) => s.url), connections]).toEqual([["/a", "/b", "/c"], 3]);
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
  });

  it("opens no socket for the same address on a hosted server", async () => {
    serve((_req, res) => res.end("never"));
    const answer = await namedHostRequest({ resolver: NOBODY, policy: { kind: "cloud" } }).request(`${base}/a`, get());
    expect([wordOf(answer), connections]).toEqual(["address_not_allowed", 0]);
  });

  it("hands a redirect back as it is where a provider's hosts are fixed, and follows nothing", async () => {
    serve((_req, res) => res.writeHead(302, { location: "https://elsewhere.example.test/" }).end());
    const answer = await fixedHostRequest(new Set(["127.0.0.1"]), { resolver: NOBODY, policy: { kind: "own-network" } }).request(`${base}/v1.0/me/calendars`, get());
    expect(answer.arrived && [answer.status, answer.location, answer.hops]).toEqual([302, "https://elsewhere.example.test/", 0]);
    expect(seen.length).toBe(1);
  });

  it("refuses a body that says it is past the ceiling without reading it, and one that grows past it while it arrives", async () => {
    serve((_req, res) => {
      res.writeHead(200, { "content-length": String(LIMITS.maxBodyBytes + 1) });
      res.write("BEGIN:VCALENDAR");
    });
    expect(wordOf(await real().request(`${base}/declared`, get()))).toBe("too_large");
    let written = 0;
    serve((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 0x41);
      const more = (): void => {
        if (res.destroyed) return;
        written += chunk.length;
        res.write(chunk, () => setImmediate(more));
      };
      more();
    });
    expect(wordOf(await real().request(`${base}/grows`, get()))).toBe("too_large");
    expect(written).toBeLessThan(LIMITS.maxBodyBytes * 8);
    serve((_req, res) => res.end(Buffer.alloc(LIMITS.maxBodyBytes, 0x41)));
    const exact = await real().request(`${base}/exact`, get());
    expect(exact.arrived && exact.body.byteLength).toBe(LIMITS.maxBodyBytes);
  });

  it("refuses a packed answer unread: nothing is unpacked, so nothing can grow after the count", async () => {
    serve((_req, res) => res.writeHead(200, { "content-encoding": "gzip" }).end(Buffer.from([0x1f, 0x8b, 0x08])));
    expect(wordOf(await real().request(`${base}/packed`, get()))).toBe("unreadable");
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity");
  });

  it("gives up when the answer's head does not come, and when the body does not end", async () => {
    serve(() => undefined);
    const head = Date.now();
    expect(wordOf(await real({ connectMs: 150 }).request(`${base}/silent`, get()))).toBe("timeout");
    expect(Date.now() - head).toBeLessThan(1_500);
    serve((_req, res) => {
      res.writeHead(200);
      const drip = setInterval(() => (res.destroyed ? clearInterval(drip) : res.write("X")), 40);
    });
    const body = Date.now();
    expect(wordOf(await real({ totalMs: 300 }).request(`${base}/drip`, get()))).toBe("timeout");
    expect(Date.now() - body).toBeLessThan(1_500);
  });

  it("ends with a word, not a throw, when the caller gives up or nobody listens", async () => {
    serve(() => undefined);
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 60);
    expect(wordOf(await real().request(`${base}/silent`, get({ signal: caller.signal })))).toBe("timeout");
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    expect(wordOf(await real().request(`http://127.0.0.1:${port}/`, get()))).toBe("connection_failed");
  });

  it("gives up at its bound and at the caller's word on a server that answers with a change of protocol", { timeout: 4_000 }, async () => {
    // The platform ends such a request with no answer and no error, so nothing but the call's own clock ends the wait.
    const sockets: Socket[] = [];
    const upgrading = createRawServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.once("data", () => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
    });
    await new Promise<void>((done) => upgrading.listen(0, "127.0.0.1", done));
    const at = `http://127.0.0.1:${(upgrading.address() as AddressInfo).port}/feed.ics`;
    try {
      const bound = Date.now();
      expect(wordOf(await real({ connectMs: 150 }).request(at, get()))).toBe("timeout");
      expect(Date.now() - bound).toBeLessThan(1_500);
      const caller = new AbortController();
      setTimeout(() => caller.abort(), 60);
      const word = Date.now();
      expect(wordOf(await real().request(at, get({ signal: caller.signal })))).toBe("timeout");
      expect(Date.now() - word).toBeLessThan(1_500);
      expect(sockets.length).toBe(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      upgrading.close();
    }
  });

  it("ends with a word, not a throw, when the server speaks no TLS", async () => {
    serve((_req, res) => res.end("plain"));
    expect(wordOf(await real().request(base.replace("http:", "https:"), get()))).toBe("connection_failed");
    expect(seen).toEqual([]);
  });
});

describe("the socket goes where the gate's lookup said, not where the name leads a second time", () => {
  // `localhost` is a name the system resolves by itself. Two servers listen on one port at two addresses of this
  // machine, and the program's lookup names one of them. A pinned request reaches that one, whichever it is; a
  // request that looked the name up again would reach the system's choice both times, so one of the two rows fails.
  /** A server at this address that answers with the address, or what kept it from listening there. */
  const listen = (address: string, port: number): Promise<Server | NodeJS.ErrnoException> =>
    new Promise((done) => {
      const s = createServer((_req, res) => res.end(address));
      s.once("error", done);
      s.listen(port, address, () => done(s));
    });
  const end = (s: Server): void => {
    s.closeAllConnections();
    s.close();
  };
  /** One server at each address on one port of the system's choosing; `null` where this machine has no such second address. */
  async function onOnePort(first: string, second: string): Promise<{ port: number; close(): void } | null> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = await listen(first, 0);
      if (a instanceof Error) return null;
      const port = (a.address() as AddressInfo).port;
      const b = await listen(second, port);
      if (!(b instanceof Error)) return { port, close: () => [a, b].forEach(end) };
      end(a);
      // Somebody else holds the port at the second address: another port. Any other failure: no such address here.
      if (b.code !== "EADDRINUSE") return null;
    }
    return null;
  }
  const PAIRS: readonly (readonly [string, string])[] = [["127.0.0.1", "127.0.0.2"], ["127.0.0.1", "::1"]];
  const MAKERS: [string, (resolver: HostResolver) => HttpPort][] = [
    ["a host a person named", (resolver) => namedHostRequest({ resolver, policy: { kind: "own-network" } })],
    ["a provider's fixed hosts", (resolver) => fixedHostRequest(new Set(["localhost"]), { resolver, policy: { kind: "own-network" } })],
  ];

  for (const [name, make] of MAKERS) {
    it(`through the port for ${name}`, async (ctx) => {
      // The first pair of addresses this machine can listen at. One with a single loopback address cannot tell the two requests apart.
      let pair: readonly [string, string] | undefined;
      for (const candidate of PAIRS) {
        const probe = await onOnePort(...candidate);
        probe?.close();
        if (probe !== null) {
          pair = candidate;
          break;
        }
      }
      if (pair === undefined) return ctx.skip();
      const reached: [string, string | false][] = [];
      for (const pinned of pair) {
        // Servers and a port of the row's own: the platform keeps a connection by name, and would answer from it.
        const servers = await onOnePort(...pair);
        if (servers === null) throw new Error("the two addresses were free a moment ago");
        try {
          const answer = await make({ resolve: async () => [pinned] }).request(`http://localhost:${servers.port}/`, get());
          reached.push([pinned, answer.arrived && textOf(answer.body)]);
        } finally {
          servers.close();
        }
      }
      expect(reached).toEqual(pair.map((address) => [address, address]));
    });
  }
});

describe("what an answer says about waiting", () => {
  const answered = (value: string | null): HttpResponse => ({ arrived: true, status: 429, header: (name) => (name.toLowerCase() === "retry-after" ? value : null), body: new Uint8Array(), location: null, url: "https://feeds.example.test/", hops: 0 });
  const clock = { now: () => Date.parse("2026-11-14T08:00:00Z") };

  it("is read in seconds or as a date, never below nothing and never above a day", () => {
    expect(retryAfterMs(answered("120"), clock)).toBe(120_000);
    expect(retryAfterMs(answered("Sat, 14 Nov 2026 08:05:00 GMT"), clock)).toBe(300_000);
    expect(retryAfterMs(answered("Sat, 14 Nov 2026 07:00:00 GMT"), clock)).toBe(0);
    expect(retryAfterMs(answered("999999999"), clock)).toBe(86_400_000);
    expect(retryAfterMs(answered("soon"), clock)).toBeNull();
    expect(retryAfterMs(answered(null), clock)).toBeNull();
  });

  it("is text read as UTF-8, a byte-order mark taken off", () => {
    expect(textOf(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("Töpferei", "utf8")]))).toBe("Töpferei");
  });

  it("has the ceiling a calendar text has", () => {
    expect(FETCH_BODY_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
