import { isUuid } from "@trafficflow/services/mail";
import { ownerCookieValue } from "./cookies.js";
import type { ApiDeps } from "./deps.js";
import { errorResponse } from "./responses.js";
import { matchRoute, type Handler, type Route, type RouteParams } from "./router.js";
import {
  withCsrf, withErrorEnvelope, withIdempotency, withRequestGuard, withRequestId,
  withSession, withSpendGate, withStepUp,
  type Middleware,
} from "./middleware.js";

export interface App {
  handle(req: Request, deps: ApiDeps): Promise<Response>;
}

// Outermost → inner: requestId → errorEnvelope → requestGuard → session → stepUp → spendGate
// → csrf → idempotency → handler. There is deliberately no in-app `withRateLimit`: a 429 a
// middleware returns costs the same invocation as the read it refuses, so the control is a
// per-IP limit at the platform edge, keyed on the trusted client IP `context.ts` derives; this
// module is also compiled into the standalone local build, which has no accounts to rate-limit.
// `withRequestGuard` sits before `withSession` because it is the only guard the public
// cookie-minting auth routes get, so it must not depend on a session existing. `withSpendGate`
// sits directly after `withStepUp`: both judge a privilege the resolved session carries or does
// not, and a caller missing both should hear about the step-up first — the cheaper fix.
const FULL_PIPELINE: Middleware[] = [
  withRequestId, withErrorEnvelope, withRequestGuard, withSession, withStepUp, withSpendGate,
  withCsrf, withIdempotency,
];

// Reduced pipeline for `raw` routes (SSE, /oauth/authorize): no JSON envelope coercion, no
// CSRF, no idempotency. It keeps `withRequestGuard` (both raw routes are GET today; a raw
// mutation added later must not arrive unguarded), and it keeps `withSpendGate` and
// `withStepUp`: `raw` is a response-shape decision, not an authorization one, and the costliest
// routes in the product are raw — a `stepUp` or gate flag on a route whose chain omits the
// middleware that reads it is worse than no flag, because it reads as a control.
// `raw-pipeline-parity.test.ts` asserts the membership rather than trusting this comment. Safe
// without `withErrorEnvelope`: both middlewares RETURN an `errorResponse` and never throw, so
// there is nothing for the absent envelope to catch.
const RAW_PIPELINE: Middleware[] = [withRequestId, withRequestGuard, withSession, withStepUp, withSpendGate];

// `anonymous` routes: no session resolution at all (`/health`). `withSession` resolves any
// credential that happens to be presented, which a liveness probe must not do: a probe with an
// ambient cookie cost an extra `sessions` query, and that query runs outside the handler's
// try/catch — an unreachable database turned into the host's generic 500 instead of the
// controlled `database_unreachable` 503. `withRequestGuard` is kept for RAW_PIPELINE's reason.
// `withSpendGate` is deliberately absent: the gate judges `deps.session` and this pipeline never
// resolves one, so a membership assertion would pass while enforcing nothing. The fence is a
// census over the route table in both directions: every `anonymous` route is
// `cost: "unauthenticated"`, and every `unauthenticated` route is `public`.
const ANONYMOUS_PIPELINE: Middleware[] = [withRequestId, withRequestGuard];

/**
 * The first parameter whose shape could never name a row — or `null` when every one is fine.
 * A `:param` is a caller-chosen string, and it went straight into an account-scoped select on
 * a `uuid` column: Postgres answers `22P02`, which is not a `ServiceError`, so the envelope
 * answered `500 internal error` on nearly every by-id route (`%0A`, `%20`, `%09` decode to
 * real bytes that render like a clean id). It runs at the single seam every request crosses —
 * a middleware would miss `raw` and `anonymous` routes and the sidecar's own `createApp`.
 * Before `withSession`, a 401/403 becomes a 400 that discloses only the route table's shape
 * and can never reach the database. `isUuid` accepts the canonical form only, imported.
 */
