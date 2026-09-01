/**
 * THE SINGLE-ORIGIN DECISION: what does `https://ohmail.app/` serve?
 *
 * One hostname, two experiences. A stranger gets the marketing page; a signed-in
 * browser gets the mail client, at the SAME URL, with no redirect and no flash. This
 * module is that decision and nothing else — a pure function of (cookie, query,
 * armed-or-not, a `fetch`), so every branch below is testable without a browser, a
 * network or a Next runtime. `middleware.ts` is the only caller and does nothing but
 * turn the answer into a rewrite.
 *
 * ## Why a network call, and why it is not optional
 *
 * `tf_session` is an OPAQUE access token: it is a random string looked up in the
 * `sessions` table, not a signed claim, so nothing at the edge can read it. That
 * leaves exactly two designs:
 *
 *  - **presence check.** Free, and WRONG. A cookie that is present but expired,
 *    revoked by `POST /auth/logout --allDevices`, or killed by refresh-token reuse
 *    detection would render the app shell — which would then 401 on every request and
 *    show a signed-in-looking chrome around nothing. "Renders a broken app instead of
 *    the landing" is precisely the failure this gate exists to prevent.
 *  - **ask the API.** One `GET /auth/session` (two indexed reads behind
 *    `withSession`), only ever on a request that ALREADY carries a session cookie.
 *
 * So: the anonymous path — every stranger, every crawler, every OG unfurl — reads a
 * cookie that is not there and returns immediately. Nothing is fetched, and `/` stays
 * a cacheable marketing page. The cost lands only on requests that claim a session.
 *
 * ## Every non-`full` answer means MARKETING — except where the RESUME MARKER says otherwise
 *
 * The app shell is only ever correct for a live full session; there is no failure mode
 * in which guessing "app" is the safer guess. But "not the app" has two honest renderings,
 * and `tf_resume` (a Lax, credential-free marker) is what picks between them:
 *
 *  - **No marker ⇒ the landing.** A stranger, a crawler, a sprayed cookie-shaped value,
 *    an unarmed deployment, a malformed body, an enrollment-scoped session: the landing
 *    is the state that is never wrong for a browser with no standing.
 *  - **Marker + the API REFUSED the token (401) ⇒ resume.** The central lapsed-session
 *    case: dead access token, live refresh token.
 *  - **Marker + the API could not ANSWER (timeout, network failure, 5xx) ⇒ resume.**
 *    The gate's {@link SESSION_TIMEOUT_MS} budget loses to a serverless cold start —
 *    the first request after every API deploy — and answering "marketing" there is how
 *    a signed-in customer opening ohmail.app got the pitch until a manual reload hit
 *    the instance their first attempt had warmed. Observed live, not supposed. The splash
 *    retries with the browser's own budget and cannot loop (see the catch below).
 *  - **Marker + a clean non-401 refusal (403, 404…) or a non-`full` 200 ⇒ the landing.**
 *    The API answered; what it said is not something a refresh fixes.
 *
 * ## The enrollment scope is a THIRD state, not a weak session
 *
 * Registration issues an `enrollment`-scoped session on the password factor alone, so a user
 * who registered but never finished 2FA holds a real `tf_session` cookie. It
 * authenticates the enrollment surface (`/auth/2fa/*`) and nothing else. Treating it
 * as a session here would hand a password-only credential the whole mail client, which
 * is the exact escalation the scope exists to prevent — so `scope` is compared to the
 * literal `"full"` and everything else, including a missing field, falls through to
 * the landing.
 *
 * ## `?demo=1` never reaches any of this
 *
 * The demo is a promise of zero network, and it is answered BEFORE
 * the cookie is read: no session lookup, no `fetch`, for a signed-in visitor exactly
 * as for a stranger. `app/demo-mode.ts` owns the parsing (every repeated `demo` value
 * is inspected, and the answer may only ever fail TOWARD the demo); this file only
 * decides that the answer wins.
 */
import { isDemoBuild, isDemoRequested } from "./demo-mode";

/** The access-token cookie. Set by the API, host-only, `SameSite=Strict`. */
export const SESSION_COOKIE = "tf_session";

