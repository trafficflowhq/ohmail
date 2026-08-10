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