function firstMisshapenParam(route: Route, params: RouteParams): string | null {
  const opaque = route.options?.opaqueParams;
  for (const [name, value] of Object.entries(params)) {
    if (opaque?.includes(name)) continue;
    if (!isUuid(value)) return name;
  }
  return null;
}

/**
 * The account this response's contents belong to — on sign-in and token routes the account the
 * credential resolved to, never the session that carried the request. Present on every response
 * with a subject; absent otherwise. The value is `deps.session.accountId` from the `sessions`
 * row, and on credential routes `deps.credentialAccount` from the seam that minted the session; a
 * session for A with a credential for B is refused 409. Pairs with `tf_owner` (`cookies.ts`). A
 * client bound to an account treats a missing header on an authenticated read as a refusal, when
 * `GET /hello` advertises `features.accountHeader`. The `/admin/*` reads are anonymous and
 * separately authorized (`routes/admin.ts`; `admin-routes.test.ts` is the census).
 */
export const ACCOUNT_HEADER = "X-Ohmail-Account";

/**
 * `X-Request-Id` — the id a person can quote back, on the response as well as in the log.
 * `withRequestId` mints the id and binds it to the per-request logger; this line is what
 * returns it to the client on every door, including the standalone/desktop one, which answers
 * straight out of `app.handle` with no host wrapper. Where the container injects no logger
 * (the engine binds `silentLogger`), the header is the client-side half only. It lives here —
 * the single exit every answer leaves through — so the 404/405/400 answered above the
 * pipelines carry it too. The hosted doors' own stamping stays and is not a duplicate: their
 * pre-`handle` responses (malformed-path 400, 413, 503, escaped-throw 500) never reach this line.
 */
/**
 * ══ ONE HEADER ADDED TO A RESPONSE, ON BOTH RUNTIMES THIS FILE RUNS IN ══════════════════════
 *
 * `new Response(res.body, …)` is right on a server and EMPTIES THE BODY on a phone. React
 * Native's `Response` is `whatwg-fetch`, which has no `body` property at all — so the expression
 * is `undefined`, `_initBody` takes that as "no body", and the copy carries an empty string.
 *
 * Measured on a release build over the standalone door, where this whole pipeline runs inside the
 * app's own runtime: every drain answered `JSON Parse error: Unexpected end of input`, the app's
 * mirror stayed at zero rows beside an engine store holding the mail, and the roster read that
 * Settings' "This phone" panel needs answered nothing. Reproduced under Node by swapping in that
 * polyfill and asking the door for a body: 0 bytes on every route, and a full body back with the
 * platform's own `Response`.
 *
 * So the COPY is made only where the runtime HAS a body to hand on — which is the same set of
 * runtimes whose `Headers` is guarded, and is why the copy was written this way in the first
 * place. Where it has not, the header is set on the response itself. A header that cannot be set
 * is DROPPED rather than taken to mean the body may go: this value is a diagnostic and the body
 * is somebody's mail.
 *
 * The capability is read per call rather than captured: this module is evaluated inside a bundle
 * whose globals the host installs, and a module-scope read would decide it before they exist.
 */
