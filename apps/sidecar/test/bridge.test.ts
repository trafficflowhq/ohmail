import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { encodeFrame, FrameDecoder, FrameWriter } from "../src/frame.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { decodeResponse, encodeResponse } from "../src/protocol.js";

/**
 * THE BRIDGE: `Request` in one process, `Response` back, over a pair of pipes.
 *
 * The project's design notes gives the UI "a `fetch` that marshals `Request`/`Response` over the
 * sidecar's stdin/stdout". These tests are about that fetch being a real one — the same method,
 * headers, bytes and status arriving on the far side — and about the transport surviving the
 * conditions a pipe imposes.
 *
 * ── WHY IN-PROCESS STREAM PAIRS AND NOT A SPAWNED CHILD ───────────────────────────────────
 *
 * A real child would resolve `@trafficflow/api` through its `exports` map — `./dist/index.js` —
 * so the test would exercise whatever `tsc -b` last emitted rather than the source under test,
 * and would simply fail on a clean checkout where `dist/` does not exist. `apps/worker`'s
 * `cli.smoke.test.ts` accepts that trade because its SUBJECT is the production boot path; here
 * the subject is the framing, and the framing is identical over a `PassThrough` pair and an OS
 * pipe. The genuine process-boundary test belongs to the packaging slice, where a built sidecar
 * exists to spawn.
 *
 * `highWaterMark` is set deliberately small so `write()` returns false constantly and the
 * backpressure path — the one that deadlocks if it is done wrong — is the path every test takes.
 */

const HWM = 512;

interface Wired {
  host: StdioHost;
  client: StdioClient;
  /** Requests the host has been asked to serve, in arrival order. */
  seen: Request[];
  /** Every line the transport emitted, parsed — the real logger's bytes. */
  lines: Array<Record<string, unknown>>;
}

const wired: Wired[] = [];
afterEach(() => {
  for (const w of wired.splice(0)) {
    w.client.close();
    w.host.stop();
  }
});

function wire(handle: (req: Request) => Promise<Response>): Wired {
  const toHost = new PassThrough({ highWaterMark: HWM });
  const toClient = new PassThrough({ highWaterMark: HWM });
  const seen: Request[] = [];
  const lines: Array<Record<string, unknown>> = [];
  /* THE REAL LOGGER, not a fake `(event, detail) => …`: the transport's failure line is the only
     record a fault on this door leaves, and a fake sink proves what the dispatcher hands over
     rather than what a drain receives. */
  const logger = createSidecarLogger({
    sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); },
  });
  const host = serveOverStdio({
    handle: (req) => {
      seen.push(req.clone());
      return handle(req);
    },
    input: toHost,
    output: toClient,
    log: diagnosticFor(logger),
  });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  const w = { host, client, seen, lines };
  wired.push(w);
  return w;
}

describe("Request → frame → Request", () => {
  it("method, path, query, headers and a JSON body all survive the crossing", async () => {
    const w = wire(async (req) => {
      const body = (await req.json()) as { hello: string };
      return Response.json({ echoed: body.hello, url: req.url, auth: req.headers.get("authorization") });
    });

    const res = await w.client.fetch("/messages/abc?limit=2", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer t0ken", "idempotency-key": "k1" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      echoed: "world",
      url: "http://sidecar/messages/abc?limit=2",
      auth: "Bearer t0ken",
    });
    expect(w.seen[0]!.method).toBe("PATCH");
    expect(w.seen[0]!.headers.get("idempotency-key")).toBe("k1");
  });

  it("an absolute url is passed through untouched", async () => {
    const w = wire(async (req) => Response.json({ url: req.url }));
    const res = await w.client.fetch("http://localhost/sync?since=0");
    expect(await res.json()).toEqual({ url: "http://localhost/sync?since=0" });
  });

  it("carries bytes, not text — a body that is not valid UTF-8 arrives intact", async () => {
    const raw = Buffer.from([0x00, 0x80, 0xfe, 0xff, 0x0a, 0x0d, 0x1a]);
    const w = wire(async (req) => new Response(await req.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } }));
    const res = await w.client.fetch("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...raw]);
  });
});

