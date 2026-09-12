/**
 * The webapp's HTTP client for everything that is NOT delta-sync (that is `@ohmail/client-engine`'s HttpAdapter): auth + 2FA
 * enrollment, mailboxes, billing. Three facts keep it small. Same-origin: the API sits behind this app's own `/api` rewrite —
 * no CORS, no preflight, default `same-origin` credentials; an absolute `NEXT_PUBLIC_API_BASE` is a build failure in
 * `next.config.mjs`. The session lives in HttpOnly cookies this client cannot read; the one readable cookie is `tf_csrf`,
 * echoed in `X-CSRF-Token` on every cookie-authenticated mutation — "am I signed in?" is answered by `GET /auth/session`,
 * never a variable. And `Content-Type: application/json` on every body (`withRequestGuard` 415s anything else). Errors are
 * values: {@link ApiError} carries the server's own sentence, code and details verbatim — the UI displays, never re-derives
 * (`test/onboarding.test.ts` forbids the sentences in source).
 */

import { csrfToken as readCsrfToken } from "./csrf";
import { isRecoverable, mayRefreshFor, resumeSession, withSessionCookieLock } from "./session-refresh";
import { readOwnerMarker, rememberOwner } from "./shell/owner-cookie";

/** The `/api` prefix the same-origin rewrite serves, or `null` on a build with no API armed. */
export const API_BASE: string | null = process.env.NEXT_PUBLIC_API_BASE ?? null;

/** Is this build wired to a server at all? `false` ⇒ demo/gate only. */
export const apiConfigured = (): boolean => typeof API_BASE === "string" && API_BASE.length > 0;

/**
 * A refusal from the API, with the SERVER's own message.
 *
 * `code` is the stable machine name (`invite_used`, `mailbox_limit_reached`,
 * `payment_required`, `step_up_required`, …). `message` is the sentence the service
 * wrote for a human. `details` is whatever the service attached — for the mailbox gate that
 * is `{mailboxLimit, mailboxCount, accessReason}`, which is what lets the UI say
 * "2 of 2 connected on Solo".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /**
     * What the RESPONSE was, as distinct from what it said — see {@link ApiWire}. Defaulted so
     * every existing construction (and every test's) keeps its exact meaning: a hand-built
     * `ApiError` did not come off a wire, and `coded: false` is the truthful thing to say
     * about one.
     */
    readonly wire: ApiWire = { coded: false },
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Facts about the response itself, which `status` and `code` cannot carry. `attempt()` fills `code:
 * "internal"` when there is no envelope, so a platform 502 with an HTML body and our own 500 arrived
 * identically — one means a route faulted, the other means nothing of ours ran. `coded` is the fact
 * that was being thrown away: did this refusal come from OUR envelope? `retryable` and
 * `retryAfterMs` come along because they were on the wire and dropped (`db_busy` sends both).
 * `retryable` is carried, NOT a verdict predicate: `rejectionOf` defaults it from the status, so
 * `retryable === false` is true of almost every clean refusal — it is here for backoff and reporting
 * (`sync-scheduler.ts` records the cost).
 */
export interface ApiWire {
  /** Did this come from our `{error:{code}}` envelope, rather than from a platform? */
  coded: boolean;
  /** The server's own `error.retryable`, when it stated one. Never a verdict — see above. */
  retryable?: boolean;
  /** `Retry-After`, in milliseconds, when the header named integer seconds. */
  retryAfterMs?: number;
}

/**
 * `Retry-After` → milliseconds, or `undefined`. Integer seconds only: RFC
 * 9110 also allows an HTTP-date, and parsing one means trusting the client
 * clock to subtract it — a machine minutes out yields a negative or absurd
 * delay from a correct header. Every `Retry-After` this API sends is
 * delta-seconds (`packages/api/src/middleware.ts`), so the date form is
 * refused and the caller falls back to its own backoff. `0` and negatives
 * are `undefined` too — "retry immediately" from a server that just refused
 * would spin a backoff seeded with 0. No upper clamp: the ceiling belongs to the consumer (`confirm-schedule.ts`).
 */
