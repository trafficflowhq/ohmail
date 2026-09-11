/**
 * One refresh, however many callers ask. `POST /auth/refresh` rotates the refresh-token family: the
 * presented token is consumed, and presenting a consumed one again is REUSE, which
 * `AuthService.rotateRefresh` treats as theft and answers by revoking the whole family — correct,
 * and not to be softened, which makes concurrency this module's whole job: three sync calls and a
 * mailbox list 401-ing together must produce ONE refresh, not four (four would sign the user out by
 * trying to keep them in). Every caller awaits the same in-flight promise. The path is BARE, not
 * `/api`-prefixed: `tf_refresh` is scoped `Path=/auth/refresh`, and a different path gets no cookie
 * — `next.config.mjs` carries the dedicated rewrite (`REFRESH_PATH`).
 */

import { csrfToken } from "./csrf";
import { markSessionAlive, markSessionDead, registerSessionProbe } from "./shell/session-truth";

/** The one path that carries `tf_refresh`. Must equal `REFRESH_PATH` in `next.config.mjs`. */
export const REFRESH_ENDPOINT = "/auth/refresh";

/** The in-flight refresh, or null. Module-scoped: one per tab; the jar is shared wider. */
let inFlight: Promise<boolean> | null = null;

/**
 * What the last refresh actually learned — three answers, not two. `resumeSession` returns a
 * boolean, and a boolean cannot carry the distinction: "the server says this session is gone" and
 * "the server did not answer" are different facts, and only the first is a verdict
 * (`AUTH-FLICKER-DIAGNOSIS.md`: a `503 db_busy` rendered as "You are signed out."). Not
 * `sessionIsDead()`: that latch is deliberately sticky and survives a client-side sign-in, so a
 * classifier keying on it would meet one unrelated 503 and reproduce the pane over a confirmed
 * session. This is the outcome of the LAST refresh, overwritten every time, never sticky — a
 * report, not a decision; the death latch keeps its single writer at `markSessionDead()`.
 */
export type RefreshOutcome = "minted" | "revoked" | "unavailable";

/** The last refresh's outcome, or `null` when this tab has not attempted one. */
let lastOutcome: RefreshOutcome | null = null;

/**
 * What did the last `POST /auth/refresh` from this tab learn? `null` before the first one.
 *
 * Read INSIDE a caller's own error path, after `api()` has already refreshed-and-retried, so
 * the value describes the refresh that was attempted for THAT failure. Callers must not treat
 * `"unavailable"` or `null` as evidence of anything about the session — that is the whole
 * point of it being a third answer.
 */
export function lastRefreshOutcome(): RefreshOutcome | null {
  return lastOutcome;
}

/**
 * The cross-tab lock — the module promise covers ONE tab, and every tab shares one `tf_refresh`: two tabs
 * firing together present the SAME token and one is a "reuse". The server's grace window is a bound, not
 * a licence: at machine wake a browser's worth of tabs fires over a re-associating network, and a
 * presentation was measured 10.1 s after its token was consumed — family revoked. Web Locks is the
 * browser's own cross-tab mutex: the first tab rotates, the rest queue, and each queued fetch reads the
 * jar current AT SEND TIME. No API ⇒ per-tab behaviour, still covered by the grace window. Deliberately
 * NO timeout on fetch or lock wait: the request must outwait a cold start (`session-resume.test.ts` pins
 * it), and the network stack bounds the holder; a closed tab releases its lock automatically.
 */
const REFRESH_LOCK = "ohmail:session-refresh";

/**
 * The same lock, held by the sign-in ceremony. `refreshSettled` orders this tab's ceremony behind this tab's
 * refresh; `inFlight` is module state, so a refresh in ANOTHER tab was invisible — its response landed after
 * the ceremony and rewrote every session cookie, restoring the previous account or clearing the new one. So
 * every request that WRITES session cookies runs inside the same origin-wide lock. Held around the REQUEST,
 * never the human: wrapping the whole ceremony would stall every tab's refresh for minutes. The wait has a
 * floor (`AbortSignal` cancels the wait for a grant, never the holder), and on expiry the ceremony REFUSES
 * (`SessionBusyError`, retryable) — proceeding unlocked is the original race with a delay in front. The one
 * path that proceeds unlocked is a browser with NO lock manager, which otherwise could not sign in at all.
 */
