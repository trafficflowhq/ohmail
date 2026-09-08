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
 * **THE ACCOUNT THIS RESPONSE'S CONTENTS BELONG TO** — and on the sign-in and token routes that
 * is the account the CREDENTIAL resolved to, not the session that carried the request.
 *
 * Present on every response that has a subject; absent on every response that does not.
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
 * ── THE SIGN-IN AND TOKEN ROUTES ANSWER FOR SOMEBODY ELSE ────────────────────────────────────
 *
 * `/auth/login`, `/auth/refresh`, `/auth/verify-email`, `/auth/desktop-claim` and `/oauth/token`
 * are `public`: `withSession` resolves whatever credential happens to be ambient, and then the
 * handler resolves a SECOND one out of the body. Those two need not name the same account, and
 * taking the header from the session was wrong on exactly the requests where it matters most —
 * the account switches. A caller holding a live session for A who posted B's refresh token was
 * answered `X-Ohmail-Account: A` over a body containing B's tokens.
 *
 * Two changes, and they are different in kind. The header on these routes now names
 * `deps.credentialAccount`, reported by the seam that actually minted or rotated the session
 * (`establish`, `mintRotation`) on its success path only — so a response that established nothing
 * names nobody. And the ambiguous request itself is REFUSED rather than described:
 * `refuseCrossAccountCredential` answers 409 before anything is rotated or issued, because no
 * legitimate client presents a session for one account and a credential for another. The header
 * cannot be made honest while the request underneath it is ambiguous.
 *
 * ── ABSENT IS NOT PERMISSION ─────────────────────────────────────────────────────────────────
 *
 * Absence means the response has no account subject: an anonymous route, a public route reached
 * without a credential, a 401, a 404/405/400 answered before any pipeline ran, or a credential
 * route that established nothing (a refused sign-in, a `twofa_required` challenge that carries no
 * tokens). A client that has bound itself to an account must treat a MISSING header on an
 * authenticated read as a refusal rather than as silence — the failure this closes is precisely
 * one where nothing looks wrong.
 *
 * **The STAFF-AUTHORIZED ADMIN READS are the exception, and they are not a bypass.** `/admin/*`
 * is `anonymous`, so no session is resolved and none can be named; authority there is the
 * operator's shared secret plus a `staff_sessions` row (`routes/admin.ts`). Several of those reads
 * return mailbox metadata — counts and tallies, `AccountDetail.mailboxes`, mailbox ids and
 * addresses as option labels, worker lag. That is metadata for a staff reader, not mail for an
 * account holder.
 *
 * **THE COUNT IS NOT WRITTEN DOWN HERE, and that is the third revision of this sentence.** It
 * named one such read; a review found three; the next review found a fourth (`/admin/worker`). A
 * number in this comment is a fact about how hard somebody looked, so the claim is now about the
 * CLASS. And the class is NOT "every anonymous route" — that equation was the fourth revision's
 * own error: `/health` and `/hello` are anonymous and carry no account data at all. It is the
 * `/admin/*` reads, which are anonymous AND separately authorized by the operator's shared secret
 * plus a `staff_sessions` row. `spend-gate.test.ts` asserts what it actually asserts — that every
 * anonymous route is `cost: "unauthenticated"` and every such route is `public` — which is a fence
 * around spending, not a statement about who may read mailbox metadata. The authority for THAT is
 * `routes/admin.ts`'s own secret-plus-staff-session check — and `admin-routes.test.ts` is the
 * census that holds it, over EVERY `GET /admin/*` derived from the route table rather than a list.
 * That mattered: the list was six long while the surface was eight, so `/admin/costs` and the
 * account ledger were never exercised against "a logged-in customer is refused exactly as a
 * stranger is". Pointing at code alone would have left this sentence true and unenforced.
 *
 * No CUSTOMER-FACING route reaches mail bytes or mailbox metadata without a session.
 *
 * ── WHAT A CLIENT MAY CONCLUDE, STATED HERE RATHER THAN CITED ────────────────────────────────
 *
 * **Present:** this response's contents belong to the named account. On the sign-in and token
 * routes that is the account the CREDENTIAL resolved to, which can differ from any session the
 * request also carried; everywhere else it is the session's account.
 *
 * **Absent:** the response has no account subject — an anonymous route, a public one reached
 * without a credential, a 401, a 404/405/400 answered before authentication, or a sign-in route
 * that established nothing (a refused sign-in, a challenge carrying no tokens). A client holding
 * per-account state must read absence on an authenticated read as a REFUSAL, not as assent.
 *
 * **Only against a server that advertises it.** `GET /hello` reports `features.accountHeader`.
 * A server built before this header existed does not carry that key at all, and a client must not
 * require the header from such a server — otherwise pointing at an older self-hosted install would
 * make every ordinary response look like a refusal.
 *
 * That is the whole contract. It is written out rather than pointed at because the design note it
 * used to cite is not part of the published repository, so a reader of that repository could not
 * follow the reference — and a comment whose reference nobody can follow is worse than no comment.
 */