function retryAfterMsOf(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

/** The one network failure that is not a refusal: we never reached the server. */
export const OFFLINE_CODE = "network_unreachable";

interface RequestOptions {
  // `PUT` joined the union for `/away-responder`, the one endpoint in the contract whose write is a
  // FULL REPLACE rather than a partial update. The verb is part of that meaning, so it is spelled
  // rather than folded into `PATCH`: the route reads an omitted field as "reset it", and a client
  // that called it with PATCH would be describing the opposite of what happens.
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Extra headers (`Idempotency-Key`). `Content-Type` and CSRF are handled here. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * The front door asked for this, and nobody else may (see
   * {@link apiOwnerHolds}): a request marked `ceremony` is exempt from the
   * account boundary because it is how an identity is ESTABLISHED — it
   * necessarily runs before anybody could be bound. On the request, not the
   * path: `/auth/session` is two requests wearing one path — the front
   * door's confirmation, and six ordinary shell reads that want the
   * signed-in person's details. A path-wide exemption handed all six the
   * other account's answer. A flag is something a caller asks for by name and a reviewer can grep for.
   */
  ceremony?: boolean;
}

/**
 * The token reader, kept on this module's public surface — one line of forwarding, not a re-export,
 * and the difference is load-bearing for the desktop build. The implementation is in `app/csrf.ts`
 * (`session-refresh.ts` needs the same reader; defining it here closes a cycle).
 * `apps/desktop/src/no-api-client.ts` mirrors this module's exported surface as refusals; a bare
 * `export { csrfToken }` emits an `import { csrfToken } from "./csrf"` in the `.d.ts`, which the
 * stand-in reproduced relative to `apps/desktop/src` — where no such module exists; the stub
 * stopped compiling and the pre-push gate caught it. A `function` declaration's `.d.ts` form names
 * no other module, so the forwarding is explicit.
 */
export function csrfToken(): string | null {
  return readCsrfToken();
}


/**
 * Whose account is this client speaking for — the one boundary every Cloud
 * call crosses. The mirror's owner gate wraps the engine's ADAPTER, and most
 * of the signed-in surface never goes near one: a browser signed into A
 * holding a shell for B could regenerate B's recovery codes and TOTP secret,
 * mint pairing tokens, read billing. A per-pane check closes today's panes,
 * not tomorrow's; this is the seam every one goes through. The allow-list is
 * NOT "/auth" (half of /auth manages credentials for an existing identity);
 * it names the ceremony paths one by one. Off until bound: a forgetting surface stays permissive.
 */
/**
 * EXACT MATCHES. One route each, and nothing beneath them.
 *
 * The list was matched with `startsWith` throughout, and review found what that quietly conferred:
 * `/auth/verify-email` also exempted `/auth/verify-email/resend`, which is a different route with
 * a different meaning — the server protects it and sends mail to the CURRENT session's address.
 * An onboarding page left open while another tab signed in could press resend and send
 * verification mail for that other account. A prefix is a decision about every route that will
 * ever live below it, including the ones nobody has written yet, so it has to be asked for.
 */
const OWNER_FREE_EXACT = [
  "/hello",
  "/version",
  "/health",
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
  "/auth/verify-email",
  // The sign-in ceremony's second factor. VERIFY only — enrolment and generation are account
  // management and stay gated; see the header.
  "/auth/2fa/totp/verify",
  "/auth/2fa/recovery-codes/verify",
] as const;

/**
 * PREFIX MATCHES, asked for by name. One entry, and it earns it: the WebAuthn assertion is two
 * routes (`/options` and `/verify`) that are one ceremony, and both must be reachable by somebody
 * who has no confirmed account yet because they are signing in.
 */
const OWNER_FREE_PREFIXES = [
  "/auth/2fa/webauthn/assert/",
] as const;

/*
 * `/auth/session` is NOT on that list any more; the removal is the point:
 * it is two requests wearing one path. The front door asks it whether this
 * browser holds a session at all — before anybody could be bound; that call
 * passes `ceremony: true`. Six ordinary shell reads ask it for the
 * signed-in person's details, and a path-wide exemption handed all six the
 * other account's answer — they are gated like every other account read.
 * The flag is on the REQUEST so the exemption is asked for by name and
 * greppable, not a property the route confers on everybody.
 */

/**
 * What this client is speaking for — a single nullable `expectedOwner`
 * conflated states needing opposite defaults. `public`: marketing pages,
 * /login, unasking tests — every request goes. `pending`: a shell is up and
 * the server has not answered; `null` said this too, so a deep-linked pane
 * over a warm mirror for A passed every check while another tab established
 * B. `bound`: the server named the account. `blocked`: a sign-out the
 * server did not confirm. A named shell is never `public` — `pending` fails
 * closed like `bound`; the window is one round trip.
 */
type OwnerBinding =
  | { kind: "public" }
  | { kind: "pending"; owner: string | null }
  | { kind: "bound"; owner: string }
  | { kind: "blocked" };

let binding: OwnerBinding = { kind: "public" };

/**
 * BIND this client to an account — called with the id `GET /auth/session` returned, from the one
 * classifier that reads it (`session-outcome.ts`). `null` returns it to `public`, which is what a
 * server-CONFIRMED sign-out does.
 */
export function bindApiOwner(accountId: string | null): void {
  binding = accountId === null ? { kind: "public" } : { kind: "bound", owner: accountId };
}

/**
 * A SHELL IS MOUNTING and nobody has confirmed it yet. `owner` is the account the shell already
 * believes it is for — the marker a warm open read to choose its mirror — or `null` on a cold
 * load, where the confirm is the first thing that will know.
 *
 * Never widens: a client already `bound` or `blocked` stays where it is, so a remount cannot
 * downgrade a confirmed shell into a pending one, and a pending call cannot undo a failed
 * sign-out's block.
 */
export function pendApiOwner(owner: string | null): void {
  if (binding.kind === "bound" || binding.kind === "blocked") return;
  binding = { kind: "pending", owner };
}

/**
 * A SIGN-OUT WAS ASKED FOR AND THE SERVER DID NOT CONFIRM IT. Fail closed until somebody signs in
 * again: the account surfaces refuse, and only the ceremony — including the retry of the logout
 * itself, and the sign-in that follows — still goes out.
 */
export function blockApiOwner(): void {
  binding = { kind: "blocked" };
}

/** What this client is speaking for, for a surface that needs to say so. */
export function boundApiOwner(): string | null {
  return binding.kind === "bound" ? binding.owner : null;
}

/** The whole state, for the tests and guards that reason about the four cases. */
export function apiOwnerBinding(): OwnerBinding {
  return binding;
}

/**
 * Does the browser still hold the session this client is speaking for?
 *
 * `absent` and `signed-out` both answer NO for anything but `public`, and that is the correction
 * review forced twice: absence used to read as silence everywhere, and a sign-out whose server
 * call failed erased the marker while leaving the session alive. A client that has been told
 * there is an account here — confirmed or not — and cannot see it named is a client that can no
 * longer prove anything, which is the moment to stop rather than the moment to trust.
 */
export function apiOwnerHolds(path: string, opts: { ceremony?: boolean } = {}): boolean {
  if (opts.ceremony === true) return true;
  if (OWNER_FREE_EXACT.some((p) => path === p)) return true;
  if (OWNER_FREE_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (binding.kind === "public") return true;
  if (binding.kind === "blocked") return false;
  const marker = readOwnerMarker();
  if (marker.kind !== "account") return false;
  const expected = binding.kind === "bound" ? binding.owner : binding.owner;
  return expected === null || marker.id === expected;
}

/**
 * The answer names the account it was for. `AF-RESPONSE-NOT-OWNER-BOUND`:
 * a switch inside a single request's flight leaves every browser
 * observation unchanged, so the server answers directly —
 * `X-Ohmail-Account`, always server-derived, never a query parameter, body
 * field or inbound header. Absence is a refusal on an authenticated read;
 * absent by design where there is no account subject. On
 * {@link credentialRoutes} a disagreement is the NEW owner (the server 409s
 * succeeded); absence there means nothing was established.
 */
const OWNER_HEADER = "X-Ohmail-Account";

/**
 * The requirement is negotiated, never assumed and never inferred. Requiring the header unconditionally is right for the
 * hosted product and wrong for every other install — a self-host on an older server or a header-stripping proxy would have
 * every authenticated read refused. So the server SAYS whether it names its answers (`/hello`), and this client requires the
 * header only where advertised. Never inferred from having seen one: that makes the requirement depend on request order and
 * lets one legitimately account-free answer switch it off. Three states: `true` — advertised, absence refuses; `false` —
 * answered and not advertised, absence admitted and the residual disclosed on screen (`AboutSection`), never silent; `null` —
 * nobody asked or `/hello` failed, admits and says nothing (a network blip must not switch the requirement off). A WRONG name
 * is wrong in all three: negotiation governs absence only.
 */
let accountHeaderAdvertised: boolean | null = null;

/**
 * `/hello` said whether this server names the account it answers for.
 *
 * The ONLY caller is `serverHello()`, and that is the whole design: see the block above. Passing
 * `null` returns the client to "nobody has asked", which is what a fresh test wants.
 */
export function setAccountHeaderCapability(advertised: boolean | null): void {
  accountHeaderAdvertised = advertised;
}

/** What the server said, for the guard and for the surface that discloses the residual. */
export function accountHeaderCapability(): boolean | null {
  return accountHeaderAdvertised;
}

/**
 * The routes where the header names the CREDENTIAL's account rather than a session's.
 *
 * Exactly the set the server's contract names, written out rather than derived from a prefix: a
 * prefix would silently enrol every route added below it into "a disagreement here is the new
 * owner", which is the one conclusion that must never be reached by default.
 */
/**
 * The two census paths that only ever CLEAR the jar. A cleared session establishes nothing, so a
 * header on one of these names an account that is on its way out — never a new owner.
 */
const CLEARS_ONLY = ["/auth/logout", "/account"] as const;

/**
 * Derived from the census, not remembered — and the derivation is the correction. The first
 * version was the set of routes that RESOLVE A CREDENTIAL, and three of them write no browser
 * cookie at all (`/auth/desktop-claim` and `/oauth/token` answer native tokens; `/pair/redeem`
 * returns none by design) — a header adopted from one of those rewrites the marker to name an
 * account whose session this browser does not hold. The question is "did this response
 * ESTABLISH a session in this browser": the cookie-writer census minus the two clear-only
 * paths, held to the server's own routes by `cookie-writer-census.test.ts`.
 */
const credentialRouteSet = (): readonly string[] =>
  COOKIE_WRITING_PATHS.filter((p) => !(CLEARS_ONLY as readonly string[]).includes(p));

/** The routes on which a header disagreeing with the cookie is a sign-in, for the guard to read. */
export function credentialRoutes(): readonly string[] {
  return credentialRouteSet();
}

/**
 * A response that could not say it was ours. Distinct from {@link ownerMismatch} on purpose: that
 * one means the BROWSER stopped naming us before or after the request, and this one means the
 * SERVER did not name us in the answer. A reader that conflates them cannot tell "the jar changed"
 * from "the answer was somebody else's", and only the second is evidence of the in-flight switch.
 */
function responseNotOurs(): ApiError {
  return new ApiError(
    0,
    "response_not_owner_bound",
    /*
     * SAYS WHAT HAPPENED, NOT WHAT IS HAPPENING NEXT. This read "Checking who is signed in",
     * which described work nothing starts: {@link reResolveApiOwner} withdraws the confirmation
     * and that is all — the next confirm comes from the shell's own ladder, on its own schedule,
     * and on a surface that has none it never comes at all. A sentence promising a check that is
     * not running is the same kind of claim as a comment describing code that is not there.
     */
    "That answer was not for this account, so it was discarded. This window is no longer confirmed for it.",
    undefined,
    { coded: false },
  );
}

/**
 * THE CONFIRMATION IS WITHDRAWN — back to `pending` for the SAME account, never to `public`.
 *
 * A refused answer is not evidence that this window belongs to somebody else; it is evidence that
 * we can no longer prove it belongs to us. `pending` keeps failing closed on an absent or
 * signed-out marker and lets the next confirm settle which account it is, which is the same
 * posture a warm open takes. Going to `public` would open every door on the way out.
 */
export function reResolveApiOwner(): void {
  if (binding.kind === "bound") binding = { kind: "pending", owner: binding.owner };
}

/**
 * Read the header's verdict on one answer. Throws to refuse; returns to admit.
 *
 * `seen === undefined` means the request never reached a server (offline, unconfigured), which is
 * a different failure and already thrown by the caller.
 */
function checkAnswerOwner(path: string, seen: string | null | undefined, ceremony: boolean): void {
  if (seen === undefined) return;

  if (credentialRouteSet().includes(path)) {
    if (seen === null) return;              // established nothing — never "still you"
    bindApiOwner(seen);
    rememberOwner(seen);                    // the pair, and it must be a pair: see `rememberOwner`
    return;
  }

  // An anonymous endpoint has no account subject and no header; asking it to name one would
  // refuse `/hello` on every signed-in browser. The ceremony flag says the same for a request
  // whose whole purpose is to find out who this is.
  if (ceremony) return;
  if (OWNER_FREE_EXACT.some((p) => path === p)) return;
  if (OWNER_FREE_PREFIXES.some((p) => path.startsWith(p))) return;

  // `public`, and a cold `pending` that does not yet know which account, have nothing to compare.
  // Neither is a window with somebody's mail in it — a named shell is never `public`, and a warm
  // open names its account before it renders.
  const expected = binding.kind === "bound" ? binding.owner
    : binding.kind === "pending" ? binding.owner
    : null;
  if (expected === null) return;

  if (seen === null) {
    /*
     * ABSENCE, WHICH IS THE NEGOTIATED HALF. Where the server advertises the header, an answer
     * that cannot say whose it is leaves this client unable to prove anything, and that is the
     * moment to stop. Where it does not advertise it, absence is the ordinary shape of every
     * answer that server gives, and refusing would refuse the whole product — so the client
     * behaves as it did before the header existed, and the surface says so out loud.
     */
    if (accountHeaderAdvertised !== true) return;
    reResolveApiOwner();
    throw responseNotOurs();
  }

  // A WRONG NAME IS WRONG WHETHER OR NOT IT WAS PROMISED. Nothing is negotiated here.
  if (seen !== expected) {
    reResolveApiOwner();
    throw responseNotOurs();
  }
}

/**
 * One request. Returns the parsed body, or throws {@link ApiError}.
 *
 * 204 answers `undefined` — `/auth/logout` and `/auth/refresh` (cookie branch) both use it,
 * and `res.json()` on an empty body throws.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const holds = (): boolean => apiOwnerHolds(path, { ...(opts.ceremony === true ? { ceremony: true } : {}) });
  // BEFORE the request and AGAIN after it. The first stops a call being made under somebody
  // else's session; the second stops an answer being handed back when the jar changed while it
  // was in flight. Both are the same question — see {@link apiOwnerHolds}.
  if (!holds()) throw ownerMismatch(path);

  /*
   * A cookie-writing request takes the lock, and does not recover under it.
   * The lock is here, not on the `auth` methods: the census sits beside the
   * other path lists, and the lock lives in the function that owns the
   * recovery path. No refresh-and-retry while holding it: Web Locks are not
   * reentrant — `resumeSession()` asks for this same name, so a recoverable
   * failure inside a ceremony queued the tab behind its own grant and hung
   * `auth.logout` before its cleanup ran. Refusing to recover loses nothing:
   * every census path forbids refresh or a second attempt is wrong on its own terms.
   */
  /*
   * WHO THE SERVER SAYS IT ANSWERED FOR, per call. An out-parameter rather than module state,
   * because module state would be read by whichever request finished last — and the sequence
   * this exists to catch is precisely two requests overlapping.
   */
  const ceremony = opts.ceremony === true;

  if (writesSessionCookies(path)) {
    return withSessionCookieLock(async () => {
      const seen: { account?: string | null } = {};
      const answer = await attempt<T>(path, opts, seen);
      if (!holds()) throw ownerMismatch(path);
      checkAnswerOwner(path, seen.account, ceremony);
      return answer;
    });
  }

  try {
    const seen: { account?: string | null } = {};
    const answer = await attempt<T>(path, opts, seen);
    if (!holds()) throw ownerMismatch(path);
    checkAnswerOwner(path, seen.account, ceremony);
    return answer;
  } catch (err) {
    // ONE refresh, ONE retry. The access cookie lives fifteen minutes and nothing renewed it,
    // so this is the ordinary state of any tab left open — see `session-refresh.ts`, and note
    // that a stale `tf_csrf` surfaces as 403 `csrf_failed` rather than 401.
    if (!(err instanceof ApiError)) throw err;
    if (!isRecoverable(err.status, err.code) || !mayRefreshFor(path)) throw err;
    /*
     * Asked BEFORE the refresh, not only after it. `resumeSession()`
     * rotates whatever session the jar currently holds; with the recheck
     * only after it, a request that left under A and came back recoverable
     * while another tab established B went on to rotate and extend B's
     * session from a stale A tab. No byte returned, and worse: the rotation
     * consumes B's refresh token, so B's own tab can present a consumed one
     * and be read as reuse. Cheap, because the answer is already wrong by
     * then: a request this client may no longer make gets no recovery attempt on somebody else's credential.
     */
    if (!holds()) throw ownerMismatch(path);
    if (!(await resumeSession())) throw err;
    // The refresh rewrites the whole jar, so the question has to be asked again before the
    // retry: a refresh that landed as a different account must not be retried as this one.
    if (!holds()) throw ownerMismatch(path);
    // A second failure is the real answer: the caller sees the refused request, not a loop.
    const seenAgain: { account?: string | null } = {};
    const retried = await attempt<T>(path, opts, seenAgain);
    if (!holds()) throw ownerMismatch(path);
    // The retry is a fresh answer and gets the fresh answer's check. A recovery rotates the
    // session, so this is the arm where the account behind the cookie is most likely to have
    // moved between the two attempts.
    checkAnswerOwner(path, seenAgain.account, ceremony);
    return retried;
  }
}

/**
 * A ceremony that writes session cookies takes the origin-wide lock. A refresh rewrites the whole cookie jar and so does
 * every one of these; until now only the refresh asked — `inFlight` is module state, so a refresh in another tab was
 * invisible and its reply could land after a completed ceremony and restore the previous account. On the METHODS, not the
 * screens: `LoginScreen` once took the lock around its three factor calls, fixing the sign-in and nothing else — a rule
 * every screen has to remember is a rule the next screen forgets. The census is the calls whose route reaches
 * `sessionCookies`, `enrollmentCookies` or `clearSessionCookies` — the first hand-written list was wrong both ways (it
 * wrapped two step-up verdicts that write NO cookie, hanging the prompt under the non-reentrant lock, and omitted
 * `account.erase`). Not on it: reads, the two OPTIONS calls, and the step-up verdicts.
 */
const COOKIE_WRITING_PATHS = [
  "/auth/register",              // enrollmentCookies
  "/auth/verify-email",          // enrollmentCookies / sessionCookies
  "/auth/login",                 // sessionCookies on the enrollment arm
  "/auth/logout",                // clears the jar
  "/auth/2fa/totp/verify",       // sessionCookies
  "/auth/2fa/recovery-codes/verify",
  "/auth/2fa/webauthn/assert/verify",
  "/auth/2fa/totp/activate",     // promotes an enrolment to a full session
  "/auth/2fa/webauthn/register/verify",
  "/account",                    // DELETE answers clearSessionCookies() — see `auth.erase`
] as const;

/** Does this request write or clear session cookies? The census above, by exact path. */
function writesSessionCookies(path: string): boolean {
  return COOKIE_WRITING_PATHS.some((p) => path === p);
}

/**
 * The census, for the test that DERIVES it from the server's own route table
 * (`cookie-writer-census.test.ts`) instead of trusting this list. Exported for that alone: the
 * first version of this list was written from memory and was wrong in both directions, and a
 * comment cannot notice when a route is added on the other side.
 */
export function cookieWritingPaths(): readonly string[] {
  return COOKIE_WRITING_PATHS;
}

/**
 * The refusal, as an `ApiError` so every existing caller's error path renders it.
 *
 * `status: 0` puts it beside `api_unconfigured` — a client-side refusal that never reached a
 * server, rather than something a server said — and `coded: false` keeps it out of every
 * classifier that keys on the API's own envelope. In particular the session classifier must
 * never read this as a verdict about a session: it is a statement about which account this
 * client is for.
 */
function ownerMismatch(_path: string): ApiError {
  return new ApiError(
    0,
    "owner_mismatch",
    "This window is signed in to a different account than this browser now holds.",
    undefined,
    { coded: false },
  );
}

async function attempt<T>(
  path: string,
  opts: RequestOptions = {},
  /** Set to the account the server named, or `null` when it named none. Left
      `undefined` when the request never reached a server. */
  seen?: { account?: string | null },
): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(0, "api_unconfigured", "This build is not connected to an ohmail server.");
  }
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const csrf = csrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, OFFLINE_CODE, "We could not reach ohmail. Check your connection and try again.");
  }

  // BEFORE the 204 shortcut: `/auth/logout` and the refresh's cookie branch both answer
  // empty, and an early return would skip the one thing this function is here to read.
  if (seen) seen.account = res.headers.get(OWNER_HEADER);

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const env = (parsed as {
      error?: { code?: string; message?: string; details?: unknown; retryable?: unknown };
    } | undefined)?.error;
    const retryAfterMs = retryAfterMsOf(res);
    if (res.status === ACCESS_REFUSED_STATUS && env?.code === ACCESS_REFUSED_CODE) {
      notifyAccessRefused(env.details);
    }
    throw new ApiError(
      res.status,
      env?.code ?? "internal",
      // The fallback is deliberately vague: reaching it means the server answered something
      // this client does not understand, and inventing a specific explanation would be worse
      // than admitting we do not have one.
      env?.message ?? "Something went wrong. Please try again.",
      env?.details,
      // `coded` is computed from the ENVELOPE, not from the fallback above — which is the
      // whole point: `code` is `"internal"` either way, and this is the field that says
      // whether a server of ours chose that word. See {@link ApiWire}.
      {
        coded: typeof env?.code === "string",
        ...(typeof env?.retryable === "boolean" ? { retryable: env.retryable } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }
  return parsed as T;
}

/**
 * THE ACCESS REFUSAL, RAISED ONCE FOR THE WHOLE CLIENT: The server answers `402 subscription_required` at every door
 * an inactive account may not reach, so every one of this module's ~200 callers could meet it. Handling it at the
 * call sites would mean two hundred chances to render mail beside a refusal; the shell needs to know instead, once,
 * and swap the whole surface for the lock screen. A NOTIFIER and not a thrown state: the `ApiError` still propagates
 * unchanged, so nothing that already handles a refusal changes behaviour. This is a side channel the shell subscribes
 * to.
 */
export const ACCESS_REFUSED_STATUS = 402;
export const ACCESS_REFUSED_CODE = "subscription_required";

/** Why access was refused, and where the customer can put it right. */
export interface AccessRefusedFacts {
  reason: "payment_required" | "suspended";
  manageUrl?: string;
}

type AccessRefusedSink = (facts: AccessRefusedFacts) => void;
let accessRefusedSink: AccessRefusedSink | null = null;

/**
 * Subscribe to access refusals. Returns the unsubscribe. LAST WRITER WINS — there is one shell
 * per document, and a second subscriber would mean two surfaces disagreeing about the same fact.
 */
export function onAccessRefused(sink: AccessRefusedSink): () => void {
  accessRefusedSink = sink;
  return () => { if (accessRefusedSink === sink) accessRefusedSink = null; };
}

/** Narrow the envelope's `details`. An unrecognised reason is `payment_required` — the arm whose
 *  remedy is a link the customer can act on, rather than one that reads as our fault. */
function notifyAccessRefused(details: unknown): void {
  const sink = accessRefusedSink;
  if (!sink) return;
  const d = (details ?? {}) as { reason?: unknown; manageUrl?: unknown };
  const reason = d.reason === "suspended" ? "suspended" : "payment_required";
  const url = typeof d.manageUrl === "string" && d.manageUrl.length > 0 ? d.manageUrl : undefined;
  // A sink that throws must not replace the refusal with its own failure.
  try {
    sink({ reason, ...(url ? { manageUrl: url } : {}) });
  } catch { /* the ApiError below is the answer either way */ }
}

// ── The shapes this flow actually exchanges ──────────────────────────────────────────────

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  twofaEnrolled: { webauthn: boolean; totp: boolean; recoveryCodes: boolean };
  /**
   * Has this address been proven? `withVerifiedEmail` refuses `POST /billing/checkout`
   * and `POST /mailboxes` while this is false, so `JoinScreen`'s `bootstrap()` reads it to
   * decide whether the `verify` step is still ahead — from SERVER state, like every other step.
   */
  emailVerified: boolean;
}

/** `POST /auth/register`, and `POST /auth/login` for a user with no factor yet (the re-entry path). */
export interface EnrollmentSession {
  status: "enrollment";
  user: SessionUser;
  next: "enroll_2fa";
  enrollmentToken: string;
  expiresIn: number;
}

/**
 * `POST /auth/register` on the PUBLIC path (202). Deliberately carries nothing: no
 * session, no user, and no field that differs between a fresh address and one that already has
 * an account. The client shows "check your mail" and cannot say more than that, which is the
 * point rather than a limitation.
 */
export interface RegistrationPending {
  status: "ok";
}

/** `POST /auth/login` for a user who HAS a second factor. */
export interface TwofaChallenge {
  status: "twofa_required";
  loginToken: string;
  methods: Array<"webauthn" | "totp" | "recovery_code">;
}

export type LoginResult = EnrollmentSession | TwofaChallenge;

/** A completed sign-in. The cookie client never sees `tokens` — they are stripped by design. */
export interface AuthenticatedSession {
  status: "authenticated";
  user: SessionUser;
}