export async function withSessionCookieLock<T>(fn: () => Promise<T>): Promise<T> {
  /*
   * PER CALL, in a closure, and never module state: two ceremonies can be in flight in one tab
   * (a resend beside a verify), and a shared flag would let one decide the other's fate. It
   * answers exactly one question — did `fn` get as far as running? — which is what separates
   * "the ceremony failed" from "we never got a grant".
   */
  let started = false;
  const run = async (): Promise<T> => {
    started = true;
    return fn();
  };
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), SETTLE_DEADLINE_MS);
      try {
        return await locks.request(REFRESH_LOCK, { mode: "exclusive", signal: ctl.signal }, run) as T;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    /*
     * `fn` RAN AND THREW ⇒ its error is the answer, and it must not be retried: re-running a
     * password step because the server said no is a second login attempt nobody asked for, and
     * against a single-use login token it is a guaranteed second failure.
     */
    if (started) throw err;
    /*
     * The deadline refuses now; it used to proceed unlocked — the original race with a delay in
     * front of it: the holder is still going to write, this ceremony writes first, and the holder's
     * answer lands last and restores the account it was refreshing (review: the test pinning that
     * fallback demonstrated the attack rather than closing it). A refusal is honest and not a dead
     * end: retryable, rendered through the error path these surfaces already have, and the state
     * clears by itself in seconds. NOT the same case as no lock manager at all — that falls through
     * and proceeds, because a browser without Web Locks could not sign in, and there the grace
     * window is the only instrument.
     */
    if (isAbort(err)) {
      throw new SessionBusyError();
    }
  }
  return run();
}

/** Did the wait end because our own deadline aborted it, rather than because there is no lock? */
function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * ANOTHER TAB IS STILL WRITING THE SESSION. Retryable by construction: the lock it is waiting on
 * is released when that tab's request settles or when that tab goes away, so the next attempt is
 * seconds later and unremarkable.
 *
 * A distinct class rather than a generic failure so a surface can tell it apart from a refusal
 * the SERVER made — nothing has been decided about the credential here, and the copy must not
 * suggest it has.
 */
export class SessionBusyError extends Error {
  readonly code = "session_busy";
  readonly retryable = true;
  constructor() {
    super("ohmail: another tab is finishing a sign-in or sign-out — try that again in a moment");
    this.name = "SessionBusyError";
  }
}

async function withCrossTabLock(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    // BOTH the property lookup and the request live inside this try: a `navigator.locks`
    // accessor that THROWS (hardened embedders) and a `request()` that REJECTS asynchronously
    // (document no longer fully active, opaque origin) are the same case — no lock manager —
    // and either escaping would hand `resumeSession` a rejected promise: its never-rejects
    // contract breaks, and because `fn`'s own `finally` never ran, `inFlight` would cache the
    // rejection for the tab's whole life, every later refresh failing instantly with no
    // fetch. `fn` itself never rejects (its body is one try/catch/finally answering
    // booleans), and this origin never uses `steal`, so anything caught here means the
    // callback was never granted: the lock-less run below is the single run it was owed,
    // never a double refresh.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      // `request` resolves with the callback's settled value once the grant releases.
      return (await locks.request(REFRESH_LOCK, { mode: "exclusive" }, fn)) as boolean;
    }
  } catch {
    /* fall through to the lock-less run */
  }
  return fn();
}

/**
 * How long {@link refreshSettled} will wait to be ordered behind a refresh already in flight.
 *
 * Fifteen seconds: comfortably past a serverless cold start plus a rotation (the budget the
 * refresh itself is deliberately given no ceiling for), and far short of a form somebody decides
 * is broken. It is not a request timeout and must never become one — see `refreshSettled`.
 */
export const SETTLE_DEADLINE_MS = 15_000;

/**
 * Wait for any refresh already in flight, and do not cancel it. A refresh rewrites the whole cookie jar whenever its
 * response lands. The collision: `/login`'s signed-in check can 401 into a refresh carrying the OLD account's cookie;
 * sign in as somebody else mid-flight and the late response restores the previous account or clears the new one.
 * Aborting is the wrong instrument: the refresh is single-flight and SHARED — other callers await this exact promise
 * — and the request may already have reached the server. So the ceremony WAITS: ordering, not cancellation. And it
 * gives up: the fetch and the lock have no deadline on purpose, so a hung holder once left a password submit awaiting
 * for ever. {@link SETTLE_DEADLINE_MS} bounds the WAIT, never the refresh — past it the old race is back for that one
 * submit, the honest trade against a form that never submits at all.
 */