export const ACCOUNT_HEADER = "X-Ohmail-Account";

/**
 * `X-Request-Id` — the id a person can quote back, on the response as well as in the log.
 *
 * ── THE HALF THAT WAS MISSING ────────────────────────────────────────────────────────────────
 *
 * `withRequestId` (`middleware.ts`) mints the id and BINDS it to whatever logger the per-request
 * container carries, so a line written while answering names the request it belongs to. But the
 * id only reached the CLIENT on the two hosted doors, which stamp it themselves from the value
 * they mint before `handle` (`apps/api-vercel/src/handler.ts`, `apps/server/src/handler.ts` —
 * both through their own `noStore`). The standalone/desktop door answers straight out of
 * `app.handle` with no such wrapper, so nothing came back for a person to quote: a report of a
 * 500 could name the minute and the screen, never the request.
 *
 * **What this does NOT by itself achieve, on that door.** The engine's container
 * (`apps/sidecar/src/engine.ts`) injects no `logger`, so `withRequestId` binds `silentLogger`
 * there and the request's own line is discarded before it reaches a sink. The header is therefore
 * the client-side half of the correlation, and the id it carries selects a log line only where
 * the container supplies a logger — today the two hosted doors. Stating it rather than implying
 * the whole chain, because a comment that promises correlation the code does not yet deliver is
 * the claim a later reader would trust.
 *
 * ── WHY HERE, AND NOT IN `withRequestId` ─────────────────────────────────────────────────────
 *
 * Same reason {@link ACCOUNT_HEADER} is here, one header along. This is the single exit every
 * answer leaves through, so the 404, the 405 and the malformed-parameter 400 — all answered
 * ABOVE the pipelines, before any middleware runs — leave through the same line as a handler's
 * response. A middleware could not reach them at all, and `raw` and `anonymous` routes would be
 * covered only because `withRequestId` happens to be a member of all three chains today.
 *
 * ── THE HOSTED DOORS' OWN LINES STAY, AND ARE NOT DUPLICATES ─────────────────────────────────
 *
 * Both hosts mint the id BEFORE `handle` and hand it to `deps.requestId`, which
 * `withRequestId`'s `||` then preserves — so the value stamped here is the same value they
 * stamp, and the same one on their log lines. Their stamping still covers what this line cannot:
 * the malformed-path 400, the body-ceiling 413, the misconfigured 503, the `db_busy` 503 and the
 * escaped-throw 500 are all built WITHOUT calling `handle`, so removing their header would drop
 * the id from exactly the responses that are hardest to correlate.
 */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Stamp {@link REQUEST_ID_HEADER} when this request has an id. The single site; the source census
 * in `request-id-header.test.ts` asserts nothing else in `packages/api/src` sets it.
 *
 * **A NEW `Response`, NOT A MUTATION**, for the reason {@link nameTheAccount} and
 * `apps/api-vercel/src/handler.ts`'s `noStore` both give: a `Response`'s header guard may forbid
 * `set`, and a throw at this point would land above every envelope and surface as the host's
 * generic 500. The body passes through untouched, so a stream stays a stream.
 *
 * **It FAILS CLOSED on an empty id, and that arm is reachable rather than theoretical.** Every
 * pipeline runs `withRequestId`, so any response from a matched route always has one. The
 * responses that do not are the 404/405/400 answered above the pipelines on a door that mints no
 * id of its own — the desktop engine passes `requestId: ""` (`apps/sidecar/src/engine.ts`) — and
 * those produce no log line either, so there would be nothing for an invented id to select. An
 * id is never minted here: minting belongs to `withRequestId`, which is also what binds it to the
 * logger, and a second minting site would hand a client an id that appears in no log at all.
 */
function stampRequestId(res: Response, deps: ApiDeps): Response {
  if (!deps.requestId) return res;
  const headers = new Headers(res.headers);
  headers.set(REQUEST_ID_HEADER, deps.requestId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
function nameTheAccount(res: Response, deps: ApiDeps, route: Route | null): Response {
  // ON A CREDENTIAL ROUTE THE AMBIENT SESSION IS NOT THE SUBJECT, and it is not consulted at all.
  // A refused sign-in made while holding somebody's session would otherwise be labelled with that
  // session's account — a response that established nothing, named as if it had.
  const subject = route?.options?.credentialSubject
    ? deps.credentialAccount
    : deps.session?.accountId;
  const account = ownerCookieValue(subject);
  if (!account) return res;
  const headers = new Headers(res.headers);
  headers.set(ACCOUNT_HEADER, account);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
