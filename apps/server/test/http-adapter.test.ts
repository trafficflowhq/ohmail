import { afterEach, describe, expect, it } from "vitest";
import { get as httpGet, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { makeHttpServer, type AdapterOptions } from "../src/http.js";
import { ACCOUNT_HEADER, JSON_BODY_MAX_BYTES } from "@trafficflow/api";
import { handleServerRequest } from "../src/handler.js";

/**
 * THE FOUR RULED CORRECTNESS POINTS of the hand-rolled adapter, each on a REAL socket — no
 * mocked IncomingMessage, no synthetic Request: the thing under test is precisely the
 * translation between the wire and the fetch types, so a fake on either side proves nothing.
 *
 *  1. `Readable.toWeb(req)` + `duplex:"half"` — a request body streams into the handler's
 *     Request (and a BODY-LESS POST arrives with `body === null`, which is what keeps
 *     `withRequestGuard` from demanding a Content-Type of `POST /auth/logout`).
 *  2. Multi-value `Set-Cookie` via `getSetCookie()` — a sign-in's five cookies reach the wire
 *     as five header lines, never one comma-joined line.
 *  3. Streaming response bodies — an SSE frame reaches the client WHILE the stream is open,
 *     not when it closes.
 *  4. Body byte cap (declared and chunked-lying variants) + headersTimeout/requestTimeout.
 */

const OPTS: AdapterOptions = {
  bodyMaxBytes: 64 * 1024,
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
};

const servers: Server[] = [];

function listen(handle: (req: Request) => Promise<Response>, opts: AdapterOptions = OPTS): Promise<number> {
  const server = makeHttpServer(handle, opts);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(null)));
  }
});

describe("point 1 — request bodies stream in as web streams", () => {
  it("a POST body round-trips through Readable.toWeb into req.text()", async () => {
    const port = await listen(async (req) => new Response(await req.text(), { status: 200 }));
    const body = JSON.stringify({ hello: "wörld → 東京", n: 42 });
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("a CHUNKED body (no Content-Length) arrives whole — the stream, not a buffer snapshot", async () => {
    const port = await listen(async (req) => new Response(await req.text(), { status: 200 }));
    // A raw socket so the request is genuinely Transfer-Encoding: chunked in two spaced writes.
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => { /* the assertion below is on the bytes received */ });
    await once(sock, "connect");
    sock.write("POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n");
    sock.write("5\r\nfirst\r\n");
    await new Promise((r) => setTimeout(r, 50));
    sock.write("7\r\n-second\r\n0\r\n\r\n");
    let raw = "";
    sock.on("data", (d) => { raw += d.toString("utf8"); });
    await once(sock, "close");
    expect(raw).toContain("200");
    expect(raw).toContain("first-second");
  });

  it("a body-less POST hands the handler a Request with body === null", async () => {
    let sawBody: unknown = "unset";
    const port = await listen(async (req) => {
      sawBody = req.body;
      return new Response(null, { status: 204 });
    });
    const res = await fetch(`http://127.0.0.1:${port}/auth/logout`, { method: "POST" });
    expect(res.status).toBe(204);
    // The load-bearing null: a zero-length stream here would make withRequestGuard answer 415
    // to a legitimately body-less POST one layer up.
    expect(sawBody).toBeNull();
  });
});

describe("point 2 — Set-Cookie multiplicity survives the translation", () => {
  it("five appended Set-Cookie headers arrive as five header lines", async () => {
    const port = await listen(async () => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "tf_session=a; HttpOnly; SameSite=Strict; Secure; Path=/");
      headers.append("set-cookie", "tf_refresh=b; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh");
      headers.append("set-cookie", "tf_csrf=c; SameSite=Strict; Secure; Path=/");
      headers.append("set-cookie", "tf_resume=1; HttpOnly; SameSite=Lax; Secure; Path=/");
      headers.append("set-cookie", "tf_owner=d; SameSite=Strict; Secure; Path=/");
      return new Response("{}", { status: 200, headers });
    });
    // node's own client keeps set-cookie as an ARRAY of wire lines — the honest witness.
    const cookies = await new Promise<string[]>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${port}/login`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["set-cookie"] ?? []));
      }).on("error", reject);
    });
    expect(cookies).toHaveLength(5);
    expect(cookies[0]).toContain("tf_session=");
    expect(cookies[1]).toContain("tf_refresh=");
    // …and no line carries a comma-fold of its siblings.
    for (const line of cookies) expect(line).not.toMatch(/, *tf_/);
  });
});

describe("point 3 — response bodies STREAM (the SSE case)", () => {
  it("the first frame reaches the client while the stream is still open", async () => {
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((r) => { releaseSecond = r; });
    const port = await listen(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          await secondGate;                       // held open until the test SAW frame one
          controller.enqueue(new TextEncoder().encode("data: two\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    const first = await reader.read();
    // Frame one arrived while the server-side stream is provably unfinished — a buffering
    // adapter would hang this read until close, and SSE would not work at all.
    expect(new TextDecoder().decode(first.value)).toContain("data: one");
    releaseSecond();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("data: two");
    expect((await reader.read()).done).toBe(true);
  });

  it("ends event streams cleanly during shutdown while an ordinary response drains", async () => {
    const eventStreamShutdown = new AbortController();
    let ordinaryStarted: () => void = () => {};
    let completeOrdinary: () => void = () => {};
    const ordinaryRequest = new Promise<void>((resolve) => { ordinaryStarted = resolve; });
    const ordinaryResponse = new Promise<void>((resolve) => { completeOrdinary = resolve; });
    let ordinaryAborted = false;
    const port = await listen(async (req) => {
      if (new URL(req.url).pathname === "/ordinary") {
        ordinaryStarted();
        await ordinaryResponse;
        ordinaryAborted = req.signal.aborted;
        return new Response("finished");
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
          req.signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }, { ...OPTS, eventStreamShutdown: eventStreamShutdown.signal });

    const events = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    const ordinary = fetch(`http://127.0.0.1:${port}/ordinary`);
    await ordinaryRequest;

    const server = servers.at(-1)!;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    eventStreamShutdown.abort();
    const grace = setTimeout(() => server.closeAllConnections(), 500);
    completeOrdinary();

    try {
      expect(await (await ordinary).text()).toBe("finished");
      expect(ordinaryAborted).toBe(false);
      expect((await reader.read()).done).toBe(true);
      await closed;
    } finally {
      clearTimeout(grace);
    }
  });
});

