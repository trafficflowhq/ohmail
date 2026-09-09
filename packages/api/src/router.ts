import type { ApiDeps } from "./deps.js";
import { matchSpec, type RouteParams } from "./match-path.js";

/* Re-exported so every existing consumer of this module keeps its import. */
export { matchSpec, type RouteParams };

export type Handler = (req: Request, deps: ApiDeps, params: RouteParams) => Promise<Response>;

/**
 * **WHAT DOES THIS HANDLER CAUSE?** Every route declares it, and the
 * declaration is what `withSpendGate` judges an unverified account against.
 *
 * The invariant: *an unverified account must not be able to generate meaningful cost*, hosting
 * included. Its acceptance test is `anything that does work, holds a connection, or calls a
 * paid API refuses an unverified account`, so the classification has to be about the
 * EFFECT of the handler, not about its verb or its path. `POST /messages/:id/move` writes one
 * row and enqueues an IMAP move the worker performs; `GET /attachments/:id` opens a socket to
 * somebody's mail server. Those are different amounts of money and the route table is the only
 * place both facts are visible at once.
 *
 * ── WHY IT IS A REQUIRED FIELD, AND NOT AN OPTION ────────────────────────────────────────
 *
 * The predecessor was an optional boolean in {@link RouteOptions} — opt-IN, so route 125 was
 * ungated by default and 122 of 124 routes were ungated in fact. Every flag in
 * {@link RouteOptions} is a behavioural toggle whose ABSENCE is a documented default; this is
 * the opposite, a question with no safe default, so it sits on {@link Route} itself where
 * omitting it is a compile error. The route table lives under `src`, which this package's main
 * `tsconfig` includes, so typechecking is a real guard here — whereas an ordinary test file is
 * not included at all, and a type-level assertion written in one would never be compiled.
 *
 * `withSpendGate` ALSO fails closed at runtime on an absent or unrecognised value, because a
 * type is not a guarantee against a JavaScript caller, a cast, or a synthetic route in a test
 * file that the compiler never sees.
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
   * The identity lifecycle: entering, proving, extending and LEAVING. Register, verify,
   * re-send the verification mail, log in, read/refresh/end the session, enrol or remove a
   * second factor, mint an OAuth token, revoke a device, erase the account.
   *
   * Reachable before verification by construction — this is the only path OUT of the
   * unverified state, and two of its exits must hold even for somebody who can never verify
   * (a registrant who mistyped their address holds a session, will never get the mail, and
   * must still be able to revoke a credential and to leave under Art. 17).
   *
   * **Some of these spend.** `POST /auth/register` and `POST /auth/verify-email/resend` send
   * mail through the transactional mail provider. They are not exempt from cost control — they are controlled by a
   * DIFFERENT mechanism, because verification cannot be the control on the route that
   * produces verification: the per-recipient `unsolicited` quota and the per-IP `verify:ip`
   * limiter. A new `ceremony` route that sends mail owes its own quota, and the frozen
   * census over this class is where its author is made to notice.
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
 * THE DOORS THAT STAY OPEN TO A REFUSED ACCOUNT — the classes, and the one route outside them.
 *
 * When the entitlements port refuses an account, the app renders a lock screen instead of mail.
 * Three things must still work from inside that lock, or it is a trap rather than a control:
 * signing out and every identity call (`ceremony`), leaving under Art. 17 (`DELETE /account`, also
 * `ceremony`), and the way back to paying — which is `POST /account/manage-link`, a `paid` route
 * and therefore the one door this set names explicitly rather than by class.
 *
 * `unauthenticated` is here because it serves no account at all, so there is no verdict to judge.
 */
export const ACCESS_REFUSED_MAY_REACH: ReadonlySet<CostClass> =
  new Set<CostClass>(["unauthenticated", "ceremony"]);

/** `<METHOD> <pattern>` of every route reachable while refused DESPITE its cost class. */
export const ACCESS_REFUSED_MAY_REACH_ROUTES: ReadonlySet<string> =
  new Set<string>(["POST /account/manage-link"]);

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
 * True iff `cost` is a class an unverified account may reach. Deliberately takes `unknown`:
 * the caller is a middleware reading a field that a JavaScript caller or an un-typechecked
 * test route can leave undefined, and the answer for "no declaration" must be `false`.
 */
export function unverifiedMayReach(cost: unknown): boolean {
  return typeof cost === "string" && UNVERIFIED_MAY_REACH.has(cost as CostClass);
}

