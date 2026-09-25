import type { ApiDeps } from "./deps.js";
import { matchSpec, type RouteParams } from "./match-path.js";
/* TYPE ONLY, and that is load-bearing: `middleware.ts` imports values from this module, so a
   value import back would be a runtime cycle. `import type` is erased, so the graph is unchanged
   and nothing new enters any bundle. */
import type { Middleware } from "./middleware.js";

/* Re-exported so every existing consumer of this module keeps its import. */
export { matchSpec, type RouteParams };

export type Handler = (req: Request, deps: ApiDeps, params: RouteParams) => Promise<Response>;

/**
 * What does this handler cause? Every route declares it, and the declaration is what
 * `withSpendGate` judges an unverified account against. The invariant: an unverified account must
 * not generate meaningful cost, hosting included — so the classification is about the effect of
 * the handler, not its verb or path. A required field, not an option: the predecessor was an
 * opt-in boolean carried by two of 124 routes. It sits on {@link Route} itself where omitting it
 * is a compile error (the route table lives under `src`, which this package's tsconfig
 * typechecks), and `withSpendGate` also fails closed at runtime for the casts and synthetic
 * routes the compiler never sees.
 */
export type CostClass =
  /**
   * The route's authority comes from something other than a user session — a shared secret
   * (`/admin/*`, `/internal/alerts*`), a provider signature (`POST /billing/webhook`), or
   * nothing at all (`GET /health`, `POST /waitlist`). No account is being served, so there is
   * no verification state to judge. Every one of these is `public`, and the ones that resolve
   * no session at all are additionally `anonymous`; a census test asserts both
   * directions, because ANONYMOUS_PIPELINE never populates `deps.session` and the middleware
   * therefore cannot be the fence there.
   */
  | "unauthenticated"
  /**
   * The identity lifecycle: entering, proving, extending and leaving. Reachable before
   * verification by construction — this is the only path out of the unverified state, and two of
   * its exits must hold even for somebody who can never verify (a mistyped address still holds a
   * session and must be able to revoke a credential and leave under Art. 17). Some of these
   * spend: register and resend send mail, controlled by a different mechanism — the per-recipient
   * `unsolicited` quota and the per-IP `verify:ip` limiter — because verification cannot be the
   * control on the route that produces verification. A new `ceremony` route that sends mail owes
   * its own quota; the frozen census over this class is where its author notices.
   */
  | "ceremony"
  /** Reads rows already stored for the caller's own account, and writes nothing. */
  | "read"
  /**
   * Writes, or enqueues work the WORKER will perform against the user's real IMAP server.
   * `POST /mailboxes` is the extreme of this class rather than an exception to it: the API
   * only stores an encrypted credential, and what that credential buys is a persistent
   * connection and a full sync of somebody's mailbox.
   */
  | "work"
  /**
   * THIS PROCESS holds a connection open for the caller: an IMAP or SMTP socket it opens
   * (`GET /attachments/:id`, `POST /drafts/:id/send`), or a stream it keeps alive with a poll
   * loop behind it (`GET /events`). `GET /img` is the third shape — a remote URL fetched on
   * the reader's behalf, against a host the SENDER named.
   */
  | "connection"
  /**
   * Calls a metered third party for this account: model inference (`POST /messages/:id/draft`)
   * or Stripe (`POST /billing/checkout`, `POST /billing/portal`).
   */
  | "paid";

/** The classes an account with an UNPROVEN address may reach. Everything else is refused. */
export const UNVERIFIED_MAY_REACH: ReadonlySet<CostClass> =
  new Set<CostClass>(["unauthenticated", "ceremony", "read"]);

/**
 * The doors that stay open to a refused account — the classes, and the one route outside them.
 * When the entitlements port refuses an account, the app renders a lock screen; three things must
 * still work from inside it or it is a trap: signing out and every identity call (`ceremony`),
 * leaving under Art. 17 (`DELETE /account`, also `ceremony`), and the way back to paying — `POST
 * /account/manage-link`, a `paid` route and therefore the one door this set names explicitly.
 * `unauthenticated` is here because it serves no account at all, so there is no verdict to judge.
 */
export const ACCESS_REFUSED_MAY_REACH: ReadonlySet<CostClass> =
  new Set<CostClass>(["unauthenticated", "ceremony"]);

/**
 * `<METHOD> <pattern>` of every route reachable while refused DESPITE its cost class.
 * `GET /account/access` is the wall reading itself (`read`); `GET /consent` (`read`) is the
 * pairing-consent read — the shared shell's first question, and a paired desktop that cannot ask
 * it renders a spinner instead of the wall. `GET /account/export` (`read`) is the way out with
 * your configuration — leave-anytime is not suspended by a lapsed subscription.
 */
