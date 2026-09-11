import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ServiceError, IdempotencyRaceLost, resolveSession, sha256, isAllowedOrigin,
} from "@trafficflow/services/mail";
import { silentLogger } from "@trafficflow/core/mail";
// The reader refusal, from the package that throws it — see the envelope arm below for why it
// cannot live beside `ServiceError`.
import { csrfTokenFor } from "./csrf.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { lookupIdempotent, type StoredIdempotent } from "./idempotency.js";
import type { ApiDeps, SessionVia } from "./deps.js";
import { accessRefusedMayReach, unverifiedMayReach } from "./router.js";
import { accessFor } from "./routes/shared.js";
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
 * Read the session token from a Bearer header (native) or the `tf_session` cookie (web). The
 * explicit credential wins: a cookie is sent whether or not anyone meant to send it, a header is
 * something a caller typed — when both arrive naming different users, honouring the ambient one
 * authenticates the request as somebody the caller did not ask to be. The browser app's edge gate
 * presents the visitor's cookie value as a bearer on a server-side `GET /auth/session`;
 * header-first is what makes that call mean what it says. `via` is `"cookie"` only when the
 * cookie authenticated, so `withCsrf` fires exactly when it should. `allowCookie === false` makes
 * the deployment bearer-only — the cookie is not consulted at all.
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
 * Cross-site + media-type guard for every state-changing request. `withCsrf` cannot fire on a
 * `public` route, yet `POST /auth/register` and `POST /auth/login` SET `tf_session` + `tf_csrf` —
 * login CSRF / session fixation: a cross-site `<form enctype="text/plain">` can post valid JSON,
 * and `SameSite=Strict` does not stop a cookie being stored from a top-level response. Three
 * checks on headers a cross-site request cannot forge: `Content-Type` must be `application/json`
 * whenever a body is present; `Sec-Fetch-Site`, when sent, must be same-origin/same-site;
 * `Origin`, when present, must be a configured browser origin. Native clients send neither and
 * are unaffected.
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
 * Map thrown `ServiceError`s to the `{ error }` envelope; anything else → 500 internal — and log
 * the 500s: this catch used to swallow every unexpected throw into an opaque envelope with no
 * trace, and a 500 nobody can see is the API-side twin of the webhook nobody noticed. The line is
 * sanitized: method, path, error class and error code — never the message (a driver's carries the
 * connection string, a `postgres` error the failing query) and never the query string (it can
 * carry a token). `ServiceError`s are logged at `warn` and only above 499: a 404 is the API
 * working as designed, but a deliberate 5xx still needs to be visible.
 */
/**
 * How long a refused caller is told to wait — and what it does not do: our own clients ignore it.
 * `HttpAdapter.rejectionOf()` reads the JSON body and the status, `MutationRejectedError` has no
 * retry-delay field, and `fetch` applies `Retry-After` to nothing, so a refused sync comes back
 * on its existing 250–1000 ms backoff, not in five seconds. The header is still correct — it is
 * what the HTTP contract says a 503 carries, and monitors, proxies and non-product clients honour
 * it — but the synchronized-retry problem is not solved until the engine's schedulers read it,
 * which is a change to the published desktop payload.
 */
const DB_BUSY_RETRY_AFTER_SECONDS = 5;

/** Methods with no side effect of their own, for which a retry cannot duplicate anything. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * May the client retry this one — asked per request. A refused statement was already written to
 * the socket and is not cancelled (`packages/db/src/client.ts`), so Postgres will normally still
 * run it: for a write, the effect may have landed while the caller was told 503. Retryable for a
 * safe method, or for a keyed request on a route that is actually `idempotent`-marked — both
 * halves load-bearing: the engine keys every queued mutation, but `withIdempotency` only acts
 * where the route opted in, so trusting the header would promise deduplication the server never
 * performs. Otherwise explicitly `false`: the client's fallback is `retryable ?? (status >=
 * 500)`, and a write that silently happens twice is the worse trade.
 */