describe("the served mailbox named after ready", () => {
  it("hosted sign-in changes keep the stream open for its next request", async () => {
    const w = wire(async () => Response.json({ ready: true }));
    await w.host.hostedSession(true);
    await w.host.hostedSession(false);
    expect(await (await w.client.fetch("/health")).json()).toEqual({ ready: true });
  });

  it("a mailbox frame is written before the answer that follows it, and the client reads past it", async () => {
    let w: Wired | null = null;
    w = wire(async () => {
      await w!.host.mailbox("mbx-2");
      return Response.json({ ok: true });
    });
    const res = await w.client.fetch("/cloud/pair-redeem", { method: "POST" });
    expect(res.status, "the client closed on an uncorrelated frame").toBe(200);
    expect((await w.client.fetch("/health")).status).toBe(200);
  });
});

describe("Response → frame → Response", () => {
  it("status, statusText and headers survive; multiple Set-Cookie stay separate", async () => {
    // The lossy case: iterating `Headers` joins repeats with ", ", and a cookie's Expires value
    // contains a comma of its own, so a joined pair cannot be split back apart.
    const w = wire(async () => {
      const h = new Headers({ "x-sync-seq": "42" });
      h.append("set-cookie", "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/");
      h.append("set-cookie", "b=2; HttpOnly");
      return new Response("ok", { status: 207, statusText: "Multi-Status", headers: h });
    });
    const res = await w.client.fetch("/x");
    expect(res.status).toBe(207);
    expect(res.statusText).toBe("Multi-Status");
    expect(res.headers.get("x-sync-seq")).toBe("42");
    expect(res.headers.getSetCookie()).toEqual([
      "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/",
      "b=2; HttpOnly",
    ]);
  });

  it("an error status is a RESPONSE, not a transport failure", async () => {
    const w = wire(async () => Response.json({ error: { code: "not_found" } }, { status: 404 }));
    const res = await w.client.fetch("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("a 204 crosses without inventing a body", async () => {
    const w = wire(async () => new Response(null, { status: 204 }));
    const res = await w.client.fetch("/gone", { method: "DELETE", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("a body over the frame cap becomes a rejected fetch, not a dead sidecar", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    const host = serveOverStdio({
      handle: async () => new Response(Buffer.alloc(4096)),
      input: toHost,
      output: toClient,
      limits: { maxBodyBytes: 1024 },
    });
    const client = connectOverStdio({ input: toClient, output: toHost });
    wired.push({ host, client, seen: [], lines: [] });
    await expect(client.fetch("/huge")).rejects.toThrow(/cap/);
    // …and the bridge is still usable afterwards.
    expect(client.pending).toBe(0);
  });
});

describe("concurrency and the deadlock the framing exists to prevent", () => {
  it("responses may come back out of order; one slow request blocks nothing", async () => {
    const gates = new Map<string, () => void>();
    const w = wire(async (req) => {
      const id = new URL(req.url).pathname.slice(1);
      await new Promise<void>((r) => gates.set(id, r));
      return Response.json({ id });
    });

    const a = w.client.fetch("/a");
    const b = w.client.fetch("/b");
    const c = w.client.fetch("/c");
    await new Promise((r) => setTimeout(r, 20));
    expect(w.client.pending).toBe(3);

    // Answer them backwards. Correlation ids are what make this legal.
    gates.get("c")!();
    expect(await (await c).json()).toEqual({ id: "c" });
    gates.get("a")!();
    expect(await (await a).json()).toEqual({ id: "a" });
    gates.get("b")!();
    expect(await (await b).json()).toEqual({ id: "b" });
  });

  it("a response wedged on backpressure does not stop the host reading the next request", async () => {
    /**
     * THE DEADLOCK PROPERTY, stated so it can fail.
     *
     * Nobody reads the host's output, so its 4 MB answer blocks awaiting `drain` — the exact
     * state a slow UI puts it in. A second request then arrives. If the host had coupled reading
     * to writing (paused its input until the answer was out, which is the only way a Node stream
     * reader actually stops), the two ends would be waiting on each other and `/ping` would never
     * be seen. Verified to bite: adding `input.pause()` / `resume()` around the dispatch in
     * `host.ts` leaves `seen` at `["/big"]` and fails this assertion.
     */
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    const seen: string[] = [];
    const host = serveOverStdio({
      handle: async (req) => {
        const p = new URL(req.url).pathname;
        seen.push(p);
        return p === "/big" ? new Response(Buffer.alloc(4 * 1024 * 1024)) : new Response("pong");
      },
      input: toHost,
      output: toClient,
    });
    const w = new FrameWriter(toHost);
    const ask = (id: number, path: string): Promise<void> =>
      w.write({ v: 1, t: "req", id, method: "GET", url: `http://sidecar${path}`, h: [] });

    await ask(1, "/big");
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toEqual(["/big"]);
    expect(toClient.readableLength, "the big answer should be stuck unread").toBeGreaterThan(0);

    await ask(2, "/ping");
    await new Promise((r) => setTimeout(r, 40));
    expect(seen, "the host stopped reading while a response was blocked on backpressure").toEqual(["/big", "/ping"]);

    // Draining releases both, in the order they were produced.
    const decoder = new FrameDecoder();
    const answered: number[] = [];
    toClient.on("data", (c: Buffer) => {
      for (const f of decoder.push(c)) answered.push(f.header.id as number);
    });
    // Both frames, however long the drain takes: a host that never releases the second one
    // holds this case until the runner's timeout, which is the red.
    while (answered.length < 2) await new Promise((r) => setImmediate(r));
    expect(answered).toEqual([1, 2]);
    host.stop();
  });

  it(
    "an 8 MB request body and an 8 MB response body cross AT THE SAME TIME",
    async () => {
      /**
       * Far more than any pipe buffer, in both directions, with `highWaterMark` set to 512 so the
       * `drain` path is taken hundreds of times and the decoder sees the body split across
       * hundreds of chunks. What it proves is byte-exactness under those conditions.
       *
       * Verified to bite: relaxing `FrameDecoder`'s completeness check to `q.length < headerLen`
       * (forgetting the body) hands out a truncated frame and fails here.
       */
      const big = Buffer.alloc(8 * 1024 * 1024);
      for (let i = 0; i < big.length; i += 4096) big.writeUInt32BE(i, i);

      const w = wire(async (req) => {
        const got = Buffer.from(await req.arrayBuffer());
        // Answer with an equally large body while the request body is still being drained by the
        // peer's writer — the symmetric-block shape.
        return new Response(got, { headers: { "x-received": String(got.length) } });
      });

      const res = await w.client.fetch("/roundtrip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: big,
      });
      expect(res.headers.get("x-received")).toBe(String(big.length));
      const back = Buffer.from(await res.arrayBuffer());
      expect(back.length).toBe(big.length);
      expect(back.equals(big)).toBe(true);
    },
    30_000,
  );

  it("many small requests in flight at once all get their own answer", async () => {
    const w = wire(async (req) => Response.json({ path: new URL(req.url).pathname }));
    const results = await Promise.all(Array.from({ length: 64 }, (_, i) => w.client.fetch(`/m/${i}`)));
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ path: string }>));
    expect(bodies.map((b) => b.path)).toEqual(Array.from({ length: 64 }, (_, i) => `/m/${i}`));
  });
});

