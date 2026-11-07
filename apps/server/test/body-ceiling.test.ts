import { describe, expect, it } from "vitest";
import { bodyCeilingFor, JSON_BODY_MAX_BYTES, readBodyWithin, BodyOverCeilingError } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { BODY_MAX_BYTES } from "../src/config.js";
import { normalizeRequest, undrained } from "../src/handler.js";

/**
 * the HIGH instance: **the one an UNAUTHENTICATED client reaches.**
 *
 * `normalizeRequest` buffered every non-GET body with `await req.arrayBuffer()` before route
 * matching and long before `withSession` — under one ceiling, {@link BODY_MAX_BYTES} (50 MiB),
 * which exists for the single route that carries attachment bytes inline. So a client that never
 * presents a credential and never names a path this host serves could make a long-running
 * process allocate 50 MiB per connection, hold it for the length of the transfer, and be
 * answered 404 for it. N connections is N × 50 MiB of somebody's self-hosted box.
 *
 * The ceiling was never wrong; it was UNCONDITIONAL. These cases drive the hostile request
 * through the host's own `normalizeRequest`.
 *
 * ── THE MUTATION, WATCHED FAIL AND RESTORED ──────────────────────────────────────────────
 *
 * Put `const body = await req.arrayBuffer()` back in `normalizeRequest`:
 *  · "a body on a path this host does not serve is never read" goes red — `pulled` is the whole
 *    2 MiB rather than 0;
 *  · "an oversized body on an ordinary JSON route is refused at the door" goes red — the
 *    2 MiB body is buffered and the request is rebuilt with it instead of throwing.
 */

/**
 * A Request whose body is a stream we can watch being consumed (or not).
 *
 * `pulled()` is the count of bytes the CONSUMER actually asked the stream for, which is the
 * quantity under test: the defect was that the door pulled all of them before anything had
 * decided the request was worth reading. `declaredLength` states a `Content-Length` the way a
 * real client does — set separately rather than by cloning the Request, because a clone tees the
 * stream and would pull it here, in the harness, before the function under test ran.
 */
function streamingRequest(
  url: string, bytes: number, opts: { method?: string; declaredLength?: number } = {},
): { request: Request; pulled: () => number } {
  let pulled = 0;
  const CHUNK = 64 * 1024;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const n = Math.min(CHUNK, bytes - sent);
      sent += n;
      pulled += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.declaredLength !== undefined) headers.set("content-length", String(opts.declaredLength));
  const request = new Request(url, {
    method: opts.method ?? "POST",
    headers,
    body,
    // undici requires the marker for a stream body; the host's own adapter passes it too.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, pulled: () => pulled };
}

describe("bodyCeilingFor — the ceiling is the ROUTE's, decided before a byte is read", () => {
  it("is zero for a path this table does not serve", () => {
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/not-a-route", BODY_MAX_BYTES)).toBe(0);
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/messages/x/nope", BODY_MAX_BYTES)).toBe(0);
  });

  it("is zero for a body-less method", () => {
    expect(bodyCeilingFor(selfHostRoutes, "GET", "/health", BODY_MAX_BYTES)).toBe(0);
    expect(bodyCeilingFor(selfHostRoutes, "HEAD", "/health", BODY_MAX_BYTES)).toBe(0);
  });

  it("is the JSON ceiling for an ordinary mutation", () => {
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/snippets", BODY_MAX_BYTES))
      .toBe(JSON_BODY_MAX_BYTES);
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/threads/merge", BODY_MAX_BYTES))
      .toBe(JSON_BODY_MAX_BYTES);
  });

  it("is the host's large ceiling for the routes that carry inline attachment bytes", () => {
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/drafts/abc/send", BODY_MAX_BYTES))
      .toBe(BODY_MAX_BYTES);
    // Send later with files takes the send's own transports (mail 0180).
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/drafts/abc/schedule-with-files", BODY_MAX_BYTES))
      .toBe(BODY_MAX_BYTES);
  });

  it("resolves the ceiling through the SAME matcher the router uses, static before param", () => {
    // `POST /drafts/:id/send` is the large route; `/drafts/:id/schedule` beside it is not, and a
    // ceiling that matched by prefix would give the wrong answer for one of them.
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/drafts/abc/schedule", BODY_MAX_BYTES))
      .toBe(JSON_BODY_MAX_BYTES);
  });
});

describe("readBodyWithin — the bytes are counted as they arrive, not after", () => {
  it("refuses a declared Content-Length over the ceiling without reading the stream", async () => {
    const { request, pulled } = streamingRequest("http://h/snippets", 8 * 1024, {
      // DERIVED from the ceiling, not a literal that happened to be above it. It was
      // `4 * 1024 * 1024`, which stopped being "over" the moment JSON_BODY_MAX_BYTES became
      // exactly that — a test that asserts a refusal, against a value the ceiling now admits.
      declaredLength: JSON_BODY_MAX_BYTES + 1,
    });

    await expect(readBodyWithin(request, JSON_BODY_MAX_BYTES)).rejects.toBeInstanceOf(BodyOverCeilingError);
    // An HONEST oversized request costs nothing at all: the header alone refuses it.
    expect(pulled()).toBe(0);
  });

  it("cuts off a body that declares nothing and then overruns", async () => {
    const { request, pulled } = streamingRequest("http://h/snippets", JSON_BODY_MAX_BYTES * 4);

    await expect(readBodyWithin(request, JSON_BODY_MAX_BYTES)).rejects.toBeInstanceOf(BodyOverCeilingError);
    // The PEAK is one chunk past the ceiling, never the whole body. This measures what was pulled
    // off the stream, which is the cost that matters; it does not distinguish comparing the count
    // before retaining the chunk from comparing it after — that ordering is one chunk of memory
    // and is stated in `readBodyWithin` rather than asserted here.
    expect(pulled()).toBeLessThanOrEqual(JSON_BODY_MAX_BYTES + 64 * 1024);
  });

  it("returns undefined for an empty body, so a body-less POST is not given a Content-Type demand", async () => {
    const empty = new Request("http://h/auth/logout", { method: "POST" });
    expect(await readBodyWithin(empty, JSON_BODY_MAX_BYTES)).toBeUndefined();
  });

  it("returns the exact bytes when they fit", async () => {
    const r = new Request("http://h/snippets", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}',
    });
    const out = await readBodyWithin(r, JSON_BODY_MAX_BYTES);
    expect(out).toBeDefined();
    expect(new TextDecoder().decode(out!)).toBe('{"a":1}');
  });
});

