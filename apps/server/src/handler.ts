import { randomUUID } from "node:crypto";
import {
  createApp, bodyCeilingFor, readBodyWithin, BodyOverCeilingError, isDbBusy, dbBusyResponse,
  API_PREFIX, MalformedPathError, normalizeEscapes, normalizePathname,
  type ApiDeps, type Route,
} from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import type { Logger } from "@trafficflow/core";
import { depsFor, runtimeOf, type ServerRuntime } from "./deps.js";
import { BODY_MAX_BYTES } from "./config.js";

/**
 * THE dispatch pipeline of the one program — a door hands a fetch Request in, this hands a
 * Response back. Every step is a correctness property and none belongs to one host:
 *
 *   1. mint a request id (a pre-pipeline failure must still be traceable),
 *   2. NORMALIZE the request URL — exactly once, before anything reads the path,
 *   3. build `ApiDeps` for this request,
 *   4. `app.handle` (with HEAD dispatched as GET — RFC 9110; the router stays strict),
 *   5. `Cache-Control: no-store` on anything that did not set its own, and the request id
 *      on every response.
 *
 * Normalization precedes the deps on purpose: the cookie decision reads the Host and the
 * idempotency hash reads the path, and both must see the same canonical request the router does.
 *
 * The path canonicalization is IMPORTED, not written here (`@trafficflow/api`'s
 * `normalizePathname`): `withIdempotency` hashes `method \n pathname \n body`, so two spellings of
 * one path (`/api/sync` through the web app's split, `/sync` direct) must canonicalize identically
 * or a safe retry from the other surface answers 409 `idempotency_replay`. A proxy in front
 * therefore needs NO strip_prefix — the pipeline strips one `/api` itself.
 */

/* The canonicalizer is `@trafficflow/api`'s, re-exported so the doors and their tests keep one
 * name for it; the census in `packages/api/test` refuses a second definition. */
export { API_PREFIX, MalformedPathError, normalizeEscapes, normalizePathname };