export const ACCESS_REFUSED_MAY_REACH_ROUTES: ReadonlySet<string> =
  new Set<string>([
    "POST /account/manage-link",
    "GET /account/access",
    "GET /account/export",
    "GET /consent",
  ]);

/**
 * True iff a refused account may still reach this route. Takes the route so the pattern
 * exception is decided in one place; fails CLOSED on an unrecognised cost, exactly as
 * {@link unverifiedMayReach} does — except that "closed" here means the lock screen, which is
 * reachable and reversible, rather than anything destructive.
 */
export function accessRefusedMayReach(route: { method: string; pattern: string; cost: unknown }): boolean {
  if (ACCESS_REFUSED_MAY_REACH_ROUTES.has(`${route.method.toUpperCase()} ${route.pattern}`)) return true;
  return typeof route.cost === "string" && ACCESS_REFUSED_MAY_REACH.has(route.cost as CostClass);
}

/**
 * HOW THE ACCESS ARM MAY ANSWER A ROUTE. A `read` — a GET whose class writes nothing — may answer
 * on a held allow while the verdict is re-read behind it; a `write` waits for the answer. `null`
 * is a class this table does not know: the gate waits on it, and the census refuses it by name.
 * Keyed on the class, so a new {@link CostClass} does not compile until it is classed here.
 */
export type AccessRouteClass = "read" | "write";

const ACCESS_CLASS_OF_GET: Readonly<Record<CostClass, AccessRouteClass>> = {
  unauthenticated: "write", ceremony: "write", read: "read", work: "write", connection: "write",
  paid: "write",
};

export function accessRouteClassOf(
  route: { method: unknown; cost: unknown },
): AccessRouteClass | null {
  if (typeof route.method !== "string" || typeof route.cost !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(ACCESS_CLASS_OF_GET, route.cost)) return null;
  return route.method.toUpperCase() === "GET"
    ? ACCESS_CLASS_OF_GET[route.cost as CostClass] : "write";
}

/**
 * True iff `cost` is a class an unverified account may reach. Deliberately takes `unknown`:
 * the caller is a middleware reading a field that a JavaScript caller or an un-typechecked
 * test route can leave undefined, and the answer for "no declaration" must be `false`.
 */
export function unverifiedMayReach(cost: unknown): boolean {
  return typeof cost === "string" && UNVERIFIED_MAY_REACH.has(cost as CostClass);
}

/**
 * WHAT A SECOND ARRIVAL OF THIS REQUEST COSTS — declared by every route that spends, beside the
 * `cost` it qualifies, so the author of the next spender writes it where they are typing and a
 * reader of the route can check it. A frozen list in a test file only recorded what somebody
 * once counted. `idempotency-census.test.ts` refuses a spender carrying neither this nor
 * `options.idempotent` — which IS the disposition where it is set (the middleware replays a
 * stored response, the service claims the key in its own transaction) — and refuses both.
 */
export type ReplayDisposition =
  /**
   * The handler reads `Idempotency-Key` ITSELF, because the middleware's replay-a-stored-response
   * shape does not fit — a response carrying a signed URL with a lifetime of its own, or a verb
   * that contends on the ROW before it ever reaches the claim.
   */
  | "handler"
  /**
   * The request names a resource and the value it should hold, and a replay reaches the same
   * state: a `PATCH`/`PUT` that sets named fields, a `DELETE` that removes one row, a `POST` that
   * stamps one timestamp on the caller's own row. Nothing is minted and nothing is counted.
   */
  | "state"
  /**
   * A constraint, a predicate or a compare-and-set makes the second arrival a no-op IN THE
   * DATABASE — a UNIQUE the insert resolves on, a `WHERE status = …` the replay no longer
   * matches. The guard is the mechanism, not the key.
   */
  | "guarded"
  /**
   * A replay mints an EQUIVALENT artefact that expires on its own and costs nothing durable — a
   * short-lived link to the caller's own page, an OAuth ceremony row with a consumption stamp. A
   * stored response would be worse than the replay: it would hand back the older, nearer-expiry
   * one.
   */
  | "ephemeral"
  /**
   * A DURABLE ROW PER CALL, with nothing to resolve a second one on. Refused by the census: a
   * route that mints must present a key before the effect. Declarable so the refusal has a
   * reachable state to refuse — a route that really does mint says so and is told to key itself.
   */
  | "mints";

