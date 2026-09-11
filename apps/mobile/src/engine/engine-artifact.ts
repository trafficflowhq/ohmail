/**
 * WHERE THE PHONE'S ENGINE ARTIFACT IS REGISTERED — one module, so there is one answer.
 *
 * The phone engine is built as a single file with every specifier resolved and every Node builtin
 * substituted, and it is loaded, booted and watched dialling before a release. How the RELEASED app
 * carries it is now DECIDED: `scripts/bundle-engine.mjs` writes it into the app's own ignored
 * `generated/` directory, `engine-bundle-native.ts` requires it by path, and `metro.config.js`
 * refuses to configure a build without it. This module is still the one answer to "is there an
 * engine in this build", because the door follows the registration rather than the file.
 *
 * ── SO THE ARTIFACT REGISTERS ITSELF, AND THE DOOR FOLLOWS THE REGISTRATION ────────────────────
 *
 * A build that carries the engine calls {@link registerPhoneEngine} once at startup; a build that
 * does not calls nothing. `standaloneAvailable` reads the answer, so the fourth door is OFFERED
 * exactly where an engine can actually run, and a build without one shows three doors rather than a
 * fourth that refuses. That is the whole reason this is a registry and not a `require`: a Metro
 * `require` of a module a build does not carry is FATAL and cannot be caught, so "try to load it and
 * see" is not available on this platform.
 *
 * BEFORE THE FIRST RENDER, and that is a requirement rather than a preference: the chooser reads
 * this at render time and holds no subscription, so an engine registered after the door list is
 * drawn leaves a build that HAS an engine showing three doors until something else re-renders.
 * Register it where the app composes, above the router.
 */
import type { StartPhoneEngine } from "./standalone-door";

let registered: StartPhoneEngine | null = null;

/**
 * Register the artifact's composition root. Called once, by the packaging half.
 *
 * THE FIRST REGISTRATION WINS, and a second, different one changes nothing — two engines in one
 * process would be two organizers of one mailbox, which is the invariant the whole product is
 * built on. Enforced by construction rather than by an exception: a throw here would be an English
 * sentence inside `src/engine/`, where `faultDetail` quotes anything that is not a `StoreFault`
 * verbatim into a translated refusal (`test/refusal.test.ts` holds that rule).
 *
 * Answers whether THIS call is the registered engine, so a caller that cares can say so rather
 * than assume. Registering the same value twice is not a conflict.
 */
export function registerPhoneEngine(start: StartPhoneEngine): boolean {
  if (registered === null) registered = start;
  return registered === start;
}

/** The registered artifact, or `null`. `null` is "this build carries no engine", not an error. */
export function phoneEngineStart(): StartPhoneEngine | null {
  return registered;
}

/** Test seam: forget the registration. Never called by the app. */
export function forgetPhoneEngine(): void {
  registered = null;
}
