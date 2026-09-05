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

// Outermost → inner. Revised pipeline order (BC pipeline): requestId → errorEnvelope
// → requestGuard → session → stepUp → spendGate → csrf → idempotency → handler.
//
// There is deliberately NO in-app `withRateLimit` in this chain. The concern it would address —
// invocation cost from an unverified or anonymous read-poll — cannot be addressed from inside the
// invocation: a 429 a middleware returns costs the same invocation as the read it refuses (the
// same reason `withSpendGate` gives for not gating reads). The control is a per-IP rate limit at
// the platform edge, keyed on the trusted client IP `context.ts` derives, applied before the
// function runs; it is configured out of band, not in code. This module is also compiled into the
// standalone local build, which has no accounts to rate-limit.
//
// `withRequestGuard` sits BEFORE `withSession` deliberately: it is the only guard the
// PUBLIC cookie-minting auth routes get (`withCsrf` cannot fire without a cookie
// session), so it must not depend on there being a session at all.
//
// `withSpendGate` sits directly AFTER `withStepUp`: both judge a privilege the
// resolved session either carries or does not, and a caller missing both should be told about
// the step-up first, because it is the cheaper thing to fix and the one a client can act on
// without human input. Both are downstream of `withSession`, so neither ever sees an
// enrollment-scoped session.
const FULL_PIPELINE: Middleware[] = [
  withRequestId, withErrorEnvelope, withRequestGuard, withSession, withStepUp, withSpendGate,
  withCsrf, withIdempotency,
];

// Reduced pipeline for `raw` routes (SSE, /oauth/authorize): no JSON envelope
// coercion, no CSRF, no idempotency. It keeps `withRequestGuard` — both raw
// routes are GET today, so it is a no-op, and a raw mutation added later must not
// silently arrive unguarded.
//
// AND IT KEEPS `withSpendGate`, which it did not before, and that omission was the
// hole. `raw` is a RESPONSE-SHAPE decision (bytes, a zip, a stream, Stripe's own status
// semantics), and it had quietly become an authorization decision as well: the five costliest
// routes in the product were raw — `GET /attachments/:id` and both `download-all` routes open
// IMAP, `GET /img` fetched a remote URL (currently unmounted), `GET /events` holds a stream
// with a poll loop behind it — and not one of them could be gated at all, because the gate was
// absent from the chain they run in. Setting the gate's earlier opt-in flag on any of them
// would have done nothing and looked like it did something.
//
// It is safe here despite the missing `withErrorEnvelope`: the gate RETURNS an
// `errorResponse`, it never throws, so there is nothing for the absent envelope to catch.
//
// AND IT NOW KEEPS `withStepUp`, for the same reason and after the same kind of miss. Putting
// `stepUp: true` on `GET /oauth/authorize` — the fix the register asks for — would have done
// NOTHING while this chain omitted the middleware that reads the flag, and it would have looked
// like it did something: the route table would have shown the gate, the census would have agreed,
// and the route would have gone on minting 400-day native credentials for any bearer token. That
// is the identical shape as the `withSpendGate` paragraph above, one flag along, which is the
// reason to state it rather than quietly add the entry.
//
// A `stepUp` flag on a route whose chain cannot enforce it is worse than no flag, because it
// reads as a control. Both raw + step-up routes therefore run the real middleware, and
// `raw-pipeline-parity.test.ts` asserts the membership rather than trusting this comment.
//
// Safe for the same reason `withSpendGate` is: `withStepUp` RETURNS an `errorResponse` and never
// throws, so the absent envelope has nothing to catch.
const RAW_PIPELINE: Middleware[] = [withRequestId, withRequestGuard, withSession, withStepUp, withSpendGate];

// `anonymous` routes: NO session resolution at all (`/health`).
//
// `withSession` resolves any credential that happens to be presented even on a `public`
// route, and that had two consequences a liveness probe must not have. First, a probe
// arriving with an ambient browser cookie cost an EXTRA `sessions` query, so "/health is one
// round trip" was true only for an anonymous caller. Second, and worse: that query runs
// OUTSIDE the handler's try/catch, so when the database was unreachable — the exact condition
// `/health` exists to report — a cookie-bearing request produced the host's generic 500
// instead of the controlled `database_unreachable` 503. The endpoint failed hardest in the
// only scenario it is for.
//
// `withRequestGuard` is kept for the same reason as in RAW_PIPELINE: `/health` is GET, so it
// is a no-op today, and a future anonymous mutation must not arrive unguarded.
//
// `withSpendGate` is deliberately ABSENT, and adding it would be false comfort rather
// than defence in depth. The gate judges `deps.session`; this pipeline never resolves one, so
// the middleware could not fire here however it were written, and a membership assertion over
// this chain would pass while enforcing nothing. The fence for anonymous routes is a CENSUS
// invariant instead, asserted over the route table in both directions: every `anonymous`
// route is `cost: "unauthenticated"`, and every `unauthenticated` route is `public`. A route
// that resolves no session and claims to spend is a contradiction the table itself refuses.
const ANONYMOUS_PIPELINE: Middleware[] = [withRequestId, withRequestGuard];

