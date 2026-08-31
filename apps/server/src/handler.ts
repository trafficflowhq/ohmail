import { randomUUID } from "node:crypto";
import { createApp, bodyCeilingFor, readBodyWithin, BodyOverCeilingError } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { buildDeps, type ServerRuntime } from "./deps.js";
import { BODY_MAX_BYTES } from "./config.js";

/**
 * THE dispatch pipeline — `src/http.ts` hands a fetch Request in, this hands a Response back.
 *
 * It mirrors the managed host's `handler.ts` step for step, because every step there is a
 * correctness property and none is serverless-specific:
 *
 *   1. mint a request id (a pre-pipeline failure must still be traceable),
 *   2. NORMALIZE the request URL — exactly once, before anything reads the path,
 *   3. build `ApiDeps` for this request,
 *   4. `app.handle` (with HEAD dispatched as GET — RFC 9110; the router stays strict),
 *   5. `Cache-Control: no-store` on anything that did not set its own, and the request id
 *      on every response.
 *
 * The one structural difference from the managed host: there is no per-request `hostState()`
 * resolution and no `misconfigured` branch — a long-running process refuses to BOOT on a bad
 * config (`config.ts`), so by the time a request exists the config is good (the KEK exception
 * reports through `/health`, which needs no branch here).
 *
 * The path canonicalization below is a hand-written twin of the managed host's `prefix.ts`, not
 * an import of it and not an extraction: the wake hub is deliberately the ONLY plumbing the two
 * hosts share, because extracting the rest would churn the managed deployment every time the
 * self-host one moves. The SEMANTICS are the managed host's exactly, for the managed host's
 * reason: `withIdempotency` hashes `method \n pathname \n body`, so two spellings of one path
 * (`/api/sync` through the webapp split, `/sync` direct) must canonicalize identically or a
 * safe retry from the other surface answers 409 `idempotency_replay`. The deployment's proxy
 * therefore needs NO strip_prefix — this host strips one `/api` itself, byte-parallel with the
 * managed one.
 */

/** The prefix the webapp's same-origin split may leave on the path. */
export const API_PREFIX = "/api";

/** Thrown for a pathname whose percent-encoding is not decodable — answered as 400. */
export class MalformedPathError extends Error {
  constructor(readonly pathname: string) {
    super("pathname contains malformed percent-encoding");
    this.name = "MalformedPathError";
  }
}

/** RFC 3986 §2.3 unreserved: these NEVER need escaping, so an escaped one is not canonical. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Canonicalize percent-escapes — RFC 3986 §6.2.2: DECODE the unreserved ones, UPPERCASE the
 * rest (a reserved character must STAY escaped: decoding `%2F` would split a segment and change
 * the route), REJECT anything malformed (previously a `URIError` from above the envelope — a
 * logged 500 for what is plainly a 400).
 */
export function normalizeEscapes(pathname: string): string {
  let out = "";
  for (let i = 0; i < pathname.length; i++) {
    const ch = pathname[i]!;
    if (ch !== "%") { out += ch; continue; }
    const hex = pathname.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new MalformedPathError(pathname);
    const byte = Number.parseInt(hex, 16);
    const decoded = String.fromCharCode(byte);
    // Only ASCII unreserved bytes are decoded; a multi-byte UTF-8 sequence stays escaped
    // (uppercased) — decoding it here would be lossy across the string/byte boundary.
    out += byte < 0x80 && UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
    i += 2;
  }
  // The whole path must be decodable as a unit too — a lone surrogate escape passes the
  // per-byte check and still fails here, exactly where matchRoute would have thrown.
  try {
    decodeURIComponent(out);
  } catch {
    throw new MalformedPathError(pathname);
  }
  return out;
}

/**
 * The canonical pathname: escapes canonicalized, slash runs collapsed, exactly ONE leading
 * `/api` dropped (never more — `/api/api/x` must 404, not invent `/x`), one trailing slash
 * dropped except on the root.
 */
