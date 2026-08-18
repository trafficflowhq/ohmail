import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";
const withNextIntl = createNextIntlPlugin();

/**
 * SAME-ORIGIN SESSION TOPOLOGY — RE-DERIVED FOR ONE ORIGIN.
 *
 * The original defect: `mailoh.app` (this app) and `mailoh.io` (`api.mailoh.io`) were different
 * REGISTRABLE domains, so the API's cookie was third-party here — blocked by Safari ITP
 * today and on Chrome's 3PC deprecation path. The fix was topology, not cookie flags: the
 * browser only ever talks to its own origin, and Vercel proxies `/api/*` onward.
 *
 * ── WHAT THE COLLAPSE ONTO ONE ORIGIN CHANGED, AND WHAT IT DID NOT ──────────────────
 *
 * This app now serves `https://ohmail.app` itself: the marketing site to a stranger, the
 * mail client to a session, one hostname. There is no `app.ohmail.app` any more — it is a
 * redirect here. Two of the original arguments for this rewrite are therefore GONE, and
 * saying so is the point of this note:
 *
 *  • **The third-party-cookie argument died at the rename, not here.** `ohmail.app` and
 *    `api.ohmail.app` share a registrable domain, so they are same-SITE and a
 *    `SameSite=Strict` cookie is not blocked between them by any browser policy.
 *  • **The "landing is a different site" argument is gone outright.** The landing IS this
 *    origin now. Nothing about the rewrite protects the marketing page from the app or
 *    the other way round; `packages/services/src/auth/origins.ts` explains what replaced
 *    that separation and what it cost.
 *
 * ── WHY THE REWRITE IS STILL LOAD-BEARING, AND NOT VESTIGIAL ────────────────────────
 *
 * Because the cookie is HOST-ONLY. `packages/api/src/cookies.ts` sets no `Domain=`, so
 * `tf_session` written for `ohmail.app` is sent to `ohmail.app` and to nothing else —
 * `api.ohmail.app` included. Same-site does not mean same-host. A browser calling
 * `https://api.ohmail.app/sync` directly would therefore carry NO credential at all, and
 * the only way the session reaches the API is through this rewrite:
 *
 *   browser ──▶ https://ohmail.app/api/sync ──(Vercel rewrite)──▶ https://api.ohmail.app/sync
 *
 * That narrowness is the entire reason the merge was worth doing. Widening the cookie to
 * `.ohmail.app` would delete the need for the rewrite AND hand the session to every
 * present and future subdomain — `admin.` today, anything tomorrow. The rewrite is the
 * price of keeping the cookie narrow, and it is a price worth paying.
 *
 * Consequences, all of them the point:
 *  • `tf_session` / `tf_refresh` / `tf_csrf` are FIRST-PARTY cookies of `ohmail.app`,
 *    `SameSite=Strict; Secure; HttpOnly`, with NO `Domain=` — `packages/api/src/cookies.ts`
 *    is untouched and must stay that way;
 *  • no CORS, no preflight, no `credentials:"include"` in the client engine's HttpAdapter;
 *  • the API deploys, scales and rolls back independently of this app. Keeping
 *    `api.ohmail.app` a separate host is what preserves that, and it is deliberately NOT
 *    simplified away in this pass.
 *
 * ONE VARIABLE controls all of it: {@link TF_API_ORIGIN}. `middleware.ts` reads the same
 * variable to decide whether a session can be VALIDATED at all — an unarmed deployment
 * cannot prove a session and therefore always serves the landing.
 */

/** The env var that arms the topology. Unset ⇒ the rewrite does not exist. */
export const API_ORIGIN_VAR = "TF_API_ORIGIN";

