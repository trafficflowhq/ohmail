import { NextResponse, type NextRequest } from "next/server";
import { resolveApiOrigin, resolveInternalApiOrigin } from "./app/api-origin";
import { canonicalRedirect } from "./app/canonical-host";
import { newNonce, nonceCsp } from "./app/security-headers";
import { APP_ROUTE, RESUME_COOKIE, RESUME_ROUTE, SESSION_COOKIE, resolveSurface } from "./app/session-gate";

/**
 * ONE ORIGIN, TWO FRONT DOORS. The routing half; `app/session-gate.ts` is the
 * deciding half, and it is deliberately the only part with any logic in it.
 *
 * `https://ohmail.app/` is the marketing site to a stranger and the mail client to a
 * signed-in browser — the same URL, the same address bar, no redirect and no flash.
 * That is only possible if the choice happens BEFORE anything renders, which is what
 * this file is for.
 *
 * ## Rewrite, not redirect — and why the difference is the whole feature
 *
 * A redirect is visible: the browser paints `/`, receives a 30x, and paints something
 * else. That is exactly the "flash the landing before redirecting" the design forbids,
 * and it also puts the app on a second URL. A REWRITE is invisible: Vercel serves the
 * `(product)` route tree while the browser's URL stays `/`, so the app's real address
 * is `ohmail.app/` and nothing else. App views are hash routes on top of it
 * (`app/shell/routing.ts` — `#/screener`, `#/reads`), so there is no path prefix
 * anywhere in the product.
 *
 * ## The matcher, and what each entry is for
 *
 *  - **`/`** — the decision itself.
 *  - **`{@link APP_ROUTE}`** — the rewrite's TARGET, which must not be a public URL.
 *    Left unguarded it is a second address for the app that skips the session check
 *    entirely and would render a signed-in-looking shell to anyone who typed it. A 308
 *    back to `/` closes it: one public address, and whoever followed a stale link
 *    lands on the gate that decides properly. Middleware does NOT re-run on its own
 *    rewrite, so the internal hop is unaffected by this rule — which is precisely why
 *    the guard can be unconditional.
 *  - **every other HTML path this deployment answers** (`/login`, `/join`, `/verify-email`,
 *    `/de`, `/privacy`,
 *    `/imprint`, `/subprocessors`) — added for the two rules that are
 *    about the ORIGIN rather than about `/`: the canonical-host redirect below, and the
 *    nonce CSP on the credential screens. They cost one edge invocation and NOT a fetch:
 *    the session gate runs on `/` and nowhere else.
 *
 * `/api/*`, `/auth/refresh`, `/_next/*`, `/demo/*` and the icons are deliberately NOT
 * matched. They are proxied or static, they are the hot path, and putting a function in
 * front of them would buy nothing — `next.config.mjs`'s `headers()` covers them.
 *
 * ## Caching
 *
 * The anonymous `/` is a prerendered marketing page and must stay CDN-cacheable; that is
 * most of why the gate refuses to fetch anything when there is no cookie. A request that
 * DOES carry `tf_session` is per-user by definition, so its response is marked
 * `private, no-store` — otherwise a shared cache could hand one user's answer (either
 * answer) to the next visitor.
 *
 * `Vary: Cookie` would be the belt to that pair of braces and is deliberately NOT set,
 * because setting it here does not work and pretending otherwise would be worse than
 * omitting it: Next owns `Vary` on an App Router response (it writes
 * `RSC, Next-Router-State-Tree, Next-Router-Prefetch, Accept-Encoding` for its own
 * router protocol) and replaces whatever middleware put there. Measured, by
 * the proxy guard, against a real `next start`. `no-store` is the load-bearing half
 * anyway — a response no cache may store needs no key to vary on.
 */

/**
 * `TF_API_ORIGIN`, the one variable that arms the whole topology — VALIDATED HERE,
 * at runtime, and not merely read.
 *
 * The previous version of this constant was `(process.env.TF_API_ORIGIN ?? "").trim() || null`
 * under a comment asserting that `next.config.mjs` had already made that safe because "Next
 * inlines it into the middleware bundle, so there is no runtime lookup". That was false, and
 * measurably so: after a build, `.next/routes-manifest.json` carries the origin baked into
 * the rewrite destination while `.next/server/middleware.js` still carries the literal
 * `process.env.TF_API_ORIGIN??""`. The rewrite was build-time and allow-listed; the GATE was
 * runtime and constrained by nothing.
 *
 * What that meant: changing `TF_API_ORIGIN` in the Vercel dashboard WITHOUT a redeploy
 * repointed this module's `fetch` — which carries the visitor's live session token as
 * `Authorization: Bearer` — at an arbitrary host, with no diff, no build failure and no
 * review, while the rewrite stayed pinned to the old value. The chosen host answers
 * `{scope:"full",user:{userId:"x"}}` and the app shell renders as though nothing happened.
 *
 * `resolveApiOrigin` applies the same allow-list `apiOrigin()` applies at build time, and
 * fails CLOSED: an unrecognised value is `null`, which `resolveSurface` already treats as
 * "nothing here can validate a token" and answers with the landing.
 */