function mayRetry(
  req: Request,
  // RESOLVED booleans, not the optional-field interface: `dbBusyResponse` narrows the caller's
  // partial knowledge to definite values first, so "absent" cannot reach here still meaning
  // "unknown" and then be read as permissive by accident.
  protection: { routeIsIdempotent: boolean; hasAccount: boolean; routeRequiresSession: boolean },
): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  /**
   * Nothing ran — asked first, before idempotency, because it is a different question. On a
   * protected route a resolved session is a precondition: "protected, and no account resolved"
   * means the refusal happened while `withSession` was still resolving the token — the first
   * database query on every authenticated request, and the likeliest to be starved. Neither the
   * handler nor `withIdempotency` can have run, so a retry is safe whatever the route's
   * idempotency marking. Ordering this after the idempotency gates was a real defect: a starved
   * session lookup on a queued `tag_create` fell through to `false`, and the engine answers
   * `false` by rolling the overlay back and dropping the outbox row.
   */
  if (protection.routeRequiresSession && !protection.hasAccount) return true;

  /**
   * Past here the handler may have run, so only real deduplication makes a retry safe — and these
   * are the same three conditions `withIdempotency` itself checks, in the same order, so this
   * answers "will a replay actually be deduplicated" rather than approximating it.
   * `req.headers.has("Idempotency-Key")` was that approximation and was wrong twice: an empty key
   * satisfies `has()` while `withIdempotency` skips it, and a request with no resolved account is
   * skipped on the next line for the same reason.
   */
  if (!protection.routeIsIdempotent) return false;
  if ((req.headers.get("idempotency-key") ?? "") === "") return false;
  /**
   * And `hasAccount` alone would throw the mutation away: the session resolve is the first
   * database query on every authenticated request, so if the ceiling fires there, `deps.session`
   * is unassigned and `hasAccount` is false — and the engine treats a non-retryable rejection as
   * an explicit refusal, rolling the mutation back and dropping the outbox row.
   * `routeRequiresSession` closes it without weakening anything: on a protected route both states
   * are safe — the session resolved (so `withIdempotency` ran and a replay is deduplicated) or it
   * did not (so nothing ran at all). What is left at `false` is an `idempotent` public route
   * resolving no session, for which `withIdempotency` short-circuits on its `accountId` guard.
   */
  return protection.hasAccount;
}

/**
 * What the caller knows about whether a replay of THIS request would actually be deduplicated.
 * Both fields default to the pessimistic value; see {@link dbBusyResponse}.
 */
export interface IdempotencyProtection {
  /** The matched route carries `options.idempotent`. */
  routeIsIdempotent?: boolean;
  /** A session was resolved — `withIdempotency` needs an `accountId` and skips without one. */
  hasAccount?: boolean;
  /**
   * The route is PROTECTED, so `withSession` would have answered 401 rather than run the handler
   * without a session. On such a route a refusal means either the session resolved (and
   * `withIdempotency` applies) or the session query itself was starved (and nothing ran) — both
   * safe to retry. See { mayRetry}.
   */
  routeRequiresSession?: boolean;
}

/**
 * The one construction of the busy answer, so every pipeline and host gives the same one.
 *
 * Everything defaults to NOT PROTECTED, because the caller that can supply none of it is the
 * host's backstop (`apps/api-vercel/src/handler.ts`), which catches throws that escaped the router
 * and therefore has neither a route nor a resolved session in hand. Not knowing must mean "do not
 * invite a retry" — the safe direction — rather than the permissive one.
 */
export function dbBusyResponse(
  req: Request, protection: IdempotencyProtection = {},
): Response {
  const known = {
    routeIsIdempotent: protection.routeIsIdempotent === true,
    hasAccount: protection.hasAccount === true,
    routeRequiresSession: protection.routeRequiresSession === true,
  };
  return dbBusyResponseFor(req, known);
}

function dbBusyResponseFor(
  req: Request,
  protection: { routeIsIdempotent: boolean; hasAccount: boolean; routeRequiresSession: boolean },
): Response {
  return errorResponse(
    "db_busy", 503,
    // Says what happened, and says it accurately. NOT "could not get a connection": it had one —
    // the connection was busy with other work and this statement never began. The distinction is
    // the whole diagnosis, and a message that blurs it would send the next reader looking for a
    // connection leak.
    "the server's database connection was busy and this request could not be started; retry shortly",
    undefined, mayRetry(req, protection),
    { "Retry-After": String(DB_BUSY_RETRY_AFTER_SECONDS) },
  );
}

