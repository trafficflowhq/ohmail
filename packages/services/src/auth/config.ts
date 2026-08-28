import { StaticKeyProvider, scryptHasher } from "./crypto.js";
import { assertOriginConfig } from "./origins.js";
import type { AuthConfig, SessionSurface } from "./config-types.js";

const MIN = 60_000;

/** The two lifetimes a rotation needs, resolved for one surface. */
export interface SurfaceTtls {
  /** The rolling refresh window, re-issued from `now` on every rotation. */
  refreshTtlMs: number;
  /** The ceiling from `sessions.created_at`, or `null` for none. */
  absoluteTtlMs: number | null;
}

/**
 * Resolve the session lifetimes for a surface — THE ONLY PLACE THE DEFAULT IS DECIDED.
 *
 * ── THE DEFAULT IS THE STRICTER SURFACE, AND THE SHAPE OF THIS FUNCTION IS THE ENFORCEMENT ──
 *
 * The dangerous version of this file is one line different: `surface === "cookie" ? cookie :
 * native`. It reads identically, passes every test that names a surface, and makes the
 * FALL-THROUGH the 400-day native branch — so every caller that forgets the argument, every new
 * route, every future refresh path, silently hands a browser a near-indefinite session. The
 * failure is invisible: the sessions work, nothing errors, and the only symptom is a credential
 * that outlives its window by a factor of four.
 *
 * So the test is written the other way round: `native` is the value that must be ASKED FOR by
 * name, and everything else — including `undefined` from a caller that never heard of surfaces —
 * lands on the cookie window. There is exactly one default in the codebase and it is the `=
 * "cookie"` below; `rotateRefresh` and `refresh` pass their surface straight through rather than
 * defaulting again, so there is no second place for the two to disagree.
 *
 * `session-lifetime.test.ts` pins both halves: the no-argument call resolves to the cookie
 * window, and flipping this default to `native` turns it red.
 */
export function surfaceTtls(cfg: AuthConfig, surface: SessionSurface = "cookie"): SurfaceTtls {
  return surface === "native"
    ? { refreshTtlMs: cfg.nativeRefreshTtlMs, absoluteTtlMs: cfg.nativeSessionAbsoluteTtlMs }
    : { refreshTtlMs: cfg.refreshTtlMs, absoluteTtlMs: cfg.sessionAbsoluteTtlMs };
}

