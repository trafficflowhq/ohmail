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

import { isSessionRefusal } from "@ohmail/client-engine";
import { csrfToken } from "./csrf";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "./shell/confirm-schedule";
import { durableRemove, durableSet } from "./shell/durable";
import { readOwner } from "./shell/owner-cookie";
import {
  ERASED_DECLARATION, clearAccountErased, erasedAnswerOf, erasedCapture, hearAccountErased,
} from "./shell/account-erased";
import {
  markSessionAlive, markSessionDead, registerSessionProbe, sessionIsDead, subscribeSessionRevival,
  subscribeSessionTruth,
} from "./shell/session-truth";

/** The one path that carries `tf_refresh`. Must equal `REFRESH_PATH` in `next.config.mjs`. */
export const REFRESH_ENDPOINT = "/auth/refresh";

/**
 * WHAT ONE RESUME ANSWERS. `resumed` is a 204; `refused` is a verdict or a resume this caller may
 * not make (the refresh door's coded refusal, an erased account, a jar that moved); `unavailable`
 * is a fault that learned nothing about the session — a 5xx, the network — which a press waits
 * out as the desktop's door does, instead of being refused.
 */
export type ResumeAnswer = "resumed" | "refused" | "unavailable";

/** The in-flight refresh, or null. Module-scoped: one per tab; the jar is shared wider. */
let inFlight: Promise<ResumeAnswer> | null = null;

/** The in-flight refresh's request, so a sign-in that minted past it can drop its late answer. */
let inFlightRequest: AbortController | null = null;

/**
 * What the last refresh actually learned — more than two answers. `resumeSession` returns a
 * boolean, and a boolean cannot carry the distinction: "the server says this session is gone" and
 * "the server did not answer" are different facts, and only the first is a verdict
 * (`AUTH-FLICKER-DIAGNOSIS.md`: a `503 db_busy` rendered as "You are signed out."). Not
 * `sessionIsDead()`: that latch is deliberately sticky and survives a client-side sign-in, so a
 * classifier keying on it would meet one unrelated 503 and reproduce the pane over a confirmed
 * session. This is the outcome of the LAST refresh, overwritten every time, never sticky — a
 * report, not a decision; the death latch keeps its single writer at `markSessionDead()`.
 */
export type RefreshOutcome = "minted" | "revoked" | "unavailable" | "superseded";

/** The last refresh's outcome, or `null` when this tab has not attempted one. */
let lastOutcome: RefreshOutcome | null = null;

/**
 * What the last refresh was TOLD, beside what it concluded.
 *
 * The refresh door used to answer one coded 401 for a revoked family AND for a database blip, so
 * the two states above were indistinguishable on the wire and a person reporting either produced
 * the same screenshot. The door now names its refusal and answers a fault as a fault; this
 * carries what came back so the difference survives into a report and into the console line
 * below. `status: 0` and a class mean nothing came back at all.
 */
export interface RefreshReport {
  outcome: RefreshOutcome;
  status: number;
  /** Our envelope's `error.code`, when the answer carried one. */
  code: string | null;
  /** The class of a thrown value — with its VALUE appended when that class is `String`. */
  errorClass: string | null;
  /** The server's `Retry-After`, in ms, when a fault named one — the backoff seeds from it. */
  retryAfterMs: number | null;
}

let lastReport: RefreshReport | null = null;

/** What the last `POST /auth/refresh` from this tab was told. `null` before the first one. */
export function lastRefreshReport(): RefreshReport | null {
  return lastReport;
}

/**
 * Record one refresh, and say a line about it when it did not mint.
 *
 * Never the body and never a token: the status, our own error code, and the class of a thrown
 * value. A thrown STRING carries its value with it, because a string IS its message and a
 * class-only line discards the whole payload.
 */
function recordRefresh(r: RefreshReport): void {
  lastOutcome = r.outcome;
  lastReport = r;
  if (r.outcome === "minted") return;
  console.warn("session_refresh", {
    outcome: r.outcome, status: r.status, code: r.code, errorClass: r.errorClass,
  });
}