/**
 * IS THIS THE SELF-HOST BUILD? Compiled, not read: `NEXT_PUBLIC_OHMAIL_FLAVOR` is inlined by the
 * build's flavor arm (`next.config.mjs`), so on the managed deployment this constant is `false`
 * in the emitted middleware and everything behind it — the internal-origin variable, the
 * first-run redirect — is unreachable no matter what the runtime environment says. That is the
 * property the TF_API_ORIGIN incident above demands: no ENVIRONMENT EDIT may repoint the gate's
 * fetch on the managed deployment. On an operator's own install the runtime variable
 * (`OHMAIL_INTERNAL_API_ORIGIN`, the api container's in-network name) is set by the operator in
 * the same compose file as the database credential, which is the self-host trust model exactly.
 */
const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

const API_ORIGIN = SELF_HOST_BUILD
  ? resolveInternalApiOrigin(process.env.OHMAIL_INTERNAL_API_ORIGIN)
  : resolveApiOrigin(process.env.TF_API_ORIGIN);

/**
 * How long the FIRST-RUN probe may hold up an anonymous `/`. Shorter than the session gate's
 * budget: the probe is one same-network hop on a self-host box, and a slow answer means "serve
 * the landing", which is never wrong.
 */
const NEEDS_SETUP_TIMEOUT_MS = 1_000;

/**
 * Does the self-host server still need its first account? Asked of the server, never guessed:
 * `needsSetup` is a database fact (users == 0) behind `/hello`, `Cache-Control: no-store`.
 * Every failure — timeout, refusal, a body that is not the contract — answers `false`, because
 * the redirect this feeds must only ever fire on a server that SAID it is fresh.
 */