/**
 * The INTERNAL route the signed-in `/` is rewritten to.
 *
 * Never a URL a human types or a link points at: the browser's address bar says `/`
 * in both states, and `middleware.ts` answers a direct request for this path with a
 * 308 back to `/` so there is exactly ONE public address for the app. It exists at all
 * because Next resolves route groups at build time — `(marketing)/page.tsx` and
 * `(product)/…/page.tsx` cannot both be `/` — and a rewrite is the only way to keep
 * two root layouts (and therefore two disjoint CSS bundles) behind one URL.
 */
export const APP_ROUTE = "/mailbox";

/**
 * The internal rewrite target for a resumable browser. Internal exactly like {@link APP_ROUTE}:
 * middleware 308s a direct request back to `/`, so the product keeps ONE public URL.
 */
export const RESUME_ROUTE = "/resume";

/**
 * THE SELF-HOST FRONT DOOR — where `/` sends a visitor this gate answered `"marketing"` for
 * when the build is the self-host flavor.
 *
 * On `ohmail.app` "not signed in and nothing to resume" means a stranger, and the landing is
 * the right greeting. On an operator's own domain there are no strangers: everyone who reaches
 * that origin is one of their users, and our pitch — our prices, our imprint — has no business
 * being served from an address we do not own. Measured live before this existed: a self-hosted
 * `https://ohmail.test/` answered 200 with the full landing, pricing section included.
 *
 * Unlike {@link APP_ROUTE} and {@link RESUME_ROUTE} this is a REAL public address, not an
 * internal rewrite target, so middleware sends a visitor to it with a redirect rather than
 * rewriting `/` onto it. Two reasons, and the second is the load-bearing one:
 *
 *  · the sign-in screen already gets the credential-page treatment (nonce CSP, `no-referrer`,
 *    `no-store`) on its own path — a rewrite would have to re-apply all three by hand;
 *  · `LoginScreen` finishes with `router.push("/")`. Rewritten, the browser is ALREADY at `/`
 *    and that push is a navigation to the URL it is on — which is how a successful sign-in
 *    leaves the user staring at the form they just submitted.
 *
 * The redirect is 307 and must never become 308: `/` on a self-host box is the mail client for
 * a signed-in browser, and a permanent redirect cached by the browser would send that browser
 * to the sign-in screen for ever.
 */
export const DOOR_ROUTE = "/login";

/** The resume marker's cookie name. Must equal `RESUME_COOKIE` in `packages/api/src/cookies.ts`. */
export const RESUME_COOKIE = "tf_resume";

/** The API path that answers "is this token a live full session?" (`core.ts`). */
export const SESSION_ENDPOINT = "/auth/session";

/**
 * How long the edge waits for the API before giving up.
 *
 * Short on purpose. This runs in front of the FIRST PAINT of the product's front door,
 * so the budget is what a human will tolerate before deciding the site is broken — not
 * what the API might eventually manage. It is deliberately SHORTER than a serverless
 * cold start can be: blowing the budget is not a dead end any more, because a browser
 * holding the resume marker is routed to the splash, whose refresh runs on the
 * browser's own clock and can outwait the cold start the edge would not. Raising this
 * instead would hold every signed-in first paint hostage to the slowest case.
 */
export const SESSION_TIMEOUT_MS = 1_500;