export async function refreshSettled(): Promise<void> {
  // Read once: `inFlight` is nulled by the callback's own `finally`, so re-reading after the
  // await could see a LATER refresh and wait for that one too — an unbounded wait dressed as a
  // bounded one. One refresh is the one this caller can have collided with.
  const pending = inFlight;
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SETTLE_DEADLINE_MS); }),
    ]);
  } finally {
    // Cleared whichever arm won: a live timer holds the event loop open in Node and keeps a
    // fake-timer test's queue non-empty, and the promise it resolves is already unreachable.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Try to turn the refresh cookie into a live session. Resolves `true` on success.
 *
 * Never throws and never rejects: every caller is on an error path already, and a refresh that
 * blew up would turn a recoverable 401 into an unhandled rejection.
 */
/** What a caller may add to a resume. See {@link resumeSession}. */
export interface ResumeOptions {
  /**
   * MAY THIS STILL RUN? Consulted inside the cross-tab lock, immediately before the request.
   *
   * `false` answers the resume as "did not happen" — deliberately not as a failure, because the
   * caller that asked for the predicate is the one that knows what a refusal means for it. The
   * splash reloads (the browser now holds somebody else's live session, so there is nothing to
   * resume and the server will serve them); `api()` does not pass one at all.
   */
  mayProceed?: () => boolean;
}

export async function resumeSession(opts: ResumeOptions = {}): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = withCrossTabLock(async () => {
    /*
     * Still the same browser? Asked INSIDE the lock, not before it. A refresh rotates whatever
     * session the jar holds, and the caller may have decided long ago (the resume splash is chosen
     * by the edge; its effect runs after hydration; the lock adds a second wait). Either gap is
     * enough for another tab to sign in, and the rotation would spend that account's refresh token
     * from a window that was never theirs — their own tab then presents a consumed token and is
     * read as reuse. Here rather than at the call site for `csrfToken()`'s reason: what matters is
     * the jar as it is when the request LEAVES.
     */

    try {
      // INSIDE the `try`, so the `finally` below clears `inFlight`. Outside it, one refusal
      // left the module's dedupe holding a settled promise for the life of the page and every
      // later resume — including `api()`'s recovery — answered `false` without asking anything.
      // Found by running the cases in file order rather than one at a time.
      if (opts.mayProceed && !opts.mayProceed()) return false;
      /*
       * The CSRF header is required here — the old "none is needed" comment was wrong in production:
       * `withCsrf` keys off the SESSION, not the route, so a POST arriving with a live `tf_session` is
       * cookie-authenticated and a missing header is `403 csrf_failed`. The saving premise fails exactly
       * on the resume splash: a SameSite=Strict cross-site navigation withholds `tf_session` from that
       * navigation while leaving it in the jar, so the splash's same-origin fetch attaches it (observed
       * live: the first Microsoft mailbox connect died here — the 403 sent ResumeScreen to /login,
       * destroying the oauth query). Echoing the cookie is the whole fix: the guard requires BOTH cookie
       * and header to equal `csrfTokenFor(session)`, the same double-submit as every mutation.
       */
      // Read INSIDE the lock, not before it: a queued tab must send the cookie and CSRF value
      // current AFTER the winner's rotation landed, which is the whole point of queueing.
      const csrf = csrfToken();
      const res = await fetch(REFRESH_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        cache: "no-store",
        credentials: "same-origin",
      });
      // 204 with fresh Set-Cookie is success; a 401 means the family is
      // gone and the server has already cleared the whole jar, so the next navigation is an honest
      // signed-out landing. Both answers are told to the session-truth store, because both are
      // DEFINITIVE: every other 401 in this product is one request's evidence (the scheduler spends
      // sixty seconds confirming one), but the refresh endpoint IS the recovery path — its coded
      // 401 means the family is revoked, with no stronger confirmation to wait for; a 204 is the
      // opposite fact with the same authority (`markSessionAlive` publishes a revival). The death
      // latch additionally requires OUR error envelope: a 401
      // with no parseable `error.code` is a platform interposing itself.
      if (res.status === 204) {
        lastOutcome = "minted";
        markSessionAlive();
        return true;
      }
      if (res.status === 401 && (await codedRefusal(res))) {
        lastOutcome = "revoked";
        markSessionDead();
        return false;
      }
      // Everything else: an uncoded 401 (a platform interposing), a 5xx, a 403, a body this
      // client cannot read. The refresh did not happen and nothing was learned about the
      // session — which is a different fact from "revoked" and is recorded as one.
      lastOutcome = "unavailable";
      return false;
    } catch {
      lastOutcome = "unavailable";
      return false;                    // offline, aborted, DNS — not resumable right now
    }
  });
  /*
   * Cleared after the assignment, and only if it is still ours. This was a `finally` inside the callback
   * — a race with its own assignment: a callback settling before `withCrossTabLock` returns (ordinary
   * under an account predicate's early refusal) runs the `finally` FIRST, and the line below then stores
   * a settled promise nothing will ever clear — every later resume returns the cached answer (found by
   * running the cases in order: alone each passed, together the second wedged the third). No identity
   * check on the clear: `if (inFlight === started)` guarded an unreachable sequence — the top guard
   * returns the live promise rather than starting a second — and a condition whose contrary state is
   * unreachable cannot be watched fail. The fix is the PLACEMENT.
   */
  const started = inFlight;
  void started.finally(() => { inFlight = null; });
  return started;
}