/**
 * THE SELF-HOST BUILD ARM — `OHMAIL_FLAVOR=selfhost`, decided at BUILD time.
 *
 * On the managed deployment THIS APP owns the origin split: `rewrites()` proxies `/api/*` and
 * `/auth/refresh` to the API host, and `TF_API_ORIGIN` is the one variable that arms it. On a
 * self-hosted install the split belongs to the REVERSE PROXY in front of both containers
 * (`deploy/selfhost/Caddyfile` routes `/api/*`, `/auth/*`, `/events`, `/health`, `/hello` and
 * `/pair*` to the API container and everything else here), so this build must emit NO rewrite at
 * all — two owners of the same split is a request served twice or, worse, served differently.
 *
 * What the flavor changes, and the exact posture of each half:
 *
 *  · **`rewrites()` returns `[]`.** The proxy owns the split. A rewrite here would need a
 *    `TF_API_ORIGIN`, and on an operator's box that variable has no allow-listable value.
 *  · **`NEXT_PUBLIC_API_BASE` is armed to `/api` anyway.** The browser still calls its own
 *    origin — the proxy routes it — so the client bundle needs the base without the rewrite.
 *    This is the one composition where the two halves legitimately part ways, which is why the
 *    flavor is a COMPILED branch and not a second environment variable that could disagree.
 *  · **`TF_API_ORIGIN` set alongside the flavor FAILS THE BUILD.** It could only mean somebody
 *    is trying to arm both owners of the split at once.
 *  · **Anything other than `"selfhost"` or unset FAILS THE BUILD.** An absent value must select
 *    the managed behavior exactly; a misspelled one must never do so silently.
 *
 * What the flavor deliberately does NOT change (recorded so nobody hunts for it): the session
 * gate in `middleware.ts` still reads `TF_API_ORIGIN` at RUNTIME against the compiled allow-list
 * (`app/api-origin.ts`), and a self-host container sets no such variable — so the gate resolves
 * `null` and every request is answered with the marketing surface. That is the fail-closed state
 * the gate already defines, and wiring a self-host session gate (plus the first-run setup page)
 * is the first-run slice's work, not a side effect of a build flag.
 */
export const FLAVOR_VAR = "OHMAIL_FLAVOR";

/**
 * Is this a self-host build? Refuses anything but the two meaningful states — see
 * {@link FLAVOR_VAR}. Exported for the config suite.
 *
 * @param {Record<string, string | undefined>} env
 */
export function selfHostFlavor(env) {
  const raw = (env[FLAVOR_VAR] ?? "").trim();
  if (raw === "") return false;
  if (raw === "selfhost") return true;
  throw new Error(
    `${FLAVOR_VAR} must be "selfhost" or unset — a misspelled flavor must never select the managed build silently`,
  );
}

/** The variable Next inlines into the client bundle. DERIVED — never set by hand. */
export const API_BASE_VAR = "NEXT_PUBLIC_API_BASE";

/**
 * The flavor's INLINED companion — set to `"selfhost"` by the flavor branch, absent otherwise,
 * and never set by hand: it is derived from {@link FLAVOR_VAR} in exactly one place (the `env`
 * block below) so the compiled flavor and the build arm cannot disagree. `app/hello.ts` and
 * `middleware.ts` read it as `process.env.NEXT_PUBLIC_OHMAIL_FLAVOR`, which Next replaces at
 * build time — a compiled branch, not a runtime lookup (the distinction the TF_API_ORIGIN
 * incident in `app/api-origin.ts` is about).
 */
export const PUBLIC_FLAVOR_VAR = "NEXT_PUBLIC_OHMAIL_FLAVOR";

/** The path the browser sees. Must match the `API_PREFIX` `apps/api-vercel` strips. */
export const API_BASE = "/api";

/** The build identity Next inlines for the (i) panel. DERIVED — never set by hand. */
export const BUILD_VAR = "NEXT_PUBLIC_BUILD";

/** The release version Next inlines beside the build. DERIVED — never set by hand. */
export const VERSION_VAR = "NEXT_PUBLIC_APP_VERSION";

/**
 * WHICH RELEASE IS THIS? Read from the workspace's own `package.json`, AT CONFIG TIME.
 *
 * The build sha answers "are we looking at the same build?"; this answers "which release is
 * this?", which is the question a person asks before reporting anything. Two facts, both on the
 * About pane, and they are derived the same way for the same reason: a hand-set variable is a
 * third copy of a number that already exists, and a third copy can disagree with the other two.
 *
 * ── READ FROM THE FILE, NEVER FROM THE ENVIRONMENT ────────────────────────────────────────
 *
 * `process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"` in the component would compile, pass every test,
 * and put **"dev"** in front of a customer the first time a deployment was made without the
 * variable set — a wrong version number is worse than none, because it is quietly believed. The
 * version is not an aspect of the environment a build runs in; it is a property of the SOURCE
 * being built, so it is read from the source. There is no fallback branch and there must not be
 * one: a `package.json` with no `version` is a workspace that cannot state what it is, and that
 * is a build failure rather than a string to substitute.
 *
 * The root manifest and not this app's: `apps/webapp/package.json` carries `0.0.0` because it is
 * a private workspace member that is never published, and the release number belongs to the
 * product rather than to one of the four things built from it.
 */