describe("failure is loud, never silent", () => {
  it("a handler that throws rejects the caller's fetch instead of hanging it", async () => {
    const w = wire(async () => {
      throw new Error("the engine fell over");
    });
    await expect(w.client.fetch("/boom")).rejects.toThrow(/the engine fell over/);
    expect(w.client.pending).toBe(0);
  });

  it("the sidecar dying rejects everything in flight", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    const host = serveOverStdio({ handle: () => new Promise<Response>(() => undefined), input: toHost, output: toClient });
    const client = connectOverStdio({ input: toClient, output: toHost });
    wired.push({ host, client, seen: [], lines: [] });

    const hung = client.fetch("/never");
    await new Promise((r) => setTimeout(r, 20));
    expect(client.pending).toBe(1);

    toClient.end(); // the sidecar exits
    await expect(hung).rejects.toThrow(/closed/);
    await expect(client.fetch("/after")).rejects.toThrow(/closed/);
  });

  it("garbage on the wire is fatal and reported, not silently misread", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    toClient.resume();
    const fatals: unknown[] = [];
    const host = serveOverStdio({
      handle: async () => new Response("never"),
      input: toHost,
      output: toClient,
      onFatal: (e) => fatals.push(e),
    });
    toHost.write(Buffer.from("GET /health HTTP/1.1\r\n\r\n")); // somebody pointed an HTTP client at it
    await new Promise((r) => setTimeout(r, 20));
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0])).toMatch(/header length|not JSON/);
    host.stop();
  });

  it("a non-request frame arriving at the host is fatal", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    toClient.resume();
    const fatals: unknown[] = [];
    const host = serveOverStdio({
      handle: async () => new Response("x"),
      input: toHost,
      output: toClient,
      onFatal: (e) => fatals.push(e),
    });
    toHost.write(encodeFrame({ v: 1, t: "res", id: 1, status: 200, statusText: "", h: [], sc: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(String(fatals[0])).toMatch(/unexpected frame/);
    host.stop();
  });

  /* THE SHELL'S LEAVING FRAME: the one header with no request behind it. It reaches `onLeaving`,
     answers nothing and is not fatal; an unknown type beside it still ends the stream. */
  it("a leaving frame reaches onLeaving and answers nothing; an unknown type is still fatal", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    const answered: Buffer[] = [];
    toClient.on("data", (c: Buffer) => { answered.push(c); });
    const fatals: unknown[] = [];
    const reasons: unknown[] = [];
    const host = serveOverStdio({
      handle: async () => new Response("x"),
      input: toHost,
      output: toClient,
      onFatal: (e) => fatals.push(e),
      onLeaving: (h) => reasons.push(h.reason),
    });
    toHost.write(encodeFrame({ v: 1, t: "leaving", reason: "restart" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fatals, "the leaving frame ended the stream").toHaveLength(0);
    expect(reasons).toEqual(["restart"]);
    expect(Buffer.concat(answered).length, "the leaving frame was answered").toBe(0);

    toHost.write(encodeFrame({ v: 1, t: "bogus" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(String(fatals[0])).toMatch(/unexpected frame/);
    host.stop();
  });

  it("a leaving frame from another protocol version is refused like any other", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    toClient.resume();
    const fatals: unknown[] = [];
    const reasons: unknown[] = [];
    const host = serveOverStdio({
      handle: async () => new Response("x"),
      input: toHost,
      output: toClient,
      onFatal: (e) => fatals.push(e),
      onLeaving: (h) => reasons.push(h.reason),
    });
    toHost.write(encodeFrame({ v: 99, t: "leaving", reason: "restart" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(String(fatals[0])).toMatch(/protocol version 99/);
    expect(reasons).toEqual([]);
    host.stop();
  });

  it("a frame from a future protocol version is refused rather than guessed at", async () => {
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    toClient.resume();
    const fatals: unknown[] = [];
    const host = serveOverStdio({
      handle: async () => new Response("x"),
      input: toHost,
      output: toClient,
      onFatal: (e) => fatals.push(e),
    });
    toHost.write(encodeFrame({ v: 99, t: "req", id: 1, method: "GET", url: "http://sidecar/x", h: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(String(fatals[0])).toMatch(/protocol version 99/);
    host.stop();
  });
});

describe("lifecycle", () => {
  it("the host announces its per-launch session before anything asks", async () => {
    const w = wire(async () => new Response("x"));
    await w.host.ready({
      baseUrl: "http://sidecar",
      sessionToken: "tok",
      accountId: "acc",
      userId: "usr",
      mailboxId: "mb",
      credentialState: "ready",
    });
    await expect(w.client.ready()).resolves.toMatchObject({ t: "ready", sessionToken: "tok", mailboxId: "mb" });
  });

  it("`finished()` waits for the in-flight request, not just for stdin to close", async () => {
    // The shutdown ordering that matters: closing PGlite while a handler is still reading it is
    // how a local mirror gets corrupted at exit.
    const toHost = new PassThrough({ highWaterMark: HWM });
    const toClient = new PassThrough({ highWaterMark: HWM });
    toClient.resume();
    let release!: () => void;
    const host = serveOverStdio({
      handle: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return new Response("done");
      },
      input: toHost,
      output: toClient,
    });
    toHost.write(encodeFrame({ v: 1, t: "req", id: 1, method: "GET", url: "http://sidecar/slow", h: [] }));
    await new Promise((r) => setTimeout(r, 20));
    toHost.end();

    let done = false;
    void host.finished().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done, "finished() resolved while a request was still being served").toBe(false);
    release();
    await host.finished();
    expect(host.inFlight).toBe(0);
  });
});

describe("the raw encoders, so a mismatch names itself", () => {
  it("encodeResponse → decodeResponse is the identity for a realistic API answer", async () => {
    const original = Response.json({ changes: [{ id: "m1", op: "move" }], hasMore: false }, {
      status: 200,
      headers: { "x-sync-seq": "17", "x-request-id": "r-1" },
    });
    const framed = await encodeResponse(9, original);
    const wire = encodeFrame(framed.header, framed.body);
    const decoded = new FrameDecoder().push(wire)[0]!;
    const back = decodeResponse(decoded.header as never, decoded.body);
    expect(back.status).toBe(200);
    expect(back.headers.get("x-sync-seq")).toBe("17");
    expect(await back.json()).toEqual({ changes: [{ id: "m1", op: "move" }], hasMore: false });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A ROUTE FAULT ON THE CLOUD DOOR IS RECORDED — the third of the three doors
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The standalone and host doors route through `packages/api`'s pipeline, so an unhandled fault
 * there is `withErrorEnvelope`'s `request_unhandled`, and both have their own control
 * (`unhandled-request-logged.test.ts`). The Cloud door does NOT use that app — `cloud-engine.ts`
 * composes its own `handle` — so nothing on it ever reaches that envelope, and the only thing
 * standing between a throw and silence is this dispatcher's own catch.
 *
 * It writes `request_failed`, whose LEVEL and field grammars are covered in `log.test.ts`. What
 * was not covered is that a throw out of the handler reaches it at all, which is a claim about
 * this loop and not about the grammar.
 */
describe("a fault on the Cloud door's transport", () => {
  class CloudRouteFault extends Error {
    override readonly name = "CloudRouteFault";
  }
  const DETAIL = "cloud-fault-detail-that-must-not-be-published";

  it("rejects the caller and writes ONE line naming the route, without the thrown message", async () => {
    const w = wire(async () => { throw new CloudRouteFault(DETAIL); });

    // The caller is REJECTED rather than left hanging — the shape "failure is loud, never
    // silent" above already pins. What that case cannot see is whether anything was recorded.
    await expect(w.client.fetch("/sync?since=0", { method: "GET" })).rejects.toThrow();

    const failed = w.lines.filter((l) => l.event === "request_failed");
    expect(
      failed.length,
      "the Cloud door's transport answered a fault and left no record of what failed",
    ).toBe(1);
    expect(failed[0]!.level).toBe("error");
    expect(failed[0]!.route).toBe("/sync");
    expect(failed[0]!.method).toBe("GET");
    expect(failed[0]!.errorClass).toBe("CloudRouteFault");
    // The message is discarded by the logger, and the query — which on this product carries mail —
    // is dropped by `describeRoute` before the grammar runs.
    expect(JSON.stringify(w.lines)).not.toContain(DETAIL);
    expect(JSON.stringify(w.lines)).not.toContain("since=0");
  });

  it("writes no such line for a request the handler answers — the positive control", async () => {
    // Without this, every assertion above is satisfied by a transport that reports EVERY request
    // as a fault, and the log would be nothing but failures while this file stayed green.
    const w = wire(async () => new Response("{}", { status: 200 }));

    const res = await w.client.fetch("/sync", { method: "GET" });
    expect(res.status).toBe(200);
    expect(w.lines.filter((l) => l.event === "request_failed"),
      "an answered request was recorded as a fault").toHaveLength(0);
  });
});