export interface RouteOptions {
  /** Route needs no session; `withSession` populates it if a token is present but never 401s. */
  public?: boolean;
  /** Requires a recent 2FA (`withStepUp`); else 403 step_up_required. */
  stepUp?: boolean;
  /**
   * The route is part of the 2FA-ENROLLMENT surface, so an enrollment-scoped session
   * is admitted. Absent — the default, and the default for every route in the
   * table — an enrollment session is rejected with 403 `enrollment_incomplete` on a
   * protected route and simply IGNORED (treated as anonymous) on a public one.
   * `withSession` owns that decision; no handler may re-implement it.
   */
  enrollmentOk?: boolean;
  /**
   * PATH PARAMETERS THAT ARE **NOT** UUIDS — the opt-out from the shape check
   * `createApp.handle` applies to every `:param` before any pipeline runs.
   *
   * **Absent means validated**, and that direction is the whole point. A path parameter is a
   * caller-chosen string that reaches a `uuid` column verbatim, so the default has to be the safe
   * one: a new `:id` route is covered by code nobody has to remember to call. The inverted
   * spelling — an opt-IN list of routes to check — is the shape that leaves the next route
   * uncovered, which is exactly how `GET /drafts/:id` answered 500 to `/drafts/not-a-uuid` for its
   * whole life while a 1 679-line input census stayed green.
   *
   * **It ships EMPTY, and that is a measured claim rather than a default.** All 78 `:id` patterns
   * in the table resolve to a `uuid` column — including the three that looked like exceptions:
   * `attachments.id` IS a uuid (its live 502 came from that route's own blanket catch, not from a
   * non-uuid id), `mailbox_folders.id` is one, and `/screener/:id` reads `messages.id`. So there is
   * no entry to make today, and the option exists for the `:token` or `:name` route somebody adds
   * later — which then has to SAY so here, visibly, instead of silently widening the door.
   *
   * Named per parameter, not per route, so a route with two params can declare one opaque and keep
   * the other checked. `input-bounds-census.test.ts` holds the frozen cross-check in both
   * directions, so an entry added here without an argument there is a red test.
   */
  opaqueParams?: readonly string[];
  /** Honors `Idempotency-Key` (`withIdempotency`). */
  idempotent?: boolean;
  /** SSE / oauth-redirect: reduced pipeline — no JSON envelope, no CSRF, no idempotency. */
  raw?: boolean;
  /**
   * **THIS ROUTE ANSWERS FOR THE CREDENTIAL IT RESOLVED, NOT FOR THE SESSION THAT CARRIED THE
   * REQUEST.** The sign-in, token and pairing routes — the ones whose handler mints or rotates a
   * session from a credential in the request BODY.
   *
   * **The set is not listed here on purpose.** It was, and the list said five while the true count
   * was ten; a second review then found the derivation itself short by a seam. A list of route
   * names in a comment is a fact about who last counted. `account-header-census.test.ts` derives
   * the set from the handlers and asserts the flags match it, so the authority is the code.
   *
   * They are all `public`, so `withSession` resolves whatever credential is ambient — and then
   * the handler resolves a SECOND one out of the body, which is the one the response is about.
   * A browser refreshing an expired token has no session at all and the response still belongs to
   * an account; a caller holding a live session presents a credential that must belong to the
   * same account or be refused (`refuseCrossAccountCredential`).
   *
   * The flag changes only where {@link ACCOUNT_HEADER} takes its value: `deps.credentialAccount`
   * instead of `deps.session`. It grants nothing and gates nothing, so a route that carries it
   * wrongly cannot become more permissive — it can only stop naming an account, which
   * `account-header-census.test.ts` checks. And it checks against a set DERIVED from the
   * handlers, not against a list — there was a frozen list, it said five when the truth was ten,
   * and this sentence went on citing it after the list was deleted.
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
   * REQUIRED, and it is a fact about a DIFFERENT program: may a Cloud-mode desktop install's
   * write-through relay forward this route to the server its door names?
   *
   * ── WHY THE ROUTE TABLE ANSWERS THIS, AND WHY IT IS NOT OPTIONAL ─────────────────────────
   *
   * `apps/sidecar/src/cloud-proxy.ts` serves reads out of a local mirror and forwards everything
   * else to the configured base with a bearer. When the door names a server the person runs
   * THEMSELVES, "everything else" is a request leaving with a credential in its body — and the
   * refusal was a DENYLIST of two paths, which is the shape three consecutive fixes were each a
   * symptom of. Each fix closed one spelling and review found the next: a malformed percent
   * escape, a trailing slash, a `/api` prefix, a folded case, a missing method comparison.
   *
   * An allowlist makes those unreachable by construction rather than by enumeration, and the
   * allowlist has to be derived from THIS table, because this is the only place that knows what
   * a route is. `relay-allowlist.ts` is the import-free projection the sidecar reads (it cannot
   * import handlers — that would drag the IMAP adapter into an engine whose census exists to
   * keep it out), and `relay-allowlist-census.test.ts` holds the two in agreement.
   *
   * NO DEFAULT, for the same reason `cost` has none. A default in either direction is wrong: a
   * silent `true` re-opens the leak on the next route somebody adds, and a silent `false` breaks
   * a shipped client's feature without a word. A new route DECLARES, and the census fails a
   * runtime table whose member has not.
   *
   * `false` is the answer for a route that resolves a credential out of the REQUEST BODY
   * (`credentialSubject`), for the browser hand-off ceremony, and for the planes a self-host
   * relay has no business reaching at all — the hosted console, the alert intake, billing, the
   * waitlist and the OAuth server surface. The census asserts the first of those by DERIVATION
   * rather than by list, so a route that becomes a credential subject cannot stay relayable.
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