export const DEFAULT_AUTH_CONFIG: Omit<AuthConfig, "rpID" | "rpName" | "origin"> = {
  inviteCodes: new Set<string>(),
  // OFF is the default deliberately: opening registration is a decision a deployment
  // makes with an environment variable and a redeploy, never something a config object
  // acquires by being constructed. Every existing test therefore keeps its exact behaviour
  // without opting out of anything.
  publicSignup: false,
  publicSignupCap: null,
  oauthClients: { "tf-macos": { redirectUris: ["trafficflow://auth"] } },
  accessTtlMs: 15 * MIN,
  // ── HOW LONG A SESSION LIVES, PER SURFACE ───────────────────────────────────────────────────
  //
  // NINETY DAYS, ROLLING, ON THE BROWSER. Every rotation re-issues the window from now, and
  // `sessionAbsoluteTtlMs` below is `null`, so a browser that is used stays signed in — full
  // stop. That is the product decision: this is a MAIL CLIENT, and a mail client that signs you
  // out on a schedule is one you stop trusting with your mail. The ninety days is the IDLE bound,
  // the only bound left: stop using a browser for a quarter of a year and it is signed out.
  //
  // What that gives up, stated plainly because it is a real loss: a refresh token stolen from a
  // browser that keeps being used no longer dies on its own. Before this, the 90-day absolute cap
  // ended such a session at most a quarter after it began, whatever the thief did. What still
  // ends it: any sign-out (`revokeFamily` kills the family), revoking the device, a password
  // change, and reuse detection the moment the thief and the real client both present a token
  // outside the ten-second grace — which is the likely outcome of a stolen browser credential
  // actually being USED, because two holders of one rotating chain collide by construction.
  // The cap was never the thing catching theft; it was a timer that also signed out honest
  // people, and the honest people met it far more often than a thief did.
  refreshTtlMs: 90 * 24 * 60 * MIN,
  // FOUR HUNDRED DAYS, ROLLING, ON THE NATIVE/BEARER SURFACE — the desktop app. It is the same
  // decision taken further, because the desktop case is stronger: the sidecar rotates on every
  // launch (`apps/sidecar/src/cloud-auth.ts` refreshes through the body branch), so the window is
  // re-issued each time the app is opened and a rolling 400 days is indefinite in practice for
  // anyone who opens their mail within a year. An installed app that demands a password and a
  // six-digit code because it sat unopened over a summer is the same failure as the sign-out
  // above, minus the browser's excuse of being a shared jar.
  //
  // 400 rather than "no expiry at all": the row keeps a real `expires_at`, so the schema, the
  // reaper and the admin console go on reading a date instead of a null that every one of them
  // would have to learn to special-case. Nothing about the desktop's lifetime needed a migration.
  nativeRefreshTtlMs: 400 * 24 * 60 * MIN,
  // ── THE ABSOLUTE CAP, GIVEN UP ON BOTH SHIPPED SURFACES ──────────────────────────────────────
  //
  // This was 90 days, measured from `sessions.created_at`, and it made "rolling" false: a browser
  // used every day was signed out on the ninetieth day regardless. A cap and a rolling window are
  // not two safety features that add up — the cap is the thing that decides, and while it stood
  // the refresh TTL only chose how fast an IDLE session died. Keeping it while claiming a rolling
  // 90-day session would have published a sentence the code contradicts on day 91.
  //
  // `null` on both surfaces, and the mechanism it turns off is still live and still tested:
  // `rotateRefresh` enforces any non-null value it is given, on either surface, and
  // `session-lifetime.test.ts` proves that against an overriding config. A deployment that wants
  // a ceiling sets one; ohmail.app does not.
  sessionAbsoluteTtlMs: null,
  nativeSessionAbsoluteTtlMs: null,
  // ── WHAT A HOME-SCREEN PWA ACTUALLY KEEPS, so nobody re-derives it from browser folklore ─────
  //
  // The rolling window above is the SERVER's promise. Whether a browser still holds the cookie to
  // spend it is a separate question with a different answer per platform, and these four facts are
  // the whole of it:
  //
  //  · iOS partitions an installed (`display: standalone`) web app's cookie jar from Safari's.
  //    The first sign-in INSIDE the installed app is therefore unavoidable — the Safari session
  //    that installed it does not carry over. That is a one-time cost at install, not a recurring
  //    sign-out, and no server-side lifetime can remove it.
  //  · ITP's seven-day cap applies to storage written by SCRIPT (`document.cookie`,
  //    localStorage, IndexedDB). Cookies written by the SERVER in a `Set-Cookie` header are
  //    exempt from it — which is what all five of ours are, HttpOnly included. This is why the
  //    session lives in a server-set cookie and why nothing about it may migrate into script
  //    storage for convenience.
  //  · Home-screen apps are exempt from the unused-site purge that would otherwise evict a site
  //    left untouched for weeks.
  //  · With those three, persistence is bounded by the window above rather than by the browser:
  //    the jar keeps `tf_refresh` for its `Max-Age`, and each rotation re-issues that `Max-Age`.
  //    So an installed PWA opened at least once a quarter stays signed in indefinitely, and the
  //    desktop app opened at least once a year does too.
  // ── THE REFRESH-ROTATION GRACE WINDOW (COOKIE SURFACE ONLY) ─────────────────────────────────
  //
  // SIXTY SECONDS. A browser shares ONE cookie jar across every tab and window, so the instant a
  // second tab, a second window, or the sync client and the REST client cross the fifteen-minute
  // access-token expiry together, they read the SAME `tf_refresh` out of the jar and present it
  // at once. Exactly one wins the rotation; without this window the loser's presentation of the
  // now-consumed token was read as reuse and REVOKED THE WHOLE FAMILY, signing a working session
  // out for the crime of being open in two tabs. That is the "Sync stopped — this session is no
  // longer authorized" a signed-in user hit on a new tab or window.
  //
  // It applies ONLY to the cookie refresh path (`AuthService.refresh`'s `concurrentGrace`, passed
  // by the `/auth/refresh` COOKIE branch). A native/bearer client and the OAuth `refresh_token`
  // grant hold their token privately and rotate it serially — no shared jar, no per-tab
  // single-flight, so no benign race — and they keep the strict reuse response unchanged.
  //
  // WHY SIXTY AND NOT TEN, because ten stood here and was measured failing in production
  // (2026-08-28, a real account): this window was argued from "the loser holds the old token only
  // until the winner's `Set-Cookie` lands, sub-second to a second or two", and that premise is
  // FALSE at machine wake — the case where the race actually happens. A laptop opening its lid
  // fires every suspended tab's queued refresh while the network is still re-associating; requests
  // sit in flight for many seconds, and the family in question was revoked on a presentation
  // arriving 10.1 seconds after its token was consumed — 114 milliseconds past the old window.
  // The client now also single-flights refresh ACROSS tabs (`session-refresh.ts`, Web Locks),
  // which removes the herd where the API exists; sixty seconds is the server-side bound for
  // browsers without that API and for requests already in flight when the lock was introduced.
  //
  // Sixty seconds is still nothing to detection: a token is consumed the moment it rotates, the
  // real client rotates past it and never presents it again — so a presentation older than this
  // window is a token someone KEPT, the replayed-theft case, and it still revokes (unless the
  // family's tail was never used at all — the lost-response recovery in `rotateRefresh`, which
  // carries its own argument).
  //
  // THE RESIDUAL, STATED (OAuth 2.0 Security BCP / RFC 9700 §4.14.2): an attacker who can replay a
  // stolen cookie refresh token WITHIN sixty seconds of the real rotation gets a distinct live tip
  // that then rotates on its own chain — a parallel session that survives until the family is
  // revoked (a sign-out, a device revocation, or the next reuse detection outside this window).
  // That list no longer ends with `sessionAbsoluteTtlMs`, which is now null: the backstop this
  // paragraph used to name is gone, and the remaining ends are all ACTIONS rather than a timer.
  // It requires real-time exfiltration AND hitting one sixty-second window per rotation, and it
  // is confined to the browser cookie surface. The widening from ten was bought deliberately:
  // the ten-second version was signing out honest users every morning, and a detection that
  // mostly detects lid-closes is not detection.
  refreshReuseGraceMs: 60_000,
  loginTokenTtlMs: 5 * MIN,
  webauthnChallengeTtlMs: 5 * MIN,
  oauthCodeTtlMs: 60_000,           // short-TTL single-use code
  // TWO MINUTES, and it is short because the code is READ OFF A SCREEN. It exists only for the
  // seconds between a browser printing it and a person typing it into the app beside them, so
  // its window is that walk and not a session. Shorter than the OAuth code's sibling ceremony
  // is not possible — a human has to retype this one — and longer turns a shoulder-surfed or
  // screen-shared value into something worth going back for.
  desktopLinkTtlMs: 2 * MIN,
  stepUpWindowMs: 5 * MIN,          // step-up window
  maxFailures: 5,
  lockoutMs: 15 * MIN,
  failureWindowMs: 15 * MIN,
  maxRegistrationsPerWindow: 20,
  maxPublicRegistrationsPerWindow: 5,
  maxDesktopClaimsPerWindow: 10,
  // THE NAME A PERSON SEES IN THEIR AUTHENTICATOR APP, for ever. "TrafficFlow Mail" is the
  // pre-rename product name and appears nowhere else in the product; the company is
  // TrafficFlow GmbH but the thing being signed into is ohmail — the brand is "ohmail", never
  // anything else, including title tags.
  //
  // Safe to change: the issuer is baked into the `otpauth://` URI at ENROLLMENT and lives in
  // the authenticator's own entry from then on. Existing enrollments keep the label they were
  // created with — nothing re-reads this to verify a code — so this renames new enrollments
  // only, which is the most that can be done without asking people to re-enrol.
  totpIssuer: "ohmail",
  totpWindow: 1,
};

