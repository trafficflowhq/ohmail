import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ServiceError, IdempotencyRaceLost, resolveSession, sha256, isAllowedOrigin,
} from "@trafficflow/services/mail";
import { silentLogger } from "@trafficflow/core/mail";
import { csrfTokenFor } from "./csrf.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { lookupIdempotent, type StoredIdempotent } from "./idempotency.js";
import type { SessionVia } from "./deps.js";
import { unverifiedMayReach } from "./router.js";
import type { Handler, Route } from "./router.js";

/**
 * A middleware wraps the next handler. It receives the resolved `Route` so it can
 * read `route.options` (public / stepUp / idempotent) without a separate binding
 * step. `app.ts` composes them outermost→inner via reduceRight.
 */
export type Middleware = (next: Handler, route: Route) => Handler;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Read the session token from a Bearer header (native) or the `tf_session` cookie (web).
 *
 * ── THE EXPLICIT CREDENTIAL WINS ────────────────────────────────────────────────────────
 *
 * The order used to be the other way round: cookie first, header only when no cookie was
 * present. That is the classic ambient-authority bug. A cookie is sent by the browser
 * whether or not anyone meant to send it; an `Authorization` header is something a caller
 * TYPED. When both arrive and they name different users, honouring the ambient one
 * authenticates the request as somebody the caller did not ask to be — silently, with a 200.
 *
 * It was survivable while the landing and the product sat on different registrable domains
 * and the host split kept cookie traffic and bearer traffic apart. The move to a single
 * `ohmail.app` (see `NEVER_AUTH_HOSTS` in `packages/services/src/auth/origins.ts`, which
 * documents the loss) puts both on `api.ohmail.app`: the webapp's `/api` rewrite sends
 * cookies, native and scripted clients send bearers, and a jar holding a stale or
 * different-user `tf_session` is now an ordinary situation rather than an impossible one.
 *
 * The single origin makes this preference load-bearing rather than merely prudent: the
 * browser app decides at the edge whether `/` renders the marketing page or the mail
 * client, and it does that by taking the visitor's `tf_session` cookie and presenting the
 * value as a BEARER on a server-side `GET /auth/session` that carries no cookie jar of its
 * own. Header-first is what makes that call mean what it says.
 *
 * Preferring the header is strictly safer in both directions. A cookie-only browser request
 * is unaffected (there is no header to prefer). A bearer client that also carries a cookie
 * gets the identity it asked for. And `withCsrf` still fires exactly when it should, because
 * `via` is `"cookie"` only when the cookie is what actually authenticated.
 *
 * `allowCookie === false` (from `ApiDeps.allowCookieAuth`) makes the deployment
 * BEARER-ONLY: the cookie is not consulted at all — not preferred-against, not
 * downgraded — so an ambient browser cookie cannot authenticate on that host and
 * `withCsrf` is unreachable by construction (`via` can never be `"cookie"`).
 */
function readSessionToken(req: Request, allowCookie: boolean): { value: string; via: SessionVia } | null {
  const auth = req.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    const value = auth.replace(/^Bearer\s+/i, "").trim();
    // A present-but-empty `Authorization: Bearer` is not a credential; fall through to the
    // cookie rather than authenticating nobody and 401-ing a working browser session.
    if (value) return { value, via: "bearer" };
  }
  if (allowCookie) {
    const cookie = parseCookies(req.headers.get("cookie"))["tf_session"];
    if (cookie) return { value: cookie, via: "cookie" };
  }
  return null;
}

/**
 * CROSS-SITE + MEDIA-TYPE GUARD for every state-changing request.
 *
 * `withCsrf`'s double-submit check only fires when a request is authenticated BY
 * COOKIE, and it cannot fire on a `public` route: `POST /auth/register` and `POST
 * /auth/login` carry no session, and both of them SET `tf_session` +
 * `tf_csrf`. That combination is login CSRF / session fixation — a cross-site
 * top-level `<form enctype="text/plain">` can be shaped to post a valid JSON body,
 * `readBody` never inspected `Content-Type`, and `SameSite=Strict` does not stop a
 * cookie being STORED from a top-level response (only from being SENT cross-site).
 * An attacker could therefore plant THEIR OWN account's enrollment session in a
 * victim's browser and walk the victim through onboarding — connecting the victim's
 * mailbox to the attacker's account.
 *
 * Three checks, all on headers a cross-site browser request cannot forge:
 *  - `Content-Type` must be `application/json` whenever a body is present (or a type
 *    is declared at all). Kills every form encoding, which is the only way a
 *    cross-site request can carry a body without CORS preflight.
 *  - `Sec-Fetch-Site`, when the browser sends it, must be same-origin / same-site.
 *  - `Origin`, when present, must be ONE OF the configured browser origins. The list has
 *    more than one entry because the product and the admin console are first-party
 *    surfaces of the same deployment. This is a cross-SITE guard, not the WebAuthn
 *    ceremony binding — a ceremony is additionally pinned to the single origin that
 *    opened it.
 * Native clients send no `Origin` and no `Sec-Fetch-*`, so they are unaffected — and
 * they cannot be victims of CSRF in the first place.
 */
