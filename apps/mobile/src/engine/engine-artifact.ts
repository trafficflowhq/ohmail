/**
 * Where the phone's engine artifact is registered — one module, so there is one answer. The engine is one
 * file with every specifier resolved and every Node builtin substituted; `scripts/bundle-engine.mjs` writes
 * it into `generated/`, `engine-bundle-native.ts` requires it by path, `metro.config.js` refuses a build
 * without it. A registry and not a `require` because a Metro `require` of a missing module is fatal and
 * cannot be caught — "try to load it and see" does not exist on this platform. `standaloneAvailable` reads
 * the answer, so the fourth door is offered exactly where an engine can run. Registration happens before the
 * first render, a requirement: the chooser reads this at render time with no subscription, so a late
 * registration leaves a build that HAS an engine showing three doors.
 */
import type { StartPhoneEngine, StartPhoneEngineFromSealed } from "./standalone-door";

let registered: StartPhoneEngine | null = null;
/**
 * THE RELAUNCH ENTRY OF THE SAME ARTIFACT, registered beside the door's.
 *
 * Its own slot rather than a second parameter, so `registerPhoneEngine`'s answer goes on meaning
 * exactly "is there an engine in this build" — which is what the fourth door is offered on. The
 * packaging half registers both from one `require`, so they cannot come from two artifacts.
 */
let reopen: StartPhoneEngineFromSealed | null = null;

/**
 * Register the artifact's composition root. Called once, by the packaging half. The first
 * registration wins, and a second, different one changes nothing — two engines in one process
 * would be two organizers of one mailbox, the invariant the whole product is built on.
 * Enforced by construction rather than exception: a throw here would be an English sentence
 * inside `src/engine/`, where `faultDetail` quotes anything that is not a `StoreFault`
 * verbatim into a translated refusal (`test/refusal.test.ts`). Answers whether THIS call is
 * the registered engine; registering the same value twice is not a conflict.
 */
export function registerPhoneEngine(start: StartPhoneEngine): boolean {
  if (registered === null) registered = start;
  return registered === start;
}

/** The registered artifact, or `null`. `null` is "this build carries no engine", not an error. */
export function phoneEngineStart(): StartPhoneEngine | null {
  return registered;
}

/**
 * Register the artifact's RELAUNCH entry. First one wins, for {@link registerPhoneEngine}'s reason.
 *
 * Answers whether this call is the registered one. Separate from the door's registration and called
 * from the same place with the same `require`, so a build cannot hold one without the other.
 */
export function registerPhoneEngineReopen(start: StartPhoneEngineFromSealed): boolean {
  if (reopen === null) reopen = start;
  return reopen === start;
}

/** The registered relaunch entry, or `null` — "this build carries no engine", not an error. */
export function phoneEngineReopen(): StartPhoneEngineFromSealed | null {
  return reopen;
}

/** Test seam: forget the registration. Never called by the app. */
export function forgetPhoneEngine(): void {
  registered = null;
  reopen = null;
}
