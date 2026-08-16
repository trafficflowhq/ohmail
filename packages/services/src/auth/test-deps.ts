import { StaticKeyProvider, scryptHasher } from "./crypto.js";
import { makeAuthConfig } from "./config.js";
import type { AuthConfig, AuthDeps } from "./types.js";

/**
 * TEST FIXTURES FOR THE IDENTITY CEREMONY — deliberately not beside the configuration builder.
 *
 * This factory lived in `config.ts`, which every deployment loads, and it was the only thing in
 * that file that needed `AuthDeps`. `AuthDeps` carries the transactional mailer, so a module
 * shared by every deployment named the hosted mail service in a type position purely to describe
 * a helper no product code ever calls. Moving the helper moved the dependency with it: `config.ts`
 * now names the configuration shape and nothing else.
 *
 * `auth/index.ts` re-exports this, so no test's import changes.
 */
/**
 * Hermetic auth dependencies for the test suite: a static 32-byte KEK and
 * the real scrypt hasher. `rpID`/`origin` default to a localhost RP.
 *
 * `mail` defaults to ABSENT, which is deliberate rather than lazy:
 * the overwhelming majority of callers test something with no mail in it at all, and a default
 * mailer would mean every one of them silently exercised a send. A test whose subject IS the
 * public signup path passes one explicitly — and the absence is itself a behaviour worth
 * testing, because `register` turns "open gate + no mailer" into `503 signup_unavailable`.
 */
export function makeTestAuthDeps(
  over: Partial<AuthConfig> = {},
  mail?: AuthDeps["mail"],
): AuthDeps {
  return {
    config: makeAuthConfig({
      rpID: "localhost",
      origin: "http://localhost:3000",
      inviteCodes: new Set(["INVITE-OK"]),
      ...over,
    }),
    keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1),
    passwordHasher: scryptHasher,
    ...(mail === undefined ? {} : { mail }),
  };
}