export const withRequestGuard: Middleware = (next) => async (req, deps, params) => {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return next(req, deps, params);

  const declared = req.headers.get("content-type");
  if (declared !== null || req.body !== null) {
    const mime = (declared ?? "").split(";")[0]!.trim().toLowerCase();
    if (mime !== "application/json") {
      return errorResponse("unsupported_media_type", 415, "request body must be application/json");
    }
  }

  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "same-site") {
    return errorResponse("cross_site_denied", 403, "cross-site request rejected");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(deps.authConfig, origin)) {
    return errorResponse("cross_site_denied", 403, "cross-site request rejected");
  }
  return next(req, deps, params);
};

/**
 * Outermost: assign a request id if none was injected, and BIND IT to the logger.
 *
 * The binding is the half that was missing for a long time. `requestId` has existed on
 * `ApiDeps` from the start and was returned to the client in `x-request-id`, but nothing
 * downstream ever wrote it to a log — so the id a user could quote back selected exactly
 * zero lines. Every logger reachable from a handler now carries it, because it is bound
 * once, here, above everything.
 */
export const withRequestId: Middleware = (next) => async (req, deps, params) => {
  deps.requestId = deps.requestId || randomUUID();
  deps.logger = (deps.logger ?? silentLogger).child({ requestId: deps.requestId });
  return next(req, deps, params);
};

/**
 * Map thrown `ServiceError`s to the `{ error }` envelope; anything else → 500 internal.
 *
 * ── AND LOG THE 500s ─────────────────────────────────────────────────────────────────────
 * This catch used to swallow every unexpected throw into an opaque `{"error":{"code":
 * "internal"}}` with no trace anywhere. The hosted API host has a structured log line for
 * failures that escape the pipeline entirely — but the ones this middleware handles are the
 * COMMON case (anything a service throws that is not a `ServiceError`), and those were
 * invisible. A 500 nobody can see is the API-side twin of the webhook nobody noticed.
 *
 * The line follows the same sanitisation rule as the host's: METHOD, PATH, error CLASS and
 * error CODE. Never the message (a driver's carries the connection string, a `postgres`
 * error carries the failing query) and never the query string (it can carry a token). If
 * class + code + route is not enough to reproduce, the fix is a test, not a fuller log line.
 *
 * `ServiceError`s are logged at `warn` and only above 499: they are the API working as
 * designed — a 404 or a 403 is not an incident — but a 5xx a service raised deliberately
 * still needs to be visible.
 */
/**
 * How long a refused caller is told to wait. Long enough that a retry does not land back inside
 * the same congestion window it was just refused in — the failure this answers lasted twenty
 * minutes, and a one-second retry would have been indistinguishable from a client-side denial of
 * service against the instance it was queued on — and short enough that a momentary blip costs
 * one visible pause rather than a dead request.
 */
const DB_BUSY_RETRY_AFTER_SECONDS = 5;

/**
 * The error class name `@trafficflow/db`'s `DbAcquireTimeoutError` carries.
 *
 * SPELLED, not imported, and the reason is the closure rule at the top of
 * `packages/db/src/index.ts`: the class lives in `client.ts`, which is reachable only from
 * `@trafficflow/db/cloud`, and `client.ts` names the COMBINED schema. `packages/api` ships inside
 * the desktop engine's import closure, so an import here would put every Cloud table into a
 * shipped .app — the exact defect that rule was written for, and it would compile and pass every
 * test on the way in.
 *
 * `test/db-busy.test.ts` imports the real class and asserts this string still names it, so a
 * rename is a red test rather than a silent return to the 60 s gateway timeout.
 */
const DB_ACQUIRE_TIMEOUT_ERROR = "DbAcquireTimeoutError";