/** Did this refusal come from OUR envelope — `{error: {code}}` — rather than from a platform? */
async function codedRefusal(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    return typeof body?.error?.code === "string";
  } catch {
    return false;
  }
}

/**
 * THE PROBE, WIRED AT IMPORT TIME. `shell/session-truth.ts` may not import this module — the
 * shell ships in the public desktop mirror, which has no `/auth/refresh` — so the wiring runs
 * the other way: any build that loads the Cloud session client (every `api-client` importer
 * does, which includes `CloudShell`) has thereby armed the probe. A surface holding auth-shaped
 * evidence calls `probeSessionNow()` and this single-flight refresh settles the question; on
 * the desktop nothing registers and the call is a no-op. Module-scope on purpose — the same
 * shape as `beginOAuthReturn`, and for the same reason: an effect somebody has to remember to
 * mount is a wiring bug waiting to be reported.
 */
registerSessionProbe(() => {
  void resumeSession();
});

/**
 * Should this failure be retried after a refresh? 401 is not the whole
 * story: `tf_csrf` is issued with the same `Max-Age` as the access cookie,
 * so an idle tab loses BOTH — its next mutation arrives with a live-looking
 * session and no double-submit token, and `withRequestGuard` answers
 * **403 `csrf_failed`**, not 401. A retry policy watching only 401 would
 * fix reads and leave every write in an idle tab broken. A refresh mints a
 * new `tf_csrf` alongside the new session, so the retry fixes both.
 */
export function isRecoverable(status: number, code?: string): boolean {
  if (status === 401) return true;
  return status === 403 && code === "csrf_failed";
}

/**
 * Paths that must NEVER trigger a refresh-and-retry.
 *
 * The auth ceremony's 401s are ANSWERS, not accidents: a wrong password, a spent login token,
 * a bad TOTP code. Refreshing on those would replace a clear "that was wrong" with a silent
 * retry, double-submit a single-use login token, and — on `/auth/refresh` itself — recurse.
 */
const NEVER_REFRESH = [
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/verify-email",
  "/auth/2fa/",
  /*
   * `/auth/logout` — a 401 here is the server saying the session is ALREADY GONE, which is the
   * outcome being asked for. `sign-out.ts` reads it exactly that way. Refreshing first re-mints
   * a session in order to revoke it, which is absurd on its own terms; it also took the sign-out
   * through a nested acquire of the ceremony lock, which is how the whole sign-out came to hang.
   * The reentrancy above makes that survivable; this makes it not happen.
   */
  "/auth/logout",
  /*
   * `/hello` is the capability handshake, here for a different reason from its neighbours: not
   * because a 401 there is an answer, but because a refresh cannot possibly be the remedy — the
   * route carries no credential meaning, and its callers treat any failure as "behave normally".
   * What its absence cost: `/login` asks `/hello` on mount, and a delayed 401 there sent `api()`
   * into a refresh carrying the PREVIOUS account's cookies — arriving after somebody signed in as a
   * different account, it restored the old session or cleared the new one. The ceremony cannot
   * order itself behind a request it does not know exists, so this route never starts one.
   */
  "/hello",
];

export function mayRefreshFor(path: string): boolean {
  return !NEVER_REFRESH.some((p) => path.startsWith(p));
}