function withHeader(res: Response, name: string, value: string): Response {
  if ("body" in Response.prototype) {
    const headers = new Headers(res.headers);
    headers.set(name, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  try {
    res.headers.set(name, value);
  } catch {
    /* A guarded `Headers` on a runtime that has no body to copy — the header is lost and the
       body is not. See the note above for why that is the right way round. */
  }
  return res;
}

export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Stamp {@link REQUEST_ID_HEADER} when this request has an id. The single site; the source
 * census in `request-id-header.test.ts` asserts nothing else in `packages/api/src` sets it.
 * A new `Response`, not a mutation: a `Response`'s header guard may forbid `set`, and a throw
 * here lands above every envelope as the host's generic 500; the body passes through untouched
 * so a stream stays a stream. It fails closed on an empty id — the desktop engine passes
 * `requestId: ""` for responses answered above the pipelines, which produce no log line, so an
 * invented id would select nothing. Minting belongs to `withRequestId` alone.
 */
function stampRequestId(res: Response, deps: ApiDeps): Response {
  if (!deps.requestId) return res;
  /* Through {@link withHeader}: on a phone a copy built from `res.body` is a copy with NO body. */
  return withHeader(res, REQUEST_ID_HEADER, deps.requestId);
}

/**
 * Attach {@link ACCOUNT_HEADER} when a session was resolved. The single site; a source census
 * (`response-headers.test.ts`) asserts nothing else in `packages/api/src` sets it. A new
 * `Response`, not a mutation, for {@link stampRequestId}'s reason. The id goes through
 * `ownerCookieValue` — the same sanitizer `tf_owner` uses — which keeps an id whose shape a
 * header cannot carry out of the header. It fails closed: an unrepresentable id omits the
 * header, and a client that treats absence as a refusal is then refused. Account ids are UUIDs
 * and comfortably inside the set.
 */
function nameTheAccount(res: Response, deps: ApiDeps, route: Route | null): Response {
  // ON A CREDENTIAL ROUTE THE AMBIENT SESSION IS NOT THE SUBJECT, and it is not consulted at all.
  // A refused sign-in made while holding somebody's session would otherwise be labelled with that
  // session's account — a response that established nothing, named as if it had.
  const subject = route?.options?.credentialSubject
    ? deps.credentialAccount
    : deps.session?.accountId;
  const account = ownerCookieValue(subject);
  if (!account) return res;
  /* Through {@link withHeader}, for its reason: this was the site that emptied every
     session-authenticated response on the phone's own door. */
  return withHeader(res, ACCOUNT_HEADER, account);
}

/**
 * Build the framework-agnostic app. `handle(req, deps)` matches a route (404/405),
 * refuses a path parameter that could never name a row (400), then runs the request through the
 * appropriate middleware pipeline into the handler, names the account it answered for
 * ({@link ACCOUNT_HEADER}) and stamps the request id ({@link REQUEST_ID_HEADER}). `deps` is the
 * per-request container (PGlite in tests, pooled Postgres in `apps/web`).
 */
export function createApp(routes: Route[]): App {
  return {
    async handle(req: Request, deps: ApiDeps): Promise<Response> {
      const { res, route } = await dispatch(routes, req, deps);
      return stampRequestId(nameTheAccount(res, deps, route), deps);
    },
  };
}

/**
 * Route → shape-check → pipeline → handler. Extracted from `handle` so that `handle` has ONE
 * exit, which is what lets {@link ACCOUNT_HEADER} be attached in one place and be total: the
 * 404, the 405 and the malformed-parameter 400 leave through the same line as a handler's answer.
 * They name nobody, because they are answered before `withSession` runs — but they are answered
 * BY the same rule rather than by falling outside it, and a reader does not have to check.
 */
async function dispatch(
  routes: Route[], req: Request, deps: ApiDeps,
): Promise<{ res: Response; route: Route | null }> {
  const { pathname } = new URL(req.url);
  const m = matchRoute(routes, req.method, pathname);
  if (!m.matched) {
    return {
      res: m.methodNotAllowed
        ? errorResponse("method_not_allowed", 405, "method not allowed")
        : errorResponse("not_found", 404, "not found"),
      route: null,
    };
  }
  const badParam = firstMisshapenParam(m.route, m.params);
  if (badParam) {
    return {
      res: errorResponse("validation_failed", 400, `${badParam} must be an id`, undefined, false),
      route: m.route,
    };
  }
  const chain = m.route.options?.anonymous
    ? ANONYMOUS_PIPELINE
    : m.route.options?.raw ? RAW_PIPELINE : FULL_PIPELINE;
  const composed = chain.reduceRight<Handler>((next, mw) => mw(next, m.route), m.route.handler);
  return { res: await composed(req, deps, m.params), route: m.route };
}