export function appVersion() {
  const root = fileURLToPath(new URL("../../package.json", import.meta.url));
  const version = JSON.parse(readFileSync(root, "utf8")).version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${root} declares no "version" — the About pane cannot state which release this is`);
  }
  return version;
}

/**
 * Which build is this? The short commit sha, or `"dev"`.
 *
 * The same pair `apps/api-vercel/src/config.ts` reads for `/health`, in the same order, so
 * the sha the (i) panel shows and the sha `/api/health` reports are the same fact from the
 * same source rather than two variables that can drift. Vercel sets
 * `VERCEL_GIT_COMMIT_SHA` on a git deploy; `TF_BUILD_VERSION` covers a CLI deploy from a
 * worktree, which carries no git metadata.
 *
 * Seven characters: this answers "are we looking at the same build?", and a full 40-char
 * sha in a UI panel is noise around the seven that get compared.
 *
 * @param {Record<string, string | undefined>} env
 */
export function buildIdentity(env) {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim() || (env.TF_BUILD_VERSION ?? "").trim();
  return sha === "" ? "dev" : sha.slice(0, 7);
}

/**
 * The ONE path the API owns outside {@link API_BASE}, and why it has to.
 *
 * `packages/api/src/cookies.ts` scopes the refresh cookie `Path=/auth/refresh` — the API's
 * own path, because the API is the only thing that ever needed to read it. Set-Cookie
 * attributes pass through a rewrite unmodified, so on `ohmail.app` the browser stores
 * `tf_refresh` at `/auth/refresh` and will send it to exactly one URL: `/auth/refresh` on
 * `ohmail.app`. `/api/auth/refresh` is NOT that URL — the cookie is not in scope for it —
 * so routing refresh only through the `/api` prefix makes the refresh token unreachable and
 * every web session simply dies at the access TTL with no way to renew.
 *
 * Two ways to fix it: widen the cookie, or serve the path the cookie already names. The
 * standing rule freezes `cookies.ts` (a `Path=/` refresh cookie rides along on every request to the app,
 * which is precisely the exposure the narrow path exists to prevent), so the topology
 * absorbs it: this second rewrite makes `ohmail.app/auth/refresh` a real URL that lands on
 * `api.ohmail.app/auth/refresh`. The rewrite suite derives this constant FROM the
 * `Path=` attribute in `cookies.ts` and fails if the two ever drift.
 *
 * Under one origin this path is also the single reserved segment the MARKETING side may
 * never claim: `/auth/*` belongs to the API, and a marketing page called `/auth-something`
 * is fine while `app/auth/…/page.tsx` is not. See {@link OWN_PATHS}.
 */
export const REFRESH_PATH = "/auth/refresh";

/**
 * THE SPLIT, ENUMERATED. Every path this deployment answers ITSELF, and therefore every
 * path the `/api/*` proxy does not get to see.
 *
 * One origin means the marketing routes, the product routes and the API proxy share a
 * namespace, and "they happen not to collide today" is not a design. So they are listed:
 *
 *   MARKETING (route group `(marketing)`, root layout #1, landing.css)
 *     /                      the landing — and, after `middleware.ts` rewrites it for a
 *                            validated session, the mail client. One URL, two renders.
 *     /privacy /imprint /subprocessors
 *
 *   PRODUCT (route group `(product)`, root layout #2, app.css)
 *     /mailbox               INTERNAL. The rewrite target for a signed-in `/`; middleware
 *                            308s any direct request back to `/`.
 *     /login /join /verify-email
 *                            `/verify-email?token=…` is the target of the verification
 *                            mail. It is OURS and must never be proxied: `/api/:path*` would
 *                            not match it, but leaving it off this list is how a page ends up
 *                            served by the wrong thing after the next rewrite edit.
 *     /link-desktop          the browser half of signing the desktop app in: the app opens this
 *                            address, the page mints a one-use handoff code, the person retypes
 *                            it into the app. It is the one page here whose ADDRESS is a product
 *                            surface in another program — the Rust shell's link table names it —
 *                            so it may never move without that table moving too.
 *     /demo                  the REAL mail client in demo mode, framed by the landing. It is
 *                            answered directly with its own static CSP header
 *                            (`frame-ancestors 'self'`, see {@link DEMO_CSP}) and runs NO edge
 *                            function — deliberately excluded from the middleware matcher, like
 *                            the manifest and the icons.
 *
 *   SHARED, outside both groups
 *     /manifest.webmanifest  one manifest for the origin
 *     /api/waitlist          the marketing form's own server-side hop — see below
 *     /favicon.ico /favicon.svg /icon-*.png /maskable-*.png /apple-touch-icon.png
 *     /og.png                static, from `public/`
 *
 *   PROXIED TO api.ohmail.app
 *     /api/:path*   (everything under /api that is not a file route)
 *     /auth/refresh
 *
 * **`/api/waitlist` is the one deliberate shadow, and it is a real decision.** A `rewrites()`
 * ARRAY is `afterFiles`, so the filesystem route wins over `/api/:path*` and the marketing
 * form is served by `app/api/waitlist/route.ts` rather than proxied to the API's own
 * `/waitlist`. That ordering is asserted by a proxy guard over a real socket rather than assumed.
 *
 * The REASON for the local handler changed with the merge and the old one no longer
 * applies: it used to exist because `ohmail.app` could never be an auth origin, so a
 * browser POST straight to the API answered 403 `cross_site_denied`. `ohmail.app` IS an
 * auth origin now, and that POST would succeed. What keeps the handler is the other half
 * of its job: a proxied `/api/*` request carries the browser's whole cookie jar to the
 * API, and the waitlist is a PUBLIC, unauthenticated form that has no business seeing a
 * session. The local handler forwards an email address and a tier and nothing else — no
 * cookies, no IP, no user agent.
 */
export const OWN_PATHS = Object.freeze([
  "/", "/privacy", "/imprint", "/subprocessors",
  // `/resume` is INTERNAL like `/mailbox`: the rewrite target for a browser holding the
  // `tf_resume` marker but no usable access cookie. Middleware 308s a direct request back
  // to `/`, so it never appears in the address bar — but it is a path this deployment
  // answers, so it belongs here or the matcher/OWN_PATHS drift test fails (correctly).
  "/mailbox", "/resume", "/login", "/join", "/verify-email", "/link-desktop",
  // `/setup` is the self-host FIRST-RUN ceremony (`app/(product)/setup`). Mounted on every
  // deployment — one route tree, one bundle — and gated by the SERVER: the form renders only
  // while `GET /hello` answers `needsSetup: true`, which the managed API never does. It takes
  // the setup token in a form, so middleware serves it as a credential page (strict CSP,
  // no-referrer, no-store), exactly like `/login`.
  "/setup",
  // `/demo` is the real mail client in demo mode (`app/(product)/demo/page.tsx`), framed by
  // the landing. It is a path this deployment answers, so it belongs here — but it is served
  // with its own static CSP header (`frame-ancestors 'self'`) and runs no edge function, so
  // the matcher/OWN_PATHS drift test excludes it from the matcher alongside the manifest.
  "/demo",
  "/manifest.webmanifest", "/api/waitlist",
  // The catch-all behind the branded 404 (`app/(marketing)/[...missing]/page.tsx`): every
  // path no route above claims, answered with `notFound()` and a real 404 status. In this
  // list because this deployment does answer those paths; excluded from the middleware
  // matcher (see the drift test) because an edge invocation in front of every scanner's
  // garbage path buys nothing — and a catch-all is not a literal the statically-read
  // matcher could carry anyway.
  "/[...missing]",
]);

/**
 * The only hosts this app is allowed to proxy live cookies to.
 *
 * A rewrite is not a redirect: the browser never sees it, so every `ohmail.app` session
 * cookie, `X-CSRF-Token` and mutation body is handed to whatever `TF_API_ORIGIN` names, and
 * that destination's `Set-Cookie` comes back as though `ohmail.app` had written it —
 * `Domain=ohmail.app` included. "Any http(s) origin with no path" is therefore not a
 * validation of anything that matters; one wrong environment variable is a full session
 * compromise with no code change and no review. So the target is a COMPILED allow-list, and
 * `TF_API_ORIGIN` selects from it rather than defining it.
 */
export const ALLOWED_API_ORIGINS = ["https://api.ohmail.app"];

/** Loopback is exempt: `pnpm dev` and the local topology-verification builds run against it. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate and canonicalize the rewrite target.
 *
 * A typo here is the worst possible failure — the deployed webapp would proxy every API
 * call to a hostname that does not resolve, and the app would look broken with no clue
 * why. So an unusable value FAILS THE BUILD instead of shipping. `undefined`/`""` is not a
 * typo, it is "not armed yet", and returns `null`.
 *
 * @param {string | undefined} raw
 * @returns {string | null} an origin with no trailing slash, or null when unset
 */
export function apiOrigin(raw) {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${API_ORIGIN_VAR} must be an absolute origin like https://api.ohmail.app`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${API_ORIGIN_VAR} must be http(s)`);
  }
  // A path, query or fragment on the destination would be silently concatenated in front of
  // `/:path*`, producing requests no route matches — and, worse, a `request_hash` that
  // disagrees with the direct API host (the serverless host's prefix contract).
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${API_ORIGIN_VAR} must be an ORIGIN only — no path, query or fragment`);
  }
  // `https://user:pass@api.ohmail.app` has origin `https://api.ohmail.app`, so the
  // allow-list below would pass it while the credentials rode along on every proxied
  // request. Refused explicitly rather than normalized away.
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${API_ORIGIN_VAR} must not carry credentials`);
  }
  const loopback = LOOPBACK.has(url.hostname.toLowerCase());
  if (loopback) {
    // Any port, either scheme — this is a developer's machine, and there is no session on
    // it worth stealing that an attacker able to set this variable could not read anyway.
    return url.origin;
  }
  if (url.protocol !== "https:") {
    throw new Error(`${API_ORIGIN_VAR} must be https outside loopback — plaintext would carry session cookies in clear`);
  }
  if (!ALLOWED_API_ORIGINS.includes(url.origin)) {
    // Names the permitted set (compiled, public) and not the rejected value: config errors
    // are echoed by `/health`-style surfaces, and the habit of printing `env[X]` is how a
    // secret eventually gets printed.
    throw new Error(
      `${API_ORIGIN_VAR} must be one of ${ALLOWED_API_ORIGINS.join(", ")} (or a loopback origin for development)`,
    );
  }
  return url.origin;
}

/**
 * `NEXT_PUBLIC_API_BASE` must be DERIVED from {@link API_ORIGIN_VAR}, never supplied.
 *
 * Omitting the `env` key does not make the variable unavailable: Next inlines any
 * `NEXT_PUBLIC_*` present in the build environment (including from `.env*` files, which it
 * loads before this config). So the "one variable cannot disagree with itself" claim only
 * holds if a second, externally supplied value is a BUILD FAILURE. The two shapes it takes
 * are both live bugs: a stale `/api` with no rewrite behind it is a silently dead client,
 * and an ABSOLUTE origin turns every engine request cross-origin — sending bodies, and the
 * JS-readable `tf_csrf`, to a host of the setter's choosing.
 *
 * The one accepted case is the value this config would have derived anyway, because Next
 * may evaluate the config in a child process that already carries it.
 *
 * @param {string | undefined} supplied
 * @param {string | null} derivedOrigin
 */
export function assertApiBaseNotOverridden(supplied, derivedOrigin, selfhost = false) {
  if (supplied === undefined) return;
  // Both arming paths accept exactly the value this config derives anyway (Next may evaluate
  // the config in a child process that already carries it): the managed one when the rewrite
  // origin exists, the self-host one where the proxy owns the split and no origin ever will.
  if ((derivedOrigin !== null || selfhost) && supplied === API_BASE) return;
  throw new Error(
    `${API_BASE_VAR} is derived from ${API_ORIGIN_VAR} and must not be set in the build environment`,
  );
}

/**
 * A PRODUCTION BUILD WITH NO API IS A BUILD FAILURE, NOT A QUIET DEMO.
 *
 * `apiOrigin` already fails the build on a MALFORMED value. Absent was the hole: it returned
 * `null`, {@link API_BASE_VAR} was never defined, no rewrite was emitted, and the build went
 * green. What shipped then was not a broken-looking app — it was a plausible one. With no
 * `NEXT_PUBLIC_API_BASE`:
 *
 *  · `app/shell/engine-config.ts` used to hand a signed-in account the `FixturesAdapter`,
 *    rendering Mila's fictional mailbox in the live chrome with no demo ribbon (that half is
 *    now `EngineUnarmedError`, the second ring);
 *  · `middleware.ts` cannot validate a session without `TF_API_ORIGIN`, so every customer
 *    with a valid cookie is served the marketing page and looks logged out;
 *  · `/api/*` resolves to nothing, so no sign-in, no mailbox and no sync is possible at all.
 *
 * Three different silent failures, one missing variable, and a deploy summary that says
 * "Ready". So the variable is REQUIRED wherever it matters, and "wherever it matters" is
 * named precisely rather than guessed:
 *
 *  · `VERCEL_ENV === "production"` — ohmail.app. Unarmed here is the outage above. THROW.
 *  · Preview and development — legitimately unarmed. A preview builds the marketing site
 *    from a branch with no secrets, and `session-gate.ts` already answers "marketing" for
 *    every request on an origin-less deployment, so nothing there can pretend to be a
 *    mailbox. Allowed.
 *  · An explicit `NEXT_PUBLIC_DEMO` build — the Stage-1 shape and the desktop preview: a
 *    bundle whose ENTIRE job is the fixture world. That is a deliberate answer to "which
 *    mode?", which is exactly what a missing variable is not. Allowed.
 *
 * The `NEXT_PUBLIC_DEMO` test is duplicated from `app/demo-mode.ts`'s `isDemoBuild` because
 * this config cannot import TypeScript — the same constraint that makes the CSP live in two
 * files. A drift guard reads both and fails if they ever disagree.
 *
 * @param {string | null} origin  the validated {@link API_ORIGIN_VAR}, or null when unset
 * @param {Record<string, string | undefined>} env
 */
export function assertApiArmed(origin, env) {
  if (origin !== null) return;
  // The self-host build is armed WITHOUT an origin by design: the reverse proxy owns the
  // split, and `NEXT_PUBLIC_API_BASE` is set by the flavor branch below. None of the three
  // silent failures this assertion exists for can occur — the base is defined and `/api`
  // resolves through the proxy.
  if (selfHostFlavor(env)) return;
  const demo = (env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase();
  if (demo === "1" || demo === "true") return;
  if ((env.VERCEL_ENV ?? "").trim() !== "production") return;
  throw new Error(
    `${API_ORIGIN_VAR} is required for a production build. Without it this bundle has no ` +
      `API: sessions cannot be validated, /api/* resolves to nothing, and no mailbox can be ` +
      `reached — a deployment that looks like it works. Set ${API_ORIGIN_VAR} to one of ` +
      `${ALLOWED_API_ORIGINS.join(", ")}, or set NEXT_PUBLIC_DEMO=1 to build the demo on purpose.`,
  );
}

/**
 * THE SECURITY RESPONSE HEADERS.
 *
 * This origin shipped none. The staff console's config — holding strictly
 * less — shipped four, and the asymmetry was backwards: the single-origin merge made `ohmail.app` the one origin
 * carrying the session cookie, the JS-readable `tf_csrf`, the WebAuthn credentials, the
 * IndexedDB mail mirror AND the marketing/demo code, which is exactly the situation
 * `packages/services/src/auth/origins.ts` describes as having no origin-layer protection
 * left. A CSP is what is left.
 *
 * The policy itself, the reasoning for every directive, and the honest account of why
 * `script-src` keeps `'unsafe-inline'` on the STATIC surfaces all live in
 * `app/security-headers.ts`. It is spelled again here because `next.config.mjs` cannot
 * import TypeScript; a drift guard reads both files and fails on any disagreement.
 *
 * ── TWO RULES, AND THE ORDER IS NOT THE POINT — THE EXCLUSION IS ────────────────────────
 *
 * Multiple `Content-Security-Policy` headers are not "last one wins": a browser enforces
 * ALL of them, so the effective policy is their intersection. A blanket rule plus a `/demo`
 * override would therefore give that route BOTH `frame-ancestors 'none'` and
 * `frame-ancestors 'self'` — intersection `'none'` — and the landing's centrepiece would
 * render as a blank frame. So the general rule EXCLUDES `/demo` by negative lookahead
 * rather than being overridden, and the proxy guard asserts each path carries exactly
 * one CSP header.
 *
 * The demo is the REAL mail client in demo mode (`app/(product)/demo/page.tsx`) — the same
 * bundle as the app, on the FixturesAdapter's fictional mailbox — served same-origin and
 * framed by the marketing page (`components/DemoSection.tsx`), which reads into the frame to
 * measure its annotations. So it cannot be sealed the way a static document could: it needs
 * the baseline bundle policy to run at all. What it does NOT need is to be framable from
 * anywhere but here, or to be reachable while carrying a live session — it carries none. Its
 * one relaxation off the baseline is `frame-ancestors 'self'`; see {@link DEMO_CSP}.
 */
const SHARED_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "upgrade-insecure-requests",
];

/** Must equal `BASELINE_CSP` in `app/security-headers.ts`. */
const BASELINE_CSP = [...SHARED_CSP, "script-src 'self' 'unsafe-inline'"].join("; ");

/**
 * The DEMO ROUTE's policy — the real mail client in demo mode, framed by the marketing page.
 *
 * It is the baseline bundle policy in every directive EXCEPT `frame-ancestors`, relaxed from
 * `'none'` to `'self'`: this surface holds no session and no action to clickjack (it reads no
 * cookie, and its FixturesAdapter reaches no network), so letting THIS origin frame it in the
 * landing's iframe costs nothing — while the live app at `/` keeps `'none'`. Everything else
 * is the baseline, so the shipped Next bundle runs here unchanged: `'self'` scripts for the
 * `/_next` chunks, `'unsafe-inline'` for the RSC bootstrap and the theme-boot block this route
 * carries with no nonce (middleware does not run on it).
 */
const DEMO_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "upgrade-insecure-requests",
  "script-src 'self' 'unsafe-inline'",
].join("; ");