async function serverNeedsSetup(apiOrigin: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiOrigin}/hello`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(NEEDS_SETUP_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { product?: unknown; needsSetup?: unknown };
    return body?.product === "ohmail" && body?.needsSetup === true;
  } catch {
    return false;
  }
}

/**
 * A PER-INSTANCE BURST CAP on the one thing an anonymous request can make this origin
 * spend.
 *
 * Before the merge, `/` was a static marketing page on a separate deployment that touched
 * no backend. Now a request carrying any `tf_session` value at all forces an edge
 * invocation, a cross-host fetch held open for up to `SESSION_TIMEOUT_MS`, an API function
 * invocation and two indexed reads — all paid BEFORE anything can reject the cookie.
 * `packages/api/src/routes/index.ts` states plainly that there is deliberately no throttle
 * middleware and that a per-IP network limit is out of scope for that slice, and
 * `AuthService`'s per-key lockout does not apply to a session read. So between a trivial
 * request loop and real invocation cost there was nothing.
 *
 * `session-gate.ts`'s shape check removes the lazy version of that loop for free. This
 * removes the rest, and it is deliberately CRUDE:
 *
 *  - the window is per EDGE INSTANCE, not global. Module state survives between
 *    invocations on the same instance and nothing more; there is no KV in this
 *    deployment and inventing one inside a repair would be the wrong trade.
 *  - the threshold is generous by two orders of magnitude against a human. A person
 *    reloading the product's front door makes one gated fetch per navigation; a NAT'd
 *    office of fifty people cannot reach {@link BURST_MAX} in {@link BURST_WINDOW_MS}.
 *  - tripping it answers what a cookieless request gets: the landing for a stranger, the
 *    resume splash for a browser holding the marker. It never errors and never blocks.
 *
 * It is a floor under the cost, not a rate limiter. A real per-IP limit belongs in the
 * platform's firewall, in front of the function, where it can refuse before an invocation
 * is billed at all — recorded as the follow-up it is.
 */
const BURST_WINDOW_MS = 10_000;
const BURST_MAX = 30;
/** Bounded so a spray of forged `X-Forwarded-For` values cannot grow the map without limit. */
const BURST_MAX_KEYS = 4_096;
const burst = new Map<string, { count: number; resetAt: number }>();

function overBurst(key: string, now: number): boolean {
  const seen = burst.get(key);
  if (seen === undefined || now >= seen.resetAt) {
    // Whole-map eviction rather than LRU: the map only ever holds one window's worth of
    // callers, and a cheap wrong answer here costs a landing page, not a session.
    if (burst.size >= BURST_MAX_KEYS) burst.clear();
    burst.set(key, { count: 1, resetAt: now + BURST_WINDOW_MS });
    return false;
  }
  seen.count += 1;
  return seen.count > BURST_MAX;
}

/** Best-effort client identity. Spoofable, which is why tripping it is harmless. */
function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // 1. THE CANONICAL HOST, before anything else and before any cost is spent. A host that
  //    is declared as a redirect must never serve the product — see `app/canonical-host.ts`
  //    for the failure this backstops and for why the list is explicit rather than
  //    default-deny.
  const elsewhere = canonicalRedirect(
    request.headers.get("host"),
    `${pathname}${request.nextUrl.search}`,
  );
  if (elsewhere !== null) return NextResponse.redirect(elsewhere, 308);

  // 2. The internal rewrite target is not an address. Query and hash are preserved so a
  //    `?demo=1` typed against it still opens the demo once `/` re-decides.
  if (pathname === APP_ROUTE || pathname === RESUME_ROUTE) {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    return NextResponse.redirect(home, 308);
  }

  // 3. Every matched path that is NOT `/` is an ordinary page: no cookie is read, no
  //    session is looked up, nothing is fetched. `/login` and `/join` take credentials, so
  //    they are served under the strict script policy; the marketing pages are static
  //    prerenders and keep the baseline policy from `next.config.mjs` (a nonce cannot
  //    survive a prerender — see `app/security-headers.ts`).
  if (pathname !== "/") {
    if (
      pathname === "/login" || pathname === "/join" || pathname === "/verify-email" ||
      // `/link-desktop` receives no credential and PRINTS one, which needs the same three
      // headers for the same three reasons: the page must not carry a `Referer` off itself
      // (under one origin `strict-origin-when-cross-origin` would send the full URL to our own
      // API), no cache may hold a document with a live handoff code rendered into it, and the
      // strict nonce policy is what stops an injected inline script from reading the code out
      // of the DOM the moment it appears.
      pathname === "/link-desktop" ||
      // `/setup` takes the self-host first-run token in a FORM — a credential page exactly as
      // `/login` is, so it gets the strict nonce policy plus no-referrer/no-store.
      pathname === "/setup" ||
      // `/join/invite` carries an invite's pairing token in its FRAGMENT. A fragment
      // never reaches this middleware, a log or a `Referer` on its own — the nonce CSP is the
      // header that matters here, because injected inline script reading `location.hash` is
      // the exposure that remains; the other two cost nothing and keep the class uniform.
      pathname === "/join/invite"
    ) {
      return credentialPage(request);
    }
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;

  // THE FIRST-RUN DOOR, self-host builds only (SELF_HOST_BUILD is compiled; this branch does
  // not exist in the managed middleware). "After `docker compose up`, the operator hits the
  // server once and gets a guided ceremony": an anonymous visit to `/` on a server that still
  // needs its first account is that moment, and the landing would be the wrong greeting. Only
  // ANONYMOUS requests ask — a browser holding any cookie has standing the fresh-server state
  // cannot explain, and the ordinary gate below sorts it out. The probe is one same-network
  // hop; on failure the landing stands, and once the first account exists `needsSetup` is
  // false forever and this costs exactly that one probe per anonymous visit.
  if (SELF_HOST_BUILD && API_ORIGIN !== null && token === null && !request.cookies.has(RESUME_COOKIE)) {
    if (await serverNeedsSetup(API_ORIGIN)) {
      const setup = request.nextUrl.clone();
      setup.pathname = "/setup";
      // 307, never 308: the answer is temporary by definition — it flips with the first account.
      const response = NextResponse.redirect(setup, 307);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }

  // A cookie-bearing request is the only one that can cost anything, so it is the only one
  // the burst cap looks at — an anonymous flood already costs a static page and no fetch.
  const throttled = token !== null && overBurst(clientKey(request), Date.now());

  // Presence only, and never sent to the gate as a credential — see `RESUME_COOKIE`. It is
  // NOT subject to the burst cap: it costs no fetch on the branch it selects.
  const marker = request.cookies.has(RESUME_COOKIE);

  const surface = await resolveSurface({
    sessionToken: throttled ? null : token,
    resumeMarker: marker,
    search: request.nextUrl.searchParams,
    apiOrigin: API_ORIGIN,
    env: { NEXT_PUBLIC_DEMO: process.env.NEXT_PUBLIC_DEMO },
  });

  const target = surface === "resume" ? RESUME_ROUTE : APP_ROUTE;
  const response =
    surface === "marketing"
      ? NextResponse.next()
      : strict(request, (init) => NextResponse.rewrite(withPathname(request, target), init));

  // Per-user responses must not be cached. A MARKER-bearing request is per-user too even
  // when no session cookie came with it — that is the whole `SameSite=Strict` cross-site
  // case — so a CDN must not be allowed to serve one browser's resume splash to another.
  if (token !== null || marker) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * The three pages that receive a CREDENTIAL IN THEIR URL, served under the strict script
 * policy plus the two headers that decision left owing.
 *
 * `/join?code=…` and `/verify-email?token=…` are linked from mail, so a live credential arrives
 * in the query string. That was accepted deliberately (a link a person can click without
 * JavaScript beats an airtight design nobody implements correctly) with five mitigations as
 * the price. Two of them are headers, and this is where they are paid.
 *
 * `/link-desktop` joins them from the OTHER direction: it takes no credential and RENDERS one —
 * the one-use handoff code the desktop app is waiting for. The document is therefore per-request
 * and secret exactly as the others are, so it gets the same treatment. Its query string is empty
 * and stays that way; see the page's own header for why it reads nothing from the URL. The
 * headers:
 *
 *  1. **`Referrer-Policy: no-referrer`.** The app-wide default is
 *     `strict-origin-when-cross-origin`, which strips the path only when the destination is
 *     ANOTHER origin — and under the single-origin merge the API is the SAME origin (`/api/*` is a rewrite on
 *     `ohmail.app`). So on the default policy the full URL, token and all, would ride in the
 *     `Referer` of the page's own API calls, and of every same-origin navigation off it. On these
 *     three paths nothing is allowed to carry a referrer at all.
 *  2. **`Cache-Control: no-store`.** These documents are per-request and their URL is a secret;
 *     a shared or disk cache holding one is a credential at rest that nobody chose to store.
 *
 * The remaining three mitigations are elsewhere and are not headers: `history.replaceState` in the
 * page component (`VerifyEmailScreen`, `JoinScreen`), and no edge access-log retention of query
 * strings, which is a platform setting rather than code.
 *
 * `/login` gains both too. It takes no credential in its URL, but it takes one in a FORM, and
 * neither header costs it anything.
 */