/**
 * THE FIRST PARAMETER WHOSE SHAPE COULD NEVER NAME A ROW — or `null` when every one is fine.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * A `:param` is a caller-chosen string, and it went straight into an account-scoped select on a
 * `uuid` column. Postgres answers `22P02 invalid input syntax for type uuid`, which is not a
 * `ServiceError` and not `isDbBusy`, so `withErrorEnvelope` classified it as an unhandled fault
 * and answered `500 internal error` — on every by-id route that reads a uuid column, which was
 * nearly all of them. The three shapes that made it hard to see are `%0A`, `%20` and `%09`:
 * `tryMatch` percent-decodes each segment, so a trailing newline, space or tab reaches the column
 * as a real byte while rendering IDENTICALLY to a clean id in a log line.
 *
 * ── WHY HERE, AND NOT IN A PIPELINE ──────────────────────────────────────────────────────────
 *
 * This is the single seam every request crosses. A `Middleware` in `FULL_PIPELINE` would have left
 * `raw` routes (`GET /attachments/:id`, both `download-all`) and `anonymous` ones
 * (`/admin/accounts/:id`) uncovered — a check that is green in tests and absent in production for
 * precisely the routes that open IMAP and read staff data. It also covers the sidecar, which
 * composes its own `createApp([...])` from a different route list (`apps/sidecar/src/engine.ts`)
 * and shares no middleware list with the hosted API at all.
 *
 * ── WHY BEFORE `withSession`, AND WHAT THAT DISCLOSES ────────────────────────────────────────
 *
 * Running above the pipeline means a caller with no session — and a cross-site POST with no CSRF
 * token — now gets `400` where it used to get `401`/`403`. That ordering discloses nothing beyond
 * the route table's own shape, which is public API surface: the answer is identical for a route
 * that exists and a caller who may not use it, it names no row, confirms no id, and distinguishes
 * no account from any other. What it CANNOT do is reach the database, which is the entire point —
 * an unauthenticated 400 costs a string test, where the 500 it replaces cost a connection
 * acquisition and a `log.error("request_unhandled")` line in the only alerting signal there is.
 *
 * ── THE REGEX IS CANONICAL-ONLY, DELIBERATELY ────────────────────────────────────────────────
 *
 * `isUuid` accepts the 8-4-4-4-12 hyphenated form and nothing else, while Postgres would also take
 * braces, `urn:uuid:` and bare 32-hex. Refusing those with a 400 is correct rather than strict:
 * every id in this system is minted by `defaultRandom()` or `crypto.randomUUID()` and travels as
 * the canonical form, so an alternative spelling is not a client of ours being unlucky — it is
 * something hand-assembling ids, and it should be told so at the door.
 *
 * `isUuid` is imported rather than re-spelled: a second copy of the pattern is a second thing to
 * keep true, and this one already has `requireUuid`'s argument written above it.
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
 * **THE ACCOUNT THIS RESPONSE WAS ISSUED FOR.** Present on every response whose request
 * resolved a session; absent on every response that did not.
 *
 * ── THE SEQUENCE NO CLIENT-SIDE CHECK CAN SEE ────────────────────────────────────────────────
 *
 * The browser binds a request to the account it believes is signed in, and asks again when the
 * answer lands. Both are OBSERVATIONS, and both are made when something reads. A switch to
 * another account and back that completes entirely between a request's departure and its arrival
 * leaves every one of them reading exactly as it did before: the `tf_owner` marker says what it
 * said, no confirmation was seen to lapse, and a response selected under the OTHER account is
 * applied to this one's mirror. The client cannot observe a state it was never asked about, so the
 * server has to say whose question it answered. This header is that sentence.
 *
 * It pairs with the `tf_owner` marker (`cookies.ts`) — same value, opposite direction. The cookie
 * is what the browser remembers; this is what the server did.
 *
 * ── IT COMES FROM THE SESSION ROW, NEVER FROM THE REQUEST ────────────────────────────────────
 *
 * The value is `deps.session.accountId`, which `withSession` took from the `sessions` row
 * (contract §1.9). Not a query parameter, not a body field, not an echo of anything the caller
 * sent — a header that repeated the caller's own claim would confirm every switch it exists to
 * catch.
 *
 * ── WHY HERE, AND NOT A MIDDLEWARE ───────────────────────────────────────────────────────────
 *
 * The same reason `firstMisshapenParam` is here, and this file already records the cost of the
 * alternative three times: the old email-verification flag, `withSpendGate` and `withStepUp` were
 * each declared on routes whose pipeline omitted the middleware that reads them, and all three
 * LOOKED like controls. (The first is named indirectly on purpose — `spend-gate.test.ts` sweeps
 * this whole directory's source text for that identifier, prose included, so that a second
 * verification mechanism cannot reappear beside `cost` unnoticed. Tripping a guard to reminisce
 * about it would be a poor trade.) A middleware would have to be a member of FULL_PIPELINE and
 * RAW_PIPELINE both, and the fourth omission would be found the same way as the first three.
 * `handle` is the one seam
 * every request crosses in every composition — the hosted API, the standalone server, and the
 * sidecar, which builds its own `createApp([...])` from a different route list and shares no
 * middleware list with any of them.
 *
 * ── ABSENT IS NOT PERMISSION ─────────────────────────────────────────────────────────────────
 *
 * Absence means no session was resolved: an anonymous route, a public route reached without a
 * credential, a 401, or a 404/405/400 answered before any pipeline ran. None of those carry mail
 * bytes or metadata for anybody. A client that has bound itself to an account must therefore
 * treat a MISSING header on an authenticated read as a refusal rather than as silence — the
 * failure this closes is precisely one where nothing looks wrong.
 */