describe("the proxy-header trust boundary (review follow-ups)", () => {
  it("inbound x-vercel-* headers are DROPPED — the platform reservation does not hold here", async () => {
    // clientIp() trusts x-vercel-forwarded-for FIRST because Vercel's edge overwrites it; on
    // this host nothing does, so a kept header is a caller-chosen rate-limit bucket and a
    // forged audit line. The handler must never see it.
    let seen: string | null = "unset";
    let xff: string | null = null;
    const port = await listen(async (req) => {
      seen = req.headers.get("x-vercel-forwarded-for");
      xff = req.headers.get("x-forwarded-for");
      return new Response("{}", { status: 200 });
    });
    const res = await fetch(`http://127.0.0.1:${port}/hello`, {
      headers: { "x-vercel-forwarded-for": "6.6.6.6", "x-vercel-id": "forged" },
    });
    expect(res.status).toBe(200);
    expect(seen).toBeNull();
    // …and the adapter appended the SOCKET's peer as the last x-forwarded-for hop, so the
    // last-hop rule keys to an address the caller cannot choose.
    expect(xff).toMatch(/127\.0\.0\.1$/);
  });

  it("a hand-typed x-forwarded-for cannot become the last hop — the socket peer is appended after it", async () => {
    let xff: string | null = null;
    const port = await listen(async (req) => {
      xff = req.headers.get("x-forwarded-for");
      return new Response("{}", { status: 200 });
    });
    await fetch(`http://127.0.0.1:${port}/hello`, { headers: { "x-forwarded-for": "6.6.6.6" } });
    const hops = (xff ?? "").split(",").map((s) => s.trim());
    expect(hops[0]).toBe("6.6.6.6");             // the forgery survives as a leading hop…
    expect(hops[hops.length - 1]).toMatch(/127\.0\.0\.1/);  // …and never as the trusted last one
  });
});