/** What a door's dispatch is made of: the route table, the door's numbers, and the per-request deps. */
export interface Pipeline {
  routes: Route[];
  /** The ceiling of the one route that carries attachment bytes inline; every other route has its own. */
  bodyMaxBytes: number;
  /** End the connection after an answer that left request bytes unread — see {@link undrainedOn}. */
  closeUndrained: boolean;
  logger: Pick<Logger, "error" | "warn">;
  buildDeps: (req: Request) => ApiDeps;
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
export function normalizeOn(routes: Route[], bodyMaxBytes: number): (req: Request) => Promise<Request> {
  return async (req) => {
    const url = new URL(req.url);
    url.pathname = normalizePathname(url.pathname);

    // HEAD is dispatched as GET below, and `bodyCeilingFor` answers 0 for both — so the ceiling is
    // read on the method as it ARRIVED, which is the method whose body is on the socket.
    const ceiling = bodyCeilingFor(routes, req.method, url.pathname, bodyMaxBytes);
    const body = await readBodyWithin(req, ceiling);

    return new Request(url, {
      method: req.method,
      headers: req.headers,
      signal: req.signal,   // a client's leave reaches the route (`/events` frees its stream slot)
      ...(body === undefined ? {} : { body }),
    });
  };
}

/** {@link normalizeOn} for a self-hosted server behind the node adapter. */
export const normalizeRequest = normalizeOn(selfHostRoutes, BODY_MAX_BYTES);

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
export function undrainedOn(routes: Route[], bodyMaxBytes: number): (req: Request, pathname: string) => boolean {
  return (req, pathname) => carriesBody(req) && bodyCeilingFor(routes, req.method, pathname, bodyMaxBytes) === 0;
}

/** {@link undrainedOn} for a self-hosted server behind the node adapter. */
export const undrained = undrainedOn(selfHostRoutes, BODY_MAX_BYTES);

/** The same response, told to end the connection. See {@link undrained}. */
function closing(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Connection", "close");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The answer to a request the pipeline refuses before the router: a malformed path (400) or a
 * body over its route's ceiling (413). Null for anything else, which is a fault.
 */
export function refusalBeforeRouter(err: unknown, requestId: string): Response | null {
  if (err instanceof MalformedPathError) {
    // Malformed percent-encoding is a CLIENT error; it must not reach `matchRoute`'s decode as a 500.
    return json(400, { error: { code: "malformed_path", message: "malformed percent-encoding in path" } }, requestId);
  }
  // The route's own body ceiling, refused before the bytes are in the heap.
  if (err instanceof BodyOverCeilingError) {
    return json(413, {
      error: {
        code: "payload_too_large",
        message: `request body exceeds this route's limit of ${err.maxBytes} bytes`,
      },
    }, requestId);
  }
  return null;
}

/** The dispatch of one program: `Request` in, `Response` out, never a throw. */
export function makeDispatch(p: Pipeline): (req: Request) => Promise<Response> {
  const app = createApp(p.routes);
  const normalize = normalizeOn(p.routes, p.bodyMaxBytes);
  const leftUnread = undrainedOn(p.routes, p.bodyMaxBytes);
  return async (req) => {
    const requestId = randomUUID();

    let normalized: Request;
    try {
      normalized = await normalize(req);
    } catch (err) {
      // EVERY pre-router exit closes the connection when the request brought a body, not just the
      // ceiling breach: `normalizeEscapes` throws BEFORE the body is read at all, and the refusal
      // of a ceiling stopped mid-body. See {@link undrainedOn}.
      const hadBody = p.closeUndrained && carriesBody(req);
      const exit = (res: Response): Response => (hadBody ? closing(res) : res);
      return exit(refusalBeforeRouter(err, requestId) ?? internal(requestId, req, err, p.logger));
    }

    // HEAD dispatched as GET, body stripped on the way out — the router stays strict (a table
    // that silently accepts an undeclared method is worse), the HOST does the RFC 9110 mapping.
    // Without this, every monitor that probes `HEAD /health` reads 405 and calls the service down.
    const isHead = normalized.method.toUpperCase() === "HEAD";
    const forRouter = isHead
      ? new Request(normalized.url, { method: "GET", headers: normalized.headers })
      : normalized;

    // ONE decision, made once and applied to every exit below — the 404/405 the router gives, and
    // the 500 a broken composition gives.
    const skipped = p.closeUndrained && leftUnread(req, new URL(normalized.url).pathname);
    const exit = (r: Response): Response => (skipped ? closing(r) : r);
    const headless = async (res: Response): Promise<Response> => {
      if (!isHead) return res;
      // HEAD: same status and headers, no body — and the produced body is discarded explicitly
      // so a streaming route cannot leak its reader.
      await res.body?.cancel().catch(() => { /* nothing to release */ });
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    };

    try {
      const deps = p.buildDeps(forRouter);
      deps.requestId = requestId;
      return await headless(exit(noStore(await app.handle(forRouter, deps), requestId)));
    } catch (err) {
      /**
       * The busy-connection answer, as a backstop for pipelines with no envelope.
       * `withErrorEnvelope` maps this to 503 `db_busy`, but it is installed in `FULL_PIPELINE`
       * only: `RAW_PIPELINE` and `ANONYMOUS_PIPELINE` (`packages/api/src/app.ts`) carry no
       * envelope, so a busy session lookup on `/events`, `/oauth/authorize` or an attachment
       * byte route lands here — and `internal()` would call it a 500, reporting a route fault
       * for connection contention. The same function the envelope uses, imported rather than
       * reimplemented, so the two halves cannot drift.
       */
      if (isDbBusy(err)) {
        p.logger.warn("request_db_busy", {
          requestId, method: forRouter.method, path: safePath(forRouter.url), status: 503, code: "db_busy",
        });
        // THROUGH `noStore`, like every other answer: the one response a client is most likely to
        // be handed repeatedly under load must not be cacheable, and must carry its request id.
        return headless(exit(noStore(dbBusyResponse(forRouter, {}, err), requestId)));
      }
      return exit(internal(requestId, forRouter, err, p.logger));
    }
  };
}

const dispatches = new WeakMap<ServerRuntime, (req: Request) => Promise<Response>>();

/**
 * The pipeline of a self-hosted server over a hand-built {@link ServerRuntime}. The connection's
 * fate is decided from the request alone, before the runtime is read: a composition too broken to
 * build its deps answers 500 and still closes a connection it left bytes on.
 */
export function handleServerRequest(req: Request, rt: ServerRuntime): Promise<Response> {
  let dispatch = dispatches.get(rt);
  if (!dispatch) {
    dispatch = makeDispatch({
      routes: selfHostRoutes,
      bodyMaxBytes: BODY_MAX_BYTES,
      closeUndrained: true,
      logger: rt.logger,
      buildDeps: (forRouter) => depsFor(forRouter, runtimeOf(rt)),
    });
    dispatches.set(rt, dispatch);
  }
  return dispatch(req);
}

/**
 * The last line before a hung socket or a platform's own error page. `withErrorEnvelope` maps
 * everything a handler throws, so reaching here means the failure was OUTSIDE the pipeline.
 * STRUCTURED AND SANITIZED: class name and `code` only — a driver error's message routinely
 * carries `host=…&user=…` and the failing query, and this line goes to a log collector.
 */
function internal(requestId: string, req: Request, err: unknown, logger: Pick<Logger, "error">): Response {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  logger.error("unhandled", {
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

export function json(status: number, body: unknown, requestId: string): Response {
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