function credentialPage(request: NextRequest): NextResponse {
  const response = strict(request, (init) => NextResponse.next(init));
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Serve a DYNAMIC document under the nonce policy.
 *
 * The nonce has to reach three places and they are not the same mechanism:
 *
 *  1. the RESPONSE header, which is what the browser enforces;
 *  2. the REQUEST headers, because Next reads `content-security-policy` off the incoming
 *     request, extracts `nonce-…` and stamps it onto every `<script>` it generates itself
 *     (the RSC bootstrap). Without this the App Router's own inline payload is blocked and
 *     the page is a blank screen;
 *  3. `x-nonce`, which `(product)/layout.tsx` reads with `headers()` to nonce the one
 *     inline script this app writes by hand — the theme boot.
 */
function strict(
  request: NextRequest,
  make: (init: { request: { headers: Headers } }) => NextResponse,
): NextResponse {
  const nonce = newNonce();
  const csp = nonceCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = make({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

function withPathname(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return url;
}

/**
 * The matcher is STATICALLY ANALYSED by `next build` — it is read out of the source,
 * not evaluated — so `APP_ROUTE` cannot appear here and the paths have to be spelled
 * again as literals. A drift guard asserts they never drift from
 * `OWN_PATHS` in `next.config.mjs`, because a silent divergence would leave the rewrite
 * target publicly reachable or a legacy host serving the product.
 *
 * `/de` — the German landing — sits with the other MARKETING documents rather than beside `/`,
 * because that is what it is: a static page this origin answers, matched for the canonical-host
 * redirect and for nothing else. The gate's `pathname` early return above fires before it, so it
 * costs one edge invocation and no fetch, exactly like `/privacy`.
 *
 * NOTHING BUT PATH LITERALS BELONGS INSIDE THE ARRAY, comments included. Both drift guards read
 * this list by pulling every double-quoted string out of the bracket span, so a note containing
 * `"/"` reads as a duplicate matcher entry and fails the comparison against `OWN_PATHS` — which
 * is a guard failure that looks exactly like a routing mistake. Measured while adding `/de`.
 */
export const config = {
  matcher: [
    "/", "/mailbox", "/resume", "/login", "/join", "/join/invite", "/setup", "/verify-email",
    "/link-desktop", "/de", "/privacy", "/imprint", "/subprocessors",
  ],
};