export interface RouteOptions {
  /** Route needs no session; `withSession` populates it if a token is present but never 401s. */
  public?: boolean;
  /** Requires a recent 2FA (`withStepUp`); else 403 step_up_required. */
  stepUp?: boolean;
  /**
   * MIDDLEWARE THIS ROUTE CARRIES, run in its pipeline at the position `app.ts` names.
   *
   * A flag says what a route WANTS and leaves some chain to honour it; a middleware here IS the
   * control and travels with the route into every composition that mounts it. `staffStepUp:
   * boolean` was the flag form, and honouring it made `app.ts` — which the standalone door
   * composes — import the staff routes and the cloud schema: the engine census refused the
   * artifact by name. Managed-service administration lives in the private plane, and a control
   * declared beside its own routes cannot reach a door that mounts none of them.
   */
  middleware?: readonly Middleware[];
  /**
   * The route is part of the 2FA-ENROLLMENT surface, so an enrollment-scoped session
   * is admitted. Absent — the default, and the default for every route in the
   * table — an enrollment session is rejected with 403 `enrollment_incomplete` on a
   * protected route and simply IGNORED (treated as anonymous) on a public one.
   * `withSession` owns that decision; no handler may re-implement it.
   */
  enrollmentOk?: boolean;
  /**
   * Path parameters that are not UUIDs — the opt-out from the shape check applied to every
   * `:param` before any pipeline runs. Absent means validated: a path parameter is a
   * caller-chosen string that reaches a `uuid` column verbatim, so a new `:id` route is covered
   * by code nobody has to remember to call (the opt-in spelling is how `GET /drafts/:id` answered
   * 500 to `/drafts/not-a-uuid` for its whole life). It ships empty, a measured claim: all 78
   * `:id` patterns resolve to a uuid column. Named per parameter, so a route with two params can
   * declare one opaque. `input-bounds-census.test.ts` holds the frozen cross-check in both
   * directions.
   */
  opaqueParams?: readonly string[];
  /** Honors `Idempotency-Key` (`withIdempotency`). */
  idempotent?: boolean;
  /** SSE / oauth-redirect: reduced pipeline — no JSON envelope, no CSRF, no idempotency. */
  raw?: boolean;
  /**
   * This route answers for the credential it resolved, not the session that carried the request —
   * the sign-in, token and pairing routes, whose handler mints a session from a credential in the
   * body. The set is not listed here: a list of route names in a comment is a fact about who last
   * counted; `account-header-census.test.ts` derives the set from the handlers and asserts the
   * flags match. All are `public`, so the handler resolves a second credential out of the body —
   * which must belong to the same account or be refused (`refuseCrossAccountCredential`). The
   * flag changes only where {@link ACCOUNT_HEADER} takes its value; it grants nothing, so
   * carrying it wrongly can only stop naming an account.
   */
  credentialSubject?: boolean;
  /**
   * NO session resolution at all — not even the opportunistic "populate it if a token
   * happens to be present" that `public` still does. `/health` only: a liveness probe must
   * cost exactly one query and must not be able to fail inside `withSession`, outside the
   * handler's own error handling, when the database is the thing that is broken.
   */
  anonymous?: boolean;
}

export interface Route {
  method: string;
  pattern: string;             // e.g. "/threads/merge", "/threads/:id", "/messages/:id/move"
  /**
   * REQUIRED. What this handler causes; see {@link CostClass}. There is no default:
   * a new route that declares nothing does not compile, and if one reaches the runtime
   * anyway (a cast, a JS caller, a synthetic route in an un-typechecked test file)
   * `withSpendGate` refuses it for an unverified account.
   */
  cost: CostClass;
  /**
   * WHAT A SECOND ARRIVAL COSTS — required by the census for every `work`/`paid` route that is
   * not `options.idempotent`, and refused beside it. See {@link ReplayDisposition}.
   */
  replay?: ReplayDisposition;
  /**
   * Required. May a Cloud-mode install's write-through relay forward this route to the server its
   * door names? `false` for a route that resolves a credential out of the request body
   * (`credentialSubject`), for the browser hand-off ceremony, and for the hosted console, intake,
   * back-office, waitlist and OAuth server surfaces. No default in either direction: a silent
   * `true` leaks on the next route added, a silent `false` breaks a shipped client without a
   * word. `relay-allowlist.ts` is the import-free projection the sidecar reads;
   * `relay-allowlist-census.test.ts` holds the two in agreement and derives the
   * credential-subject refusal from the handlers.
   */
  relay: boolean;
  handler: Handler;
  options?: RouteOptions;
}

/**
 * `matched` carries the resolved route + extracted params. `methodNotAllowed`
 * distinguishes 405 (some route matched the PATH but not the method) from 404
 * (no route matched the path at all).
 */
export type MatchResult =
  | { matched: true; route: Route; params: RouteParams }
  | { matched: false; methodNotAllowed: boolean };

/**
 * Resolve `method` + `pathname` to the single most-specific route of that method.
 * Static-before-param; 404 vs 405 distinguished via `methodNotAllowed`.
 */
export function matchRoute(routes: Route[], method: string, pathname: string): MatchResult {
  const m = matchSpec(routes, method, pathname);
  return m.matched
    ? { matched: true, route: m.spec, params: m.params }
    : { matched: false, methodNotAllowed: m.methodNotAllowed };
}