/**
 * The pooled handle gave up waiting for a connection — see `POOLED_ACQUIRE_TIMEOUT_MS`.
 *
 * Matched on `name` rather than `instanceof` for the import reason above, and matched at all
 * because the alternative answer is a 500: this is not an unhandled fault, it is the API
 * declining work it has no connection to do.
 */
function isDbBusy(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { name?: unknown }).name === DB_ACQUIRE_TIMEOUT_ERROR;
}

export const withErrorEnvelope: Middleware = (next, route) => async (req, deps, params) => {
  try {
    return await next(req, deps, params);
  } catch (err) {
    const log = deps.logger ?? silentLogger;
    /**
     * 503, FAST, BEFORE THE `ServiceError` BRANCH AND BEFORE THE 500.
     *
     * The instance's database connection was busy with something else for the whole ceiling, so
     * this statement never began. Without this branch the throw lands in the `internal` 500 below,
     * which is worse than useless here: it reports a fault in the route to an operator whose
     * actual problem is connection contention, and it names no cause anything can be alerted on.
     *
     * `retryable: true` is a claim about what the CLIENT should do, not about whether the
     * statement reached the server — a pipelined statement may still run (see
     * `DbAcquireTimeoutError`), exactly as one does today when the platform kills the invocation
     * at 60 s instead. Retrying is right, and `Idempotency-Key` is what makes a mutation's retry
     * safe; that was already true and this changes none of it. What changes is that the ambiguous
     * window shrinks from 60 s to the ceiling, and carries a name.
     *
     * `warn`, not `error`. One refusal is this ceiling WORKING; the incident is the RATE of them,
     * which is a threshold question rather than a per-request one.
     */
    if (isDbBusy(err)) {
      log.warn("request_db_busy", {
        method: req.method, route: route.pattern, status: 503, code: "db_busy",
      });
      return errorResponse(
        "db_busy", 503,
        "the server could not get a database connection in time; retry shortly",
        undefined, true,
        { "Retry-After": String(DB_BUSY_RETRY_AFTER_SECONDS) },
      );
    }
    if (err instanceof ServiceError) {
      if (err.httpStatus >= 500) {
        log.error("request_failed", {
          method: req.method, route: route.pattern, status: err.httpStatus, code: err.code, err,
        });
      }
      return errorResponse(err.code, err.httpStatus, err.message, err.details, err.retryable);
    }
    log.error("request_unhandled", { method: req.method, route: route.pattern, status: 500, err });
    return errorResponse("internal", 500, "internal error");
  }
};

/**
 * Resolve the session token (cookie or bearer) and attach `deps.session`; 401 on
 * protected routes with none.
 *
 * Then enforce SCOPE, structurally, for every route at once — an
 * enrollment-scoped session is a password-only credential and must not be usable as
 * an identity outside the enrollment surface:
 *  - `enrollmentOk` route → admitted (that is the whole enrollment surface).
 *  - protected route without the flag → **403 `enrollment_incomplete`**. Not 401:
 *    the credential is valid and the caller IS authenticated, it is the privilege
 *    that is missing, and a client must not react by discarding a session that only
 *    needs a passkey to become useful.
 *  - public route without the flag → the session is DROPPED (`deps.session = null`)
 *    and the request proceeds anonymously. Two reasons: a stale enrollment cookie
 *    must not 403 a fresh `POST /auth/login` (that is the re-entry path), and
 *    `GET /oauth/authorize` is `public` yet mints a native authorization code from
 *    `ctx.userId` — dropping the identity turns that into the 401 it must be
 *    instead of a password-only escalation to full bearer tokens.
 */
export const withSession: Middleware = (next, route) => async (req, deps, params) => {
  const token = readSessionToken(req, deps.allowCookieAuth !== false);
  if (token) {
    const core = await resolveSession(deps.db, token.value, deps.now());
    if (core) deps.session = { ...core, via: token.via };
  }
  if (deps.session?.scope === "enrollment" && !route.options?.enrollmentOk) {
    if (!route.options?.public) {
      return errorResponse("enrollment_incomplete", 403, "finish two-factor enrollment before using this endpoint");
    }
    deps.session = null;
  }
  if (!route.options?.public && !deps.session) {
    return errorResponse("unauthorized", 401, "authentication required");
  }
  return next(req, deps, params);
};