const STATIC_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/**
 * THE GITHUB STAR COUNT, FETCHED ONCE PER BUILD.
 *
 * The landing's nav renders a link to the public repository with its star count. That
 * number cannot come from the page: the marketing surface loads nothing off-origin — no
 * badge script, no client fetch — and the no-third-party guard enforces it. So the
 * count is read HERE, at config time, from GitHub's public repos endpoint (no auth for a
 * public repo), and inlined as {@link GITHUB_STARS_VAR}. As fresh as the last deploy,
 * which is what every README badge is anyway.
 *
 * ── THE FAILURE MODE IS A DECISION, NOT AN ACCIDENT ─────────────────────────────────
 *
 * A build must never die on a GitHub hiccup — the deploy's job is the mail product, not
 * the badge. On any failure (timeout, rate limit, offline build machine, a response with
 * no usable number) the count falls back to {@link LAST_KNOWN_STARS}, a hand-recorded
 * last-known value — slightly stale beats absent, and the Nav's own fallback (no number
 * at all, via `starLabel` → null) remains for a value that cannot be parsed. Update the
 * constant when it drifts far enough to notice; never make it load-bearing.
 *
 * Lives inside the async default export, NOT at module top level: the test suite imports
 * this module for its named exports, and a top-level fetch would put the network under
 * every one of those imports.
 */