export interface MailboxDTO {
  id: string;
  provider: string;
  address: string;
  displayName: string | null;
  status: string;
  /**
   * Last successful worker cycle, ISO-8601, or `null` for a mailbox that has never synced.
   *
   * The server has always sent this (the server's own mailbox DTO);
   * this client simply did not declare it, so the one fact that answers "is my mail actually
   * coming down?" was on the wire and unreachable. Settings → Mailboxes and the (i) panel
   * both read it. `null` is a real state and is rendered as one — a mailbox connected
   * seconds ago has not synced yet, and saying "never" is true while "just now" would not be.
   */
  lastSyncAt: string | null;
  /**
   * HOW THIS MAILBOX SIGNS IN — `"password"` or `"oauth"` (cloud 0009). The server has always projected it
   * (`MailboxService.toDTO`); this client did not declare it, and without it the reconnect control for an oauth
   * mailbox is unrepresentable. That matters more than a missing field usually does: an oauth mailbox's only
   * credential is a refresh token, so the password/host form is meaningless for it, and offering "Edit" would let
   * somebody store a typed password beside an `authType: "oauth2"` credential that the dialler then refuses to use.
   * OPTIONAL, because a client build may be talking to an older API. Absent is read as `"password"` — the historical
   * behaviour, and the one that offers the form rather than withholding it.
   */
  authKind?: "password" | "oauth";
  /**
   * WHO ORGANIZES THIS MAILBOX, AND WHETHER IT WAS EVER AGREED TO (mail 0083): `organizer` is this install; `reader`
   * is somebody else's, or nobody's. A reader is CONNECTED and its mirror is growing — what it does not do is move,
   * file or delete mail. The server has projected these since mail 0083 and this client did not declare them, which
   * is why the web pane's claim control was still gated on `status === "disabled"`: the one set the server refuses,
   * since a `disabled` row is a tombstone and a stood-down row is `connected`. OPTIONAL, and absent reads as
   * `organizer` at every site. Every install was one before the column existed, so a server that cannot say has not
   * demoted anybody; the dangerous default is the other one, which would put a claim banner over a mailbox this
   * install already organizes.
   */
  organizerRole?: "organizer" | "reader";
  /**
   * WHO holds it, when somebody else does — `null` when this install does, or when nobody ever
   * has. Those two cases are NOT distinguishable from this field, which is exactly why
   * {@link organizeConsentedAt} exists beside it.
   *
   * `since` is when that install BECAME the organizer, not when it was last seen: a banner says
   * "since Tuesday", never "last seen 40 seconds ago", because a heartbeat on a screen invites
   * somebody to sit and watch it.
   */
  organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
  /**
   * Whether that holder is still RENEWING (`held`) or stopped and left its claim behind
   * (`stopped`). `null` is "this install has not looked". The two want opposite sentences on
   * screen, which is why the lease's verdicts are not collapsed into a boolean anywhere they
   * reach a person.
   */
  organizerState?: "held" | "stopped" | null;
  /**
   * Is the claim on this mailbox this install's own — the SERVER's comparison, not a client's.
   *
   * `organizedBy.kind` cannot answer it: `cloud` is what a second Cloud deployment is too, and
   * their ids differ by design. Optional because a host older than this field sends none, and
   * absent reads as NOT ours.
   */
  organizedByThisInstall?: boolean;
  /**
   * WHEN somebody agreed to let ohmail organize this mailbox, or `null` for "nobody has". ABSENT AND `null` ARE
   * DIFFERENT HERE, AND THE DIFFERENCE IS A CONTROL: The claim offer's server-side rule is `status <> 'disabled' AND
   * (organizer_role = 'reader' OR organize_consented_at IS NULL)`. Read `== null`, an ABSENT field — an API deployed
   * before mail 0083 — satisfies the second disjunct on every row, and the pane sprouts an "Organize here instead"
   * button on every mailbox of every older deployment, each of which would be refused. So every reader of this field
   * tests `=== null`, and the seam that maps it (`CloudShell`) forwards it UNTOUCHED rather than with a `?? null`.
   * This is the same absent-versus-null rule {@link initialImportCompletedAt} carries, with the sign chosen for the
   * same reason: collapse the unknown toward the state that offers LESS.
   */
  organizeConsentedAt?: string | null;
  /**
   * WHEN THE ORGANIZING SITUATION LAST CHANGED, AND WHEN IT WAS LAST ACKNOWLEDGED. The pair the once-only notice is
   * derived from — `organizerEventAt > organizerEventSeenAt`, with an unset `seenAt` meaning "never acknowledged".
   * Two instants and not a flag, so every door computes the same answer from the same facts and an acknowledgement
   * made on one of them reaches the others on their next poll. OPTIONAL, and absent withholds the line. A build that
   * cannot tell must not announce that a mailbox changed hands.
   */
  organizerEventAt?: string | null;
  organizerEventSeenAt?: string | null;
  /**
   * WHEN this install last gave this mailbox up deliberately, or `null`. Cleared by the next
   * claim, so it describes the current tenure rather than a history.
   *
   * It is the only thing separating a mailbox somebody released from one whose holder vanished:
   * both are readers with no holder, and only the first is something the person here did.
   */
  organizerReleasedAt?: string | null;
  /** The standing "stop organizing here" ask, pending until the organizer's pass confirms it. */
  releaseRequestedAt?: string | null;
  /** The standing "organize here" press, spent by the gate's next pass. */
  takeoverAuthorizedAt?: string | null;
  /**
   * WOULD A DECISION MADE HERE BE ACCEPTED BY WHOEVER ORGANIZES THIS MAILBOX?
   *
   * `true` only where a press has somewhere to go — the holder is still renewing and its build
   * can take a decision from a reader. OPTIONAL, and absent means the same as `false`: withhold
   * the controls and say why. The dangerous default is the other one, which draws a decision bar
   * whose every press ends in a refusal.
   */
  organizerAcceptsRequests?: boolean;
  /**
   * WHY a mailbox is in `error` (mail 0023). Null unless `status === "error"`.
   *
   * A stable KEY, not a sentence — the server never ships English, so the copy stays in
   * `messages/*.json` where it can be translated and edited without a deploy of the API.
   * `errorDetail` is an allowlisted token (an IMAP response code, a Node errno, an SQLSTATE)
   * and never an error message; it is diagnostic filler for a tooltip, not the label.
   */
  errorCode?: "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown" | null;
  errorDetail?: string | null;
  failedAt?: string | null;
  retryCount?: number;
  /**
   * Why a `connected` mailbox is not being synced (mail 0029) — the second
   * time this exact gap has bitten: `lastSyncAt` was on the wire and
   * undeclared, and these two repeated it, because nothing makes a client
   * declare a field it is not yet reading. `syncBlockedReason` is a closed
   * set of three with a CHECK behind it, so unlike `errorCode` no value a
   * mail server chose can reach it. Typed `string` rather than the union:
   * the union's owner is `app/shell/mail-state.ts`, which the Desktop
   * mirror publishes and which may not import this file — one declaration, in the place that renders it.
   */
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  /**
   * How many of the user's own filings this mailbox has not applied yet. The API never opens
   * IMAP — a decision writes `folder_state` and the worker moves on its next cycle — so between
   * press and cycle the mail is filed in ohmail and not on the server, and with the host
   * refusing connections the gap does not close while every other field says the mailbox is
   * fine. Optional, and the optionality is the contract: an older server omits it, and
   * `mail-state.ts` gates on `typeof === "number"` so absent says nothing rather than zero — a
   * `?? 0` anywhere between turns "we do not know" into "nothing is outstanding", wrong in
   * exactly the case the field exists for.
   */
  pendingMoves?: number;
  /**
   * Why those filings are outstanding — the same rows split by the operand
   * that decides (mail 0097). The count above was the only thing on the
   * wire, so one sentence covered every reason — including two where "the
   * server is catching up" is FALSE: a deferred row is not being caught up
   * with, and on a reader install the server is not the organizer.
   * Optional on {@link pendingMoves}' rule: absent is an older server, and
   * the client renders what it always rendered. `mail-state.ts` owns the
   * arm and the closed set; members are typed loosely here for `syncBlockedReason`'s reason.
   */
  filing?: {
    due: number;
    deferred: number;
    oldestPendingAt: string | null;
    nextAttemptAt: string | null;
    attempts: number;
    lastRefusalClass: string | null;
    asOf: string;
    lastCycleAt: string | null;
  };
  /**
   * Why a `disabled` mailbox is disabled, when the LEASE decided it (mail
   * 0027) — the third time this gap has bitten and the most expensive: this
   * field did not exist on the server DTO either, so a stood-down mailbox
   * had `errorCode` null, `syncBlockedSince` null and nothing to say why —
   * observed live as a card calling a minutes-old mailbox "disconnected"
   * under a headline saying none was connected. `string` rather than the
   * union, exactly as `syncBlockedReason`: the set's client-side owner is
   * `mail-state.ts`, which the Desktop mirror publishes.
   */
  disabledReason?: string | null;
  /**
   * When this mailbox was connected.
   *
   * The ONE per-mailbox clock that is not shared. `lastSyncAt` is stamped for every mailbox a
   * worker cycle served in a single `UPDATE … WHERE id IN (…)`
   * (the sync worker), which is why two rows can report an identical
   * age to the second; `createdAt` is per row and immutable, so "connected 12 minutes ago and
   * nothing has arrived" is a sentence the client can actually stand behind.
   */
  createdAt?: string;
  /**
   * When this mailbox's FIRST import actually finished (mail 0038) — NULL
   * until a worker cycle completes with no backlog. The end-of-import
   * signal `lastSyncAt` cannot be: that column is shared across the pass
   * and lands after the first cycle whatever the backlog. This one is
   * per-mailbox and late, and `mail-state.ts` reads it as a FLOOR — a NULL
   * keeps the strip saying "still importing" even when this client's mirror
   * has stopped growing, which stops a partial mailbox reading as complete.
   * Optional so a stale bundle degrades to growth-only rather than crashing.
   */
  initialImportCompletedAt?: string | null;
  /**
   * The forwarding-detection notice's evidence pair (mail 0078). `inboundQuietSince` non-null is a
   * standing quiet episode: the worker judged this connected, healthy mailbox to have received
   * essentially no genuine inbound for a generous window — the shape a provider-level forward
   * without "keep a copy" leaves, once two days of debugging pointed at ohmail. The value is the
   * newest genuine inbound date; `inboundQuietDismissedAt` is the dismissal. The CLIENT owns the
   * comparison (`showInboundQuiet`): show iff `since` is set, health holds on screen, and
   * `dismissedAt` is null or predates `since` — a new episode's newer `since` re-shows. Optional:
   * an older API reads `undefined` and loses only the notice.
   */
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
  /**
   * The biggest message this mailbox's submission server said it will accept, in bytes (mail
   * 0055) — its own `SIZE` announcement, read from the EHLO the connect-time SMTP probe already
   * ran, or `null` when none. The compose surface used to state a CONSTANT ceiling — the hosted
   * API's request-body limit, a fact about one deployment and no mail server anywhere.
   * `composeAttachCap` takes the smaller of the two, so a provider capping submission below the
   * pipeline binds the form to the provider's number instead of a bounce after the wait.
   * Optional (an older API degrades to the constant); nullable ("announced nothing" is real and
   * resolves the same way).
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * How much mail is in this mailbox — present only on a response to
   * `?counts=1`. Optional for a DIFFERENT reason from every other field on
   * this type: not server age, but that THIS client decides per request
   * whether to ask — `mailboxes.list()` omits it, `list({ counts: true })`
   * gets it, both correct about the same mailbox at the same moment. Absent
   * means "nobody asked" and `0` means "empty" — two facts a renderer that
   * collapses them turns into "0 messages" about a full mailbox every time
   * a countless poll lands. `typeof === "number"`; never `?? 0`.
   */
  messageCount?: number;
  /**
   * How much mail the server says is in there — the first pull's denominator (mail 0083): Σ
   * `mailbox_folders.server_exists` over opened folders. Unlike {@link messageCount} it rides
   * EVERY response, including the 30 s poll — the server sums folder rows it was already
   * reading. Three reader rules: `typeof === "number"`, never `?? 0` (absent is "no folder
   * carries a count yet" or an older API; `0` claims the mail server holds nothing); it GROWS
   * as the first cycle walks the tree, a moving floor, so a derived remaining count can rise;
   * and it can be SMALLER than {@link messageCount}, so `remaining` clamps at zero and shows
   * nothing there.
   */
  serverMessageCount?: number;
}

/**
 * WHAT THE SERVER SAYS THIS ACCOUNT MAY DO — limits and stored bytes.
 *
 * Limits and AI metering belong to whoever operates the deployment: this client renders the
 * verdict it is handed and keeps no figures of its own. A self-hosted or desktop install has no
 * such program and is unmetered. The name is the older spelling of the same question.
 */