/**
 * THE SHAPE A `tf_session` VALUE CAN POSSIBLY HAVE — the free half of the amplifier fix.
 *
 * The single-origin merge turned the product's public front door into something that spends
 * a cross-host `fetch`, an API invocation and two indexed reads on ANY request that presents a cookie.
 * The cookie is attacker-supplied and needs no validity: the cost is paid before anything
 * can reject it. Before the merge `/` was a static page on a separate deployment that
 * touched no backend, so this is a cost the collapse introduced.
 *
 * Every value the API ever writes into this cookie comes from `generateToken()` in
 * `packages/services/src/auth/crypto.ts` — `randomBytes(n).toString("base64url")` — for
 * both the access token and the enrollment-scoped token. So a value carrying a character
 * outside the base64url alphabet, or a wildly wrong length, is one no session has ever
 * had, and asking the API about it can only ever produce a 401.
 *
 * The bounds are deliberately LOOSE around today's 43 characters (32 bytes). This check
 * fails a signed-in user onto the marketing page if it is ever wrong, which is the failure
 * the whole gate exists to prevent — so it is written to survive `generateToken` being
 * called with a different size, and the gate's guard derives the alphabet and a live
 * sample length from `crypto.ts` rather than trusting this comment.
 *
 * What this is NOT: a rate limit. An attacker who sends 43 random base64url characters
 * still gets a fetch. It removes the trivial loop, not the determined one — see
 * `middleware.ts` for the per-IP burst cap that covers the rest.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,256}$/;

/** Could this cookie value ever have been issued? Cheap, allocation-free, no network. */
export function looksLikeSessionToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/** What `/` should render for this request. */
export type Surface = "marketing" | "app" | "demo" | "resume";

