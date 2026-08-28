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

function withCrossTabLock(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      // `request` resolves with the callback's settled value; `.then` flattens the lib's
      // nested-promise reading of that into the boolean it is at runtime.
      return locks.request(REFRESH_LOCK, { mode: "exclusive" }, fn).then((v) => v);
    }
  } catch {
    /* a lock manager that refuses is a browser without one */
  }
  return fn();
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
        markSessionAlive();
        return true;
      }
      if (res.status === 401 && (await codedRefusal(res))) markSessionDead();
      return false;
    } catch {
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
];

export function mayRefreshFor(path: string): boolean {
  return !NEVER_REFRESH.some((p) => path.startsWith(p));
}