export interface SubscriptionStatus {
  /**
   * The account's counted stored mail-body bytes, rendered against
   * `entitlements.storageBytesLimit`. Optional: an absent value means "say nothing about
   * storage", never "0 of 0".
   */
  storageUsedBytes?: number;
  entitlements: {
    mailboxLimit: number;
    canAddMailbox: boolean;
    aiEnabled: boolean;
    syncEnabled: boolean;
    /** The effective stored-body cap in bytes. Optional: an older server omits it. */
    storageBytesLimit?: number;
    reason: string;
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────────────────

export const auth = {
  // `inviteCode` is OPTIONAL on the wire. A deployment with `TF_PUBLIC_SIGNUP=1`
  // accepts a body without it; one without still answers `validation_failed`, which is the
  // server's call and not this client's. Omitting the key is not the same as sending `""`
  // and the caller decides which it means.
  // TWO possible shapes, discriminated on `status`, because the two paths are different
  // in kind. The INVITE path returns an enrollment session (201) exactly as before. The PUBLIC
  // path returns `{status:"ok"}` (202) and NO session, byte-identically whether or not the
  // address already had an account — the continuation is the mail, which is the only place the
  // difference can be told to the one person entitled to know it.
  register: (b: { email: string; password: string; displayName: string; inviteCode?: string }) =>
    api<EnrollmentSession | RegistrationPending>("/auth/register", { method: "POST", body: b }),

  /**
   * `POST /auth/verify-email`. The password is REQUIRED alongside the token and is not a
   * convenience: a mailed link on its own would let whoever registered an address wait for its
   * real owner to click and thereby verify the REGISTRANT's account. See
   * `AuthService.verifyEmail` for the full chain.
   */
  verifyEmail: (b: { token: string; password: string }) =>
    api<EnrollmentSession | { status: "verified" }>("/auth/verify-email", { method: "POST", body: b }),

  /** Another link for the SESSION's own address. Takes no recipient, by design. */
  resendVerification: () =>
    api<{ ok: true }>("/auth/verify-email/resend", { method: "POST", body: {} }),

  login: (b: { email: string; password: string }) =>
    api<LoginResult>("/auth/login", { method: "POST", body: b }),

  /**
   * `signal` is not decoration. `/login` runs a retry ladder beside a sign-in form, and a
   * confirm still in flight when a password is submitted can finish AFTER the new session's
   * cookies are set — and the refresh it may trigger rewrites the whole jar. Suppressing the
   * promise continuation does not undo that; only stopping the request does. Every other
   * caller omits it and is unchanged.
   */
  /**
   * `ceremony: true` is the FRONT DOOR's, and only the front door's — `resolveOwnerOutcome`, the
   * one classifier that establishes who this browser is. Every other caller of this method is an
   * ordinary shell read of the signed-in person's email, account id and enrolled factors, and is
   * owner-bound like the rest of the account surface. See {@link RequestOptions.ceremony}.
   */
  session: (opts: { signal?: AbortSignal; ceremony?: boolean } = {}) =>
    api<{ user: SessionUser; scope: "full" | "enrollment" }>("/auth/session", opts),

  logout: () => api<void>("/auth/logout", { method: "POST", body: {} }),

  // ── 2FA enrollment (the enrollment-session surface: the seven `enrollmentOk` routes) ──

  webauthnRegisterOptions: () =>
    api<{ options: PublicKeyCredentialCreationOptionsJSON }>("/auth/2fa/webauthn/register/options", {
      method: "POST", body: {},
    }),

  /**
   * `session` is present ONLY when this was the FIRST factor: enrolling it EXCHANGES the
   * enrollment session for a full one, which is what makes the passkey step the
   * moment onboarding stops being password-only.
   */
  webauthnRegisterVerify: (b: { credential: unknown; label: string }) =>
    api<{ credentialId: string; twofaEnrolled: SessionUser["twofaEnrolled"]; session?: AuthenticatedSession }>(
      "/auth/2fa/webauthn/register/verify", { method: "POST", body: b },
    ),

  totpEnroll: () => api<{ secret: string; otpauthUrl: string }>("/auth/2fa/totp/enroll", {
    method: "POST", body: {},
  }),

  totpActivate: (b: { code: string }) =>
    api<{ twofaEnrolled: SessionUser["twofaEnrolled"]; session?: AuthenticatedSession }>(
      "/auth/2fa/totp/activate", { method: "POST", body: b },
    ),

  /**
   * Recovery codes. Double-gated on purpose: `enrollmentOk` AND `stepUp`, and the
   * two are independent — which is what makes "passkey first, then codes" a structural
   * order rather than client discipline. Calling this before a factor lands 403s.
   */
  recoveryCodes: () => api<{ codes: string[] }>("/auth/2fa/recovery-codes", { method: "POST", body: {} }),

  /**
   * Remove the authenticator. `DELETE /auth/2fa/totp` shipped with the rest of the 2FA surface and had NO
   * client until Settings → Security existed to call it, which is a large part of why 2FA read
   * as one-way: enrol once during signup, then no route back.
   *
   * Step-up gated at the route AND re-checked in `AuthService.requireStepUp` — deliberately
   * double-gated, because it is the one destructive call in this group. The server also refuses
   * to remove the last surviving factor, so the UI's decision to hide the button unless a
   * passkey remains is a courtesy, not the enforcement.
   */
  totpRemove: () => api<void>("/auth/2fa/totp", { method: "DELETE" }),

  // ── Sign-in completion ────────────────────────────────────────────────────────────────

  webauthnAssertOptions: (b: { loginToken: string }) =>
    api<{ options: PublicKeyCredentialRequestOptionsJSON }>("/auth/2fa/webauthn/assert/options", {
      method: "POST", body: b,
    }),

  webauthnAssertVerify: (b: { loginToken: string; credential: unknown }) =>
    api<AuthenticatedSession>("/auth/2fa/webauthn/assert/verify", { method: "POST", body: b }),

  totpVerify: (b: { loginToken: string; code: string }) =>
    api<AuthenticatedSession>("/auth/2fa/totp/verify", { method: "POST", body: b }),

  /**
   * Mint the one-use code the desktop app exchanges for a session of its own (`/link-desktop`).
   * Step-up gated at the route; this client only lets the refusal through — swallowing `403
   * step_up_required` would turn "your step-up expired" into "linking does not work". `expiresIn`
   * is SECONDS and the page counts down with it (the TTL is the server's `desktopLinkTtlMs`; a
   * copy here would drift silently). `challenge` is the public half of a PKCE pair the desktop
   * invented before opening this page; sending it binds the code to whoever holds the verifier,
   * which is what makes handing the code back over a URL scheme safe. Omitting it is the browser
   * flow, where the code is meant to be retyped.
   */
  desktopLink: (b: { challenge?: string } = {}) =>
    api<{ code: string; expiresIn: number }>("/auth/desktop-link", {
      method: "POST",
      body: b.challenge ? { challenge: b.challenge } : {},
    }),

  recoveryVerify: (b: { loginToken: string; code: string }) =>
    api<AuthenticatedSession & { remainingCodes: number }>("/auth/2fa/recovery-codes/verify", {
      method: "POST", body: b,
    }),

  // ── Step-up re-verification (the inline ceremony behind a stale 5-minute window) ────────
  //
  // `step_up_required` used to be a dead end: the only remedy a pane could offer was a full
  // sign-out/sign-in round trip. These three re-run the sign-in second factor against the
  // SESSION THE BROWSER ALREADY HOLDS and re-stamp its factor clock — the response is
  // `{ok: true}` and carries NO cookies and NO tokens (the server censuses that), so nothing
  // about the session changes except that step-up-gated verbs work again for five minutes.
  // A pane catches `step_up_required`, runs one of these, and retries its own verb.

  stepUpTotp: (b: { code: string }) =>
    api<{ ok: true }>("/auth/step-up/totp", { method: "POST", body: b }),

  stepUpWebauthnOptions: () =>
    api<{ options: PublicKeyCredentialRequestOptionsJSON }>("/auth/step-up/webauthn/options", {
      method: "POST", body: {},
    }),

  stepUpWebauthnVerify: (b: { credential: unknown }) =>
    api<{ ok: true }>("/auth/step-up/webauthn/verify", { method: "POST", body: b }),
};

// ── Pairing tokens (wherever `/hello` announces `features.pairing` — the self-host server
//    mints BOTH grants; the managed service mints device-pair only, its invite arms refused
//    server-side because that deployment wires no invite bridge) ─────────────────────────────

/**
 * One row of `GET /pair` — the caller's own mints, never the token itself (raw tokens exist
 * exactly once, in the mint response; only their hash is at rest). `status` is the server's
 * derivation, consumed > revoked > expired > live.
 */
export interface PairingTokenDTO {
  id: string;
  grant: "invite" | "device-pair";
  label: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  status: "live" | "consumed" | "revoked" | "expired";
}

export const pair = {
  /**
   * `POST /pair` with the `invite` grant — the invite mint. Step-up gated (handing out a
   * credential that opens the server is a ceremony), and the answer's `token` is the raw
   * token's ONE appearance: the list below never carries it and nothing stores it. No
   * `ttlSeconds` is sent, so the server's own invite default (seven days) applies — the pane's
   * copy states that lifetime, and deriving both from one place is what keeps the sentence true.
   */
  mint: (b: { label?: string }) =>
    api<{ id: string; token: string; grant: "invite"; label: string; expiresAt: string }>(
      "/pair", { method: "POST", body: { grant: "invite", ...(b.label ? { label: b.label } : {}) } },
    ),

  /**
   * `POST /pair` with the `device-pair` grant — the device mint behind Settings → Devices'
   * "Add a device". Step-up gated exactly as the invite mint is, and the returned `token` is
   * likewise the raw value's ONE appearance: the pane turns it into the frozen
   * `${apiOrigin}/pair#<token>` link (QR + typed entry) and never stores it. No `ttlSeconds`
   * is sent, so the server's device-pair default (five minutes) applies — the pane's copy
   * states that lifetime, and deriving both from one place keeps the sentence true.
   */
  mintDevice: (b: { label?: string }) =>
    api<{ id: string; token: string; grant: "device-pair"; label: string; expiresAt: string }>(
      "/pair", { method: "POST", body: { grant: "device-pair", ...(b.label ? { label: b.label } : {}) } },
    ),

  /** The caller's own pairing tokens, newest first — metadata only, see {@link PairingTokenDTO}. */
  list: () => api<{ items: PairingTokenDTO[] }>("/pair"),

  /**
   * Take back one live token. Step-up gated like the mint — but 404 for every miss (spent,
   * expired, someone else's), which the pane treats as "already gone" rather than an error:
   * the row it names is leaving the list either way.
   */
  revoke: (id: string) => api<void>(`/pair/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * `POST /pair/redeem` with the `invite` grant: a pairing token in, an email-bound invite code out — the client's
   * next move is `auth.register` with that code, which is the existing invite path unchanged. Anonymous by design
   * (the redeemer has no session yet; the token IS the credential), so there is no cookie and no CSRF pair on this
   * call — `api()` sends the CSRF header only when the cookie exists, which it does not at first-run. The one caller
   * today is the self-host FIRST-RUN page, redeeming the setup token the server printed at boot. Whether the
   * resulting account starts email-verified is decided by the SERVER from the consumed token's own record (ownerless
   * first-boot token: yes), never by anything sent here — see `redeemInviteGrant` in packages/services.
   */
  redeemInvite: (b: { token: string; email: string }) =>
    api<{ grant: "invite"; invite: { code: string; email: string; expiresAt: string } }>(
      "/pair/redeem", { method: "POST", body: { grant: "invite", token: b.token, email: b.email } },
    ),
};

// ── Devices — the sessions signed into this account, and the take-back ────────────────────

/**
 * One row of `GET /devices` — a live session. `id` is the DEVICE id for a NAMED device and the session's own id for a
 * plain browser sign-in (both are what `DELETE /devices/:id` takes); `label` is the pairing mint's own word for the
 * device ("kitchen iPad") and empty for a plain sign-in. `current` marks the session making the request, which is the
 * one row the pane must not offer to revoke — that verb already exists and is called signing out. `named` is the
 * server's own discriminator (does a device row back this session?): `false` is a plain browser sign-in, which the
 * pane may collapse into one group; `true` is a paired device or the desktop app, listed individually. OPTIONAL
 * because an older server does not send it — absent means "treat as named", i.e. the pre-grouping rendering, which
 * degrades to exactly what that server's list looked like.
 */
export interface DeviceDTO {
  id: string;
  /**
   * The server's device vocabulary. `"macos"` is the legacy spelling for a native desktop of
   * unrecorded platform; current installs declare the platform-qualified kinds. Typed with a
   * trailing open arm so a NEWER server's kind renders as the generic fallback instead of
   * failing to parse — the same forward tolerance `named` has in the other direction.
   */
  kind:
    | "web" | "macos"
    | "desktop-linux" | "desktop-macos" | "desktop-windows"
    | "mobile-android" | "mobile-ios"
    | (string & {});
  label: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  current: boolean;
  named?: boolean;
  pushToken: string | null;
}

export const devices = {
  /** The caller's own live sessions, newest first. */
  list: () => api<{ items: DeviceDTO[] }>("/devices"),

  /**
   * Revoke a device's sessions — the take-back that makes offering a pairing QR safe at all.
   * Step-up gated (`DELETE /devices/:id`); the pane answers a 403 `step_up_required` with the
   * inline re-verification prompt rather than a dead end.
   */
  revoke: (id: string) => api<void>(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Sign out every OTHER plain web session in one act — the collapsed group's verb. The
   * server scopes it structurally (device-less, full-scope, never the caller's session or
   * family, never a paired device) and answers how many it revoked. Step-up gated like every
   * other credential revocation.
   */
  revokeWebSessions: () =>
    api<{ revoked: number }>("/devices/revoke-web-sessions", { method: "POST", body: {} }),
};

// ── Mailboxes ────────────────────────────────────────────────────────────────────────────

export interface CreateMailboxBody {
  provider: string;
  address: string;
  displayName?: string;
  /**
   * `port`/`secure` OMITTED asks the server's probe to auto-detect: 993 implicit TLS first,
   * then 143 STARTTLS, storing whichever it proved. Presets keep sending their known pair.
   * `allowInsecure` is the explicit plaintext consent for a server the probe reported as
   * having no TLS at all — sent only after the user checked the opt-in, and re-verified
   * server-side before it is honored.
   */
  imap: { host: string; port?: number; secure?: boolean; user: string; pass: string; allowInsecure?: boolean };
  smtp?: { host: string; port?: number; secure?: boolean; user?: string; pass?: string };
}

/**
 * A PATCH of an existing mailbox. Partial by design — the server MERGES a transport block over the stored connection
 * params, so `{ imap: { pass } }` rotates only the password and keeps the host/port/user that are already stored.
 * `pass` is required whenever an `imap` block is present: it is the presence of a secret that makes the server re-try
 * the login before storing anything. A block with a corrected host and no password would rewrite nothing and prove
 * nothing, so the type forbids it — to change a host you re-enter the password, which is the credential that gets
 * tried and re-encrypted. The connection params (host/port/user) are never echoed by `GET /mailboxes`, so a form
 * cannot pre-fill them; an omitted field means "keep what is stored", not "clear it".
 */
export interface UpdateMailboxBody {
  displayName?: string | null;
  status?: "connected" | "disabled";
  /** `allowInsecure` as on {@link CreateMailboxBody.imap} — consent, re-verified server-side. */
  imap?: { host?: string; port?: number; secure?: boolean; user?: string; pass: string; allowInsecure?: boolean };
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass: string };
}

export const mailboxes = {
  /**
   * The account's mailboxes. `counts` asks the server to add `MailboxDTO.messageCount` to every row — one grouped
   * aggregate over the account's mail. It is OFF by default and every polled caller leaves it off:
   * `MailStateProvider` reads this route every 30 s in every open tab for the status strip, and the Settings pane
   * reads it every 10 s while it is on screen. Ask for the count when a screen that shows it opens, not on a
   * heartbeat. An older server ignores the parameter and answers the bare list, which is why the field is optional on
   * the DTO and why a renderer must read it with a `typeof === "number"` guard rather than treating an absent field
   * as zero.
   */
  list: (opts: { counts?: boolean } = {}) =>
    api<{ items: MailboxDTO[] }>(opts.counts ? "/mailboxes?counts=1" : "/mailboxes"),
  /**
   * Ask the worker to re-scan this mailbox from scratch. 202 — it clears each folder's
   * CONDSTORE cursor and the worker picks it up on its next cycle, so nothing is synced by
   * the time this returns. The UI must say "queued", never "synced".
   */
  resync: (id: string) => api<{ status: string }>(`/mailboxes/${id}/resync`, { method: "POST", body: {} }),
  /**
   * Dismiss the forwarding-detection notice for this mailbox (mail 0078). Stamps
   * `inboundQuietDismissedAt` and answers the fresh DTO so the pane settles at once; the notice
   * returns only when a NEW quiet episode postdates the stamp. Idempotent — a repeat press
   * re-stamps the same dismissal.
   */
  dismissInboundQuiet: (id: string) =>
    api<MailboxDTO>(`/mailboxes/${id}/inbound-quiet/dismiss`, { method: "POST", body: {} }),
  /**
   * `POST /mailboxes` is `stepUp`-gated — it writes envelope-encrypted credentials. During
   * onboarding the passkey/TOTP enrollment that just happened IS the fresh second factor, so
   * the step-up window is open; a user who wanders off and comes back gets `step_up_required`
   * and has to re-authenticate, which is the correct outcome and not an error to paper over.
   */
  create: (b: CreateMailboxBody) => api<MailboxDTO>("/mailboxes", { method: "POST", body: b }),

  /**
   * Test a connection without creating anything — `POST /mailboxes/probe`. `connection`-classed and `stepUp`-gated
   * with {@link create}, because the body carries a mailbox password; no `:id` because no row exists yet, and it
   * writes nothing at all. The failure shape is `create`'s by construction: the server throws the same
   * `mailbox_probe_failed` refusal with the same seven-member `details.reason` taxonomy, so `probeReasonOf`
   * classifies both and every connect-failure surface renders a test failure with no new copy. Only SUCCESS is new,
   * and it carries a folder count — the checkable part: a greeting and an accepted LOGIN prove host, port, TLS and
   * password but not that the account can READ anything. The LIST runs inside the connection that proved the password
   * (a second dial would be a second login, charged again by providers that rate-limit auth).
   */

  /**
   * `folders` is `null` where no count was taken; a renderer shows a verdict with no number rather than "0 folders".
   */
  probe: (b: {
    address: string;
    imap: { host: string; port?: number; secure?: boolean; user?: string; pass: string };
  }) =>
    api<{ ok: true; host: string; user: string; folders: number | null }>(
      "/mailboxes/probe", { method: "POST", body: b },
    ),

  /**
   * Change a connected mailbox's settings — the reconnect/rotate path.
   *
   * `stepUp`-gated exactly like `create`, because it writes an envelope-encrypted credential, and
   * for the same reason it tries the login before it stores it: a rotated password the mail server
   * refuses is answered `mailbox_probe_failed` and the OLD credential is left in place, so a typo
   * here cannot take a working mailbox offline. The caller shows the `details.reason` sentence and
   * lets the user correct the field they just typed — nothing is stood down.
   */
  update: (id: string, b: UpdateMailboxBody) =>
    api<MailboxDTO>(`/mailboxes/${id}`, { method: "PATCH", body: b }),

  /**
   * REMOVE A MAILBOX — stop organizing it, and forget the login stored for it. `stepUp`-gated with `create` and
   * `update`, and for the mirror image of their reason: those two STORE a mailbox password, this one DESTROYS the
   * stored credential and ends the mail flowing into an account. The route has existed since the mailbox surface was
   * built and until now nothing in any client called it — the only way to disconnect a mailbox was to ask somebody
   * with database access. 204, and it is a SOFT delete on the server: the row stays because `messages.mailbox_id`
   * references it, the credential rows go, the lease columns are cleared, and the pending scheduled sends are closed
   * with a sentence. Nothing reaches the IMAP mailbox — no folder is touched and no message is deleted there — which
   * is the load-bearing claim the confirmation makes and the reason it can be made at all.
   */
  remove: (id: string) => api<void>(`/mailboxes/${id}`, { method: "DELETE" }),

  /**
   * WHO IS ORGANIZING THIS MAILBOX RIGHT NOW, read from the mailbox itself. Exactly one ohmail organizes a mailbox at
   * a time, and the claim lives in an unsubscribed `ohmail/_meta` folder because that is the only thing a desktop
   * install and Cloud both see. When Cloud loses a mailbox it records why and stops — and from then on nothing
   * re-reads the claim, so the stored reason is a snapshot of the moment it stood down and not an answer to "is that
   * install still running?". This asks the mailbox. A short-lived IMAP connection, so it is not free and is not
   * polled. It is read once, when somebody is about to decide something.
   */
  organizer: (id: string) => api<OrganizerPeek>(`/mailboxes/${id}/organizer`),

  /**
   * Ask Cloud to organize a mailbox it stood down from. It authorizes ONE attempt and does not win anything: the
   * worker reads the claim on its next pass and decides. If another install is still renewing and outranks us, this
   * side stays a reader and the authorization is spent with it. Step-up-gated — it decides who moves somebody's mail,
   * and the body may carry a mailbox password. RENAMED from `takeover`. The old name was true of the only case that
   * existed — wresting a mailbox back from another install — and false of the case that is now the common one: the
   * FIRST consent, where there is nobody to take it over from. Both halves are one ceremony and one route.
   */

  /**
   * `imap.pass` re-proves the login before anything is written, for the claim-back whose stored password the provider
   * has since invalidated; `screening` carries the onboarding window, which must ride the same transaction as the
   * consent because the window is measured from a baseline the consent is what writes.
   */
  organize: (id: string, body: {
    imap?: { pass: string };
    screening?: { dormancyDays?: number; scope?: "window" | "all_time" };
  } = {}) =>
    api<MailboxTakeover>(`/mailboxes/${id}/organize`, { method: "POST", body }),

  /**
   * STOP ORGANIZING THIS MAILBOX HERE, AND KEEP THE MAIL. The mirror of {@link organize}, and NOT step-up-gated,
   * which is the asymmetry worth stating rather than smoothing over. A second factor guards the direction that TAKES
   * CONTROL of somebody's mail; this direction gives it up, keeps every credential and every message, and is
   * reversible with one press of the button beside it. Gating it would mean a person who has lost their second factor
   * cannot stop a machine from filing their mail. It records the request and does not perform it: the claim lives in
   * the mailbox itself, so only the process holding that connection can give it up. `requested` is answered 202 for
   * that reason — the ceasing happens on the organizer's next pass, within a minute.
   */
  release: (id: string) =>
    api<MailboxRelease>(`/mailboxes/${id}/release`, { method: "POST", body: {} }),

  /**
   * ACKNOWLEDGE THE ORGANIZER NOTICE ON ONE MAILBOX — the "Mark read" press.
   *
   * Stamps one instant on the caller's own row, and the line is gone from every door on its next
   * poll because every door derives it from the same comparison. Idempotent by construction: a
   * repeat press re-stamps the same acknowledgement, which only makes it more durable.
   *
   * Returns the updated row, so the pressing client settles at once instead of waiting a poll to
   * see its own press take.
   */
  dismissOrganizerNotice: (id: string) =>
    api<MailboxDTO>(`/mailboxes/${id}/organizer-notice/dismiss`, { method: "POST", body: {} }),

  /**
   * BEGIN the Microsoft consent ceremony. Returns the URL to navigate to at TOP LEVEL. It is a URL and not a redirect
   * this call follows, and that is not a style choice: a `fetch` cannot follow a cross-origin redirect AND change the
   * document, and Microsoft's consent screen sets `X-Frame-Options`, so an iframe is impossible and a popup is
   * blocked in the common case. The caller does `window.location.assign(authorizeUrl)`. `mailboxId` is optional and
   * buys ONE thing: a `login_hint`, so somebody reconnecting an expired mailbox is offered the right Microsoft
   * account first.
   */

  /**
   * It does NOT decide which mailbox row the ceremony writes — the address in Microsoft's `id_token` does — so a
   * person who ignores the hint and signs in as somebody else gets that other mailbox rather than this row repointed.
   * 503 `oauth_unconfigured` is a first-class answer: the deployment has not finished setting the Entra application
   * up. The caller renders the server's sentence, as everywhere else.
   */
  oauthStart: (b: { mailboxId?: string; returnTo?: string } = {}) =>
    api<{ authorizeUrl: string; state: string }>("/mailboxes/oauth/microsoft/start", { method: "POST", body: b }),

  /**
   * IS THE OUTLOOK DOOR ARMED ON THIS DEPLOYMENT — a boolean, and NOTHING about the registration.
   *
   * The pane reads this before it renders "Connect Outlook" (and the per-row "Reconnect Microsoft"),
   * so a deployment whose operator has not finished setting the Entra application up shows no button
   * that would then answer 503. The server resolves availability from the SAME `resolveOAuthProviderConfig`
   * the admin console and `…/start` use — but returns only `available`: the client id, the tenant and
   * the secret never cross to the browser. Read once on mount, not polled; it changes only when an
   * operator saves the console form.
   */
  oauthAvailability: () =>
    api<{ available: boolean; device?: boolean }>("/mailboxes/oauth/microsoft/availability"),

  /**
   * BEGIN THE DEVICE-CODE CEREMONY — the door an install that is not ohmail.app connects Outlook through, and the
   * only one available to a server whose operator has no Entra registration. There is no URL to navigate to and no
   * redirect anywhere in this flow. The answer is a short code and a URL the person opens themselves, on whatever
   * device they like; the tokens are issued straight to their own server. The caller renders the code and then drives
   * {@link deviceOAuthPoll}. `device` from {@link oauthAvailability} is the gate — offered only where a public client
   * is configured, so this is never a call that returns 503. 503 `oauth_device_unconfigured` is still a first-class
   * answer for the race where an operator unsets the variable mid-ceremony, and its sentence names the variable, as
   * the server's sentences always do.
   */
  deviceOAuthStart: () =>
    api<{
      state: string; userCode: string; verificationUri: string;
      expiresAt: string; intervalMs: number;
    }>("/mailboxes/oauth/microsoft/device/start", { method: "POST", body: {} }),

  /**
   * ONE POLL. Called repeatedly at the cadence the SERVER states, never at one this client picks. `retryAfterMs` is
   * authoritative: the interval belongs to Microsoft (RFC 8628 §3.5 — `slow_down` widens it cumulatively) and the
   * client id being throttled is shared by every install using the public registration, so a client that polled
   * faster would degrade the flow for other people's servers. The server refuses an early poll outright without
   * spending a request on Microsoft, so ignoring this value buys nothing anyway — it is stated so the honest client
   * and the enforced behaviour are the same thing. `status` is the whole state machine. `pending` re-arms; `declined`
   * and `expired` are terminal and not errors — somebody said no, or ran out of time; `granted` carries the stored
   * mailbox.
   */
  deviceOAuthPoll: (b: { state: string }) =>
    api<{
      status: "pending" | "declined" | "expired" | "granted";
      retryAfterMs?: number;
      expiresAt?: string;
      userCode?: string;
      verificationUri?: string;
      mailbox?: MailboxDTO;
      created?: boolean;
    }>("/mailboxes/oauth/microsoft/device/poll", { method: "POST", body: b }),

  /**
   * FINISH it — the SAME-SITE half, and the reason the ceremony is three steps rather than two. `tf_session` is
   * `SameSite=Strict`, so the browser withholds it on the cross-site top-level navigation back from Microsoft: the
   * API's `GET …/callback` cannot see a session and does not try to. It bounces the browser here instead, and THIS
   * call — same-origin, cookie and CSRF header both present — is where the ceremony is spent, the session's account
   * is checked against the one that started it, and the mailbox is stored. Single-use: a second call with the same
   * `state` is 400, which is what makes a replayed redirect (a refresh, a shared link) harmless rather than a second
   * mailbox.
   */
  oauthComplete: (b: { state: string; code: string }) =>
    api<{ mailbox: MailboxDTO; created: boolean; returnTo: string | null }>(
      "/mailboxes/oauth/microsoft/complete", { method: "POST", body: b },
    ),
};

/** One organizer holding a claim, as `GET /mailboxes/:id/organizer` reports it. */
export interface OrganizerHolder {
  kind: "local" | "cloud" | "unknown";
  /** The machine, as its own install named itself. `null` when the claim carried no name. */
  displayName: string | null;
  heartbeatAt: string;
  /** Still renewing. `false` means it stopped and left the claim behind. */
  active: boolean;
}

export interface OrganizerPeek {
  state: "none" | "held" | "stopped";
  /** Freshest first. */
  holders: OrganizerHolder[];
  /** Claims present but unreadable — evidence somebody claimed, which is why `state` is not `none`. */
  unreadable: number;
}

export type MailboxTakeover =
  | { outcome: "authorized"; previousReason: string }
  | { outcome: "already_organizing" }
  | { outcome: "disconnected" };

/**
 * What "stop organizing here" answered.
 *
 * `not_organizing` is a SUCCESS and not a refusal: a request to stop organizing a mailbox this
 * install does not organize has already got what it asked for, and it is also where a second
 * press lands, because the first one's gate demotes the row within a cycle.
 */
export type MailboxRelease =
  | { outcome: "requested" }
  | { outcome: "not_organizing" }
  | { outcome: "disconnected" };

// ── Saved settings found on a mailbox (the portable organizer profile) ───────────────────

/** What a found settings document holds, in the units the confirm card speaks. */
export interface ProfileImportCountsWire {
  screener: number;
  rules: number;
  notifyRules: number;
  tags: number;
  awayResponder: boolean;
}

/**
 * `GET /mailboxes/:id/profile-import` — is there a settings document waiting on this mailbox?
 *
 * `none` is the resting answer and the cheap one: the server reads its own durable record and
 * dials nothing, which is what lets the shell ask once per mailbox per tab. `found` carries the
 * counts of the document AS IT IS NOW plus its `fingerprint` — the receipt the confirm sends
 * back, so what gets applied is exactly what was shown. `newer` means a later ohmail wrote it;
 * nothing is offered, because a partial import would silently drop what this build cannot read.
 */
export type ProfileImportCandidateWire =
  | { state: "none" }
  | {
    state: "found";
    fingerprint: string;
    updatedAt: string;
    producer: { kind: string; version: string };
    counts: ProfileImportCountsWire;
  }
  | { state: "newer"; v: number }
  /**
   * The document holds more entries in one of its lists than the server will apply in a single
   * transaction, so nothing is offered — the same answer `newer` gives, for a different reason.
   *
   * Declared so the wire contract is complete; the card reads it as NO OFFER through `asOffer`'s
   * tolerant reader, which is already the correct behaviour — nothing is claimed and nothing is
   * shown. A dedicated message naming the list and the limit would be better and is a separate
   * change to the card, not to this type.
   */
  | { state: "too_large"; fingerprint: string; list: string; count: number; max: number };

export interface ProfileImportAppliedWire {
  imported: ProfileImportCountsWire;
  /** Document rules the server's own validation refused — imported minus these arrived. */
  skippedRules: number;
  seq: number | null;
}

export const profileImport = {
  candidate: (mailboxId: string) =>
    api<ProfileImportCandidateWire>(`/mailboxes/${mailboxId}/profile-import`),
  /**
   * Apply, on explicit confirmation only. The server re-reads the mailbox and refuses
   * (409 `profile_changed`) if the document no longer matches the fingerprint the user saw.
   */
  apply: (mailboxId: string, fingerprint: string) =>
    api<ProfileImportAppliedWire>(`/mailboxes/${mailboxId}/profile-import`, {
      method: "POST", body: { fingerprint },
    }),
  /**
   * Keep local. Durable — the same content never asks again, on this or any later visit —
   * and inert: nothing is applied and nothing in the mailbox is touched. A `newer` notice is
   * dismissed by the refused version instead, since there is no readable content to name.
   */
  decline: (mailboxId: string, subject: { fingerprint?: string; v?: number }) =>
    api<{ dismissed: boolean }>(`/mailboxes/${mailboxId}/profile-import/decline`, {
      method: "POST", body: subject,
    }),
};

// ── The account itself ───────────────────────────────────────────────────────────────────

/**
 * What `GET /account/access` answers.
 *
 * `mailboxes: null` is UNBOUNDED, never unknown — the port's own convention, and the reason an
 * unmetered host answers `metered: false` rather than a number nobody set.
 */
export type AccountAccess =
  | { metered: false }
  | { metered: true; canAddMailbox: boolean; mailboxes: number | null };

/** What `DELETE /account` answers. Every field is stated on the confirmation screen. */
export interface ErasureResult {
  erased: true;
  usersErased: number;
  /** Rows removed per table — the operator's audit line, not something the UI enumerates. */
  tables: Record<string, number>;
  /** The server's own sentence about what survives. Shown verbatim, never paraphrased. */
  retained: string;
  /**
   * What happened to a paid subscription. `cancel_failed` is the one value the screen must
   * shout about: the account is erased either way, and the customer no longer has a session
   * with which to discover that Stripe refused.
   */
  subscription: "none" | "cancelled" | "cancel_failed";
}

/** `GET`/`PATCH /account/ai` — the managed-AI switch, stored on `accounts.ai_enabled`. */
export const aiSettings = {
  get: () => api<{ aiEnabled: boolean }>("/account/ai"),
  set: (aiEnabled: boolean) =>
    api<{ aiEnabled: boolean }>("/account/ai", { method: "PATCH", body: { aiEnabled } }),
};

/** The wire shape of `GET/PATCH /account/screening` — the editable Ohbox preference. */
export interface ScreeningPreferenceWire {
  /** The stored posture, or `null` while the account has never set one (reads as lenient). */
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  /** The stored bar text, or `null` while the account has never set one (show `defaultBar`). */
  ohboxBar: string | null;
  /** The product-default bar, for the textarea placeholder when `ohboxBar` is null. */
  defaultBar: string;
  /**
   * Whether auto-apply is on. When on, obvious newsletters and receipts are filed out of the
   * Screener for you using the deterministic rules — no AI, no spend — and every move stays
   * reversible. Absent/failed reads resolve to `false`, so the default is off.
   */
  screenerAutoApply: boolean;
}

/**
 * `GET`/`PATCH /account/screening` — "what deserves my Ohbox". The PATCH sends only the axes the
 * caller changed: an omitted key is left untouched, an explicit `null` reverts that axis to default.
 */
export const screeningSettings = {
  get: () => api<ScreeningPreferenceWire>("/account/screening"),
  set: (body: {
    ohboxPolicy?: ScreeningPreferenceWire["ohboxPolicy"];
    ohboxBar?: string | null;
    screenerAutoApply?: boolean;
  }) => api<ScreeningPreferenceWire>("/account/screening", { method: "PATCH", body }),
};

/** What `GET /consent` answers: where an account stands in onboarding, and the dial it counts with. */
export interface ConsentStateWire {
  /** ISO timestamp, or null while the seed review has never been confirmed. */
  seedConfirmedAt: string | null;
  screeningResetAt: string | null;
  /**
   * The dormancy window in days. ALWAYS a number — the server substitutes the product default
   * for an account that has never moved it, because a client cannot partition with a null.
   */
  dormancyDays: number;
  /**
   * WHEN this account finished screening its backlog — the instant the dormancy window is measured back from — or
   * null for "never decided anything, measure from now" (mail 0056). Optional in the type, and the three states
   * collapse the way {@link autoSuggestAt}'s do rather than the way `blockRemoteImagesAt`'s do NOT: `null` (a server
   * that read the row and found no baseline) and `undefined` (an API deployed before mail 0056) both mean the client
   * partitions with the sliding window, which is what it did before this field existed. Nothing here is a safety
   * branch — the worst case of not knowing is the old churn, not somebody's mail being hidden. The one thing a reader
   * must not do is invent a baseline for either state. It is the SECOND half of the cutline arithmetic and must be
   * read together with {@link dormancyDays}: cutoff = `(screeningBaselineAt ?? now) - dormancyDays`.
   */
  screeningBaselineAt?: string | null;
  /**
   * WHEN auto-suggest was turned on, or null for off — and `undefined` from an API deployed
   * before mail 0040, which must read the same as null.
   *
   * Optional in the type on purpose. The three states a client can be in are "off", "on since
   * T", and "this deployment does not have the field", and only the second of them may spend
   * money, so the other two collapse safely into one branch. Typing it as required would make
   * the pre-0040 deployment a type lie the reader has to remember to handle.
   */
  autoSuggestAt?: string | null;
  /**
   * WHEN this account opted OUT of loading remote images automatically, or null for the product
   * default — which is that they load, through the proxy.
   *
   * Optional in the type, and the three states are NOT interchangeable here the way
   * {@link autoSuggestAt}'s are. `null` is a server that read the row and found no opt-out ⇒ auto.
   * `undefined` is an API deployed before mail 0048, which cannot have read the row at all ⇒
   * MANUAL, the same answer a failed fetch gets. Collapsing them would load remote content on
   * behalf of somebody whose stored preference this build never saw.
   */
  blockRemoteImagesAt?: string | null;
  /**
   * WHEN this account asked for tracking pixels to LOAD, or null for the default (blocked) — and
   * `undefined` from an API deployed before mail 0072. Unlike the field above, `null` and
   * `undefined` may be read as ONE answer: both are "blocked", and the collapse is safe because
   * blocked is the protective posture — a client that cannot tell refuses a beacon, never fetches
   * one.
   */
  loadTrackingPixelsAt?: string | null;
  /**
   * WHEN "Use folders" was turned on, or null for off — and `undefined` from an API deployed
   * before the folders feature, which must read the same as null (the pre-feature interface is
   * exactly what such a server serves). Optional in the type for `autoSuggestAt`'s reason: the
   * two absent states collapse safely into "off".
   */
  foldersEnabledAt?: string | null;
  /**
   * PER-MAILBOX "Use folders" — only the EXCEPTIONS travel: `{ mailboxId: instant switched
   * off }` (FOLDERS-SPEC.md §17). A mailbox absent from the map participates; an absent map
   * (an API deployed before mail 0073) reads as "no exceptions", which is the same picture
   * that server actually serves.
   */
  folderMailboxesOff?: Record<string, string>;
  /**
   * PER-MAILBOX SIGNATURES — `{ mailboxId: text }`, only the mailboxes that HAVE one (mail
   * 0075). A mailbox absent from the map signs with nothing, which is the resting state; an
   * absent MAP (an API deployed before mail 0075) reads the same way, which is the picture
   * such a server actually serves.
   */
  signatures?: Record<string, string>;
  /**
   * PER-MAILBOX SIGNATURE MARKUP (mail 0098) — only the mailboxes whose signature has
   * formatting. Optional like the map above and for the same reason: a host too old to have
   * the column omits it, which reads as "nothing here has formatting" and is the picture
   * that server serves.
   */
  signaturesHtml?: Record<string, string>;
  /**
   * WHEN this account turned OFF auto-unsubscribe on screen-out, or null for the product default — which is that
   * screening a sender out, or marking them spam, also sends the sender's one-click unsubscribe request. Optional,
   * and here `null` and `undefined` ARE the same answer, unlike {@link blockRemoteImagesAt} one field up. Both mean
   * "no stored opt-out has reached this build", and both must resolve to the SAME branch — ON — because what the
   * client does with this value is decide whether to TELL somebody, before they click, that a screen-out will also
   * leave the sender's list. The server has its own copy and will act on it regardless, so a client that resolved "I
   * do not know" to OFF would drop the disclosure of an irreversible request that is still going out. Collapsing them
   * is the correct direction, not the convenient one.
   */
  blockAutoUnsubscribeAt?: string | null;
  /**
   * THE ACCOUNT'S INTERFACE LANGUAGE — `'de'`, or `null` for "this account has no preference". Optional, and here
   * `null` and `undefined` genuinely ARE the same answer, unlike {@link blockRemoteImagesAt} one field up: both mean
   * "nothing from the account, so keep whatever language this device remembered". An API too old to carry the field
   * and an account that never opened the selector leave the reader in exactly the same place, and neither may
   * override a device — so collapsing them is correct rather than convenient. A string that is not a supported locale
   * cannot arrive: the column's CHECK closes the set and `consentSettings` refuses an unsupported value on the read
   * side as well. The client normalises anyway (`normalizeLocale`), because a boot path that trusts a wire string is
   * one deploy skew away from asking for a catalogue that does not exist.
   */
  locale?: string | null;
  /**
   * THE ACCOUNT'S APPEARANCE FACE — `'paper' | 'ohmarchy'`, or `null` for "no account-wide
   * choice". Optional with `locale`'s collapse: an API too old to carry the field and an
   * account that never chose leave the reader in the same place — the DEVICE resolves its own
   * default (its pin, then the Linux detection, then paper; `ThemeProvider` owns the order).
   * Unlike locale, `'paper'` is a real stored value, because on a Linux device it is the
   * instruction that overrides the detection (mail 0082's header).
   */
  themeFace?: string | null;
  /**
   * WHEN THE FIRST-RUN FLOW WAS LAST LEFT — finished or cancelled — or `null` for "never" (mail 0083). The last of
   * the onboarding truth-conditions, and the only one about the flow itself rather than about the mailbox. Optional,
   * and `null` and `undefined` collapse to the SAME branch — open the flow — which is the correct direction rather
   * than the convenient one. An API too old to carry the column and an account that has never been through the flow
   * leave the reader in the same place, and the cost of being wrong that way is an overlay with a Cancel on it.
   * Resolving an unknown to "completed" would be the expensive mistake: it hides first-run setup from an account that
   * has never seen it, and there is no other route into consent on the standalone door.
   */
  onboardingCompletedAt?: string | null;
  /**
   * THE SCREENING MODE — `'window'` (the cutline is `screeningBaselineAt − dormancyDays`) or
   * `'all_time'` (no cutline; nothing is filed to History unscreened). Mail 0083.
   *
   * Optional, and `undefined` reads as `'window'`: an API deployed before the column serves
   * exactly the windowed behaviour every client had before the mode existed, so the absent case
   * is not a guess. It is the THIRD half of the cutline arithmetic and must be read with
   * {@link dormancyDays} and {@link screeningBaselineAt} — a client holding two of the three
   * partitions its mirror differently from the server that counted for it.
   */
  screeningScope?: "window" | "all_time";
  counts: {
    decidedSenders: number;
    activeUndecidedSenders: number;
    dormantUndecidedSenders: number;
  };
}

export interface SeedCandidateWire {
  address: string;
  name: string | null;
  messages: number;
  lastWrittenAt: string | null;
  alreadyDecided: boolean;
}

export interface SeedReviewWire {
  candidates: SeedCandidateWire[];
  excluded: Array<{ address: string; reason: "robot-recipient" | "machine-sent" | "own-address" }>;
  scannedMessages: number;
  truncated: boolean;
}

/**
 * Onboarding consent — the sent-mail seed, the dormancy dial and the screening reset. `dormancyDays` reaches the
 * client HERE rather than through the sync feed, and deliberately: it is one integer per account that moves about as
 * often as somebody changes their mind about what "recent" means. Growing the delta vocabulary for it would mean a
 * new entity type in every change-log writer, in the wire union and in the mirror, for a value with no history worth
 * replaying and no delete to represent. The precedent is the one the schema already documents for per-account
 * settings tables: served over REST, refetched. The dial IS writable, through {@link consent.setDormancyDays} →
 * `PATCH /consent/settings`, which shares one route with {@link consent.setAutoSuggest}: two independent knobs,
 * field-present ⇒ acted-on.
 */

/**
 * The write echoes the EFFECTIVE window back (always a number), and the caller sets its hook state from that echo so
 * the open tab re-partitions with the value the server actually stored. It is a settings write only — the dial
 * changes what the Screener SHOWS, never where mail lives.
 */
/**
 * WAKE REGISTRATIONS — the three calls that let this browser be woken while it is closed. `vapidKey` comes FIRST and
 * is not optional: a browser subscribes by handing its push service a server's public key, and from then on renders
 * only wakes signed by the matching private half. The key is per-deployment — the hosted service, an operator's own
 * install — so it has to be asked for rather than compiled in. A deployment with no keypair answers `null`, which is
 * a supported state and not a failure: the app says so and does not subscribe. `subscribe` sends the three values a
 * `PushSubscription` yields and nothing else. No device name, no locale, no account field — the row is keyed by the
 * endpoint, and the session is what says whose it is.
 */
export const push = {
  vapidKey: () => api<{ publicKey: string | null }>("/push/vapid-key"),
  subscribe: (endpoint: string, p256dh: string, auth: string) =>
    api<{ id: string }>("/push/subscriptions", {
      method: "POST",
      body: { transport: "webpush", endpoint, p256dh, auth },
    }),
  /** Idempotent by intent: a 404 means the row is already gone, which is the desired state. */
  unsubscribe: (id: string) =>
    api<void>(`/push/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const consent = {
  state: () => api<ConsentStateWire>("/consent"),
  /**
   * TURN AUTO-SUGGEST ON OR OFF. The only account setting this client can write. `enabled` is sent as a real boolean
   * because the route refuses anything else — an absent or non-boolean field is a 400 rather than a silent opt-out,
   * so a bug here surfaces as a refusal instead of as suggestions that quietly stopped. No `Idempotency-Key`: setting
   * a flag to the same value twice is the same state, and the only thing a replay moves is the recorded instant. The
   * response echoes what the DATABASE holds, so the caller updates from that rather than from what it asked for.
   */
  setAutoSuggest: (enabled: boolean) =>
    api<{ autoSuggestAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { autoSuggest: enabled },
    }),
  /**
   * SET THE DORMANCY WINDOW — the cutline dial, on the SAME route as {@link consent.setAutoSuggest} with
   * `dormancyDays` in the body instead of `autoSuggest` (field-present ⇒ acted-on, so the two never touch each
   * other's column). AND "ALL TIME", WHICH IS THIS SAME DIAL'S OTHER ANSWER: `scope` is `'window'` (the cutline is
   * `screeningBaselineAt − dormancyDays`) or `'all_time'` (no cutline at all). It rides THIS call rather than one of
   * its own because the two are one answer to one question, and the server writes them in one upsert for the same
   * reason. Either argument may be omitted and omitted means UNTOUCHED, in both directions; the echo carries back
   * only the halves that were named. `days` is an integer 1–365, or `null` to revert to the product default.
   */

  /**
   * The server refuses anything outside the band with a 400 rather than storing a value that would later crash the
   * `GET /consent` read, and it NEVER stores the default itself — so the response's `dormancyDays` is the EFFECTIVE
   * window (a null store reads back as the default). The caller updates its hook from that echo, which is what
   * re-partitions the open tab.
   */
  setDormancyDays: (days: number | null | undefined, scope?: "window" | "all_time") =>
    api<{ dormancyDays?: number; screeningScope?: "window" | "all_time" }>("/consent/settings", {
      method: "PATCH",
      body: {
        // FIELD-PRESENT ⇒ ACTED ON, so an unnamed half must not appear on the wire at all: a
        // `dormancyDays: undefined` would serialise away, but naming it explicitly is what
        // keeps "leave the other one alone" a property of the request rather than of JSON.
        ...(days !== undefined ? { dormancyDays: days } : {}),
        ...(scope !== undefined ? { screeningScope: scope } : {}),
      },
    }),
  /**
   * KEEP THE PER-MESSAGE "SHOW IMAGES" FLOW, OR LET IMAGES LOAD — the third knob on the same route (field-present ⇒
   * acted-on, so it never touches the other two columns). `blocked: true` stores the OPT-OUT; `false` clears it and
   * returns the account to the product default. The response echoes the stored instant (`null` when images load), and
   * the caller sets its state from that echo — a refused write must not be drawn as a move, and here a write drawn as
   * a move in the wrong direction would start loading remote content. The route refuses anything that is not a real
   * boolean, so a malformed body is a 400 rather than a silently cleared opt-out.
   */
  /**
   * TURN "USE FOLDERS" ON OR OFF — the folders feature's master toggle (FOLDERS-SPEC.md §6), on
   * the same route with `foldersEnabled` in the body (field-present ⇒ acted-on). It spends
   * nothing and writes nothing into the mailbox; the response echoes what the DATABASE holds,
   * and the caller updates from that rather than from what it asked for.
   */
  setFoldersEnabled: (enabled: boolean) =>
    api<{ foldersEnabledAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { foldersEnabled: enabled },
    }),
  /** Per-mailbox "Use folders" (FOLDERS-SPEC.md §17) — the echo is the WHOLE exceptions map. */
  setMailboxFoldersEnabled: (mailboxId: string, enabled: boolean) =>
    api<{ folderMailboxesOff: Record<string, string> }>("/consent/settings", {
      method: "PATCH",
      body: { folderMailboxes: { [mailboxId]: enabled } },
    }),
  /**
   * Per-mailbox signature (mail 0075): a string stores it, `null` clears it — the echo is the
   * WHOLE map, and since mail 0098 BOTH maps, because a write to either changes both columns.
   *
   * `signatureHtml` carries the MARKUP shape and the server derives the text half from it. The
   * two ride DIFFERENT body fields and exactly one is sent: a request naming a mailbox in both
   * is refused before anything writes, so the caller's `null` text in the markup branch is not
   * a placeholder — it is the absence of the other shape.
   */
  setMailboxSignature: (
    mailboxId: string, signature: string | null, signatureHtml?: string | null,
  ) =>
    api<{
      signatures: Record<string, string>;
      signaturesHtml?: Record<string, string>;
    }>("/consent/settings", {
      method: "PATCH",
      body: signatureHtml !== undefined
        ? { signaturesHtml: { [mailboxId]: signatureHtml } }
        : { signatures: { [mailboxId]: signature } },
    }),
  setBlockRemoteImages: (blocked: boolean) =>
    api<{ blockRemoteImagesAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { blockRemoteImages: blocked },
    }),
  /**
   * THE FIRST-RUN FLOW HAS BEEN LEFT — finished or cancelled (mail 0083), on the same route with
   * `onboardingCompleted` in the body (field-present ⇒ acted-on). It takes NO argument because the wire accepts only
   * `true`: there is no un-complete instruction, so a boolean parameter would be a control with an unreachable
   * position. Both endings call it, which is the ruling — the stamp answers "should this open by itself again", and
   * both answers to that are no. It is deliberately NOT the consent write. Consent, the baseline, the window and the
   * scope land together inside `POST /mailboxes/:id/organize`'s transaction; this is the flow's own bookkeeping, so a
   * cancel BEFORE consent records the cancel and authorises nothing.
   */
  completeOnboarding: () =>
    api<{ onboardingCompletedAt: string }>("/consent/settings", {
      method: "PATCH",
      body: { onboardingCompleted: true },
    }),
  /**
   * BLOCK TRACKING PIXELS (the default), OR LET THEM LOAD — mail 0072, the same route. `blocked:
   * true` clears the stored opt-out; `false` stores it. The response echoes `loadTrackingPixelsAt`
   * — the instant pixels were allowed, `null` while they are blocked.
   */
  setBlockTrackingPixels: (blocked: boolean) =>
    api<{ loadTrackingPixelsAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { blockTrackingPixels: blocked },
    }),
  /**
   * KEEP AUTO-UNSUBSCRIBE ON SCREEN-OUT, OR STOP IT — the fifth knob on the same route (field-present ⇒ acted-on, so
   * it never touches the other four columns). `blocked: true` stores the OPT-OUT; `false` clears it and returns the
   * account to the product default. The response echoes the stored instant (`null` when the pass runs), and the
   * caller sets its state from that echo: a refused write drawn as a move would tell somebody their lists are being
   * left alone while the server goes on leaving them, which is the one direction of this control that matters. The
   * route refuses anything that is not a real boolean, so a malformed body is a 400 rather than a silently cleared
   * opt-out.
   */
  setBlockAutoUnsubscribe: (blocked: boolean) =>
    api<{ blockAutoUnsubscribeAt: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { blockAutoUnsubscribe: blocked },
    }),
  /**
   * SET THE INTERFACE LANGUAGE — the fourth knob on the same route (field-present ⇒ acted-on). Resolves to the STORED
   * value, which is not always the one that was asked for: the service never stores the default, so `setLocale("en")`
   * answers `null`. The caller must apply the ECHO — `AccountLocale` does — because `null` is what tells this and
   * every other device that the account has stopped overriding their remembered language. Applying the argument
   * instead would leave one tab believing the account still says English while the row says nothing. `null` is a
   * legal argument and means "back to the default"; it is NOT the same as omitting the field, which would leave the
   * stored value untouched.
   */
  setLocale: (locale: string | null) =>
    api<{ locale: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { locale },
    }).then((r) => r.locale),
  /**
   * SET THE ACCOUNT-WIDE APPEARANCE FACE — "apply for all devices", the same route and the
   * same echo rule as {@link setLocale}. `'paper'` stores and echoes `'paper'` (never
   * collapsed to null — it is what overrides a Linux device's ohmarchy detection); `null`
   * drops the account-wide choice and every device resolves its own default again.
   */
  setThemeFace: (themeFace: string | null) =>
    api<{ themeFace: string | null }>("/consent/settings", {
      method: "PATCH",
      body: { themeFace },
    }).then((r) => r.themeFace),
  /** The review list. Reads, and writes nothing — the list is an offer. */
  seedReview: () => api<SeedReviewWire>("/consent/seed"),
  /**
   * THE CONSENT EVENT. One press, one key: the server refuses a second confirm outright
   * (409), so an `Idempotency-Key` is what separates "the user clicked twice" from "the
   * first response never arrived".
   */
  confirmSeed: (addresses: string[], opts: { idempotencyKey?: string } = {}) =>
    api<{ rulesCreated: number; contactsCreated: number; declined: number; skipped: number }>(
      "/consent/seed",
      {
        method: "POST",
        body: { addresses },
        ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
      },
    ),
  /** What a reset would leave physically moved. Safe to call before deciding to reset. */
  resetPreview: () =>
    api<{ unmoved: Array<{ folder: string; messages: number; observed: number }> }>("/consent/reset"),
  /** Step-up gated. The caller runs the second factor first, as `account.erase` does. */
  reset: () =>
    api<{
      rulesDeleted: number; contactsDeleted: number; screenerSuggestionsDeleted: number;
      learningSignalsDeleted: number;
      unmoved: Array<{ folder: string; messages: number; observed: number }>;
    }>("/consent/reset", { method: "POST" }),
};