export interface GateInput {
  /** The raw `tf_session` cookie value, or null when the browser sent none. */
  sessionToken: string | null;
  /**
   * Whether the browser sent the RESUME MARKER (`tf_resume`, see `packages/api/src/cookies.ts`).
   *
   * Presence only — it carries no credential and proves nothing. It answers one question the
   * gate could not otherwise ask: "might this browser be able to get a session back?" Without
   * it, an access cookie that expired fifteen minutes ago and a browser that has never seen
   * ohmail are indistinguishable here, and both got the marketing page — which is the bug.
   */
  resumeMarker?: boolean;
  /** The request's query string — `?demo=1` and friends. */
  search: string | URLSearchParams;
  /**
   * The API origin this deployment proxies to (`TF_API_ORIGIN`), or null when the
   * topology is not armed. Unarmed ⇒ there is nothing that can validate a token, so
   * no cookie can ever produce the app — which is what keeps a pre-DNS deployment
   * honest instead of optimistic.
   */
  apiOrigin: string | null;
  /** The process environment, for `NEXT_PUBLIC_DEMO`. */
  env?: Record<string, string | undefined>;
  /** Injectable so the tests can assert the ZERO-fetch branches by counting calls. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The `GET /auth/session` body this gate is willing to act on.
 *
 * `userId`, NOT `id` — `SessionUser` in `packages/services/src/auth/types.ts` is the
 * source of truth, and the first cut of this file guessed `id`. Every unit test passed,
 * because the tests fed the shape the code expected; production then answered the real
 * shape, `user.id` was `undefined`, and a live full session rendered the marketing page.
 * The gate's guard now derives the field name FROM `types.ts` so the two cannot
 * drift again — the same discipline the rewrite guard uses for `REFRESH_PATH`.
 */
interface SessionBody {
  scope?: unknown;
  user?: { userId?: unknown } | null;
}

/**
 * Decide what `/` serves. Never throws: every failure is an answer of `"marketing"`.
 */
export async function resolveSurface(input: GateInput): Promise<Surface> {
  const env = input.env ?? {};

  // 1. The demo wins over everything and costs nothing. Before the cookie, before the
  //    network — a signed-in user asking for the demo gets the demo.
  if (isDemoBuild(env) || isDemoRequested(input.search)) return "demo";

  // 2. No usable access cookie. Two very different situations, and conflating them is
  //    exactly the production defect: a stranger, versus a signed-in customer whose
  //    fifteen-minute access cookie lapsed while a ninety-day refresh token sits in the jar.
  //    The marker tells them apart, and neither branch costs a fetch.
  //
  //    `SameSite=Strict` makes this matter a second way: a LIVE session arriving by a
  //    cross-site link sends no `tf_session` at all, so it lands here too. The marker is
  //    `Lax`, so it arrives, and such a visitor resumes instead of being shown marketing.
  const token = input.sessionToken?.trim();
  const resumable = input.resumeMarker === true && input.apiOrigin !== null;
  if (!token) return resumable ? "resume" : "marketing";

  // 2b. A value no `generateToken()` could ever have produced is not worth a network
  //     round trip — see TOKEN_SHAPE. Free, and it runs before the API is consulted.
  //     A garbage token with a valid marker still gets to try: the token is what is
  //     malformed, and the refresh path does not use it.
  if (!looksLikeSessionToken(token)) return resumable ? "resume" : "marketing";

  // 3. A cookie on a deployment with no API behind it proves nothing. Answering "app"
  //    on presence alone is the one shortcut this file refuses to take.
  if (!input.apiOrigin) return "marketing";

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? SESSION_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(`${input.apiOrigin}${SESSION_ENDPOINT}`, {
      method: "GET",
      // BEARER, not the cookie. The token value is identical, but a bearer request is
      // host-independent: it does not depend on the API host being on
      // `TF_COOKIE_HOSTS`, it carries no `Origin`, and it is byte-for-byte the shape a
      // native client sends — the one auth path that is true on every surface.
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // A session read must never be answered from a cache: the whole question is
      // whether this token is live RIGHT NOW.
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeout, DNS, TLS, an aborted edge invocation — indistinguishable from here and
    // all of them mean the same thing: we cannot prove a session RIGHT NOW.
    //
    // WITH THE MARKER, THAT IS A "resume", AND THE TIMEOUT IS THE CASE THAT FORCED IT.
    // The API is a serverless function and this gate's budget is {@link SESSION_TIMEOUT_MS};
    // the first request after a deploy pays a cold start that can exceed it, and API
    // deploys are routine. The old answer here was "marketing", so the
    // person who hit that first request — a signed-in customer opening ohmail.app — was
    // handed the pitch, and their manual reload (against the instance their first attempt
    // had just warmed) landed in the app. Observed live as exactly that pattern.
    //
    // The splash can prove what this gate cannot: its `POST /auth/refresh` runs with the
    // browser's own budget, not this 1.5s clamp (a resume guard pins the absence
    // of an artificial timeout there), so a cold-but-alive API succeeds and `reload()`
    // re-runs a now-warm gate. And it cannot loop — the earlier version of this comment
    // refused "resume" fearing "a retry loop dressed as a page", but a failed resume exits
    // to `/login`, never back to `/`, and the splash's sessionStorage stamp turns a second
    // pass inside ten seconds into an honest failure card (`ResumeScreen`). Worst case of
    // resuming during a real outage: one quiet splash, then the truth. Worst case of not
    // resuming: every API blink logs the front door out.
    //
    // WITHOUT the marker there is nothing to resume and no standing to assume: the landing
    // stays the answer, which also keeps this branch worthless to anyone spraying
    // cookie-shaped values during an outage.
    return resumable ? "resume" : "marketing";
  }

  // 401 expired/revoked, 5xx, 404… A 401 with a marker is the CENTRAL case this exists for:
  // the access token is genuinely dead and the refresh token is genuinely alive, which is
  // every signed-in user fifteen minutes after they last loaded a page.
  //
  // A 5xx is the catch branch's failure wearing a status line — the API did not ANSWER the
  // question, it reported that it couldn't — so with the marker it resumes for the same
  // reasons (and with the same loop guards) as the timeout above. The other non-200s
  // (403, 404, 400…) are clean refusals: the API answered, and what it said is not
  // something a refresh fixes, so they stay on the landing marker or no marker.
  if (response.status === 401 && resumable) return "resume";
  if (response.status >= 500 && resumable) return "resume";
  if (response.status !== 200) return "marketing";

  let body: SessionBody;
  try {
    body = (await response.json()) as SessionBody;
  } catch {
    return "marketing";
  }

  // `=== "full"` and not `!== "enrollment"`: an unrecognised or absent scope must fail
  // toward the landing, or a future third scope becomes a silent promotion to the app.
  //
  // An ENROLLMENT session must never be routed to resume either: refreshing it would not
  // make it full, and mid-onboarding belongs on `/join`, not in a resume loop.
  if (body?.scope !== "full") return "marketing";
  if (typeof body?.user?.userId !== "string") return "marketing";
  return "app";
}