export const ACCOUNT_HEADER = "X-Ohmail-Account";

/**
 * Attach {@link ACCOUNT_HEADER} when a session was resolved. The single site; a source census
 * (`response-headers.test.ts`) asserts nothing else in `packages/api/src` sets it.
 *
 * **A NEW `Response`, NOT A MUTATION**, for the reason `apps/api-vercel/src/handler.ts`'s
 * `noStore` gives next to the same decision: a `Response`'s header guard may forbid `set`, and a
 * throw here would land ABOVE `withErrorEnvelope` and surface as the host's generic 500. The body
 * is passed through untouched, so a stream stays a stream.
 *
 * **The id goes through `ownerCookieValue`**, which is the same sanitizer `tf_owner` itself uses
 * and is here for its second job: it keeps an id whose shape a header cannot carry out of a
 * header. It fails CLOSED — an unrepresentable id omits the header, and a client that treats
 * absence as a refusal is then refused, rather than being handed a value that is not what it
 * looks like. Account ids are UUIDs and comfortably inside the set.
 */
function nameTheAccount(res: Response, deps: ApiDeps): Response {
  const account = ownerCookieValue(deps.session?.accountId);
  if (!account) return res;
  const headers = new Headers(res.headers);
  headers.set(ACCOUNT_HEADER, account);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Build the framework-agnostic app. `handle(req, deps)` matches a route (404/405),
 * refuses a path parameter that could never name a row (400), then runs the request through the
 * appropriate middleware pipeline into the handler, and names the account it answered for
 * ({@link ACCOUNT_HEADER}). `deps` is the per-request container (PGlite in tests, pooled Postgres
 * in `apps/web`).
 */
export function createApp(routes: Route[]): App {
  return {
    async handle(req: Request, deps: ApiDeps): Promise<Response> {
      return nameTheAccount(await dispatch(routes, req, deps), deps);
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
async function dispatch(routes: Route[], req: Request, deps: ApiDeps): Promise<Response> {
  const { pathname } = new URL(req.url);
  const m = matchRoute(routes, req.method, pathname);
  if (!m.matched) {
    return m.methodNotAllowed
      ? errorResponse("method_not_allowed", 405, "method not allowed")
      : errorResponse("not_found", 404, "not found");
  }
  const badParam = firstMisshapenParam(m.route, m.params);
  if (badParam) {
    return errorResponse(
      "validation_failed", 400, `${badParam} must be an id`, undefined, false,
    );
  }
  const chain = m.route.options?.anonymous
    ? ANONYMOUS_PIPELINE
    : m.route.options?.raw ? RAW_PIPELINE : FULL_PIPELINE;
  const composed = chain.reduceRight<Handler>((next, mw) => mw(next, m.route), m.route.handler);
  return composed(req, deps, m.params);
}