/** The single per-account autoresponder row, as `GET/PUT /away-responder` serve it. */
export interface AwayResponderWire {
  enabled: boolean;
  /**
   * NO `subject`. The responder is REPLY-ONLY: it answers with `Re: <what the correspondent
   * wrote>`, threaded by `In-Reply-To`/`References`, so there is no subject for anyone to compose.
   * The server accepts the field from an older client and ignores it, which is what keeps a browser
   * tab that has not reloaded from 400ing on every save — including the save that turns the
   * responder off.
   */
  body: string | null;
  startsAt: string | null;
  /**
   * WHEN THE RESPONDER STOPS — the instant the settings pane's date field resolves to (end of the
   * chosen day where the reader is), or `null` for open-ended.
   *
   * Past it the responder answers nobody, and the away pass then switches the row off and clears
   * this field, so `enabled` and this date cannot disagree for longer than one pass cycle. The
   * server refuses an instant already past while `enabled` is true.
   */
  endsAt: string | null;
  /** Who gets an automatic reply. `screened_in` restricts it to senders past the Screener. */
  audience: "screened_in" | "everyone";
  /**
   * How often ONE PERSON may be answered. `per_day` is the default and what every existing
   * responder carries. `per_message` means "once, until you change the text" — keyed by the text
   * itself, so saving without editing does not re-answer anybody.
   */
  throttle: "always" | "per_message" | "per_day" | "per_week";
  /**
   * WHICH PILES GET A REPLY — folder names, `['INBOX']` for a responder nobody has widened. The second dimension
   * beside `audience`, answering a different question: `audience` is about a SENDER (past the Screener, decided
   * once), this is about WHERE their mail landed. A sender let in once whose later mail files to Reads is still
   * "somebody I've let in", which is how eight automatic replies reached shop and notification senders. FOLDERS, not
   * pile words — the Ohbox pile's folder is `INBOX`. `AWAY_PILE_VIEW` and `awayEffectivePiles`
   * (`@trafficflow/core/away-scope`) translate for display, and the settings control imports the offered set from
   * there so it cannot offer a pile the server refuses. PUT IS A FULL REPLACE, so this field is not optional for a
   * caller: omitting it resets the scope to the Ohbox. An EMPTY array is "answer nobody" and is stored as asked.
   */

