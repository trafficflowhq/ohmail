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

import { CREDENTIAL_REFUSED, isSessionRefusal } from "@ohmail/client-engine";
import { csrfToken } from "./csrf";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "./shell/confirm-schedule";
import { durableRemove, durableSessionRemove, durableSessionSet, durableSet } from "./shell/durable";
import { readOwner } from "./shell/owner-cookie";
import { isDemoOwned, storageOwner } from "./shell/storage-owner";
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
 * Is a refresh of this tab in flight now? `api()` and the engine's transport ask before a request
 * leaves and wait for it (`refreshSettled`): a rotation replaces the access token, so a request that
 * leaves beside one carries the token being replaced and is refused once (cold boot, and every
 * scheduled renewal with a request in flight).
 */
export function refreshInFlight(): boolean {
  return inFlight !== null;
}

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
 * ANOTHER TAB'S RENEWAL, WAITED FOR. {@link refreshSettled} orders a request behind this tab's own
 * renewal; another tab's holds the same lock, and its name stands in the shared record from just
 * before it goes until its answer lands. A request beside it carries the access token that rotation
 * replaces, is refused once, and its recovery rotates again. So it asks the lock in SHARED mode,
 * granted once no renewal holds it, and lets go at once, within {@link SETTLE_DEADLINE_MS}. Answers
 * whether it waited; with no record, no lock manager or this tab's own renewal out, it does not.
 */
export async function otherTabRenewalSettled(): Promise<boolean> {
  if (inFlight !== null || !renewalOutElsewhere()) return false;
  let locks: LockManager | undefined;
  try {
    locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  } catch {
    return false;
  }
  if (!locks?.request) return false;
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      locks.request(REFRESH_LOCK, { mode: "shared", signal: ctl.signal }, async () => undefined).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve(); }, SETTLE_DEADLINE_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return true;
}

/** A renewal's name in the shared record, young, over a jar its answer has not moved yet. */
function renewalOutElsewhere(): boolean {
  let owed: Partial<PendingAttempt> | null = null;
  try {
    const raw = window.localStorage.getItem(SESSION_ATTEMPT_KEY);
    owed = raw === null ? null : (JSON.parse(raw) as Partial<PendingAttempt> | null);
  } catch {
    return false;
  }
  if (owed === null || typeof owed.csrf !== "string" || typeof owed.at !== "number") return false;
  const age = Date.now() - owed.at;
  return age >= 0 && age < SETTLE_DEADLINE_MS && owed.csrf === csrfMark(csrfToken());
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
  /**
   * THE NAME THIS PRESENTATION GOES OUT UNDER, in place of `attemptFor`'s. Only the late-answer
   * repair passes it: the row it presents was killed under that name, and past the server's grace a
   * new name reads as a second holder. A presentation that names itself arms no watch.
   */
  attemptId?: string;
  /**
   * THE RESUME SPLASH'S PRESENTATION, which a reload of this tab can overtake: its keepalive request
   * outlives the page and its answer lands in the jar after it. Noted for this tab while it is out;
   * the next page's splash, finding the note young over a jar its answer has not moved, waits for
   * that answer instead of presenting the same token again ({@link SPLASH_PRESENTATION_KEY}).
   */
  landing?: boolean;
}

/**
 * THE SPLASH'S PRESENTATION OUT, for the next page of this tab: per tab (`sessionStorage`), holding
 * its time, the jar's `tf_csrf` mark and the account, never a token. Taken back when the page hears
 * an answer; a page that unloaded first leaves it for its successor.
 */
export const SPLASH_PRESENTATION_KEY = "ohmail.session.splashOut";
const LANDING_POLL_MS = 100;

interface PresentationOut { at: number; mark: string; owner: string | null }

/** The previous page's presentation in this tab, young, over this jar unmoved and this account. */
function presentationOut(): PresentationOut | null {
  let out: Partial<PresentationOut> | null = null;
  try {
    const raw = window.sessionStorage.getItem(SPLASH_PRESENTATION_KEY);
    out = raw === null ? null : (JSON.parse(raw) as Partial<PresentationOut> | null);
  } catch {
    return null;
  }
  if (out === null || typeof out.at !== "number" || typeof out.mark !== "string") return null;
  const owner = typeof out.owner === "string" ? out.owner : null;
  const age = Date.now() - out.at;
  if (age < 0 || age >= SETTLE_DEADLINE_MS || out.mark !== csrfMark(csrfToken()) || owner !== readOwner()) return null;
  return { at: out.at, mark: out.mark, owner };
}

