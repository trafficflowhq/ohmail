/**
 * THE ROUTE TABLE — one declaration of what this origin answers and what it forwards.
 *
 * These paths used to be enumerated once per reader: `OWN_PATHS` and `rewrites()` in
 * `next.config.mjs`, the matcher in `middleware.ts`, and four expectations in the suite that
 * spelled the lists again. Adding the Flathub route moved two of them and left the rest stale —
 * five guard cases red over a change that broke nothing. One table, imported by the config and
 * by every guard, is what makes a stale copy unrepresentable rather than caught.
 *
 * `middleware.ts` still spells its matcher as literals, because `next build` reads that array
 * out of the source without evaluating it. The drift guard derives the expected set from `edge`
 * below, so the literals cannot wander.
 *
 * This module is PURE — no environment, no side effects — which is why a guard may import it
 * where importing `next.config.mjs` would run the build-time validation.
 */

/** The one prefix the browser calls, and the one `apps/api-vercel` strips. */
export const API_BASE = "/api";

/**
 * The path `tf_refresh` is scoped to, and therefore the one URL the browser will send it to.
 *
 * `packages/api/src/cookies.ts` sets `Path=/auth/refresh` and that file is frozen (a `Path=/`
 * refresh cookie rides along on every request to the app, which is the exposure the narrow path
 * exists to prevent), so the topology absorbs it: the rewrite below makes `ohmail.app/auth/refresh`
 * a real URL that lands on `api.ohmail.app/auth/refresh`. The rewrite suite derives this constant
 * FROM the `Path=` attribute in `cookies.ts` and fails if the two ever drift.
 *
 * Under one origin this is also the single reserved segment the MARKETING side may never claim:
 * `/auth/*` belongs to the API, and a marketing page called `/auth-something` is fine while
 * `app/auth/…/page.tsx` is not.
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
 *     /de                    the same landing in German (route group `(marketing-de)`, root
 *                            layout #3, the same landing.css). Marketing only: the session
 *                            gate runs on `/` and nowhere else, so a signed-in reader who
 *                            opens `/de` gets the German page, exactly as `/privacy` stays
 *                            `/privacy` for them.
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
 *     /authorize-desktop     the confirmation the native sign-in goes through: the API redirects
 *                            here with a request handle, the page says which app is asking and for
 *                            which account, and the press is what authorizes it.
 *     /demo                  the REAL mail client in demo mode, framed by the landing.
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
 *
 * `edge: true` means the middleware matcher covers the path — an HTML document that wants the
 * canonical-host redirect and the nonce CSP. `edge: false` costs no edge invocation and MUST
 * say why; a silent opt-out is refused by the drift guard.
 *
 * @typedef {{ path: string, edge: boolean, why?: string }} OwnRoute
 * @type {readonly Readonly<OwnRoute>[]}
 */