  /**
   * `ohmail/Screener` is only storable beside `audience: "everyone"` — the server answers 400 for the other pair, and
   * the control disables that box.
   */
  piles: ("INBOX" | "ohmail/Reads" | "ohmail/Receipts" | "ohmail/Screener")[];
  updatedAt: string | null;
}

/**
 * The away responder. REST-only, like the consent settings above and for the same reason: one row per account that
 * changes when somebody goes on holiday. `PUT` IS A FULL REPLACE, and every caller has to treat it as one. The route
 * stores exactly the fields in the body and defaults the ones that are absent — an omitted `audience` becomes
 * `screened_in`, the narrow member — so a partial write is a silent reset of whatever it left out, never a merge.
 * `AwayResponderRow` therefore sends the whole row back and never a single field. No `Idempotency-Key`: the upsert is
 * keyed on the account, so a replay stores the same row twice and the only thing that moves is `updatedAt`.
 */

/**
 * That is not free — `updatedAt` is the away responder's ENABLEMENT EPISODE, so a replay lets each correspondent be
 * answered once more — which is why this client never retries the call automatically and why the row's control is a
 * deliberate press rather than a debounced autosave.
 */
/**
 * WHAT A SAVE ANSWERS — the row, plus the one discriminator a 202 carries.
 *
 * `PUT /away-responder` answers 202 with `pending: true` on an account whose mailboxes are
 * organized by another install: nothing was written here and a request is waiting on the machine
 * that organizes them. The wire type used to be the row alone, so that field was dropped and the
 * pane announced "Saved." over the values it had just put back — a false state about a setting
 * that decides what strangers are told. Separate from {@link AwayResponderWire} rather than a
 * field on it, so the PUT BODY cannot grow a member the server never asked for.
 */