/**
 * Build a validated {@link AuthConfig}.
 *
 * `origin` may be one string (every single-origin caller) or an allow-list — the product
 * and the operator console are two hosts under one registrable domain, sharing the single
 * rpID `ohmail.app`. The rpID is the REGISTRABLE DOMAIN, not any one host: a per-host rpID
 * could not cover both, and one credential store has to span them.
 *
 * **A host that only REDIRECTS is never an auth origin**, and that is a mechanical
 * assertion, not a comment: `origins.ts` refuses each of them by EXACT host match,
 * unconditionally, on EVERY config — built here or as a hand-built literal handed to
 * `new AuthService(...)`, which is the shape the production config takes.
 *
 * It is an exact HOST match rather than the rpID-shaped check it used to be, and that
 * changed when the marketing surface and the app came to share one registrable domain:
 * "reject an rpID under the marketing surface's registrable domain" would reject the only
 * rpID the product can use. `NEVER_AUTH_HOSTS` in `origins.ts` states what moved, what is
 * weaker, and what still holds — including the part that is a genuine loss.
 *
 * The origin/rpID relationship is validated HERE, at config construction — a boot
 * failure, not a request failure. See `origins.ts`.
 */
export function makeAuthConfig(over: Partial<AuthConfig> & Pick<AuthConfig, "rpID" | "origin">): AuthConfig {
  const cfg: AuthConfig = {
    ...DEFAULT_AUTH_CONFIG,
    // The name shown in the OS passkey prompt ("Save a passkey for …"). Display-only:
    // WebAuthn binds `rp.id` into the credential via `rpIdHash`, never `rp.name`, so changing
    // it cannot invalidate a stored passkey — verified against `schema.ts`, which persists no
    // rp name at all. `rpID` is untouched and must stay `ohmail.app`.
    rpName: "ohmail",
    ...over,
  };
  assertOriginConfig(cfg);
  return cfg;
}