describe("point 4 — the body cap and the two socket timeouts", () => {
  it("a DECLARED Content-Length over the cap is 413 before the handler ever runs", async () => {
    let handled = 0;
    const port = await listen(async () => { handled += 1; return new Response("{}"); });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: "/drafts", headers: { "content-length": String(OPTS.bodyMaxBytes + 1), "content-type": "application/json" } },
        (r) => {
          let body = "";
          r.on("data", (d) => { body += d.toString(); });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      // Headers only — the refusal must not need a byte of body.
      req.flushHeaders();
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("payload_too_large");
    expect(handled).toBe(0);
  });

  it("a chunked body that LIES past the cap is cut off — 413 or a destroyed socket, never acceptance", async () => {
    let handlerSawWholeBody = false;
    const port = await listen(async (req) => {
      try {
        await req.text();
        handlerSawWholeBody = true;
      } catch {
        /* the capped stream errored mid-read — the refusing branch */
      }
      return new Response("{}", { status: 200 });
    }, { ...OPTS, bodyMaxBytes: 1024 });

    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => { /* a mid-write reset IS the refusal — asserted via close below */ });
    await once(sock, "connect");
    sock.write("POST /drafts HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n");
    let raw = "";
    sock.on("data", (d) => { raw += d.toString("utf8"); });
    const chunk = "a".repeat(512);
    const closed = once(sock, "close");
    const interval = setInterval(() => {
      if (sock.destroyed) { clearInterval(interval); return; }
      sock.write(`${(512).toString(16)}\r\n${chunk}\r\n`);
    }, 5);
    await closed;
    clearInterval(interval);
    // The server must have cut the connection (it did — we are past `close`), the handler must
    // never have seen a complete over-cap body, and when a response got out it was the 413.
    expect(handlerSawWholeBody).toBe(false);
    if (/HTTP\/1\.1 (\d+)/.test(raw)) expect(raw).toMatch(/HTTP\/1\.1 413/);
  });

  it("a chunked GET body is refused outright — the cap cannot be bypassed on a body-less method", async () => {
    // The measured bypass: GET/HEAD used to get a body-less Request while node's
    // keep-alive dump drained the wire body UNCOUNTED until requestTimeout. Now a GET that
    // declares a body is 400 + a destroyed connection before a chunk is read.
    let handled = 0;
    const port = await listen(async () => { handled += 1; return new Response("{}"); }, { ...OPTS, bodyMaxBytes: 1024 });
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => { /* the destroy IS the refusal */ });
    let raw = "";
    sock.on("data", (d) => { raw += d.toString("utf8"); });
    await once(sock, "connect");
    sock.write("GET /hello HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n");
    const closed = once(sock, "close");
    const chunk = "a".repeat(512);
    const interval = setInterval(() => {
      if (sock.destroyed) { clearInterval(interval); return; }
      sock.write(`${(512).toString(16)}\r\n${chunk}\r\n`);
    }, 5);
    const start = Date.now();
    await closed;
    clearInterval(interval);
    // Refused fast (never the requestTimeout drain), with the named refusal, handler untouched.
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(raw).toContain("400");
    expect(raw).toContain("body_not_allowed");
    expect(handled).toBe(0);
  });

  it("headersTimeout/requestTimeout are armed on the server and destroy a stalled socket", async () => {
    const port = await listen(async () => new Response("{}"), {
      bodyMaxBytes: 1024,
      headersTimeoutMs: 100,
      requestTimeoutMs: 200,
      connectionsCheckingIntervalMs: 25,
    });
    const server = servers[servers.length - 1]!;
    // The properties themselves — mutate makeHttpServer to drop either assignment and this line
    // goes red even where the behavioral half might race.
    expect(server.headersTimeout).toBe(100);
    expect(server.requestTimeout).toBe(200);

    // Behavioral half: a client that sends HALF its headers and then stalls (slowloris) gets
    // node's own `408 Request Timeout` + close from the connections sweep instead of holding a
    // socket forever. The CLIENT MUST READ for that to be observable — the 408 arrives as data
    // followed by FIN, and a paused socket sees neither (measured: an unread refusal looks
    // exactly like an unenforced timeout).
    const sock: Socket = connect(port, "127.0.0.1");
    sock.setEncoding("utf8");
    let response = "";
    sock.on("data", (c: string) => { response += c; });
    sock.on("error", () => { /* a reset is also an enforced close */ });
    await once(sock, "connect");
    sock.write("GET /health HTTP/1.1\r\nHost: half");
    const start = Date.now();
    await Promise.race([once(sock, "end"), once(sock, "close")]);
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(response).toContain("408");
  });
});