export interface AwayResponderSaveWire extends AwayResponderWire {
  pending?: boolean;
}

export const away = {
  state: () => api<AwayResponderWire>("/away-responder"),
  save: (next: Omit<AwayResponderWire, "updatedAt">) =>
    api<AwayResponderSaveWire>("/away-responder", { method: "PUT", body: next }),
};

export const account = {
  /**
   * `DELETE /account` — Art. 17 erasure. `stepUp`-gated, and unlike `POST /mailboxes` there is no window in which a
   * caller is already fresh: nothing but a completed second factor sets `sessions.last_twofa_at`, and the window is
   * five minutes. So `AccountSection` runs the sign-in ceremony immediately before calling this, rather than calling
   * it optimistically and translating the 403. No body: `withRequestGuard` only demands `application/json` of a
   * request that HAS one, and this call's whole payload is the session it is authenticated by.
   */
  /*
   * ON THE CEREMONY LIST, and it was the one real writer the hand-written census missed.
   * `DELETE /account` answers with `clearSessionCookies()` (`packages/api/src/routes/account.ts`),
   * so it empties the whole origin jar — the most destructive cookie write in the product. An
   * erase issued under A whose response lands after B has signed in clears B's session; in the
   * tighter race the DELETE itself authenticates as B, which is an irreversible wrong-account
   * operation rather than a stray sign-out.
   */
  erase: () => api<ErasureResult>("/account", { method: "DELETE" }),
  /**
   * `POST /account/manage-link` — where this account manages its subscription, or `null`.
   *
   * `null` ONLY for a 404, which is this deployment saying it operates no such page: an
   * unmetered or self-hosted install, and the one refusal that is a fact about the server
   * rather than about the caller. Every other status throws, `api()` having already turned an
   * unreachable server into an `ApiError` too — so the decision to show no row for a refusal
   * belongs to the caller (`useManageLink`), where it can be driven, and not to a client that
   * would otherwise report a 500 as "there is nothing here".
   */
  /**
   * `GET /account/access` — the limits the entitlements program states for this account.
   *
   * A REFUSAL never arrives here: a refused account is answered 402 at every `read` door and
   * this module's own notifier swaps the surface for the lock screen, so the only thing to read
   * back is "may you add another mailbox, and how many does the plan hold". `metered: false` is
   * a host with no such program, where both answers are "no limit".
   */
  access: () => api<AccountAccess>("/account/access"),
  manageLink: async (): Promise<{ url: string } | null> => {
    try {
      return await api<{ url: string }>("/account/manage-link", { method: "POST", body: {} });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
};

/**
 * The spy-pixel blocker's consent write.
 *
 * The blocker's other two surfaces are NOT here on purpose. `GET /img` is never `fetch`ed by
 * this client at all: it is a url the sanitizer puts in an `<img src>`, so the browser issues
 * it as a subresource of the message frame and the host-only session cookie authenticates it
 * — see `app/shell/remote-images.ts`. And the tracker-event feeds are read through the sync
 * engine's own mirror rather than through this client.
 */
export const privacy = {
  /**
   * "Load anyway" for one message. Idempotent-safe server-side (a second call is a no-op), so
   * a retry costs a row update and never a wrong answer.
   *
   * No body, for `account.erase`'s reason: `withRequestGuard` only demands `application/json`
   * of a request that has one, and the whole payload is the message id in the path.
   */
  loadRemote: (messageId: string) =>
    api<{ remoteContent: string }>(`/messages/${encodeURIComponent(messageId)}/load-remote`, {
      method: "POST",
      body: {},
    }),
};

// ── Screener suggestions ─────────────────────────────────────────────────────────────────

/**
 * WHY THE SCREENER HAS A CLIENT HERE AT ALL, WHEN ITS ROWS COME FROM `/sync`. The waiting queue this app renders is
 * DERIVED from the message mirror (`@ohmail/client-engine`'s `screenerSegments`), not from `GET /screener`, and the
 * delta stream carries no suggestion — a suggestion is advice about mail, not a change to it, so nothing puts one in
 * `/sync`. That is the whole reason every waiting row used to show "no suggestion": there was no path by which one
 * could arrive. These two calls are that path, and they are deliberately the only ones. `GET /screener` reads what
 * has already been bought (it spends nothing) and `POST /screener/suggest` buys more, for a sender set the client
 * names explicitly. Neither replaces the mirror as the source of the rows; both are joined onto it by sender address.
 */
export interface ScreenerWireItem {
  id: string;
  messageId: string;
  sender: { name: string | null; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  aiSuggestion: { decision: "yes" | "no" | "hold"; confidence: number; rationale: string } | null;
}

export interface ScreenerWirePage {
  items: ScreenerWireItem[];
  nextCursor: string | null;
  /**
   * The price of suggesting for THIS PAGE — not for what is on screen.
   *
   * Read for `maxPerRequest` alone, and that asymmetry is deliberate: the page is a server-side
   * window over the held set while the rows this app shows come from the mirror, so the two
   * sender lists are not the same list and `credits` here would price senders the user may not
   * be looking at. The number that IS quoted to the user comes from a dry run over the exact
   * set about to be posted.
   */
  suggestable: { senders: string[]; credits: number; maxPerRequest: number };
  /**
   * SENDERS THIS INSTALL HAS DECIDED ON THAT ITS ORGANIZER HAS NOT CARRIED OUT YET. They are ALREADY EXCLUDED from
   * {@link items}, which is what makes this field load-bearing rather than informational: without it the exclusion is
   * a disappearance, and a sender who left the queue on a press a person made yesterday has nothing on screen
   * accounting for them. OPTIONAL, and absent means "none known" — a server deployed before the field, and every
   * install that organizes its own mailboxes. Both want the same thing, which is nothing shown. `state` and `reason`
   * are read structurally rather than switched on: an organizer that starts answering with an outcome this build has
   * never heard of should render the generic sentence, not a raw token.
   */
  pendingDecisions?: Array<{
    subject: string;
    scope: "sender" | "domain";
    decidedAt: string;
    sent: boolean;
    /**
     * `pending` and `sent` are outstanding; `refused` means the organizer answered no and the
     * sender is back in the queue. A decision that was applied, or that expired, is not reported.
     * Optional, because a server deployed before the field sends none.
     */
    state?: "pending" | "sent" | "refused";
    /** The organizer's word for a refusal — `null` outside `refused`, and for one it did not explain. */
    refusedReason?: string | null;
  }>;
}

/**
 * Why one requested sender produced nothing. Mirrors `ScreenerSuggestSkip` on the server.
 *
 * `"withheld"` was a member and is not one now: under the AI-OPEN ruling every held sender is
 * suggestable, so no server can emit it. It is dropped rather than kept-and-never-matched because
 * a mirrored union that carries a value the server cannot send is how a dead UI branch survives a
 * policy change — and this one had copy attached to it that made a promise the product stopped
 * making.
 */
export type ScreenerSkipReason =
  | "not_held" | "out_of_credits" | "spend_unavailable" | "model_unavailable";

export interface ScreenerSuggestWire {
  dryRun: boolean;
  requested: number;
  /** Senders that would be bought. `quotedCredits` is what they COST — never re-derive it. */
  quoted: number;
  quotedCredits: number;
  /** Credits actually moved. Lower than the quote when a sender's answer was already bought. */
  charged: number;
  /** Set when the spend gate stopped the run PART-WAY; absent on a run that served everything. */
  stopped?: "out_of_credits" | "spend_unavailable";
  /**
   * WHAT IS LEFT ON THE ACCOUNT after this request — the server's ledger read, never ours. The one number a person
   * wants after being told what a run cost, and the one this client is categorically not allowed to compute.
   * Subtracting `charged` from a remembered figure is a shadow ledger: wrong after a renewal, a refund, an expiry or
   * a second tab, and wrong in the direction that tells somebody they have credits they do not. Invariant #10 — the
   * side that moves the money is the side that names it. OPTIONAL, and absent means NO ANSWER, never zero: an
   * unmetered deployment has no ledger to read and a courtesy read that failed is not a balance of nothing.
   * `summarize` omits the clause entirely rather than rendering a number it had to invent.
   */
  remainingCredits?: number;
  suggestions: Array<{
    sender: string;
    messageId: string;
    /** `hold` ⇒ the model declined to place this sender; no bulk control may act on it. */
    decision: "yes" | "no" | "hold";
    /**
     * Which pile the model actually named. OPTIONAL because an older server does not send it, and
     * a client that guessed a folder from `decision` alone would be inventing an answer — see
     * `toSuggestion`, which falls back to the two-way reading rather than to a default folder.
     */
    destination?: string;
    /** The model's own "this is junk". Optional for the same deploy-skew reason. */
    spam?: boolean;
    confidence: number;
    rationale: string;
  }>;
  skipped: Array<{ sender: string; reason: ScreenerSkipReason }>;
}

export const screener = {
  /** One page of the held queue, with whatever suggestions are already on record. `cost: read`. */
  list: (opts: { limit?: number; cursor?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return api<ScreenerWirePage>(`/screener${qs ? `?${qs}` : ""}`);
  },

  /**
   * Buy suggestions for an EXPLICIT sender set — or, with `dryRun`, price it and stop.
   *
   * `dryRun` reaches no model, moves no credits and stores nothing, which is what makes it
   * safe to call on every change of the batch size. The real run carries an `Idempotency-Key`
   * so a retry after a lost response replays the answer instead of buying twice; the caller
   * owns the key, because the thing being made idempotent is one press of one button.
   */
  suggest: (senders: string[], opts: { dryRun?: boolean; idempotencyKey?: string } = {}) =>
    api<ScreenerSuggestWire>("/screener/suggest", {
      method: "POST",
      body: opts.dryRun ? { senders, dryRun: true } : { senders },
      ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
    }),

  // ── The Junk window (FOLDERS-SPEC.md §16.2) — a LIVE view of the provider's own \Junk. ────
  // Nothing here is mirror data: the server reads the folder itself, bounded (newest 50 per
  // mailbox window), and never writes a mirror row. All three answer 409 `folders_disabled`
  // until "Use folders" is on, so a flag-off client simply never calls them.

  /** One merged newest-first page across the account's junk windows. `cursor` pages older. */
  junkList: (opts: { cursor?: string } = {}) =>
    api<JunkPageWire>(`/screener/junk${opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`),

  /**
   * One junk message's body, fetched live and parsed to TEXT — never HTML, never stored.
   * Epoch-bound: `uidValidity` is the row's own, and a folder renumbered since answers 410
   * rather than the body of whatever message now wears the UID.
   */
  junkBody: (mailboxId: string, uid: number, uidValidity: string) =>
    api<{ subject: string; text: string }>(
      `/screener/junk/body?mailboxId=${encodeURIComponent(mailboxId)}&uid=${uid}&uidValidity=${encodeURIComponent(uidValidity)}`,
    ),

  /**
   * "Not junk": ONE server-side move out of \Junk back to the inbox — the un-training gesture —
   * after which the message re-enters through the NORMAL pipeline (a first-time sender waits in
   * the Screener; an allowed one lands in the Ohbox). 410 when the provider removed it first.
   *
   * `allow: { sender }` is the SECOND verb — "Not junk, always allow": the server disables the
   * sender's spam-promoting rule and mints their allow BEFORE the move, in one transaction, so
   * the rescued message and every later one skip the gate. Same route; the server never forks a
   * parallel rescue path. On a 410 the allow still stands — the press was about the sender.
   */
  junkRescue: (mailboxId: string, uid: number, uidValidity: string, opts: { allow?: { sender: string } } = {}) =>
    api<JunkRescueWire>("/screener/junk/rescue", {
      method: "POST",
      body: { mailboxId, uid, uidValidity, ...(opts.allow ? { allow: opts.allow } : {}) },
    }),

  /**
   * The search-append (§16.2's table): one server-side SEARCH per junk folder behind the same
   * read budget as the list, the newest hits merged. A mailbox that did not answer in time is
   * stated `unreachable` — "Junk could not be searched" — never an empty answer pretending.
   */
  junkSearch: (q: string) =>
    api<JunkSearchWire>(`/screener/junk/search?q=${encodeURIComponent(q)}`),

  /** The one-time sweep offer's DRY RUN (§16.1): what still sits in ohmail/Quarantine. */
  junkSweepPreview: () => api<JunkSweepWire>("/screener/junk/sweep"),

  /** The PRESS: records the sweep for the worker to execute; answers the preview it leaves. */
  junkSweepRequest: () => api<JunkSweepWire>("/screener/junk/sweep", { method: "POST" }),
};

export interface JunkRescueWire {
  status: "rescued";
  /** Present only for the second verb: what the allow half did. */
  allowed?: { disabledRuleIds: string[]; createdRuleId: string | null };
}

export interface JunkSearchWire {
  mailboxes: JunkMailboxWire[];
  items: JunkItemWire[];
  /** Some mailbox matched more than the page carried — the rows are the newest hits only. */
  truncated: boolean;
}

export interface JunkSweepMailboxWire {
  id: string;
  address: string;
  candidates: number;
  hasJunkFolder: boolean;
  pending: boolean;
}

export interface JunkSweepWire {
  mailboxes: JunkSweepMailboxWire[];
  /** Candidates across the mailboxes that CAN move — the offer's number. */
  movable: number;
  pending: boolean;
}

/** One row of the live Junk window — a header fact, never a mirror entity. */
export interface JunkItemWire {
  mailboxId: string;
  uid: number;
  uidValidity: string;
  subject: string;
  from: { name: string | null; address: string };
  date: string | null;
  messageIdHeader: string | null;
  seen: boolean;
  /** Who filed it: our recorded verdict/sweep, or the mail server's own filter. */
  origin: "verdict" | "provider";
}

export interface JunkMailboxWire {
  id: string;
  address: string;
  window: "ok" | "no_junk_folder" | "unreachable";
  /** This mailbox's cursor was discarded (UIDVALIDITY changed) — its rows are a fresh TOP page. */
  reset?: boolean;
}

export interface JunkPageWire {
  mailboxes: JunkMailboxWire[];
  items: JunkItemWire[];
  nextCursor: string | null;
}

// ── The Trash window — a LIVE, un-mirrored read of the provider's own \Trash ──────────────
// The Trash VIEW's own list is the mirror (`engine.listTrash`): what ohmail deleted, with its
// origin folder and its restore. These two answer the other population — mail deleted in
// another mail client, which the sync never reads. Both are GET; neither writes anything, here
// or on the server (`packages/api/src/trash-window.ts` carries the argument and its own test
// counts the mirror tables around every read). There is no third verb and there is no POST:
// "put it back" has no destination for a message the mirror has never held.

export const trashWindow = {
  /** One merged newest-first page across the account's Trash folders. `cursor` pages older. */
  list: (opts: { cursor?: string } = {}) =>
    api<TrashWindowPageWire>(
      `/trash/window${opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`,
    ),

  /**
   * One live row's body, fetched live and parsed to TEXT — never HTML, never stored. Trash
   * holds whatever was deleted, spam included, so it renders on the Junk window's terms.
   * Epoch-bound: `uidValidity` is the row's own, and a folder emptied since answers 410 rather
   * than the body of whatever message now wears the UID.
   */
  body: (mailboxId: string, uid: number, uidValidity: string) =>
    api<{ subject: string; text: string }>(
      `/trash/window/body?mailboxId=${encodeURIComponent(mailboxId)}&uid=${uid}`
        + `&uidValidity=${encodeURIComponent(uidValidity)}`,
    ),
};

/** One row of the live Trash window — a header fact read off the folder, never a mirror entity. */
export interface TrashWindowItemWire {
  mailboxId: string;
  uid: number;
  uidValidity: string;
  subject: string;
  from: { name: string | null; address: string };
  date: string | null;
  messageIdHeader: string | null;
  seen: boolean;
  /**
   * WHO PUT IT THERE. `"ohmail"` — the message matches a mirror row this account deleted here,
   * so the mirrored section already lists it with its deletion time and its restore; the client
   * drops those from the live population rather than showing one message twice. `"provider"` —
   * the person's own delete in another mail client, or the mail server's own filing.
   */
  origin: "ohmail" | "provider";
}

export interface TrashWindowMailboxWire {
  id: string;
  address: string;
  /**
   * This mailbox's own outcome, stated instead of thrown: `"ok"` — the folder was read;
   * `"no_trash_folder"` — it has no native \Trash, so there is nothing to show;
   * `"unreachable"` — the read failed or ran past the server's budget just now. An empty list is
   * never substituted for the last of those.
   */
  window: "ok" | "no_trash_folder" | "unreachable";
  /** This mailbox's cursor was discarded (UIDVALIDITY changed) — its rows are a fresh TOP page. */
  reset?: boolean;
}

export interface TrashWindowPageWire {
  mailboxes: TrashWindowMailboxWire[];
  items: TrashWindowItemWire[];
  nextCursor: string | null;
}

// ── WebAuthn browser glue ────────────────────────────────────────────────────────────────

/**
 * The JSON shapes `@simplewebauthn/server` produces. Declared structurally rather than
 * imported: the webapp must not pull a server package into the browser bundle, and these
 * are the two objects the ceremony passes through untouched.
 */
export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  userVerification?: string;
}

/** Is a platform passkey even possible here? Drives whether TOTP is offered as the primary. */
export function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/**
 * `ArrayBuffer`, not `Uint8Array`. The DOM's `BufferSource` is `ArrayBufferView<ArrayBuffer>
 * | ArrayBuffer`, and a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>` — which admits
 * `SharedArrayBuffer` and therefore does not satisfy it under TS 5.7's stricter typed-array
 * generics. Returning the buffer itself is both assignable and what WebAuthn wants anyway.
 */
const b64urlToBytes = (v: string): ArrayBuffer => {
  const pad = v.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
};

const bytesToB64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Run the CREATE ceremony and return the credential in the JSON shape the server verifies.
 *
 * Hand-rolled rather than `@simplewebauthn/browser`, for one reason: adding a dependency to
 * the client bundle for ~40 lines of base64url conversion is a cost paid on every page load
 * by every user, including the ones who never sign in. The shapes are fixed by the WebAuthn
 * spec and by what `verifyRegistration` reads, and `enrollment-flow.test.ts` already drives
 * the same wire format from a software authenticator.
 */
export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown> {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rp: options.rp,
      user: {
        id: b64urlToBytes(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        id: b64urlToBytes(c.id), type: "public-key" as const,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
      attestation: options.attestation as AttestationConveyancePreference | undefined,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new ApiError(0, "passkey_cancelled", "The passkey was not created.");
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/** The GET ceremony — signing in with a passkey already enrolled. */
export async function assertPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<unknown> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      timeout: options.timeout,
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        id: b64urlToBytes(c.id), type: "public-key" as const,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      userVerification: options.userVerification as UserVerificationRequirement | undefined,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new ApiError(0, "passkey_cancelled", "The passkey prompt was dismissed.");
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      authenticatorData: bytesToB64url(response.authenticatorData),
      signature: bytesToB64url(response.signature),
      userHandle: response.userHandle ? bytesToB64url(response.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/**
 * Turn any thrown value into the sentence to show.
 *
 * An {@link ApiError} already carries the server's own message — the whole point of the
 * refusal taxonomy — so it is used verbatim. A `NotAllowedError` from the WebAuthn API means
 * the user dismissed the prompt (or it timed out), which is not a failure to apologise for.
 */
/** `session_busy` without importing the class — see {@link messageOf}. */
function isSessionBusy(err: unknown): boolean {
  return err instanceof Error
    && (err as { code?: unknown }).code === "session_busy"
    && typeof err.message === "string" && err.message.length > 0;
}

export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  /**
   * THE ONE REFUSAL THIS CLIENT RAISES THAT IS NOT AN `ApiError`: `SessionBusyError` is thrown when another tab has
   * held the origin-wide session lock past the deadline. Its own message says what happened and what to do — "another
   * tab is finishing a sign-in or sign-out, try that again in a moment" — and every surface renders refusals through
   * this function, which dropped it to "Something went wrong. Please try again." That is worse than losing detail.
   * The person is looking at a form that refused for a reason that clears by itself in seconds, and the generic
   * sentence gives them no way to know that; the published note for the lock change promised them this sentence, so
   * the claim was false as well as unhelpful. Matched by CODE rather than by class, because importing the class here
   * would make `api-client` depend on `session-refresh`, which depends on it.
   */
  if (isSessionBusy(err)) return (err as Error).message;
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return "The passkey prompt was dismissed. You can try again, or use an authenticator app instead.";
  }
  if (err instanceof DOMException && err.name === "InvalidStateError") {
    return "This device already has a passkey for this account. Sign in with it instead.";
  }
  return "Something went wrong. Please try again.";
}

/** The machine code, for the few places the UI branches rather than just displays. */
export function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : "unknown";
}