/**
 * Enforce a recent 2FA on step-up routes: null / stale `lastTwofaAt` → 403.
 *
 * ── NO SESSION AT ALL IS A 401, NOT A 403, AND THAT SPLIT IS NEW ────────────────────────────
 *
 * It used to answer 403 for a missing session too, and on every route that existed at the time
 * the branch was unreachable: `stepUp` implied `!public`, so `withSession` had already returned
 * 401 before this middleware ran. `GET /oauth/authorize` is the first route that
 * is BOTH `public` and `stepUp` — it has to be `public`, because an enrollment-scoped cookie
 * must be DROPPED rather than 403'd on the way in — so the branch became reachable and its
 * answer became wrong.
 *
 * Wrong in a way that matters twice. It would have told an anonymous caller to "step up", which
 * it cannot do, instead of to authenticate; and `withSession` has an argument riding on the 401
 * (`"dropping the identity turns that into the 401 it must be instead of a password-only
 * escalation to full bearer tokens"`) which a 403 here would have quietly overturned, along with
 * the `enrollment-flow.test.ts` case that asserts it.
 *
 * On every protected step-up route this changes nothing at all, because `withSession` still
 * answers first and this branch stays unreachable there.
 */
export const withStepUp: Middleware = (next, route) => async (req, deps, params) => {
  if (route.options?.stepUp) {
    const s = deps.session;
    if (!s) return errorResponse("unauthorized", 401, "authentication required");
    const withinWindow =
      s.lastTwofaAt != null && deps.now().getTime() - s.lastTwofaAt.getTime() <= deps.authConfig.stepUpWindowMs;
    if (!withinWindow) return errorResponse("step_up_required", 403, "recent two-factor authentication required");
  }
  return next(req, deps, params);
};

/**
 * **An unverified account must not be able to generate meaningful cost.**
 * Every route declares what it causes ({@link CostClass}); this refuses the ones that spend.
 *
 * ## DEFAULT-DENY, and why the predecessor was not
 *
 * This began as an opt-IN boolean route flag, and two of 124 routes carried it. The
 * shape is the defect, not the count: a flag a route has to REMEMBER is a flag route 125 will
 * not have, and the two it protected were chosen by whoever happened to be thinking about money
 * that afternoon. It left `POST /mailboxes/:id/resync`, `POST /messages/:id/draft` (model
 * inference), `POST /drafts/:id/send` (SMTP) and every attachment fetch (IMAP) open to an
 * account that had proven nothing.
 *
 * Now the question is asked of every route and the strict answer is the default:
 * `unverifiedMayReach(route.cost)` is `false` for an absent, misspelled or new class as much as
 * for `paid`. `Route.cost` is a REQUIRED field, so the ordinary way to get here — adding a route
 * — is a compile error rather than a silent hole; this branch is the floor beneath that for the
 * cases the compiler never sees (a cast, a JavaScript caller, or a synthetic route declared in
 * a test — this package's main `tsconfig` includes `src` only, so an ordinary test file is not
 * typechecked).
 *
 * ## It judges a SESSION, not a request
 *
 * No session ⇒ pass through. That is not a hole and it is deliberate: `withSession` has already
 * decided whether an anonymous caller may be here at all, and an anonymous caller is not an
 * ACCOUNT — the rule above is about what an account can do before it has proven its address. The
 * routes an anonymous caller can reach that genuinely spend (`POST /auth/register`,
 * `POST /waitlist`) are limited per IP and per recipient, which is the only control that can
 * apply to somebody with no identity at all.
 *
 * ## What stays reachable, and why refusing a READ would be theatre
 *
 * `unauthenticated`, `ceremony` and `read` pass. The first two are argued on {@link CostClass}.
 * The third is the one worth defending: a 403 costs the same serverless invocation as the read
 * it refuses, so gating reads cannot take a cent off a hostile poller's bill — it can only break
 * the legitimate client. The control for invocation cost is an edge rate limit, which this
 * deployment does not have and which is tracked separately.
 *
 * ## Ordering, and why 403 rather than 402/401
 *
 * It runs AFTER `withStepUp`, so a caller missing both a recent factor and a verified address is
 * told about the factor first — the step-up is the cheaper thing to fix and the one a client can
 * act on automatically. `withSession` has already rejected an enrollment-scoped session before
 * either, so this only ever judges a full session.
 *
 * 403 and a distinct `email_unverified` code: the credential is valid and the caller IS
 * authenticated (so not 401 — a client must not discard a session that only needs one click to
 * become useful), and nothing is owed us (so not 402, which the mailbox-allowance gate uses for
 * "choose a plan" and which the browser app routes to the plan step).
 *
 * The status is also what keeps the refusal VISIBLE. The browser app retries a failed request
 * after a token refresh for 401 and for 403 `csrf_failed` only, so this 403 is passed through
 * to the caller rather than swallowed by a retry loop — which is why the sentence below is
 * written as an instruction to a person and not as a fault code.
 *
 * `emailVerifiedAt` rides on the resolved session (`resolveSession`'s `users` JOIN), so this
 * middleware costs no query. A deployment whose database predates migration 0023 cannot reach
 * here at all: the `SCHEMA_MARKERS` probe answers `503 schema_incomplete` first, which is
 * deliberate — a missing column must be a loud refusal, never a gate that silently reads
 * "verified" for everybody.
 *
 * ## Whether to require at all is the COMPOSITION'S policy — and absence is REQUIRE
 *
 * `deps.requireVerifiedForProduct` (see its doc on {@link ApiDeps}) lets a composition root
 * state whether this gate applies on its deployment: the hosted service says `true` out loud,
 * an operator-run standalone server may say `false` (its mailbox adds present an IMAP
 * credential, which proves more about mailbox ownership than a verification mail does, and its
 * accounts legitimately arrive unverified through a pairing invite). The comparison below is
 * `!== false`, DELIBERATELY, and not `=== true` or a `??` default: only the exact boolean
 * `false` relaxes, so an absent field, a garbage value and every future container that never
 * heard of the policy all get the strict gate. A gate whose absence-of-config branch is the
 * permissive one is a misconfiguration that presents as working, which this repository has
 * paid for before.
 */