/**
 * ── THE UNREAD BODY AND THE KEEP-ALIVE CONNECTION — a REAL socket, because nothing else shows it
 *
 * `handleServerRequest` now decides how much of a request body to buffer from the ROUTE, and
 * answers 404/413 without reading it at all when the answer does not depend on it. That is the
 * point of the change; it also means the refused bytes are still on the wire, and this is the
 * case a synthetic `ReadableStream` cannot expose.
 *
 * The mechanism, verified against node rather than assumed: the adapter builds the web body as
 * `Readable.toWeb(req.pipe(cap))`. Cancelling that web stream destroys `cap` and UNPIPES the
 * `IncomingMessage` — it neither destroys nor drains it — and `pipe` has already set node's
 * `_consuming` flag, which is the exact flag node's own `req._dump()` fallback checks before
 * draining at end-of-response. So on a keep-alive connection the leftover bytes are parsed as
 * the START OF THE NEXT REQUEST.
 *
 * The host therefore answers `Connection: close` whenever it deliberately left bytes unread.
 * These two cases drive one physical socket and read what actually comes back.
 */
/**
 * ── A CANCELLED REQUEST BODY AND THE KEEP-ALIVE CONNECTION ────────────────────────────────
 *
 * `handleServerRequest` decides how much of a request body to buffer from the ROUTE, and answers
 * 404/413 without finishing it when the answer does not depend on it — `readBodyWithin` cancels
 * the web stream, at zero bytes for a path the table does not serve and part-way for a body over
 * its route's ceiling.
 *
 * ── WHAT CANCELLING ACTUALLY DOES TO THE SOCKET, MEASURED ────────────────────────────────
 *
 * The adapter builds the web body as `Readable.toWeb(req.pipe(cap))`. Cancelling that stream
 * destroys `cap` and UNPIPES the `IncomingMessage`; it neither destroys nor drains it. `pipe` has
 * already set node's `_consuming` flag, and that is the exact flag node's own end-of-response
 * `req._dump()` checks before draining — so it skips this request, the refused bytes stay on the
 * wire, and the next request on a keep-alive connection is parsed starting inside them.
 *
 * **Measured on a real socket, not reasoned.** The control below pipelines a second request
 * behind a cancelled body with no `Connection: close` and gets ONE answer where two were sent:
 * the connection is stalled until the request timeout. A handler that never touches the body at
 * all is fine (node drains it) — cancelling is what breaks it, and cancelling is what the door
 * does.
 *
 * Measured at 256 KiB rather than 4 KiB deliberately: a small body fits inside the transform's
 * own buffers and round-trips a pipelined request perfectly well, so the stall is SIZE-DEPENDENT
 * — the shape this repository treats as looking like flakiness rather than like a defect. The
 * 4 KiB form of the control passed while the defect was live.
 *
 * So the host answers `Connection: close` whenever it deliberately left bytes unread. It costs
 * one TCP connection per refused request, charged to the party that sent a body for a route that
 * does not exist or that broke the route's own ceiling.
 */
const BIG_BODY = 256 * 1024;
/**
 * Clear of {@link BIG_BODY}, so the adapter's cap does not answer the cases that are about the
 * ROUTER's exits (the 404 and the malformed path).
 *
 * **It is NOT clear of a body big enough to break a route's own ceiling**, and that is not an
 * oversight — it is exactly `JSON_BODY_MAX_BYTES`, so a body over a JSON route's ceiling is also
 * over the ADAPTER's, and the adapter refuses first. Both refusals are real and both must close
 * the connection, so the two are separate cases below and each asserts which one answered it.
 * A single case here read as covering both and covered one.
 */
const ROOMY: AdapterOptions = { ...OPTS, bodyMaxBytes: 4 * 1024 * 1024 };
/**
 * A cap ABOVE any route's JSON ceiling, so the request reaches `handleServerRequest` and the
 * ROUTE's ceiling is the thing that refuses — `readBodyWithin` reads part of the body and
 * cancels the rest. See the second ceiling case.
 */
const ABOVE_ROUTE_CEILING: AdapterOptions = { ...OPTS, bodyMaxBytes: 4 * JSON_BODY_MAX_BYTES };