describe("normalizeRequest — the self-host door, driven with the hostile request", () => {
  it("a body on a path this host does not serve is NEVER read", async () => {
    const { request, pulled } = streamingRequest("http://h/nope", 2 * 1024 * 1024);

    const normalized = await normalizeRequest(request);

    // THE FINDING. This used to buffer the whole thing before anything had decided the path was
    // not served — an anonymous memory-exhaustion primitive on the self-host door.
    expect(pulled()).toBe(0);
    // And the request still reaches `app.handle`, which answers its own 404 from the same table.
    expect(new URL(normalized.url).pathname).toBe("/nope");
  });

  it("an oversized body on an ordinary JSON route is refused at the door", async () => {
    const { request } = streamingRequest("http://h/snippets", JSON_BODY_MAX_BYTES * 2);

    await expect(normalizeRequest(request)).rejects.toBeInstanceOf(BodyOverCeilingError);
  });

  it("the send route keeps the large ceiling, so a real attachment still gets through", async () => {
    const big = JSON_BODY_MAX_BYTES * 2;
    const { request, pulled } = streamingRequest("http://h/drafts/abc/send", big);

    const normalized = await normalizeRequest(request);

    expect(pulled()).toBe(big);
    expect(new URL(normalized.url).pathname).toBe("/drafts/abc/send");
  });

  it("so does a letter scheduled with its files", async () => {
    const big = JSON_BODY_MAX_BYTES * 2;
    const { request, pulled } = streamingRequest("http://h/drafts/abc/schedule-with-files", big);
    await normalizeRequest(request);
    expect(pulled()).toBe(big);
  });

  it("still strips one `/api` prefix and still drops an empty body", async () => {
    // The canonicalization this function existed for is unchanged — the ceiling is applied to the
    // CANONICAL path, so `/api/snippets` and `/snippets` get the same one.
    expect(bodyCeilingFor(selfHostRoutes, "POST", "/snippets", BODY_MAX_BYTES)).toBe(JSON_BODY_MAX_BYTES);
    const n = await normalizeRequest(new Request("http://h/api/auth/logout", { method: "POST" }));
    expect(new URL(n.url).pathname).toBe("/auth/logout");
    expect(n.body).toBeNull();
  });
});

/**
 * THE OTHER HALF OF THE DRAIN FIX. `http-adapter.test.ts` proves on a real socket that a
 * CANCELLED request body stalls a keep-alive connection unless the response says
 * `Connection: close`; this is the predicate that decides when the host says it.
 *
 * Watched fail and restored: make `undrained` return `false` unconditionally and the adapter
 * suite's two `Connection: close` cases go red on the header.
 */
describe("undrained — which requests leave bytes the pipeline will not read", () => {
  const withBody = (path: string, method = "POST"): Request =>
    new Request(`http://h${path}`, {
      method,
      headers: { "content-type": "application/json", "content-length": "4096" },
      body: "x".repeat(4096),
    });

  it("is true for a body on a path the table does not serve", () => {
    expect(undrained(withBody("/nope"), "/nope")).toBe(true);
  });

  it("is FALSE for a route that reads its body — nothing was left behind", () => {
    expect(undrained(withBody("/snippets"), "/snippets")).toBe(false);
    expect(undrained(withBody("/drafts/abc/send"), "/drafts/abc/send")).toBe(false);
  });

  it("is FALSE for a body-less request, however unroutable its path", () => {
    // No body, nothing to leave on the wire — closing the connection would cost a reconnect for
    // an ordinary 404.
    expect(undrained(new Request("http://h/nope", { method: "POST" }), "/nope")).toBe(false);
    expect(undrained(new Request("http://h/nope"), "/nope")).toBe(false);
  });

  it("is TRUE for a CHUNKED body, which declares no length at all", () => {
    /**
     * The header form of this question is wrong at this layer and this is the case that shows it.
     * `toWebRequest` STRIPS `transfer-encoding` before constructing the Request — undici refuses
     * a Request carrying a connection-level header — so a chunked POST arrives with neither
     * `Content-Length` nor `Transfer-Encoding`. Asked of the headers, it looks body-less; asked of
     * `req.body`, it is what it is. The header form answered `false` here and left the connection
     * stalled.
     */
    const chunked = new Request("http://h/nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(8)); c.close(); },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(chunked.headers.get("content-length")).toBeNull();
    expect(chunked.headers.get("transfer-encoding")).toBeNull();
    expect(undrained(chunked, "/nope")).toBe(true);
  });
});
