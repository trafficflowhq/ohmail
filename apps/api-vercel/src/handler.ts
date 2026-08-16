import { randomUUID } from "node:crypto";
import { createApp, apiRoutes } from "@trafficflow/api";
import { hostState } from "./config.js";
import { buildDeps } from "./deps.js";
import { MalformedPathError, normalizeRequest } from "./prefix.js";

/**
 * THE dispatch point. `app/[[...path]]/route.ts` is a thin shim over this; all of the
 * behaviour is here so it can be tested without a Next runtime.
 *
 * Order matters and is fixed:
 *   1. mint a request id (so even a pre-pipeline failure is traceable),
 *   2. resolve the host state (once per cold instance; a config fault becomes a clean 503),
 *   3. NORMALIZE the request URL — exactly once, before anything reads the path (`prefix.ts`),
 *   4. build `ApiDeps` for this request,
 *   5. `app.handle` (with HEAD dispatched as GET),
 *   6. `Cache-Control: no-store` on anything that did not set its own.
 *
 * Step 3 is before step 4 on purpose: `buildDeps` reads the `Host` header for the cookie
 * decision, and the idempotency hash reads the path — both must see the same canonical
 * request the router does. And the canonical path is computed ONCE and passed onward; nothing
 * downstream re-normalizes (see {@link misconfigured}).
 */

const app = createApp(apiRoutes);

export async function handleApiRequest(req: Request): Promise<Response> {
  // One id per request, minted HERE rather than by `withRequestId`, because the failures this
  // function handles happen before any middleware runs and were previously untraceable.
  const requestId = randomUUID();
  const state = hostState();

  let normalized: Request;
  try {
    normalized = await normalizeRequest(req);
  } catch (err) {
    if (err instanceof MalformedPathError) {
      // Malformed percent-encoding is a CLIENT error. It used to reach `matchRoute`, whose
      // `decodeURIComponent` throws `URIError` from above the error envelope, so `/messages/%ZZ`
      // was a logged 500 rather than the 400 it plainly is.
      return json(400, { error: { code: "malformed_path", message: "malformed percent-encoding in path" } }, requestId);
    }
    return internal(requestId, req, err);
  }

  // Already canonical — every consumer below uses THIS value.
  const pathname = new URL(normalized.url).pathname;
  if (!state.ok) return misconfigured(pathname, state.error, state.version, requestId);

  // HEAD is dispatched as GET. Next maps an unexported HEAD onto the exported GET function, but
  // the inner router only sees `req.method`, so `HEAD /health` matched the path with the wrong
  // method and answered 405 — a broken liveness probe for every monitor that HEADs. The router
  // stays strict (a route table that silently accepts a method it does not declare is worse);
  // the HOST does the RFC 9110 mapping, and strips the body on the way out.
  const isHead = normalized.method.toUpperCase() === "HEAD";
  const forRouter = isHead
    ? new Request(normalized.url, { method: "GET", headers: normalized.headers })
    : normalized;

  try {
    const deps = buildDeps(forRouter, state.cfg);
    deps.requestId = requestId;
    const res = noStore(await app.handle(forRouter, deps), requestId);
    if (!isHead) return res;
    // HEAD: same status and headers, no body — and the produced body is discarded explicitly
    // so a streaming route cannot leak its reader.
    await res.body?.cancel().catch(() => { /* nothing to release */ });
    return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    return internal(requestId, forRouter, err);
  }
}

/**
 * The last line before the platform's own HTML error page, which an API client cannot parse.
 * `withErrorEnvelope` already maps everything a handler throws, so reaching here means the
 * failure was OUTSIDE the pipeline (a middleware itself, or a raw route, which has no envelope
 * above it).
 *
 * The log line is STRUCTURED AND SANITIZED. It used to be `console.error("[api-vercel]
 * unhandled", err)` — the whole error object, in a comment that itself acknowledged the value
 * may carry a connection string. A driver error's `message` routinely contains `host=…&user=…`
 * and a `postgres` error carries the failing query; Vercel's log drain keeps all of it, so that
 * one line could publish the production credential to anyone with log access. What an operator
 * actually needs is WHICH request, WHERE, and WHAT CLASS of failure — the error's class name
 * and its `code`, both enumerable — plus the route. The message and the stack are deliberately
 * omitted: if class + code + route is not enough to reproduce, the fix is a test, not a fuller
 * log line.
 */
function internal(requestId: string, req: Request, err: unknown): Response {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  console.error(JSON.stringify({
    level: "error",
    event: "unhandled",
    requestId,
    method: req.method,
    path: safePath(req.url),
    errorClass: typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown",
    errorCode: typeof e?.code === "string" ? e.code : null,
  }));
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

/**
 * A host whose configuration did not load answers 503 everywhere — but `/health` answers
 * 503 *with the reason*, because an operator staring at a broken deployment needs to know
 * WHICH variable is wrong, and the messages this carries name variables, never values.
 *
 * It takes the ALREADY-CANONICAL pathname. Re-normalizing here was a real contract break:
 * `normalizePathname` strips exactly ONE `/api` by design, so applying it twice turned
 * `/api/api/health` — which must 404 — into `/health` and handed it the diagnostic detail.
 */
function misconfigured(pathname: string, error: string, version: string, requestId: string): Response {
  if (pathname === "/health") {
    return json(503, { ok: false, version, error: "config_invalid", detail: error }, requestId);
  }
  return json(503, { error: { code: "service_misconfigured", message: "service is misconfigured" } }, requestId);
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
 * `Cache-Control: no-store` unless the route already declared its own (SSE sets `no-cache`,
 * `/health` sets `no-store`), plus the request id on every response so a client can quote it in
 * a bug report. Nothing on this API is cacheable — it is all per-account mutable state behind a
 * session — and a shared cache holding one account's `/sync` response is the worst bug this
 * codebase could ship. A NEW Response is built rather than mutating headers, because a
 * Response's header guard may forbid that; the body is passed through untouched, so a stream
 * stays a stream.
 */
function noStore(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  if (!headers.has("cache-control")) headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
