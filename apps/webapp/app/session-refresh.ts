/**
 * ONE refresh, however many callers ask for it.
 *
 * `POST /auth/refresh` rotates the refresh-token family: the presented token is consumed and a
 * new one issued, and presenting a consumed token a second time is REUSE, which
 * `AuthService.rotateRefresh` treats as theft and answers by revoking the whole family. That
 * behaviour is correct and must not be softened — which makes concurrency this module's whole
 * job. Three sync calls and a mailbox list 401-ing together must produce ONE refresh, not
 * four; four would rotate once and then kill the family with its own retries, signing the user
 * out as a direct consequence of trying to keep them signed in.
 *
 * So every caller awaits the same in-flight promise.
 *
 * ── THE PATH IS BARE, NOT `/api`-PREFIXED ───────────────────────────────────────────────
 *
 * `packages/api/src/cookies.ts` scopes `tf_refresh` to `Path=/auth/refresh`, and a browser
 * sends a path-scoped cookie only to that exact path. `/api/auth/refresh` is a DIFFERENT path,
 * so the cookie would not be attached and the refresh would fail with no refresh token —
 * looking exactly like an expired session. `apps/webapp/next.config.mjs` carries a second,
 * dedicated rewrite for `/auth/refresh` for precisely this reason; its `REFRESH_PATH` note is
 * the long version.
 */

import { csrfToken } from "./csrf";
import { markSessionAlive, markSessionDead, registerSessionProbe } from "./shell/session-truth";

/** The one path that carries `tf_refresh`. Must equal `REFRESH_PATH` in `next.config.mjs`. */
export const REFRESH_ENDPOINT = "/auth/refresh";

/** The in-flight refresh, or null. Module-scoped: one per tab; the jar is shared wider. */
let inFlight: Promise<boolean> | null = null;

/**
 * ═══ WHAT THE LAST REFRESH ACTUALLY LEARNED — three answers, not two ══════════════════════
 *
 * `resumeSession` returns a boolean, and a boolean cannot carry the distinction the rest of
 * the app has to make: **"the server says this session is gone" and "the server did not
 * answer" are different facts**, and only the first is a verdict about the account. A caller
 * that reads `false` alone is reading the two of them as one, which is exactly the defect
 * `AUTH-FLICKER-DIAGNOSIS.md` records — a `503 db_busy` on the confirm rendered as
 * "You are signed out." over a live cookie.
 *
 * ── WHY THIS AND NOT `sessionIsDead()` ─────────────────────────────────────────────────────
 *
 * Because that latch is deliberately STICKY and deliberately survives a client-side sign-in.
 * `engine.tsx` documents the case: visiting `/login` while signed out latches the store from
 * a truthful coded 401, and `router.push("/")` then carries the latch into a freshly
 * signed-in shell — which is why the resolver's confirmed answer WITHDRAWS the claim
 * there. A classifier keying on `sessionIsDead()` would read that stale `true`, meet one
 * unrelated 503, and reproduce the pane over a session the server had just confirmed.
 *
 * This is the other shape: the outcome of the LAST refresh this tab performed, overwritten by
 * every refresh, never sticky. It answers "what did the recovery path just say?", which is the
 * only question a 401 on another endpoint needs answered.
 *
 * It is a report and not a decision: nothing here renders anything, and the death latch keeps
 * its single writer at the `markSessionDead()` call below.
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
 * ── THE CROSS-TAB LOCK, because the module-scoped promise above only covers ONE tab ─────────
 *
 * Every tab shares one cookie jar and one `tf_refresh`, and rotation consumes the presented
 * token — so two tabs firing this refresh together present the SAME token and one of them is a
 * "reuse". The server carries a grace window for exactly that, but the window is a bound, not a
 * licence: at machine wake a whole browser's worth of suspended tabs fires at once over a
 * network that is still re-associating, and a presentation was measured arriving 10.1 seconds
 * after its token was consumed — past the old window, family revoked, user signed out.
 *
 * The Web Locks API is the browser's own cross-tab mutex: the first tab rotates while the rest
 * QUEUE, and each queued tab's fetch then reads the JAR CURRENT AT SEND TIME — the winner's
 * fresh cookie, not the stale one it woke up holding. Serial rotations are cheap and correct;
 * skipping "unnecessary" ones is not worth a staleness heuristic. A browser without the API
 * (or a lock manager that throws) falls back to today's per-tab behaviour, which the server's
 * grace window and lost-response recovery still cover.
 *
 * DELIBERATELY NO TIMEOUT — not on the fetch, not on the lock wait. This request must outwait
 * a serverless cold start (the pinned invariant in `session-resume.test.ts`: clamping it turns
 * cold starts into sign-outs), and a queued tab inherits the same budget. The lock cannot jam
 * for ever without a live page holding a fetch the browser itself never times out, which
 * browsers do not allow: the network stack bounds the holder, the holder's settle frees the
 * queue, and a closed or discarded tab releases its lock automatically.
 */