export const withSpendGate: Middleware = (next, route) => async (req, deps, params) => {
  if (deps.requireVerifiedForProduct !== false
    && deps.session && deps.session.emailVerifiedAt == null && !unverifiedMayReach(route.cost)) {
    return errorResponse(
      "email_unverified", 403,
      "Confirm your email address first. We sent a link when you signed up — " +
      "open it, or ask for a new one, and then try again.",
    );
  }
  return next(req, deps, params);
};

/**
 * CSRF on unsafe + cookie-authenticated requests. Bearer callers are exempt: a bearer token is
 * something a caller TYPED, never ambient authority a browser attaches on its own.
 *
 * ── THE TOKEN IS CHECKED AGAINST THE SESSION, NOT AGAINST ITSELF ──────────────────────────
 *
 * This asked one question — is the `tf_csrf` cookie equal to the `X-CSRF-Token` header — and any
 * pair of equal values answered it. The token was never bound to the session presented with it,
 * so an attacker who could put a value in BOTH places passed.
 *
 * They can. `tf_session` is host-only by design and cannot be widened, but `tf_csrf` is a
 * different cookie: script on an allow-listed same-site sibling origin sets
 * `tf_csrf=A; Domain=ohmail.app`, the browser then sends both copies, `parseCookies` keeps the
 * last (the tossed one), and the sibling posts with `X-CSRF-Token: A`. The victim's session
 * cookie rides along as ambient authority and a mutating route runs — send a draft, move mail,
 * delete it — with a token that was never minted for that session.
 *
 * So the EXPECTED value is recomputed from the session token this request actually presented
 * (`csrfTokenFor`), and both the header and the cookie must equal it. A tossed cookie now
 * matches nothing. `via === "cookie"` is what guarantees `tf_session` is the credential in play,
 * so the derivation subject is exactly the session being protected.
 *
 * ── CONSTANT-TIME, AND WHY IT IS WORTH THE THREE LINES ────────────────────────────────────
 *
 * `!==` on strings gives no timing guarantee, and this value is now DERIVABLE from a secret
 * (the access token) rather than merely random — so a byte-at-a-time oracle on an allowed origin
 * would recover a token that authorises mutations. `timingSafeEqual` costs nothing here and
 * removes the question. Length is compared first, outside the constant-time path, because
 * `timingSafeEqual` throws on unequal lengths and the length of a digest is not a secret.
 */
export const withCsrf: Middleware = (next) => async (req, deps, params) => {
  if (UNSAFE_METHODS.has(req.method.toUpperCase()) && deps.session?.via === "cookie") {
    const cookies = parseCookies(req.headers.get("cookie"));
    const presented = cookies["tf_csrf"];
    const header = req.headers.get("x-csrf-token");
    const sessionToken = cookies["tf_session"];
    const failed = errorResponse("csrf_failed", 403, "csrf validation failed");
    if (!presented || !header || !sessionToken) return failed;
    const expected = csrfTokenFor(sessionToken);
    if (!sameToken(header, expected) || !sameToken(presented, expected)) return failed;
  }
  return next(req, deps, params);
};