describe("a cancelled request body ends the connection instead of stalling it", () => {
  /** Write raw bytes on one socket and read whatever the server sends back, whole. */
  async function rawExchange(port: number, wire: string, waitMs = 400): Promise<string> {
    const sock: Socket = connect(port, "127.0.0.1");
    await once(sock, "connect");
    let text = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => { text += d; });
    // THE SERVER ENDS THIS CONNECTION ON PURPOSE — that is the property these cases assert — so a
    // body still in flight finishes with ECONNRESET on this side. With no listener that is an
    // unhandled 'error' event, which node throws and vitest reports as a suite-level failure:
    // sixteen green tests and an exit code of 1, which reads exactly like a broken suite.
    //
    // This is not swallowing the fault. The fault would be the connection STAYING open, and the
    // assertions below check that directly — a reset here is the success case arriving.
    sock.on("error", () => { /* the close is what the test is for */ });
    sock.write(wire);
    await new Promise((r) => setTimeout(r, waitMs));
    sock.destroy();
    return text;
  }

  /** A request with an unread body, then a pipelined GET, on one connection. */
  const pipelined = (path: string, payload: string): string =>
    `POST ${path} HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${payload.length}\r\n\r\n${payload}` +
    `GET /health HTTP/1.1\r\nHost: h\r\n\r\n`;

  /**
   * THE PRODUCTION HANDLER, not a hand-written stand-in.
   *
   * The first version of these cases hard-coded `connection: "close"` in a fake handler, so
   * deleting the real `exit(...)` in `handleServerRequest` left every one of them green — a
   * regression guard that never watched the thing it guards. A review round said so.
   *
   * The runtime is deliberately EMPTY. `handleServerRequest` decides the connection's fate from
   * the request alone, before `buildDeps` is reached and independently of whether it succeeds:
   * a composition this broken answers 500 rather than 404, and the close decision is applied to
   * both because it is about the SOCKET, not about the answer. That is what makes an empty
   * runtime the right harness here rather than a shortcut — the property under test is the one
   * that does not depend on the bag.
   */
  const brokenRuntime = {
    logger: { error() { /* silent */ }, warn() {}, info() {}, debug() {}, child() { return this; } },
  } as unknown as Parameters<typeof handleServerRequest>[1];

  const productionServer = (): Promise<number> =>
    listen((req) => handleServerRequest(req, brokenRuntime), ROOMY);

  it("a body for a path the table does not serve — the connection ends", async () => {
    const port = await productionServer();

    const text = await rawExchange(port, pipelined("/nope", "x".repeat(BIG_BODY)));

    expect(text.toLowerCase(), "the production handler must say Connection: close")
      .toContain("connection: close");
    // ONE answer, then the connection ends — the honest outcome: the client's pipelined request
    // was never going to be read correctly off this socket.
    expect(text.split("HTTP/1.1 ").length - 1).toBe(1);
  });

  /**
   * THE ADAPTER'S REFUSAL — refused before the router, on the DECLARED length.
   *
   * `productionServer` runs at {@link ROOMY}, whose cap IS `JSON_BODY_MAX_BYTES`, so this body
   * is over the adapter's cap as well as over `/snippets`'s. The adapter therefore answers on
   * `content-length` alone and `handleServerRequest` never runs. The assertions below name that
   * path rather than assuming it: the adapter's envelope says "request body too large" and
   * carries no request id, because only `handler.ts` mints one.
   *
   * The case this one does NOT reach — the route's own ceiling, read and cancelled inside the
   * handler — is the next test.
   */
  it("a body over the ADAPTER's cap — refused before the router, connection ends", async () => {
    const port = await productionServer();
    const over = "y".repeat(JSON_BODY_MAX_BYTES + 64 * 1024);
    const wire =
      `POST /snippets HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${over.length}\r\n\r\n${over}` +
      `GET /health HTTP/1.1\r\nHost: h\r\n\r\n`;

    const text = await rawExchange(port, wire, 800);

    expect(text).toContain("413");
    expect(text).toContain("payload_too_large");
    expect(text.toLowerCase()).toContain("connection: close");
    expect(text.split("HTTP/1.1 ").length - 1).toBe(1);
    // WHICH refusal answered — the discriminator, so the comment above is a checked claim and
    // not a description that can quietly stop being true.
    expect(text).toContain("request body too large");
    expect(text.toLowerCase()).not.toContain("x-request-id");
    // AND IT NAMES NOBODY. This refusal is answered by the adapter, above the router, so no
    // session was ever resolved — and the account header rides only on an answer the session
    // layer produced. A refusal that named an account would be claiming a request it never read
    // belonged to someone.
    expect(text.toLowerCase()).not.toContain(ACCOUNT_HEADER.toLowerCase());
  });

  /**
   * THE ROUTE'S REFUSAL — the harder path, and the one the case above was long documented as
   * covering while never reaching it.
   *
   * The adapter's cap is four times any JSON route's ceiling here, so the request passes the
   * adapter untouched and `handleServerRequest` runs. `normalizeRequest` asks `bodyCeilingFor`
   * for `/snippets`'s own ceiling and `readBodyWithin` READS UP TO IT AND CANCELS THE REST —
   * which is what leaves unread bytes on a socket that node's keep-alive dump will not drain,
   * and therefore what `closing()` in `handler.ts` exists for.
   *
   * Its fingerprint is the opposite of the adapter's: `handler.ts`'s envelope names the route's
   * limit and carries the request id it minted.
   */
  it("a body over the ROUTE's ceiling but under the adapter's — the handler refuses, and closes", async () => {
    const port = await listen((req) => handleServerRequest(req, brokenRuntime), ABOVE_ROUTE_CEILING);
    const over = "y".repeat(JSON_BODY_MAX_BYTES + 64 * 1024);
    const wire =
      `POST /snippets HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${over.length}\r\n\r\n${over}` +
      `GET /health HTTP/1.1\r\nHost: h\r\n\r\n`;

    const text = await rawExchange(port, wire, 800);
    const lower = text.toLowerCase();

    expect(text).toContain("413");
    expect(text).toContain("payload_too_large");
    // The discriminator: this is handler.ts's 413, reached through readBodyWithin.
    expect(text).toContain("exceeds this route's limit");
    expect(lower).toContain("x-request-id");
    // The claim of this whole describe block, on the path that actually cancels a body.
    expect(lower).toContain("connection: close");
    expect(text.split("HTTP/1.1 ").length - 1).toBe(1);
    // Refused during normalization, before `app.handle` — so no session, and no account named.
    expect(lower).not.toContain(ACCOUNT_HEADER.toLowerCase());
  });

  it("a MALFORMED path with a body — the pre-router exit closes too", async () => {
    const port = await productionServer();
    const payload = "z".repeat(BIG_BODY);
    const wire =
      `POST /%ZZ HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${payload.length}\r\n\r\n${payload}` +
      `GET /health HTTP/1.1\r\nHost: h\r\n\r\n`;

    const text = await rawExchange(port, wire);

    // This exit is reached BEFORE `readBodyWithin` runs at all — the path is refused during
    // normalization — so the body was piped into the counting transform and never drained.
    expect(text).toContain("400");
    expect(text).toContain("malformed_path");
    expect(text.toLowerCase()).toContain("connection: close");
  });

  it("an ordinary request KEEPS the connection — the close is not applied to everything", async () => {
    const port = await productionServer();
    // A real route with a body inside its ceiling: nothing was left unread, so nothing is closed.
    // Without this the previous cases would pass just as well if the handler always closed.
    const body = JSON.stringify({ title: "t", body: "b" });
    const wire =
      `POST /snippets HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}` +
      `GET /health HTTP/1.1\r\nHost: h\r\n\r\n`;

    const text = await rawExchange(port, wire);

    expect(text.toLowerCase()).not.toContain("connection: close");
    // Both requests answered on the one socket — the connection was reusable.
    expect(text.split("HTTP/1.1 ").length - 1).toBe(2);
  });

  it("WITHOUT the close header the connection stalls — the measurement the header exists for", async () => {
    // Byte-identical to the first case minus `Connection: close`. The 404 comes back and the
    // pipelined GET never does: node skipped its drain because `pipe` had set `_consuming`, so
    // 256 KiB of unread body sits in front of the next request until the timeout.
    const port = await listen(async (req) => {
      await req.body?.cancel().catch(() => { /* already gone */ });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }, ROOMY);

    const text = await rawExchange(port, pipelined("/nope", "z".repeat(BIG_BODY)));

    expect(text).toContain("404");
    expect(text.toLowerCase()).not.toContain("connection: close");
    expect(text.split("HTTP/1.1 ").length - 1, "the pipelined request is never answered").toBe(1);
  });
});