export function normalizePathname(pathname: string): string {
  let p = normalizeEscapes(pathname);
  p = p.replace(/\/{2,}/g, "/");
  if (p === "") p = "/";
  if (p === API_PREFIX) {
    p = "/";
  } else if (p.startsWith(`${API_PREFIX}/`)) {
    p = p.slice(API_PREFIX.length);
  }
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/**
 * Rebuild `req` on its canonical path. The body is BUFFERED here, for the managed host's two
 * reasons: every mutation on this API is JSON (`withRequestGuard` refuses any other media type),
 * and an EMPTY body must be DROPPED rather than forwarded — undici gives a Request constructed
 * with an empty body a non-null `body`, and `withRequestGuard` then demands a Content-Type from
 * a legitimately body-less `POST /auth/logout`. The adapter's streaming Request (point 1) is the
 * transport in; this is where the pipeline decides the whole body is wanted.
 *
 * ── AND HOW MUCH OF IT IS WANTED IS DECIDED BY THE ROUTE, NOT BY THE ADAPTER ─────────────
 *
 * This used to read `await req.arrayBuffer()` under a comment saying *"the adapter's byte cap
 * bounds what can arrive"*. It does — at {@link BODY_MAX_BYTES}, 50 MiB, which is the ceiling
 * the ONE route that carries attachment bytes needs. Applying it here applied it to every
 * request, including requests that name no route this host serves and carry no credential: an
 * anonymous client could make this long-running process allocate 50 MiB per connection and hold
 * it for the transfer, and be answered 404 for it. `bodyCeilingFor` matches the route from the
 * canonical path FIRST (which costs no body at all) and returns that route's own ceiling — zero
 * for a path this table does not serve, so nothing is read and `app.handle` answers the same
 * 404/405 it always did.
 */
export async function normalizeRequest(req: Request): Promise<Request> {
  const url = new URL(req.url);
  url.pathname = normalizePathname(url.pathname);

  // HEAD is dispatched as GET below, and `bodyCeilingFor` answers 0 for both — so the ceiling is
  // read on the method as it ARRIVED, which is the method whose body is on the socket.
  const ceiling = bodyCeilingFor(selfHostRoutes, req.method, url.pathname, BODY_MAX_BYTES);
  const body = await readBodyWithin(req, ceiling);

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Does this request carry a body? Asked of the REQUEST OBJECT, never of its headers.
 *
 * The header form (`Content-Length` or `Transfer-Encoding`, RFC 9112 §6) is what the adapter's own
 * `hasBody` asks of the `IncomingMessage`, and it is WRONG at this layer: `toWebRequest` strips
 * `transfer-encoding` from the Headers it builds, because undici refuses to construct a Request
 * carrying a connection-level header. So a CHUNKED request — which declares no length — arrives
 * here looking body-less, and a chunked `POST` to a path the table does not serve would have been
 * answered without `Connection: close` and stalled the connection exactly as the measured control
 * does. A review round caught that; the real-socket chunked case below is the guard.
 *
 * `req.body !== null` is the honest question and it is decided by the same adapter: it attaches a
 * body iff its own `hasBody` was true, for both framings.
 */
function carriesBody(req: Request): boolean {
  return req.body !== null;
}

/**
 * DID THIS REQUEST ARRIVE WITH BYTES THIS PIPELINE IS NOT GOING TO READ?
 *
 * ── WHY THE ANSWER HAS TO REACH THE RESPONSE ────────────────────────────────────────────────
 *
 * The adapter builds the web body as `Readable.toWeb(req.pipe(cap))`, so cancelling the web
 * stream destroys the counting transform and UNPIPES the `IncomingMessage` — it does not destroy
 * or drain it. `pipe` has already set node's `_consuming` flag, and node's own end-of-response
 * fallback (`req._dump()`) only drains a request whose `_consuming` is false. So on a keep-alive
 * HTTP/1.1 connection the refused bytes stay on the socket, and the NEXT request on that
 * connection is parsed starting inside them: a stalled connection until the request timeout.
 *
 * That is a regression this slice would otherwise have introduced. `await req.arrayBuffer()`
 * drained every byte, which is exactly the cost being refused — so the fix cannot be to read
 * them, and it cannot be to pretend cancelling drains them.
 *
 * `Connection: close` is the fix HTTP already has for this: node ends the connection after the
 * response instead of reusing it, so the unread bytes go with the socket. It costs one TCP
 * connection per refused request, which is the correct party to charge — a request that named no
 * route, or one that broke the route's own ceiling.
 */
export function undrained(req: Request, pathname: string): boolean {
  if (!carriesBody(req)) return false;
  return bodyCeilingFor(selfHostRoutes, req.method, pathname, BODY_MAX_BYTES) === 0;
}

/** The same response, told to end the connection. See {@link undrained}. */
function closing(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Connection", "close");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const app = createApp(selfHostRoutes);

export async function handleServerRequest(req: Request, rt: ServerRuntime): Promise<Response> {
  const requestId = randomUUID();

  let normalized: Request;
  try {
    normalized = await normalizeRequest(req);
  } catch (err) {
    // EVERY pre-router exit closes the connection when the request brought a body, not just the
    // ceiling breach. `normalizeEscapes` throws BEFORE `readBodyWithin` runs at all, so a
    // malformed path with a large body was answered 400 on a socket whose body had been piped
    // into the counting transform and never drained — the same stall, reached anonymously by a
    // different door. See {@link undrained}.
    const hadBody = carriesBody(req);
    const exit = (res: Response): Response => (hadBody ? closing(res) : res);
    if (err instanceof MalformedPathError) {
      return exit(json(400, { error: { code: "malformed_path", message: "malformed percent-encoding in path" } }, requestId));
    }
    // The route's own body ceiling, refused at the door. The adapter's 413 is the same envelope
    // and the same code — this is the narrower one, reached when the request DOES name a route
    // and is simply too big for it.
    if (err instanceof BodyOverCeilingError) {
      // `Connection: close` for {@link undrained}'s reason: the refusal stopped mid-body, so the
      // rest of it is still on the socket and this connection cannot be reused.
      return exit(json(413, {
        error: {
          code: "payload_too_large",
          message: `request body exceeds this route's limit of ${err.maxBytes} bytes`,
        },
      }, requestId));
    }
    return exit(internal(requestId, req, err, rt));
  }

  // HEAD dispatched as GET, body stripped on the way out — the router stays strict (a table
  // that silently accepts an undeclared method is worse), the HOST does the RFC 9110 mapping.
  // Without this, every monitor that probes `HEAD /health` reads 405 and calls the box down.
  const isHead = normalized.method.toUpperCase() === "HEAD";
  const forRouter = isHead
    ? new Request(normalized.url, { method: "GET", headers: normalized.headers })
    : normalized;

  // ONE decision, made once and applied to every exit below — the 404/405 the router gives, and
  // the 500 a broken composition gives. See {@link undrained}.
  const skipped = undrained(req, new URL(normalized.url).pathname);
  const exit = (r: Response): Response => (skipped ? closing(r) : r);

  try {
    const deps = buildDeps(forRouter, rt);
    deps.requestId = requestId;
    // The ANSWER is unchanged (`app.handle` matches the same table and gives the same 404/405 it
    // always did); only the connection's fate differs.
    const res = exit(noStore(await app.handle(forRouter, deps), requestId));
    if (!isHead) return res;
    await res.body?.cancel().catch(() => { /* nothing to release */ });
    return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    return exit(internal(requestId, forRouter, err, rt));
  }
}

/**
 * The last line before a hung socket. `withErrorEnvelope` maps everything a handler throws, so
 * reaching here means the failure was OUTSIDE the pipeline. STRUCTURED AND SANITIZED, the
 * managed host's exact discipline: class name and `code` only — a driver error's message
 * routinely carries `host=…&user=…` and the failing query, and this line goes to the
 * operator's log collector.
 */
function internal(requestId: string, req: Request, err: unknown, rt: ServerRuntime): Response {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  rt.logger.error("unhandled", {
    requestId,
    method: req.method,
    path: safePath(req.url),
    errorClass: typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown",
    errorCode: typeof e?.code === "string" ? e.code : null,
  });
  return json(500, { error: { code: "internal", message: "internal error" } }, requestId);
}

/** The path only — a query string can carry a token, and no log line needs one. */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "?";
  }
}

function json(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}

/**
 * `Cache-Control: no-store` unless the route already declared its own, plus the request id on
 * every response. Nothing on this API is cacheable — it is all per-account mutable state behind
 * a session, and a proxy an operator puts in front of this host holding one account's `/sync`
 * response would be the worst bug this codebase could ship. A NEW Response is built rather than
 * mutating headers (a Response's header guard may forbid that); the body passes through
 * untouched, so a stream stays a stream.
 */
function noStore(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  if (!headers.has("cache-control")) headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