/** Did that presentation's answer land: the jar moved off its mark, for the same account, within the bound? */
async function presentationLanded(out: PresentationOut): Promise<boolean> {
  const until = out.at + SETTLE_DEADLINE_MS;
  for (;;) {
    if (readOwner() !== out.owner) return false;
    if (csrfMark(csrfToken()) !== out.mark) return true;
    const left = until - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(LANDING_POLL_MS, left)));
  }
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

/**
 * THE LATE-ANSWER REPAIR IN FLIGHT, with whether its own question, asked inside the lock, refused it.
 * A repair so refused did not happen: a caller that joined it asks for itself, as it would have with
 * no repair in flight. Every other answer is shared with its joiners, as `inFlight`'s is.
 */
let inFlightRepair: { answer: Promise<ResumeAnswer>; asked: { refused: boolean } } | null = null;

export async function resumeSession(opts: ResumeOptions = {}): Promise<ResumeAnswer> {
  const repair = inFlightRepair;
  if (repair !== null) {
    const answer = await repair.answer;
    return answer === "refused" && repair.asked.refused ? resumeSession(opts) : answer;
  }
  if (inFlight) return inFlight;
  const asked = { refused: false };
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
    let noted = false;
    try {
      // INSIDE the `try`, so the `finally` below clears `inFlight`. Outside it, one refusal
      // left the module's dedupe holding a settled promise for the life of the page and every
      // later resume — including `api()`'s recovery — answered `false` without asking anything.
      // Found by running the cases in file order rather than one at a time.
      if (opts.mayProceed && !opts.mayProceed()) {
        asked.refused = true;
        return "refused";
      }
      // A RELOADED SPLASH: the previous page's presentation of this jar is still out. Its answer is
      // waited for; the wait gives the jar time to change hands, so the caller's question is asked again.
      if (opts.landing === true && opts.attemptId === undefined) {
        const out = presentationOut();
        if (out !== null) {
          const landed = await presentationLanded(out);
          if (opts.mayProceed && !opts.mayProceed()) {
            asked.refused = true;
            return "refused";
          }
          if (landed) return landedFromThePreviousPage();
        }
        durableSessionSet(SPLASH_PRESENTATION_KEY,
          JSON.stringify({ at: Date.now(), mark: csrfMark(csrfToken()), owner: readOwner() }), "session-splash");
        noted = true;
      }
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
      const attemptId = opts.attemptId ?? attemptFor(csrf);
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
        // A repair's own answer arms no watch: one repair per renewal, then the 12-minute belt.
        watchForLateAnswer(opts.attemptId === undefined ? attemptId : null);
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
      // Heard: the next page has nothing to wait for. A page that unloaded first never gets here.
      if (noted) durableSessionRemove(SPLASH_PRESENTATION_KEY, "session-splash");
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
  if (opts.attemptId !== undefined) inFlightRepair = { answer: started, asked };
  void started.finally(() => { inFlight = null; inFlightRepair = null; });
  return started;
}

/** The previous page's answer is this session: settled as this page's own 204 would be, nothing presented. */
function landedFromThePreviousPage(): "resumed" {
  settleAttempt();
  durableSessionRemove(SPLASH_PRESENTATION_KEY, "session-splash");
  recordRefresh({ outcome: "minted", status: 204, code: null, errorClass: null, retryAfterMs: null });
  noteSessionMinted();
  markSessionAlive();
  return "resumed";
}

/** Sign-out's door for the splash's note. Answers what could not be removed. */
export function forgetSplashPresentation(): string[] {
  return durableSessionRemove(SPLASH_PRESENTATION_KEY, "session-splash") === "lost" ? [SPLASH_PRESENTATION_KEY] : [];
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
let mintsHere = 0;

/**
 * How many sessions this page has received (a renewal's 204 or a ceremony's mint). A request that
 * meets a 401 after this moved since it LEFT carried the access token a renewal replaced: it is sent
 * once more on the new jar, never renewed again — a second rotation refused every request that had
 * left beside the first (measured on a cold boot: three rotations for one page load).
 */
export function sessionMints(): number {
  return mintsHere;
}

function noteSessionMinted(): void {
  // A new session is the one gesture that lifts an erased-account wall (`account-erased.ts`).
  clearAccountErased();
  mintedHere = Date.now();
  mintsHere += 1;
  durableSet(SESSION_MINTED_KEY, String(mintedHere), "session-mint");
  // A sign-in's mint is recorded as a renewal's is: a live page's answer, never a dead page's.
  noteAnswer();
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

/**
 * A LATE ANSWER, REPAIRED BY THE LIVE TAB. A renewal outlives its page (`keepalive`), so a page that
 * unloaded mid-renewal can have its answer stored AFTER the next page presented the same token and
 * stored its own: the jar then holds a row the server killed, and the next renewal signs out. Every
 * mint a live page sees records its `tf_csrf` mark here (never the value); for one window after its
 * own 204 a tab polls the jar, and a mark no live page recorded is a dead page's answer. Presented
 * once more under the name this tab's renewal went out as, inside the server's grace, it converges.
 */
export const SESSION_ANSWER_KEY = "ohmail.session.lastAnswer";
/**
 * THE TAB'S WATCH, FOR ITS NEXT PAGE: a resume splash reloads itself just after the 204 it armed on.
 * Per tab (`sessionStorage`) and per account (`storageOwner()`), holding the mark, the renewal's name,
 * its time and the account, never a token, a CSRF value or a cookie. The first page that confirms
 * that account's session inside the window continues the watch; any other account's note is removed.
 */
export const SESSION_WATCH_PREFIX = "ohmail.session.lateWatch.";
/** The server's `refreshReuseGraceMs`, stated once on this side; a root test holds the two equal. */
export const REFRESH_GRACE_MS = 60_000;
/** The answer's way back and the repair's way out, taken from the grace; the watch is the rest. */
export const LATE_ANSWER_TRANSIT_MS = 5_000;
export const LATE_ANSWER_WATCH_MS = REFRESH_GRACE_MS - LATE_ANSWER_TRANSIT_MS;
export const LATE_ANSWER_POLL_MS = 500;

/** This page's copy of the last mark it recorded, for a jar that refuses storage. */
let answerHere: string | null = null;
/** The watch's next poll: one per tab, replaced or ended by every own 204. */
let lateTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether this page has read its tab's note: once, at its first confirmed session. */
let noteRead = false;

interface LateWatchNote { mark: string; name: string; at: number; account: string }

function noteAnswer(): void {
  const csrf = csrfToken();
  if (csrf === null) return;
  answerHere = csrfMark(csrf);
  durableSet(SESSION_ANSWER_KEY, answerHere, "session-answer");
}

/** Did a live page of this origin record this mark: this page, or the one shared record? */
function answerRecorded(mark: string): boolean {
  if (mark === answerHere) return true;
  try {
    return window.localStorage.getItem(SESSION_ANSWER_KEY) === mark;
  } catch {
    return false;
  }
}

/** The account a note is written for and read by: the jar's owner, never the demo's. */
function watchAccount(): string | null {
  // The cookie is asked first: `storageOwner()` says out loud when there is none, and a healthy
  // renewal writes no line (`session-death.test.ts`).
  if (readOwner() === null) return null;
  const owner = storageOwner();
  return owner === null || isDemoOwned(owner) ? null : owner;
}

const noteKey = (account: string): string => `${SESSION_WATCH_PREFIX}${account}`;

/** This tab's notes, every account's; `null` when the jar cannot be walked. */
function noteKeys(): string[] | null {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key !== null && key.startsWith(SESSION_WATCH_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return null;
  }
}

/** Sign-out's door: the poll stops and every account's note goes. Answers what could not be removed. */
export function forgetLateAnswerWatch(): string[] {
  if (lateTimer !== null) clearTimeout(lateTimer);
  lateTimer = null;
  const keys = noteKeys();
  if (keys === null) return [`${SESSION_WATCH_PREFIX}*`];
  return keys.filter((key) => durableSessionRemove(key, "session-watch") === "lost");
}

/** At an own 204: watch for the presentation that went out as `name`; `null` (a repair's) ends it. */
function watchForLateAnswer(name: string | null): void {
  const account = watchAccount();
  const csrf = csrfToken();
  if (name === null || csrf === null) {
    if (lateTimer !== null) clearTimeout(lateTimer);
    lateTimer = null;
    // A repair's answer takes its note too, or the tab's next page would watch again.
    if (account !== null) durableSessionRemove(noteKey(account), "session-watch");
    return;
  }
  const mark = csrfMark(csrf);
  const at = Date.now();
  if (account !== null) {
    const note: LateWatchNote = { mark, name, at, account };
    durableSessionSet(noteKey(account), JSON.stringify(note), "session-watch");
  }
  armLateWatch(mark, name, at, account);
}

/** A confirmed session: other accounts' notes go; the first one in this page continues its own. */
function readLateAnswerNote(): void {
  const account = watchAccount();
  for (const key of noteKeys() ?? []) {
    if (account === null || key !== noteKey(account)) durableSessionRemove(key, "session-watch");
  }
  if (noteRead) return;
  noteRead = true;
  if (account === null || lateTimer !== null) return;
  let note: Partial<LateWatchNote> | null = null;
  try {
    const raw = window.sessionStorage.getItem(noteKey(account));
    note = raw === null ? null : (JSON.parse(raw) as Partial<LateWatchNote> | null);
  } catch {
    return;
  }
  if (note === null) return;
  if (note.account !== account || typeof note.mark !== "string" || typeof note.name !== "string"
    || typeof note.at !== "number") {
    durableSessionRemove(noteKey(account), "session-watch");
    return;
  }
  armLateWatch(note.mark, note.name, note.at, account);
}

subscribeSessionRevival(readLateAnswerNote);

/** Poll the jar until `at` plus the window, firing at most once, for `account`; `own` is the answer's mark. */
function armLateWatch(own: string, name: string, at: number, account: string | null): void {
  if (lateTimer !== null) clearTimeout(lateTimer);
  lateTimer = null;
  if (typeof window === "undefined") return;
  // The bound by clock AND by count, both from the answer's own time: a throttled timer, or a test
  // clock that never moves. A time ahead of this clock is discarded.
  const budget = Math.ceil((LATE_ANSWER_WATCH_MS - (Date.now() - at)) / LATE_ANSWER_POLL_MS);
  if (Date.now() < at || budget <= 0) return;
  let polls = 0;
  // The jar moved to a mark no live page recorded, and is still the armed account's: its owner is read
  // the way the arm read it. Asked at the poll and again inside the lock. Another account's jar ends
  // the watch and takes its note: it is never presented under this account's renewal name.
  const lateAnswerHeld = (): boolean => {
    const csrf = csrfToken();
    if (csrf === null || sessionIsDead()) return false;
    if (watchAccount() !== account) {
      if (account !== null) durableSessionRemove(noteKey(account), "session-watch");
      return false;
    }
    const mark = csrfMark(csrf);
    return mark !== own && !answerRecorded(mark);
  };
  const poll = (): void => {
    lateTimer = null;
    polls += 1;
    try {
      const age = Date.now() - at;
      if (age < 0 || age >= LATE_ANSWER_WATCH_MS || polls >= budget) return;
      const csrf = csrfToken();
      if (csrf === null || sessionIsDead()) return;
      if (csrfMark(csrf) === own) {
        lateTimer = setTimeout(poll, LATE_ANSWER_POLL_MS);
        return;
      }
      // Moved: a recorded mark is a live page's rotation and ends the watch; otherwise ONE repair.
      if (lateAnswerHeld()) void resumeSession({ attemptId: name, mayProceed: lateAnswerHeld });
    } catch {
      /* a page going away: the watch ends with it */
    }
  };
  lateTimer = setTimeout(poll, LATE_ANSWER_POLL_MS);
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
  if (!watchingVisibility && typeof document !== "undefined") {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", () => {
      if (renewOwed && !tabHidden()) { renewOwed = false; void renew(1); }
    });
  }
  // DUE NOW is started HERE, synchronously: the confirm that publishes this revival opens the sync
  // gate on its next line, and a renewal one timer tick later raced the first snapshot, which left
  // on the access token the rotation was replacing and answered 401.
  // In flight first, every request waits for it (`refreshInFlight`).
  if (due <= 0) { void renew(1); return; }
  renewTimer = setTimeout(() => { renewTimer = null; void renew(1); }, due);
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
 * new `tf_csrf` alongside the new session, so the retry fixes both. A 401
 * naming the CREDENTIAL is the answer (a wrong code), and is never retried.
 */
export function isRecoverable(status: number, code?: string): boolean {
  if (status === 401) return code !== CREDENTIAL_REFUSED;
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
   * A factor's 401 is an answer. A server older than `credential_refused` refuses a wrong step-up
   * code 401 `unauthorized`, which is also what a lapsed session gets, so a refresh here sent the
   * same code twice: two attempts against the sign-in throttle and a rotated session per wrong
   * code. The list stays as that belt. `/pair/redeem` spends a single-use token. The set is not
   * remembered: `factor-routes-never-refresh.test.ts` derives every route that checks a factor or a
   * single-use credential from the server and refuses one this list does not cover.
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