/** Constant-time string compare. Unequal lengths are refused before the comparison. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The canonical query representation that goes into the request hash.
 *
 * The hash used to be `method \n path \n body` only, which quietly asserted that no
 * idempotent route will ever depend on its query string. That assertion is not enforceable
 * anywhere and would fail silently: the first idempotent route to read a query parameter
 * would replay one request's response for a DIFFERENT request. Including the query closes
 * that by construction.
 *
 * Canonical means SORTED by key then value, and re-encoded by `URLSearchParams`, so
 * `?b=2&a=1` and `?a=1&b=2` — the same request by every HTTP semantic — hash identically
 * and a retry from a client that orders its parameters differently is not a 409.
 */
export function canonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()];
  if (params.length === 0) return "";
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return new URLSearchParams(params).toString();
}

/**
 * Idempotency. On an idempotent route carrying `Idempotency-Key`:
 *  - hash `method\npath\ncanonicalQuery\nrawBody`;
 *  - a stored (unexpired) row with the SAME hash → replay it verbatim (status + body + X-Sync-Seq);
 *  - a stored row with a DIFFERENT hash → 409 idempotency_replay;
 *  - none → expose `deps.idempotency` so the handler's service CLAIMS the row IN its tx.
 *
 * The store is the handler's responsibility and MUST run inside the SAME `db.transaction`
 * as the mutation. There is deliberately NO post-hoc net here: a middleware-side store
 * over `deps.db` (autocommit) would reopen the very commit-then-crash window this closes
 * (mutation commits, then the process dies before the separate idempotency insert → the
 * retry re-executes). Consequence: every idempotent route MUST carry a replay test.
 *
 * ## The concurrent case, which the lookup alone cannot cover
 *
 * The lookup above runs in autocommit BEFORE any transaction opens, so two simultaneous
 * invocations of the same key both miss it. That is not a rare interleaving on a serverless
 * host — it is what a double-tap or a client retrying a request whose response was lost
 * looks like. Both would then apply their effect, and the loser's `ON CONFLICT DO NOTHING`
 * insert used to vanish silently while its transaction committed anyway: two workflow runs,
 * two promoted rules, two different responses for one key.
 *
 * So the service's claim is now authoritative and a LOST claim throws
 * {@link IdempotencyRaceLost}, rolling the loser's effect back. This middleware catches it
 * and answers with the WINNER's stored response — the same status, the same body, the same
 * `X-Sync-Seq` the first request got. Exactly one effect, two identical answers, and no
 * spurious 409 (a 409 is reserved for a genuinely DIFFERENT request reusing a key).
 */
export const withIdempotency: Middleware = (next, route) => async (req, deps, params) => {
  if (!route.options?.idempotent) return next(req, deps, params);
  const key = req.headers.get("idempotency-key");
  if (!key) return next(req, deps, params);
  const accountId = deps.session?.accountId;
  if (!accountId) return next(req, deps, params); // protected routes are already 401'd by withSession

  const url = new URL(req.url);
  const rawBody = await req.clone().text();
  const requestHash = sha256(
    `${req.method}\n${url.pathname}\n${canonicalQuery(url)}\n${rawBody}`,
  ).toString("hex");

  const replay = (found: StoredIdempotent): Response =>
    found.requestHash !== requestHash
      ? errorResponse("idempotency_replay", 409, "idempotency key reused with a different request")
      : jsonResponse(found.responseJson, { status: found.responseStatus, seq: found.seq ?? undefined });

  const found = await lookupIdempotent(deps.db, accountId, key, deps.now());
  if (found) return replay(found);

  deps.idempotency = { key, requestHash };
  try {
    return await next(req, deps, params);
  } catch (err) {
    if (!(err instanceof IdempotencyRaceLost)) throw err;
    // The winner committed while we were mid-flight; our own effect has rolled back.
    const winner = await lookupIdempotent(deps.db, accountId, key, deps.now());
    // No winner readable means the row is not there after all — a real fault, not a race.
    // Rethrow so it becomes a 500 rather than a fabricated success.
    if (!winner) throw err;
    return replay(winner);
  }
};
