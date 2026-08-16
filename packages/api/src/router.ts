import type { ApiDeps } from "./deps.js";

export type RouteParams = Record<string, string>;

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
  /** Honors `Idempotency-Key` (`withIdempotency`). */
  idempotent?: boolean;
  /** SSE / oauth-redirect: reduced pipeline — no JSON envelope, no CSRF, no idempotency. */
  raw?: boolean;
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

const segsOf = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

/**
 * Percent-decode a path segment WITHOUT throwing.
 *
 * `decodeURIComponent` raises `URIError` on a malformed escape (`/messages/%ZZ/move`), and this
 * runs inside route matching — above `withErrorEnvelope` in `createApp` — so that throw used to
 * escape the pipeline entirely and surface as the host's generic 500 with a logged stack, for
 * what is plainly a 400. Hosts that can reject malformed encoding earlier do
 * (the hosted API host's `normalizePathname` answers 400); this is the floor for every other
 * host: an undecodable segment is matched VERBATIM, which simply finds no route for a
 * nonsense id and answers the 404 it deserves.
 */
function safeDecodeSegment(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Try one pattern against the path segments. Returns extracted params + a
 * per-segment specificity vector (1 = static literal, 0 = `:param`) or null if
 * the pattern does not match. The specificity vector is compared lexicographically
 * so STATIC segments win over params at the earliest differing position:
 * `/threads/merge` [1,1] beats `/threads/:id` [1,0].
 */
function tryMatch(patternSegs: string[], pathSegs: string[]): { params: RouteParams; spec: number[] } | null {
  if (patternSegs.length !== pathSegs.length) return null;
  const params: RouteParams = {};
  const spec: number[] = [];
  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i]!;
    const val = pathSegs[i]!;
    if (ps.startsWith(":")) {
      params[ps.slice(1)] = safeDecodeSegment(val);
      spec.push(0);
    } else if (ps === val) {
      spec.push(1);
    } else {
      return null;
    }
  }
  return { params, spec };
}

/** Lexicographic compare: > 0 iff `a` is strictly more specific than `b`. */
function cmpSpec(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Resolve `method` + `pathname` to the single most-specific route of that method.
 * Static-before-param; 404 vs 405 distinguished via `methodNotAllowed`.
 */
export function matchRoute(routes: Route[], method: string, pathname: string): MatchResult {
  const pathSegs = segsOf(pathname);
  const wanted = method.toUpperCase();
  let pathMatched = false;
  let best: { route: Route; params: RouteParams; spec: number[] } | null = null;

  for (const route of routes) {
    const m = tryMatch(segsOf(route.pattern), pathSegs);
    if (!m) continue;
    pathMatched = true;
    if (route.method.toUpperCase() !== wanted) continue;
    if (!best || cmpSpec(m.spec, best.spec) > 0) best = { route, params: m.params, spec: m.spec };
  }

  if (best) return { matched: true, route: best.route, params: best.params };
  return { matched: false, methodNotAllowed: pathMatched };
}
