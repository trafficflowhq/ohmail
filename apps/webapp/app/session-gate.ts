/**
 * The single-origin decision: what does `https://ohmail.app/` serve? A stranger gets the marketing
 * page; a signed-in browser gets the mail client, same URL, no redirect, no flash. A pure function
 * of (cookie, query, armed-or-not, a `fetch`); `middleware.ts` is the only caller and just turns
 * the answer into a rewrite. The network call is not optional: `tf_session` is an OPAQUE token —
 * nothing at the edge can read it — and a presence check would render the app shell for an expired
 * or revoked cookie, a signed-in-looking chrome around nothing. The anonymous path reads a cookie
 * that is not there and returns immediately, so `/` stays a cacheable marketing page; the cost
 * lands only on requests that claim a session.
 */

/**
 * Every non-`full` answer means MARKETING — except where the resume marker (`tf_resume`, Lax,
 * credential-free) says otherwise. THE GATE NEVER ROUTES A FAULT TO A WRITE: with the marker, no
 * token or a CODED 401 means resume (the splash spends the refresh token); a present token the API
 * could not vouch for — timeout, network, 5xx, 429, an uncoded 401 — means `app`, whose own check
 * verifies with backoff and keeps the warm mirror. A throttled token-holder is served `app` without
 * a probe. No marker: the landing, whatever the fault. `?demo=1` is answered before the cookie.
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
 * The self-host front door — where `/` sends a visitor this gate answered `"marketing"` for, on the self-host
 * build. On an operator's own domain there are no strangers, and our pitch — prices, imprint — has no business
 * on an address we do not own (measured live: a self-hosted `/` served the full landing, pricing included). A
 * REAL public address, so middleware REDIRECTS rather than rewrites: the sign-in screen already gets the
 * credential-page treatment on its own path, and `LoginScreen` finishes with `router.push("/")` — rewritten,
 * the browser is already at `/` and a successful sign-in would leave the user staring at the form they just
 * submitted. 307 and never 308: `/` on a self-host box is the mail client for a signed-in browser, and a
 * permanent redirect cached by the browser would send it to the sign-in screen for ever.
 */
export const DOOR_ROUTE = "/login";

/** The resume marker's cookie name. Must equal `RESUME_COOKIE` in `packages/api/src/cookies.ts`. */
export const RESUME_COOKIE = "tf_resume";

/** The API path that answers "is this token a live full session?" (`core.ts`). */
export const SESSION_ENDPOINT = "/auth/session";

/**
 * How long the edge waits for the API before giving up. Short on purpose: this runs in front of the
 * first paint of the product's front door, so the budget is what a human tolerates before deciding
 * the site is broken. Deliberately SHORTER than a serverless cold start can be — blowing the budget
 * decides nothing, because a token-holder with the marker is served the app, whose own check runs
 * on the browser's clock with backoff and outwaits the cold start. Raising this instead would hold
 * every signed-in first paint hostage to the slowest case.
 */
export const SESSION_TIMEOUT_MS = 1_500;

/**
 * The shape a `tf_session` value can possibly have — the free half of the amplifier fix. The merge
 * made the front door spend a cross-host `fetch` and two indexed reads on ANY request presenting a
 * cookie, paid before anything can reject it. Every value the API writes comes from
 * `generateToken()` (`randomBytes(n).toString("base64url")`), so a value outside the base64url
 * alphabet or wildly wrong in length has never been a session. The bounds are deliberately LOOSE
 * around today's 43 characters: failing a signed-in user onto the marketing page is the failure the
 * gate exists to prevent, and the gate's guard derives the alphabet and a live sample length from
 * `crypto.ts` rather than trusting this comment. Not a rate limit — `middleware.ts` has the burst cap.
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
  /**
   * The edge's burst cap tripped for this client (`middleware.ts`). A token-holder is then served
   * the app WITHOUT a probe — the shell verifies — and never the splash: a refresh is a write, and
   * being fast is not a reason to spend a rotation.
   */
  throttled?: boolean;
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

  // 3b. Throttled: no probe, and never the splash. Only a token-holder reaches this line.
  if (input.throttled === true) return resumable ? "app" : "marketing";

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
    // Timeout, DNS, TLS, an aborted edge invocation: the API did not ANSWER, so nothing about the
    // session was learned. The shell asks again on the browser's own clock and keeps the warm
    // mirror; the splash would spend a rotation the jar did not need and, while the API stays
    // busy, loop into a sign-in card over a live session. Without the marker there is no
    // standing to assume a session, which also keeps this branch worthless to a cookie sprayer.
    return resumable ? "app" : "marketing";
  }

  // A CODED 401 is the API saying this access token is dead — with the marker, the refresh token
  // may well be alive, which is every signed-in user fifteen minutes after their last page. An
  // uncoded 401 is a platform in front of the API, a 5xx or a 429 is a fault: no answer about the
  // session, so the app (see the catch). Other refusals (400, 403, 404) are answers a refresh does
  // not fix, and land on the landing.
  if (response.status === 401) {
    if (!resumable) return "marketing";
    return (await codedRefusal(response)) ? "resume" : "app";
  }
  if ((response.status >= 500 || response.status === 429) && resumable) return "app";
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

/** Did this 401 come from OUR envelope (`{error: {code}}`) rather than from a platform? */
async function codedRefusal(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    return typeof body?.error?.code === "string";
  } catch {
    return false;
  }
}
