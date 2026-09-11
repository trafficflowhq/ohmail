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
 * Resolve the session lifetimes for a surface — the ONLY place the default is decided, and the
 * default is the STRICTER surface. The dangerous version is one line different: `surface ===
 * "cookie" ? cookie : native` reads identically, passes every test that names a surface, and
 * makes the FALL-THROUGH the 400-day native branch — every caller that forgets the argument
 * silently hands a browser a near-indefinite session. So `native` must be ASKED FOR by name;
 * everything else — `undefined` included — lands on the cookie window. Exactly one default exists
 * (the `= "cookie"` below). `session-lifetime.test.ts` pins both halves: the no-argument call
 * resolves to the cookie window, and flipping the default turns it red.
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
  // How long a session lives, per surface. NINETY DAYS, ROLLING, on the browser: every rotation
  // re-issues the window from now, and `sessionAbsoluteTtlMs` is `null`, so a browser that is
  // used stays signed in. That is the product decision — a mail client that signs you out on a
  // schedule is one you stop trusting with your mail; ninety days is the IDLE bound, the only
  // bound left. What that gives up, stated plainly: a refresh token stolen from a browser that
  // keeps being used no longer dies on its own. What still ends it: any sign-out
  // (`revokeFamily`), revoking the device, a password change, and reuse detection the moment
  // thief and real client both present a token outside the grace — the likely outcome of a stolen
  // rotating chain actually being used. The cap was never the thing catching theft; it was a
  // timer that mostly signed out honest people.
  refreshTtlMs: 90 * 24 * 60 * MIN,
  // FOUR HUNDRED DAYS, ROLLING, on the native/bearer surface — the desktop app. The same decision
  // taken further: the sidecar rotates on every launch (`apps/sidecar/src/cloud-auth.ts`), so the
  // window re-issues each time the app opens, and a rolling 400 days is indefinite in practice
  // for anyone who opens their mail within a year. An installed app demanding a password and a
  // six-digit code because it sat unopened over a summer is the same failure as the browser
  // sign-out, minus the shared-jar excuse. 400 rather than no expiry at all: the row keeps a real
  // `expires_at`, so the schema, the reaper and the console keep reading a date instead of
  // learning to special-case a null.
  nativeRefreshTtlMs: 400 * 24 * 60 * MIN,
  // The absolute cap, given up on both shipped surfaces. It was 90 days from
  // `sessions.created_at`, and it made "rolling" false: a browser used every day was signed out
  // on the ninetieth regardless. A cap and a rolling window are not two safety features that add
  // up — the cap decides, and while it stood the refresh TTL only chose how fast an IDLE session
  // died; keeping it while claiming a rolling session would publish a sentence the code
  // contradicts on day 91. `null` on both surfaces, and the mechanism stays live and tested:
  // `rotateRefresh` enforces any non-null value, proven in `session-lifetime.test.ts` against an
  // overriding config. A deployment that wants a ceiling sets one.
  sessionAbsoluteTtlMs: null,
  nativeSessionAbsoluteTtlMs: null,
  // What a home-screen PWA actually keeps: iOS partitions an installed app's cookie jar from
  // Safari's (one sign-in at install); ITP's seven-day cap applies to SCRIPT-written storage and
  // our cookies are server-set — exempt — so the session must never migrate into script storage;
  // persistence is bounded by our window. THE GRACE: SIXTY SECONDS, cookie refresh path only. One
  // jar is shared by every tab, so two tabs crossing the access expiry present the SAME
  // `tf_refresh` at once; without the window the loser read as reuse and the family was revoked.
  // Sixty, not ten — measured at machine wake: queued refreshes sit in flight for many seconds,
  // and a family was revoked 10.1 s after consumption, 114 ms past the old window. The residual
  // (RFC 9700 §4.14.2): a token replayed WITHIN the window buys a parallel chain living until a
  // sign-out, device revocation, or the next reuse detection — all ACTIONS, no timer.
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
 * Build a validated {@link AuthConfig}. `origin` may be one string or an allow-list — two hosts
 * under one registrable domain share the single rpID `ohmail.app`: the rpID is the REGISTRABLE
 * DOMAIN, because one credential store must span them. A host that only REDIRECTS is never an
 * auth origin, mechanically: `origins.ts` refuses each by EXACT host match on EVERY config —
 * built here or a hand-built literal, the shape the production config takes. Exact host, not the
 * old rpID-shaped check: once marketing and app shared one registrable domain, that check would
 * reject the only rpID the product can use (`NEVER_AUTH_HOSTS`). Origin/rpID validation happens
 * HERE, at construction — a boot failure, not a request failure.
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