/** The class of a thrown value, carrying the value itself when the class would lose it. */
function classOf(err: unknown): string {
  if (typeof err === "string") return `String: ${err}`;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err !== "object") return typeof err;
  const named = (err as { name?: unknown }).name;
  return typeof named === "string" && named.length > 0 ? named : "Object";
}

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
    const before = csrfToken();
    try {
      return await fn();
    } finally {
      // A ceremony that minted a session is a mint like a refresh's: the renewal counts from it.
      const after = csrfToken();
      if (after !== null && after !== before) {
        noteSessionMinted();
        // A minted session disproves a held death. Signed out, `/login` latches one (its session
        // read refreshes into a coded 401), and the sign-in is a client-side navigation: the new
        // shell's first reads (the access read behind Settings → Subscription) were refused before
        // the wire, and nothing asked again. After `noteSessionMinted`, so the renewal the revival
        // arms counts from this mint.
        markSessionAlive();
        // A refresh still in flight here carries the PREVIOUS jar; its answer must not land after
        // this mint. The server has revoked that session in the mint's transaction.
        inFlightRequest?.abort();
      }
    }
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

async function withCrossTabLock(fn: () => Promise<ResumeAnswer>): Promise<ResumeAnswer> {
  try {
    // BOTH the property lookup and the request live inside this try: a `navigator.locks`
    // accessor that THROWS (hardened embedders) and a `request()` that REJECTS asynchronously
    // (document no longer fully active, opaque origin) are the same case — no lock manager —
    // and either escaping would hand `resumeSession` a rejected promise: its never-rejects
    // contract breaks, and because `fn`'s own `finally` never ran, `inFlight` would cache the
    // rejection for the tab's whole life, every later refresh failing instantly with no
    // fetch. `fn` itself never rejects (its body is one try/catch/finally answering
    // a `ResumeAnswer`), and this origin never uses `steal`, so anything caught here means the
    // callback was never granted: the lock-less run below is the single run it was owed,
    // never a double refresh.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      // `request` resolves with the callback's settled value once the grant releases.
      return (await locks.request(REFRESH_LOCK, { mode: "exclusive" }, fn)) as ResumeAnswer;
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
 * Wait for any refresh already in flight. A refresh rewrites the whole cookie jar when its answer lands, and one
 * carrying the OLD account's cookie can land after a sign-in as somebody else. The ceremony WAITS first, because the
 * refresh is shared and its callers await it; the wait gives up at {@link SETTLE_DEADLINE_MS}, never the refresh, so a
 * hung holder cannot stop a submit. Past it, the mint revokes the jar's previous session on the server and aborts the
 * request here (outcome `superseded`), so neither half of the late answer can sign the browser back in.
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

/**
 * THE NAME OF A RENEWAL WHOSE ANSWER HAS NOT LANDED: the attempt id the native clients send, kept in the
 * jar so a reload or another tab retries as the same attempt. The server re-admits a spent token named
 * by the attempt that spent it, where the same token under a new name past the grace window is swept.
 * It is resumed only while the jar has not moved on (its `tf_csrf` is the one it went out with, or has
 * merely lapsed) and for one access window: a landed answer's `tf_csrf` outlives that window, and past
 * it the server's own recovery takes a quiet tail.
 */
export const SESSION_ATTEMPT_KEY = "ohmail.session.refreshAttempt";

interface PendingAttempt {
  id: string;
  csrf: string;
  at: number;
}

/** This page's copy, for a jar that refuses storage. */
let attemptHere: PendingAttempt | null = null;

/** Enough of `tf_csrf` to tell that the jar moved on, and never the value itself. */
function csrfMark(csrf: string | null): string {
  if (csrf === null) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < csrf.length; i += 1) h = Math.imul(h ^ csrf.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function owedAttempt(): PendingAttempt | null {
  try {
    const raw = window.localStorage.getItem(SESSION_ATTEMPT_KEY);
    const v = raw === null ? null : (JSON.parse(raw) as Partial<PendingAttempt> | null);
    if (v && typeof v.id === "string" && typeof v.csrf === "string" && typeof v.at === "number") return v as PendingAttempt;
  } catch {
    /* unreadable: this page's own copy */
  }
  return attemptHere;
}

function mintAttemptId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return `w${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === "function") {
    return `w${Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The attempt this renewal goes out as: the one still owed, or a new one, written down BEFORE it goes. */
function attemptFor(csrf: string | null): string {
  const owed = owedAttempt();
  // 0 <= age < window: a stamp in the future is any script's to write, and it is discarded.
  const age = owed === null ? -1 : Date.now() - owed.at;
  if (owed !== null && age >= 0 && age < ACCESS_WINDOW_MS && (csrf === null || owed.csrf === csrfMark(csrf))) {
    return owed.id;
  }
  const next: PendingAttempt = { id: mintAttemptId(), csrf: csrfMark(csrf), at: Date.now() };
  attemptHere = next;
  durableSet(SESSION_ATTEMPT_KEY, JSON.stringify(next), "session-attempt");
  return next.id;
}

/** A definitive answer settles the attempt; the next renewal is a new one. */
function settleAttempt(): void {
  attemptHere = null;
  durableRemove(SESSION_ATTEMPT_KEY, "session-attempt");
}

export async function resumeSession(opts: ResumeOptions = {}): Promise<ResumeAnswer> {
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

    const request = new AbortController();
    inFlightRequest = request;
    try {
      // INSIDE the `try`, so the `finally` below clears `inFlight`. Outside it, one refusal
      // left the module's dedupe holding a settled promise for the life of the page and every
      // later resume — including `api()`'s recovery — answered `false` without asking anything.
      // Found by running the cases in file order rather than one at a time.
      if (opts.mayProceed && !opts.mayProceed()) return "refused";
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
      // Who this refresh leaves under — BEFORE it goes: an erased account's answer clears the jar.
      const erasedBefore = erasedCapture();
      const attemptId = attemptFor(csrf);
      const res = await fetch(REFRESH_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...ERASED_DECLARATION,
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: JSON.stringify({ attemptId }),
        cache: "no-store",
        credentials: "same-origin",
        /* The server spends the presented token the moment it claims it, so an answer that dies with its
         * page (the tab closed, a link followed out) leaves the jar holding a spent token, whose next
         * presentation past the grace window is swept as reuse. `keepalive` lets the browser finish the
         * request and store the rotated cookies after the page is gone; a mint's abort still stops it
         * while the page lives. */
        keepalive: true,
        signal: request.signal,
      });
      if (request.signal.aborted) return superseded(null);
      // 204 with fresh Set-Cookie is success; a 401 means the family is
      // gone and the server has already cleared the whole jar, so the next navigation is an honest
      // signed-out landing. Both answers are told to the session-truth store, because both are
      // DEFINITIVE: every other 401 in this product is one request's evidence (the scheduler spends
      // sixty seconds confirming one), but the refresh endpoint IS the recovery path — its coded
      // 401 means the family is revoked, with no stronger confirmation to wait for; a 204 is the
      // opposite fact with the same authority (`markSessionAlive` publishes a revival). The death
      // latch additionally requires the door's own refusal code: a 401 without one is a platform
      // interposing itself.
      if (res.status === 204) {
        settleAttempt();
        recordRefresh({ outcome: "minted", status: 204, code: null, errorClass: null, retryAfterMs: null });
        noteSessionMinted();
        markSessionAlive();
        return "resumed";
      }
      // THE ACCOUNT WAS ERASED: the erased door's, never `markSessionDead` — no heal schedule
      // can mint a session for an account that is gone (`shell/account-erased.ts`).
      const erased = await erasedAnswerOf(res);
      if (erased !== null) {
        const heard = hearAccountErased(erased.named, erasedBefore) === "erased";
        if (heard) settleAttempt();
        recordRefresh({
          outcome: heard ? "revoked" : "unavailable", status: 410, code: "account_erased", errorClass: null,
          retryAfterMs: null,
        });
        return heard ? "refused" : "unavailable";
      }
      // Read ONCE, for both facts: whether the envelope is ours, and which code it names. Only the
      // refresh door's own refusal is a verdict (`isSessionRefusal`, the phone's reading too).
      const code = res.status === 401 ? await refusalCode(res) : null;
      if (isSessionRefusal(res.status, code)) {
        settleAttempt();
        recordRefresh({ outcome: "revoked", status: 401, code, errorClass: null, retryAfterMs: null });
        markSessionDead();
        return "refused";
      }
      // Everything else: an uncoded 401 or one naming another code (a platform interposing), a
      // 5xx, a 403, a body this client cannot read. The refresh did not happen and nothing was
      // learned about the session — which is a different fact from "revoked" and is recorded as one.
      recordRefresh({
        outcome: "unavailable", status: res.status, code: code ?? await faultCode(res), errorClass: null,
        retryAfterMs: retryAfterMsOf(res) ?? null,
      });
      return "unavailable";
    } catch (err) {
      if (request.signal.aborted) return superseded(err);
      // Offline, aborted, DNS — not resumable right now, and no answer to read a code from.
      recordRefresh({
        outcome: "unavailable", status: 0, code: null, errorClass: classOf(err), retryAfterMs: null,
      });
      return "unavailable";
    } finally {
      if (inFlightRequest === request) inFlightRequest = null;
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

/** A sign-in minted past this refresh: nothing it learned is about the jar that holds now. */
function superseded(err: unknown): "refused" {
  settleAttempt();
  recordRefresh({
    outcome: "superseded", status: 0, code: null, errorClass: err === null ? null : classOf(err), retryAfterMs: null,
  });
  return "refused";
}

/**
 * The refusal's own code, when this came from OUR envelope — `{error: {code}}` — rather than
 * from a platform. `null` means the answer was not ours, which is what keeps a deployment
 * protection page or a proxy interstitial from counting as the server's verdict.
 */
async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** The same read on a NON-verdict answer: a fault's code is for the log, never for a decision. */
async function faultCode(res: Response): Promise<string | null> {
  return res.bodyUsed ? null : refusalCode(res);
}

/**
 * `Retry-After` → milliseconds, or `undefined`. Integer seconds only: the HTTP-date form means
 * trusting this client's clock to subtract it, and every `Retry-After` this API sends is
 * delta-seconds (`packages/api/src/middleware.ts`). `0` and negatives are `undefined` too — a
 * backoff seeded with 0 spins. No upper clamp here: the ceiling is `confirm-schedule.ts`'s. The one
 * reader, shared with `api-client.ts`, which already depends on this module.
 */
export function retryAfterMsOf(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
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
 * RENEWAL AHEAD OF EXPIRY. The access cookie lives fifteen minutes, and waiting for a request to
 * meet its 401 puts the refresh, and any fault it meets, in front of the person. So every minted or
 * confirmed session arms ONE renewal at ~80% of the window, jittered, while the tab is visible,
 * through `resumeSession` — the one refresh path, with its lock, its single flight and its verdicts.
 * A fault retries on the confirm ladder; past it `api()`'s refresh-on-401 is the belt. `tf_csrf` is
 * re-minted with every session, so a changed value inside the lock means another tab renewed.
 */
export const ACCESS_WINDOW_MS = 15 * 60_000;
export const RENEW_AT_FRACTION = 0.8;
export const RENEW_JITTER_MS = 60_000;

/**
 * WHEN THIS BROWSER'S JAR LAST RECEIVED A SESSION, shared by every tab and page load. The window
 * is counted from the MINT: a page confirming a session minted before it had counted from itself,
 * and the cookie lapsed first (every 401-led refresh the tester logged followed a page load). This
 * client's clock at both ends; no account, no token. A jar that refuses storage keeps this page's
 * own mint, so a refused write never reads as "unknown" twice.
 */
export const SESSION_MINTED_KEY = "ohmail.session.mintedAt";
let mintedHere: number | null = null;

function noteSessionMinted(): void {
  // A new session is the one gesture that lifts an erased-account wall (`account-erased.ts`).
  clearAccountErased();
  mintedHere = Date.now();
  durableSet(SESSION_MINTED_KEY, String(mintedHere), "session-mint");
}

/** The latest mint this origin recorded, or `null` when nothing says how old the session is. */
function lastSessionMint(): number | null {
  let stored: number | null = null;
  try {
    const raw = window.localStorage.getItem(SESSION_MINTED_KEY);
    if (raw !== null && /^\d+$/.test(raw)) stored = Number(raw);
  } catch {
    /* unreadable: the page's own copy, if any */
  }
  if (stored === null) return mintedHere;
  return mintedHere === null ? stored : Math.max(stored, mintedHere);
}

let renewTimer: ReturnType<typeof setTimeout> | null = null;
/** What the jar held when the renewal was armed: a skip is decided against it. */
let armed: { owner: string; csrf: string | null } | null = null;
/** The timer fired while the tab was hidden; the next `visible` pays it. */
let renewOwed = false;
let watchingVisibility = false;

function tabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function stopRenewal(): void {
  if (renewTimer !== null) clearTimeout(renewTimer);
  renewTimer = null;
  armed = null;
  renewOwed = false;
}

function armRenewal(): void {
  stopRenewal();
  if (typeof window === "undefined") return;
  const owner = readOwner();
  if (owner === null) return;
  armed = { owner, csrf: csrfToken() };
  const lead = ACCESS_WINDOW_MS * RENEW_AT_FRACTION - Math.random() * RENEW_JITTER_MS;
  // From the mint, capped at a whole lead (a clock stepped back); unknown age renews at once.
  const minted = lastSessionMint();
  const due = minted === null ? 0 : Math.min(lead, minted + lead - Date.now());
  renewTimer = setTimeout(() => { renewTimer = null; void renew(1); }, Math.max(1, due));
  if (!watchingVisibility && typeof document !== "undefined") {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", () => {
      if (renewOwed && !tabHidden()) { renewOwed = false; void renew(1); }
    });
  }
}

/**
 * Still this jar's renewal to make? The same account, and a CSRF value that is either the one
 * armed with or gone (the access cookie lapsed while the tab slept — renew now). A different
 * value is another tab's fresh session.
 */
function renewalOwed(): boolean {
  if (armed === null || readOwner() !== armed.owner) return false;
  const csrf = csrfToken();
  return csrf === null || csrf === armed.csrf;
}

async function renew(attempt: number): Promise<void> {
  if (armed === null || sessionIsDead()) return;
  if (tabHidden()) { renewOwed = true; return; }
  const owner = armed.owner;
  // A 204 publishes a revival, and the revival re-arms from its own moment.
  if (await resumeSession({ mayProceed: renewalOwed }) === "resumed") return;
  if (!renewalOwed()) {
    if (armed !== null && readOwner() === owner) armRenewal();
    return;
  }
  const report = lastRefreshReport();
  if (report?.outcome !== "unavailable" || attempt >= CONFIRM_ATTEMPTS) return;
  renewTimer = setTimeout(() => { renewTimer = null; void renew(attempt + 1); },
    nextConfirmDelay(attempt, report.retryAfterMs));
}

subscribeSessionRevival(armRenewal);
subscribeSessionTruth(() => { if (sessionIsDead()) stopRenewal(); });

/** Test seam: is a renewal armed right now? */
export function renewalArmedForTests(): boolean {
  return armed !== null;
}

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
   * A factor's 401 is an answer. A wrong step-up code is refused 401 `unauthorized`, which is also
   * what a lapsed session gets, so a refresh here sent the same code twice: two attempts against
   * the sign-in throttle and a rotated session per wrong code. `/pair/redeem` spends a single-use
   * token. The set is not remembered: `factor-routes-never-refresh.test.ts` derives every route
   * that checks a factor or a single-use credential from the server and refuses one this list does
   * not cover.
   */
  "/auth/step-up/",
  "/pair/redeem",
  /*
   * `/auth/logout`, and the web's sign-out door below `/auth/refresh`, which that entry already
   * covers: a 401 at either is an answer, never an accident. Refreshing first re-mints a session
   * in order to revoke it, which is absurd on its own terms; it also took the sign-out through a
   * nested acquire of the ceremony lock, which is how the whole sign-out came to hang. The door's
   * coded 401 is its verdict on the family (`sign-out.ts` reads it so); `/auth/logout`'s says only
   * that its access token did not resolve, which is why the web no longer presses it.
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