const REFRESH_LOCK = "ohmail:session-refresh";

/**
 * ═══ THE SAME LOCK, HELD BY THE SIGN-IN CEREMONY ══════════════════════════════════════════
 *
 * `refreshSettled` orders THIS TAB's ceremony behind THIS TAB's refresh, and review named what
 * that cannot reach: `inFlight` is module state, so a refresh running in ANOTHER tab is invisible
 * to it. Tab A begins a refresh; tab B sees its own `inFlight === null`, waits for nothing, signs
 * in; A's response lands afterwards and rewrites every session cookie — restoring the previous
 * account or clearing the one just created. The Web Lock below serialises refreshes against each
 * other and did nothing about a login, because a login never asked for it.
 *
 * So the ceremony asks for it too. Every request that WRITES session cookies — the password step
 * and each second factor — runs inside the same origin-wide lock, so a refresh in any tab either
 * completes before the login starts or waits until after it. Ordering across tabs, by the same
 * instrument that already ordered refreshes across tabs.
 *
 * ── HELD AROUND THE REQUEST, NEVER AROUND THE HUMAN ───────────────────────────────────────
 *
 * One round trip at a time. Wrapping the whole ceremony — password, then a person finding their
 * phone, then a code — would hold an origin-wide lock for minutes and stall every other tab's
 * refresh behind it. Each call takes it, writes, and releases.
 *
 * ── AND THE WAIT HAS A FLOOR, FOR `refreshSettled`'S REASON ───────────────────────────────
 *
 * A lock is a queue, and a queue behind a holder that never finishes is the deadlock this slice
 * already fixed once in the other place. `AbortSignal` cancels the WAIT FOR A GRANT — never the
 * holder, which keeps whatever budget it had — and on expiry the ceremony proceeds unlocked,
 * which is exactly the behaviour it had before this existed. A race the sign-in may lose beats a
 * sign-in that cannot happen.
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
     * ── THE DEADLINE REFUSES NOW; IT USED TO PROCEED UNLOCKED ──────────────────────────────
     *
     * Waiting out and then writing anyway is the original race with a delay in front of it: the
     * holder is still going to write, this ceremony writes first, and the holder's answer lands
     * last and restores the account it was refreshing or clears the one just created. Review
     * pointed out that the test pinning that fallback DEMONSTRATED the attack rather than closing
     * it, which was fair.
     *
     * A refusal is the honest outcome and it is not a dead end: it is retryable, it reaches the
     * screen through the error path every one of these surfaces already renders, and the state it
     * describes clears by itself in seconds. A visible "try that again" beats a silent
     * wrong-account write, which is this slice's stated ordering applied to its own machinery.
     *
     * NOT the same case as having no lock manager at all — that falls through below and proceeds,
     * because a browser without Web Locks would otherwise be unable to sign in, and there the
     * server's grace window is the only instrument there has ever been.
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
 * ═══ WAIT FOR ANY REFRESH ALREADY IN FLIGHT, AND DO NOT CANCEL IT ═════════════════════════
 *
 * A refresh REWRITES THE WHOLE COOKIE JAR: a success rotates `tf_session`, `tf_refresh`,
 * `tf_csrf`, the resume marker and the account name; a coded failure clears all five. That is a
 * side effect the client cannot take back, and it lands whenever the response lands.
 *
 * The collision: `/login`'s "are you already signed in?" check can 401 and enter this refresh
 * carrying the OLD account's cookie. If the person then signs in as somebody else while it is
 * still in flight, the refresh's response arrives AFTER the ceremony has written the new
 * account's cookies — restoring the previous account's session, or clearing the new one
 * outright. The person is switched back, or signed out seconds after signing in.
 *
 * Aborting it is the wrong instrument and this function exists to say so. The refresh is
 * SINGLE-FLIGHT and SHARED — a sync drain, a mailbox read and the resume splash may all be
 * awaiting this exact promise — so cancelling it on one caller's behalf strands every other
 * caller on a recovery it was owed, and (because the request may already have reached the
 * server) does not even guarantee the cookies are left alone.
 *
 * So the ceremony WAITS instead. The refresh finishes and writes whatever it writes; the login
 * then runs and writes last. Ordering, not cancellation. Nothing is stranded, and the jar ends
 * up holding the credential the person actually asked for.
 *
 * Never rejects, and resolves immediately when nothing is in flight.
 *
 * ── AND IT GIVES UP, WHICH IS THE HALF THAT WAS MISSING ────────────────────────────────────
 *
 * "The refresh finishes and writes whatever it writes; the login then runs and writes last" was
 * written as though the refresh always finishes. Nothing here guaranteed that. The fetch has no
 * application deadline on purpose (a cold start must not become a sign-out —
 * `session-resume.test.ts` pins that), and the cross-tab Web Lock has none either: a queued tab
 * waits for a grant held by a tab that may be hung, suspended or wedged behind a network stack
 * that never settles. In that state a password submit awaited this for ever — no login request
 * was ever sent, the form stayed busy, and nothing on screen said why.
 *
 * That is a worse failure than the one the ordering exists to prevent. The collision it guards
 * against is a race that MAY happen; a wait with no floor is a sign-in that CANNOT happen. So the
 * wait is bounded and the caller proceeds.
 *
 * {@link SETTLE_DEADLINE_MS} bounds the WAIT, never the refresh — the request is untouched, is
 * still shared, still single-flight, and still gets however long it needs. What expires is one
 * caller's willingness to be ordered behind it. Past the deadline the ordering guarantee is gone
 * and the old race is back for that one submit: a refresh landing afterwards can still rewrite
 * the jar. That is the honest trade and it is stated here rather than glossed, because the
 * alternative is a form that never submits at all.
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
export async function resumeSession(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = withCrossTabLock(async () => {
    try {
      /*
       * THE CSRF HEADER IS REQUIRED HERE, and the comment that used to stand in its place was
       * wrong in production.
       *
       * It read: "No CSRF header, and none is needed: `tf_refresh` is `SameSite=Strict`, so a
       * cross-site page cannot cause this request to carry it… `POST /auth/refresh` is `public`
       * and reads the cookie directly." Every clause is true and the conclusion does not follow.
       * `withCsrf` (`packages/api/src/middleware.ts`) keys off the SESSION, not off the route:
       *
       *     if (UNSAFE_METHODS.has(method) && deps.session?.via === "cookie") { … }
       *
       * `public` only means `withSession` will not 401 — it still POPULATES a session when a
       * credential happens to be present. So a POST that arrives with a live `tf_session` cookie
       * is cookie-authenticated as far as the guard is concerned, and a missing `X-CSRF-Token`
       * is answered `403 csrf_failed`.
       *
       * The premise that saved it was "`tf_csrf` expires with the access cookie, so by the time
       * a refresh is wanted it is typically gone" — i.e. no session, no guard. That holds for the
       * IDLE-TAB case this module was written for, and it is exactly false for the case the
       * resume splash exists to serve: a `SameSite=Strict` cross-site top-level navigation
       * withholds `tf_session` from THAT NAVIGATION while leaving it alive in the jar. The edge
       * gate therefore sees no cookie and routes to the splash, and the splash's same-origin
       * fetch then attaches the very cookie the navigation withheld. Live session, live
       * `tf_csrf`, no header — 403, every time.
       *
       * Observed live: the first Microsoft mailbox connect through this flow died here. Microsoft's
       * redirect is that cross-site navigation, so the return from consent ALWAYS lands on the
       * splash; the refresh 403'd; `ResumeScreen` read the non-204 as "not resumable" and sent
       * the browser to `/login`, which destroyed the `?oauth=pending&state=…&code=…` query and
       * the `#/settings` fragment the ceremony was carried in. `/login` then found the live
       * session and forwarded to `/`, so the person landed on the Ohbox with no mailbox added
       * and nothing on screen. The ceremony row was never consumed.
       *
       * Echoing the cookie is the whole fix and it weakens nothing. The guard recomputes the
       * expected value from the presented session token (`csrfTokenFor`) and requires BOTH the
       * cookie and the header to equal it, so this is the same double-submit every other
       * mutation makes — and a cross-site attacker cannot read `tf_csrf` to forge the header.
       * Absent cookie ⇒ no header, which is the genuinely session-less case where the guard does
       * not run.
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
      // 204 with fresh Set-Cookie headers is success. A 401 means the family is gone, and the
      // server has already cleared the whole jar (including the resume marker) on its way out,
      // so the next navigation is an honest signed-out landing rather than another attempt.
      //
      // ── BOTH ANSWERS ARE TOLD TO THE SESSION-TRUTH STORE, because both are DEFINITIVE ──────
      //
      // Every other 401 in this product is one request's evidence — `sync-scheduler.ts` spends
      // sixty seconds confirming one before it will say "sign in", precisely because a transient
      // 401 once told a signed-in user they were signed out. THIS one is different in kind: the
      // refresh endpoint is the recovery path itself, so its coded 401 means the refresh family
      // is revoked and the jar is cleared — there is no stronger confirmation to wait for. And a
      // 204 is the opposite fact with the same authority: a session exists again, which is what
      // lets surfaces holding an auth-shaped failure ask once more (`markSessionAlive` publishes
      // a revival; see `shell/session-truth.ts`).
      //
      // The death latch additionally requires OUR error envelope. A 401 with no parseable
      // `error.code` is a platform interposing itself — deployment protection, an alias
      // mid-roll — and the scheduler's `isTerminalRefusal` already records how such a 401 told
      // a signed-in user to sign in while the API answered 200. Same lesson, same guard.
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
    } finally {
      inFlight = null;
    }
  });
  return inFlight;
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
 * Should this failure be retried after a refresh?
 *
 * **401 is not the whole story, and assuming it was would have left half the bug in place.**
 * `tf_csrf` is issued with the same `Max-Age` as the access cookie, so an idle tab loses BOTH.
 * Its next mutation therefore arrives with a live-looking session and no double-submit token,
 * and `withRequestGuard` answers **403 `csrf_failed`** — not 401. A retry policy watching only
 * 401 would fix reads and leave every write in an idle tab broken.
 *
 * A refresh mints a new `tf_csrf` alongside the new session, so the retry fixes both.
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
   * `/hello` is the capability handshake, and it is here for a different reason from its
   * neighbours: not because a 401 there is an ANSWER, but because a refresh cannot possibly be
   * the remedy for one. The route carries no credential meaning — it reports what the server is
   * and whether it has any accounts yet — and its callers are page mounts that treat any failure
   * as "behave normally".
   *
   * What it cost while it was absent: `/login` asks `/hello` on mount, independently of the
   * already-signed-in ladder. A delayed 401 there — an edge gate, a proxy, a server mid-deploy —
   * sent `api()` into a refresh carrying the PREVIOUS account's cookies, and a refresh rewrites
   * the whole jar whenever it lands. Arriving after somebody had finished signing in as a
   * different account, it restored the old session or cleared the new one. The ceremony cannot
   * order itself behind a request it does not know exists, so the fix is that this route never
   * starts one.
   */
  "/hello",
];

export function mayRefreshFor(path: string): boolean {
  return !NEVER_REFRESH.some((p) => path.startsWith(p));
}
