import { StaticKeyProvider, scryptHasher } from "./crypto.js";
import { assertOriginConfig } from "./origins.js";
import type { AuthConfig } from "./config-types.js";

const MIN = 60_000;

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
  refreshTtlMs: 30 * 24 * 60 * MIN,
  // The hard ceiling on a SLIDING session. Rotation renews the 30-day refresh window on every
  // use, so a mail client somebody opens weekly would otherwise stay signed in for ever — and
  // a token stolen from such a browser would be a permanent credential. 90 days is the
  // Fastmail/Notion/Linear-class number: long enough that no ordinary user ever meets it,
  // short enough that an abandoned or stolen session dies on its own. Measured from
  // `sessions.created_at` in `rotateRefresh`.
  sessionAbsoluteTtlMs: 90 * 24 * 60 * MIN,
  // ── THE REFRESH-ROTATION GRACE WINDOW (COOKIE SURFACE ONLY) ─────────────────────────────────
  //
  // TEN SECONDS, and it is short on purpose. A browser shares ONE cookie jar across every tab and
  // window, and the web client's refresh helper single-flights `POST /auth/refresh` only PER TAB —
  // it has no cross-tab coordination — so the instant a second tab, a second window, or the
  // sync client and the REST client both cross the fifteen-minute access-token expiry together,
  // they read the SAME `tf_refresh` out of the jar and present it at once. Exactly one wins the
  // rotation; without this window the loser's presentation of the now-consumed token was read as
  // reuse and REVOKED THE WHOLE FAMILY, signing a working session out for the crime of being open
  // in two tabs. That is the "Sync stopped — this session is no longer authorized" a signed-in
  // user hit on a new tab or window.
  //
  // It applies ONLY to the cookie refresh path (`AuthService.refresh`'s `concurrentGrace`, passed
  // by the `/auth/refresh` COOKIE branch). A native/bearer client and the OAuth `refresh_token`
  // grant hold their token privately and rotate it serially — no shared jar, no per-tab
  // single-flight, so no benign race — and they keep the strict reuse response unchanged.
  //
  // The legitimate race is bounded by the round trip of the winning refresh — the loser can only
  // still be holding the old token until the winner's `Set-Cookie` lands in the shared jar, which
  // is sub-second to a second or two on a slow connection. Ten seconds is margin over that, and
  // nothing near long enough to matter to detection: a token is consumed the moment it rotates,
  // and the real client rotates past it and never presents it again — so a presentation older
  // than this window is a token someone kept, which is precisely the replayed-theft case reuse
  // detection is FOR, and it still revokes.
  //
  // THE RESIDUAL, STATED (OAuth 2.0 Security BCP / RFC 9700 §4.14.2): an attacker who can replay a
  // stolen cookie refresh token WITHIN ten seconds of the real rotation gets a distinct live tip
  // that then rotates on its own chain — a parallel session that survives until the family is
  // revoked (a sign-out) or `sessionAbsoluteTtlMs`. It requires real-time exfiltration AND hitting
  // one ten-second window per rotation, and it is confined to the browser cookie surface. Shrinking
  // it further would start signing honest multi-tab users out again; that is the trade this number
  // buys, made deliberately and only where the race is real.
  refreshReuseGraceMs: 10_000,
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