/**
 * The error class name `@trafficflow/db`'s `DbAcquireTimeoutError` carries. Spelled, not
 * imported: the class lives in `client.ts`, reachable only from `@trafficflow/db/cloud`, which
 * names the combined schema — and `packages/api` ships inside the desktop engine's import
 * closure, so an import here would put every Cloud table into a shipped .app while compiling and
 * passing every test. `test/db-busy.test.ts` imports the real class and asserts this string still
 * names it, so a rename is a red test rather than a silent return to the 60 s gateway timeout.
 */
const DB_ACQUIRE_TIMEOUT_ERROR = "DbAcquireTimeoutError";

/**
 * The pooled handle gave up waiting for a connection — see `POOLED_ACQUIRE_TIMEOUT_MS`.
 *
 * Matched on `name` rather than `instanceof` for the import reason above, and matched at all
 * because the alternative answer is a 500: this is not an unhandled fault, it is the API
 * declining work it has no connection to do.
 */
export function isDbBusy(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { name?: unknown }).name === DB_ACQUIRE_TIMEOUT_ERROR;
}

/**
 * The two organizer refusals `@trafficflow/db` throws, by name — {@link
 * DB_ACQUIRE_TIMEOUT_ERROR}'s rule applied to the second family that reached this file from that
 * package. `organizer-role.ts` lives in `@trafficflow/db` because the dependency cannot run the
 * other way; naming its entry point from here is what breaks the closure, so the refusal is
 * matched the way the timeout above is. `test/db-busy.test.ts` imports the real classes and
 * asserts these strings still name them.
 */
const ORGANIZER_REFUSAL_ERRORS = ["OrganizedElsewhereError", "MailboxNotFoundError"] as const;

/**
 * A refusal thrown by the organizer-role helper, structurally: it carries the same `code`,
 * `httpStatus` and `message` a `ServiceError` does, which is what lets one arm answer both.
 *
 * The SHAPE is checked as well as the name. A name match alone would hand `errorResponse` an
 * `undefined` status from anything that happened to be called `MailboxNotFoundError` — and this
 * middleware's whole job is that an unrecognised throw becomes a 500 rather than a malformed 200.
 */
export function isOrganizerRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; httpStatus?: unknown };
  return (ORGANIZER_REFUSAL_ERRORS as readonly string[]).includes(String(e.name))
    && typeof e.code === "string" && typeof e.httpStatus === "number";
}

/**
 * The class name of a thrown value — `String` for a thrown primitive, `null`/`undefined` for
 * those. Never the message: a driver's message quotes connection strings and an application's
 * quotes what a person typed, which is the reversal the instruments lane's item 5 was refused
 * for. `@trafficflow/db`'s `faultClassOf` is the same function; it is duplicated here rather
 * than imported for {@link DB_ACQUIRE_TIMEOUT_ERROR}'s reason — this module is published inside
 * the desktop engine and may not reach that package's entry point.
 */
function faultClassOf(err: unknown): string {
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err !== "object") return err.constructor?.name ?? typeof err;
  const named = (err as { name?: unknown }).name;
  if (typeof named === "string" && named.length > 0) return named;
  return (err as object).constructor?.name ?? "Object";
}

/**
 * HOW LONG A FAULT RECORD MAY DELAY THE ANSWER IT DESCRIBES. One second.
 *
 * The 503 branch below is "503, FAST". Recording through the same pool inherits the 15 s acquire
 * ceiling exactly when it bites, turning a fast refusal into a slow one — so the bound lives
 * here, where the response budget lives, and no port implementation can exceed it.
 *
 * The write is abandoned rather than cancelled: it may land, or be frozen on a serverless host.
 * Best-effort by contract, and the platform poller stays truthful when this arm cannot write.
 */
export const API_FAULT_RECORD_BUDGET_MS = 1_000;

/**
 * Count one 5xx, if this host counts them at all.
 *
 * The port's absence is the local shell's normal state and says nothing; a present port that
 * throws is a hosted board going dark and says so once. See {@link ApiFaultLogPort}.
 */