export const GITHUB_STARS_VAR = "NEXT_PUBLIC_GITHUB_STARS";

/** GitHub's public repo endpoint; `stargazers_count` needs no auth on a public repo. */
export const GITHUB_REPO_API = "https://api.github.com/repos/trafficflowhq/ohmail";

/** Last-known count, recorded by hand when the wiring landed (2026-08-15). */
const LAST_KNOWN_STARS = 1;

/** @param {typeof fetch} fetcher injectable for the test next door */
export async function githubStars(fetcher = fetch) {
  try {
    const res = await fetcher(GITHUB_REPO_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ohmail-build" },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) throw new Error(`github answered ${res.status}`);
    const body = await res.json();
    const n = body?.stargazers_count;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new Error("no usable stargazers_count");
    }
    return n;
  } catch {
    return LAST_KNOWN_STARS;
  }
}

const selfhost = selfHostFlavor(process.env);
if (selfhost && (process.env[API_ORIGIN_VAR] ?? "").trim() !== "") {
  // Two owners of the origin split at once: the flavor hands it to the reverse proxy, the
  // variable would hand it to this app's rewrite. Refuse rather than pick.
  throw new Error(
    `${API_ORIGIN_VAR} must not be set on a ${FLAVOR_VAR}=selfhost build — the reverse proxy owns the /api split there`,
  );
}
const origin = selfhost ? null : apiOrigin(process.env[API_ORIGIN_VAR]);
assertApiArmed(origin, process.env);
assertApiBaseNotOverridden(process.env[API_BASE_VAR], origin, selfhost);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @trafficflow/core is here for exactly ONE entry point: `@trafficflow/core/ics`, whose
  // exports target is the dependency-free SOURCE file (see its header). The barrel and every
  // other subpath stay node-only (mailparser, node:crypto) and must never be imported from
  // this app — `MessageBody.tsx` documents that boundary.
  transpilePackages: ["@ohmail/ui", "@ohmail/tokens", "@ohmail/fixtures", "@ohmail/client-engine", "@trafficflow/core"],

  // `NEXT_PUBLIC_API_BASE` is DERIVED, never set by hand. The topology wants the browser to call
  // `/api`, which is only true when the rewrite that backs `/api` exists; two independent
  // variables could disagree, and the failure mode of disagreeing (an app fetching `/api`
  // with nothing behind it) is a silently dead client. Omitting the key is NOT enough to
  // make that true — Next inlines any `NEXT_PUBLIC_*` it finds in the environment — so
  // `assertApiBaseNotOverridden` above turns a second, externally supplied value into a
  // build failure. THAT is what makes "one variable cannot disagree with itself" a fact
  // rather than a description. `?demo=1` ignores all of it — the FixturesAdapter has no
  // network at all, which is what keeps the demo working before the DNS
  // flip and after.
  //
  // The build identity, for the (i) panel. DERIVED like the API base and for the same
  // reason: `TF_BUILD_VERSION` and `VERCEL_GIT_COMMIT_SHA` already exist and already mean
  // this (`apps/api-vercel/src/config.ts` reads the same pair for `/health`), so a
  // hand-set third variable could only ever disagree with them. Short sha, because the
  // question it answers is "are we looking at the same build?" and 7 characters answer it.
  // Absent in development, where "dev" is the true answer.
  //
  // The RELEASE VERSION is derived too, and from the strongest source of the three: the
  // workspace's own `package.json`, read here at config time. It is deliberately NOT
  // `process.env.NEXT_PUBLIC_APP_VERSION` with a fallback — see `appVersion` for why a `?? "dev"`
  // is a wrong number shown to a customer rather than a missing one.
  env: {
    // Armed by EITHER arming path: the managed rewrite origin, or the self-host flavor whose
    // proxy serves `/api` without a rewrite here. See `selfHostFlavor`.
    ...(origin || selfhost ? { [API_BASE_VAR]: API_BASE } : {}),
    // The flavor, inlined for the two consumers that must branch on it at COMPILE time: the
    // middleware's session gate (which variable may name the API, and whether an anonymous `/`
    // asks the server about first-run) and `app/hello.ts` (whether product screens consult
    // `/hello` at all). Inlining is the security property, not a convenience — on the managed
    // build the constant is absent and every self-host branch is unreachable regardless of the
    // runtime environment, which is the same reasoning as the compiled rewrite allow-list.
    ...(selfhost ? { [PUBLIC_FLAVOR_VAR]: "selfhost" } : {}),
    [BUILD_VAR]: buildIdentity(process.env),
    [VERSION_VAR]: appVersion(),
  },

  async headers() {
    return [
      {
        // FIRST and EXCLUSIVE — see the note above SHARED_CSP. The demo is the real mail
        // client in demo mode (`app/(product)/demo/page.tsx`), framed same-origin by the
        // landing, so it needs the baseline bundle policy with framing relaxed to `'self'`.
        // The `/((?!demo).*)` rule below excludes it by negative lookahead so it never also
        // receives the blanket `frame-ancestors 'none'` header — two CSP headers intersect,
        // they do not override, and the intersection would be `'none'` and a blank frame.
        source: "/demo",
        headers: [
          { key: "Content-Security-Policy", value: DEMO_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Everything else, including `/`. The negative lookahead keeps the blanket policy
        // off `/demo` — the one path in the deployment that may be framed by this origin.
        source: "/((?!demo).*)",
        headers: [
          { key: "Content-Security-Policy", value: BASELINE_CSP },
          ...STATIC_SECURITY_HEADERS,
        ],
      },
    ];
  },

  async rewrites() {
    // Dormant until armed. Emitting a rewrite to a hostname that does not resolve yet would
    // point production at a dead host — worse than having no API at all, because the demo
    // gate stays honest while `NEXT_PUBLIC_API_BASE` is absent.
    //
    // On a self-host build `origin` is null BY CONSTRUCTION (the flavor refuses the variable),
    // so this same branch is the flavor's `rewrites() === []` contract: the reverse proxy in
    // front of this container owns the split. Asserted in test/selfhost-flavor.test.ts.
    if (!origin) return [];
    return [
      { source: `${API_BASE}/:path*`, destination: `${origin}/:path*` },
      // The refresh cookie's own Path — see {@link REFRESH_PATH}. Without this the token
      // exists in the jar and is never sent anywhere, and web sessions expire permanently.
      { source: REFRESH_PATH, destination: `${origin}${REFRESH_PATH}` },
    ];
  },

  webpack: (config) => {
    // NodeNext TS packages use .js import specifiers on TS sources — map them for webpack.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"] };
    return config;
  },
};

const configured = withNextIntl(nextConfig);

/**
 * Async on purpose: the one thing that happens here beyond the object above is the
 * build-time star fetch, and Next only calls this when it actually builds or serves —
 * a test importing the named exports never triggers it.
 *
 * A value already present in the environment wins over the fetch. That is one seam with
 * two users: a build environment can pin the count (and skip the network entirely), and
 * the hermetic config tests evaluate this function without ever
 * touching GitHub. Unlike {@link API_BASE_VAR} this is NOT a security surface — the worst
 * a supplied value can do is show a wrong star count, and `starLabel` refuses anything
 * that does not parse as a number.
 */
export default async function config() {
  const provided = (process.env[GITHUB_STARS_VAR] ?? "").trim();
  const stars = provided !== "" ? provided : String(await githubStars());
  return {
    ...configured,
    env: { ...configured.env, [GITHUB_STARS_VAR]: stars },
  };
}