export const OWN_ROUTES = Object.freeze(/** @type {OwnRoute[]} */ ([
  { path: "/", edge: true },
  { path: "/privacy", edge: true },
  { path: "/imprint", edge: true },
  { path: "/subprocessors", edge: true },
  // `/de` is the GERMAN landing — the same composition `/` renders, under a second marketing
  // root layout that pins the German `lang` attribute (`app/(marketing-de)`). A path rather than
  // a negotiated body on `/`: one URL with two bodies needs `Vary: Accept-Language` to be
  // cacheable at all, and Next overwrites `Vary` on an App Router response (`middleware.ts`
  // records that, measured against a real `next start`). The legal pages
  // have no German twin on purpose — their text is binding and deliberately outside the
  // catalogue — so this is one path, not a mirrored tree.
  { path: "/de", edge: true },
  // `/resume` is INTERNAL like `/mailbox`: the rewrite target for a browser holding the
  // `tf_resume` marker but no usable access cookie. Middleware 308s a direct request back
  // to `/`, so it never appears in the address bar — but it is a path this deployment
  // answers, so it belongs here or the matcher/OWN_PATHS drift test fails (correctly).
  { path: "/mailbox", edge: true },
  { path: "/resume", edge: true },
  { path: "/login", edge: true },
  { path: "/join", edge: true },
  { path: "/verify-email", edge: true },
  { path: "/link-desktop", edge: true },
  // `/authorize-desktop` is the CONFIRMATION in front of the native sign-in. `GET /oauth/authorize`
  // used to mint a credential from an ambient cookie and redirect straight back to the app; it now
  // bounces here with a request handle, and the press on this page is what mints. The API builds
  // this address from its own config, so the path is a contract with `routes/oauth.ts`.
  { path: "/authorize-desktop", edge: true },
  // `/setup` is the self-host FIRST-RUN ceremony (`app/(product)/setup`). Mounted on every
  // deployment — one route tree, one bundle — and gated by the SERVER: the form renders only
  // while `GET /hello` answers `needsSetup: true`, which the managed API never does. It takes
  // the setup token in a form, so middleware serves it as a credential page (strict CSP,
  // no-referrer, no-store), exactly like `/login`.
  { path: "/setup", edge: true },
  // `/join/invite` is the invite landing (`app/(product)/join/invite`) — the page the link
  // from Settings → Invites opens, self-host only (the page compiles to a 404 on the
  // managed flavor). The pairing token rides the URL FRAGMENT, which never reaches a server,
  // a log or a Referer; middleware serves the path as a credential page because the nonce CSP
  // is what stops injected inline script from reading `location.hash`.
  { path: "/join/invite", edge: true },
  {
    // `/demo` is the real mail client in demo mode (`app/(product)/demo/page.tsx`), framed by
    // the landing. It is a path this deployment answers, so it belongs here.
    path: "/demo",
    edge: false,
    why: "served with its own static CSP (`frame-ancestors 'self'`); a second, intersecting"
      + " policy from the edge would be `'none'` and a blank frame",
  },
  {
    path: "/manifest.webmanifest",
    edge: false,
    why: "a static asset — a function in front of it buys nothing",
  },
  {
    path: "/api/waitlist",
    edge: false,
    why: "a route handler, not a document — see the shadow note above",
  },
  {
    // `/version` answers a short digest of the build this deployment is serving, for one reader:
    // a tab that loaded some time ago and wants to know whether it is still the app this origin
    // serves (`app/shell/build-watch.ts`). Not under `/api`, so it shadows nothing — it is a fact
    // about the WEB deployment rather than about the API.
    path: "/version",
    edge: false,
    why: "the manifest's class — machine-read JSON, no session, no document, no canonical-host"
      + " redirect to make",
  },
  {
    // `/flathub-verification` serves the token Flathub reads to confirm this domain owns the
    // app id (`app/(marketing)/flathub-verification`). The well-known path Flathub actually
    // fetches is rewritten onto it by `STATIC_REWRITES`, so the token lives in one place; with
    // no token configured the route has no body, which is the 404 the path gave before it existed.
    path: "/flathub-verification",
    edge: false,
    why: "`/version`'s class — a machine-read token one crawler fetches, carrying no session and"
      + " rendering no document",
  },
  {
    // The catch-all behind the branded 404 (`app/(marketing)/[...missing]/page.tsx`): every
    // path no route above claims, answered with `notFound()` and a real 404 status. In this
    // list because this deployment does answer those paths.
    path: "/[...missing]",
    edge: false,
    why: "an edge invocation in front of every scanner's garbage path is a cost amplifier with"
      + " no session to gate — and the statically-read matcher cannot carry a catch-all anyway",
  },
]).map((r) => Object.freeze(r)));

/** The paths, in declaration order — the enumeration the route census compares itself to. */
export const OWN_PATHS = Object.freeze(OWN_ROUTES.map((r) => r.path));

/** The subset the middleware matcher must carry, and nothing else. */
export const EDGE_PATHS = Object.freeze(OWN_ROUTES.filter((r) => r.edge).map((r) => r.path));

/**
 * Flathub reads `/.well-known/org.flathub.VerifiedApps.txt` on this domain to prove the app id
 * `app.ohmail.Desktop` is ours. A Next route segment cannot be named `.well-known`, so the path is
 * rewritten onto a route that answers it — and 404s while no token is configured.
 */
export const FLATHUB_VERIFICATION = Object.freeze([
  Object.freeze({ source: "/.well-known/org.flathub.VerifiedApps.txt", destination: "/flathub-verification" }),
]);

/** Every rewrite that needs no environment. A build with rewrites at all emits all of them. */
export const STATIC_REWRITES = Object.freeze([...FLATHUB_VERIFICATION]);

/**
 * THE WHOLE `rewrites()` ANSWER, for an origin or for none.
 *
 * `next.config.mjs` returns this and adds nothing of its own; the guards compare the config's
 * answer against it. A rewrite added here therefore reaches every reader at once, which is the
 * property this module exists for.
 *
 * `origin` null is BOTH unarmed states: a managed build with no `TF_API_ORIGIN`, and a self-host
 * build where the flavor refuses the variable and the reverse proxy owns the split. Two owners of
 * one split is a request served twice or, worse, served differently.
 *
 * @param {string | null} origin an origin with no trailing slash, or null when unarmed
 * @returns {Array<{ source: string, destination: string }>}
 */
export function rewritesFor(origin) {
  if (!origin) return [];
  // NEXT OWNS WHAT THIS RETURNS, so every entry leaves here as a fresh, unfrozen object.
  // `next/dist/lib/load-custom-routes.js` assigns `route.source` and `route.destination` on
  // each rewrite it loads. The table above stays frozen — the freeze is the claim that nothing
  // edits it at runtime — and spreading a frozen ARRAY copies element REFERENCES, so handing
  // those straight over killed an ARMED build: "Cannot assign to read only property 'source'".
  // Unarmed the function returns `[]` and never reaches them, which is why every build gate,
  // all of which run unarmed, read green. The copy is the boundary; keep it at the `return`.
  return [
    ...STATIC_REWRITES,
    { source: `${API_BASE}/:path*`, destination: `${origin}/:path*` },
    { source: REFRESH_PATH, destination: `${origin}${REFRESH_PATH}` },
  ].map((r) => ({ ...r }));
}