async function countFault(
  deps: ApiDeps, route: Route, req: Request, status: number, err: unknown,
): Promise<void> {
  const port = deps.faultLog;
  if (!port) return;
  const log = deps.logger ?? silentLogger;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = port.record({
      route: route.pattern, method: req.method, status,
      errorClass: faultClassOf(err),
      requestId: deps.requestId || null,
      at: deps.now(),
    });
    // A rejection AFTER the budget wins the race against nothing, so it must be absorbed here or
    // it becomes an unhandled rejection with no request left to attribute it to.
    write.catch(() => {});
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), API_FAULT_RECORD_BUDGET_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    if (await Promise.race([write.then(() => "wrote" as const), budget]) === "budget") {
      log.warn("api_fault_record_slow", {
        route: route.pattern, status, budgetMs: API_FAULT_RECORD_BUDGET_MS,
      });
    }
  } catch (recordErr) {
    log.warn("api_fault_record_failed", { route: route.pattern, status, err: recordErr });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const withErrorEnvelope: Middleware = (next, route) => async (req, deps, params) => {
  try {
    return await next(req, deps, params);
  } catch (err) {
    const log = deps.logger ?? silentLogger;
    /**
     * 503, fast, before the `ServiceError` branch and before the 500: the instance's database
     * connection was busy for the whole ceiling, so this statement never began — the `internal`
     * 500 below would report a route fault to an operator whose actual problem is connection
     * contention. Whether the answer invites a retry is decided per request by {@link mayRetry}.
     * This middleware is not the whole story, which is why {@link dbBusyResponse} is exported:
     * `RAW_PIPELINE` and `ANONYMOUS_PIPELINE` carry no envelope, so the host applies the same
     * answer as a backstop (`apps/api-vercel/src/handler.ts`). `warn`, not `error`: one refusal
     * is this ceiling working — the incident is the rate of them.
     */
    if (isDbBusy(err)) {
      log.warn("request_db_busy", {
        method: req.method, route: route.pattern, status: 503, code: "db_busy",
      });
      // COUNTED, even though the connection is what just refused us. The write goes through a
      // fresh acquire and will often be refused too — that is honest, not a defect: a refusal
      // this rule never sees is one the pool was too saturated to record, and the platform
      // poller's own 5xx count is the arm that stays truthful there. Recording the ones that DO
      // land is what turns "the pooler is busy" from a log line into `pooler_refusals`.
      await countFault(deps, route, req, 503, err);
      return dbBusyResponse(req, {
        routeIsIdempotent: route.options?.idempotent === true,
        hasAccount: Boolean(deps.session?.accountId),
        routeRequiresSession: route.options?.public !== true,
      });
    }
    /**
     * The refusal every reader door shares (mail 0083). `OrganizedElsewhereError` and
     * `MailboxNotFoundError` are thrown from `@trafficflow/db` and handled here rather than in
     * eleven per-route catches — the forgotten one turns a 409 the client can render into a 500
     * it cannot. `details` carries `{ by: { kind, name, since } }` so every door composes one
     * sentence. Matched by name, not `instanceof`: importing the classes pulls
     * `@trafficflow/db`'s entry point — the combined schema — into the desktop engine's shipped
     * closure. The cost is a rename silently un-mapping the 409, which `db-busy.test.ts` pins by
     * asserting these strings are the classes' real names.
     */
    if (isOrganizerRefusal(err)) {
      const e = err as { code: string; httpStatus: number; message: string; details?: unknown };
      return errorResponse(e.code, e.httpStatus, e.message, e.details);
    }
    if (err instanceof ServiceError) {
      if (err.httpStatus >= 500) {
        log.error("request_failed", {
          method: req.method, route: route.pattern, status: err.httpStatus, code: err.code, err,
        });
        // Gated on the SAME condition as the log line above, so the table and the log can never
        // disagree about what a 5xx was. A 4xx `ServiceError` is the API working and is refused
        // by cloud 0033's own CHECK as well as by this branch.
        await countFault(deps, route, req, err.httpStatus, err);
      }
      return errorResponse(err.code, err.httpStatus, err.message, err.details, err.retryable);
    }
    log.error("request_unhandled", { method: req.method, route: route.pattern, status: 500, err });
    await countFault(deps, route, req, 500, err);
    return errorResponse("internal", 500, "internal error");
  }
};

/**
 * Resolve the session token and attach `deps.session`; 401 on protected routes with none. Then
 * enforce scope structurally — an enrollment-scoped session is a password-only credential: an
 * `enrollmentOk` route admits it; a protected route without the flag answers 403
 * `enrollment_incomplete` (not 401 — the credential is valid, the privilege missing, and a client
 * must not discard a session that only needs a passkey); a public route without the flag drops
 * the session and proceeds anonymously — a stale enrollment cookie must not 403 a fresh login,
 * and `GET /oauth/authorize` mints from `ctx.userId`, so dropping the identity yields the 401 it
 * must be instead of a password-only escalation.
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
 * Enforce a recent 2FA on step-up routes: null or stale `lastTwofaAt` → 403. No session at all is
 * a 401, not a 403: `GET /oauth/authorize` is the first route that is both `public` and `stepUp`
 * (it must be `public` so an enrollment-scoped cookie is dropped on the way in), so the
 * no-session branch became reachable — and a 403 would tell an anonymous caller to step up, which
 * it cannot, and would quietly overturn `withSession`'s argument that dropping the identity
 * yields a 401 rather than a password-only escalation (`enrollment-flow.test.ts` asserts it). On
 * every protected step-up route `withSession` still answers first and this branch stays
 * unreachable.
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
 * An unverified account must not be able to generate meaningful cost. Every route declares a
 * {@link CostClass}; this refuses the ones that spend. Default-deny:
 * `unverifiedMayReach(route.cost)` is `false` for an absent or new class, and `Route.cost` is
 * required, so adding a route is a compile error (this branch is the floor for casts and
 * synthetic routes). No session passes through — the anonymous routes that spend are limited per
 * IP and recipient. `read` stays reachable: a 403 costs the same invocation as the read it
 * refuses. 403 `email_unverified` — not 401 (the credential is valid), not 402 (nothing is owed).
 * `deps.requireVerifiedForProduct !== false`: only the exact boolean `false` relaxes.
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
  /**
   * The access arm — one place, so a refused account meets the same answer at every door. 402 and
   * not 403: the remedy is a payment, and the client renders the lock screen off this status
   * alone. `details` carries the reason and, when the port supplies one, where to go — nothing
   * else, because a refusal is not the place to project an account's billing state. `accessFor`
   * answers `null` on a host that declared no entitlements program and never refuses on a fault,
   * so this arm can only fire on a real verdict. Nothing is deleted, nothing logged out; the
   * doors in `accessRefusedMayReach` stay open.
   */
  if (deps.session && !accessRefusedMayReach(route)) {
    const verdict = await accessFor(deps, deps.session.accountId);
    if (verdict && !verdict.ok) {
      return errorResponse(
        "subscription_required", 402,
        "This account is not active. Your mail and settings are kept — nothing has been deleted.",
        { reason: verdict.reason, ...(verdict.manageUrl ? { manageUrl: verdict.manageUrl } : {}) },
      );
    }
  }
  return next(req, deps, params);
};

/**
 * CSRF on unsafe + cookie-authenticated requests; bearer callers are exempt — a bearer token is
 * typed, never ambient. The token is checked against the session, not against itself: comparing
 * cookie and header alone accepts any pair of equal values, and script on a same-site sibling can
 * plant a parent-domain `tf_csrf` and post the same value in the header. The expected value is
 * recomputed from the session token this request presented (`csrfTokenFor`), and both header and
 * cookie must equal it. Constant-time: the value is derivable from a secret, so `!==` would open
 * a byte-at-a-time oracle; length is compared first because `timingSafeEqual` throws on unequal
 * lengths, and a digest's length is not a secret.
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
 * The canonical query representation that goes into the request hash. The hash used to be `method
 * \n path \n body` only, which quietly asserted that no idempotent route will ever depend on its
 * query string — unenforceable, and the first route to break it would replay one request's
 * response for a different request. Canonical means sorted by key then value and re-encoded by
 * `URLSearchParams`, so `?b=2&a=1` and `?a=1&b=2` hash identically and a retry from a client that
 * orders parameters differently is not a 409.
 */
export function canonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()];
  if (params.length === 0) return "";
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return new URLSearchParams(params).toString();
}

/**
 * Idempotency. On an idempotent route carrying `Idempotency-Key`: hash
 * `method\npath\ncanonicalQuery\nrawBody`; the same stored hash replays verbatim; a different
 * hash is 409 `idempotency_replay`; none exposes `deps.idempotency` so the handler's service
 * claims the row in its tx — inside the same `db.transaction` as the mutation (autocommit reopens
 * the commit-then-crash window), so every idempotent route carries a replay test. Concurrency:
 * the lookup runs before any transaction, so two simultaneous invocations both miss it; the claim
 * is authoritative, a lost claim throws {@link IdempotencyRaceLost} rolling the loser back, and
 * the middleware answers with the winner's stored response.
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
