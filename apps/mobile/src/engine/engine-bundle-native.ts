/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PACKAGING HALF — the pre-bundled engine, required by path and registered before render
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `engine-artifact.ts` holds the registry and says the door follows the registration; this is the
 * one file that registers. `local-engine.ts` states the other half of the split — the engine
 * reaches this app as a bundle whose specifiers are already resolved and whose Node builtins are
 * already substituted, so nothing here imports the engine's SOURCE.
 *
 * ── A STATIC `require`, WHICH IS THE WHOLE MECHANISM ──────────────────────────────────────
 *
 * Metro resolves the specifier below at BUNDLE time. That is deliberate and it is what makes the
 * ruling's property structural rather than promised: a build that does not carry the artifact
 * cannot be produced at all. `metro.config.js` refuses first, with a sentence naming the generator,
 * because Metro's own "Unable to resolve module" names a path and not the command that writes it —
 * but if that check were deleted the resolution still fails. Two mechanisms, and the narrow one is
 * not load-bearing.
 *
 * It is NOT wrapped in a try/catch, and not because nobody thought of it: a Metro `require` of a
 * module the build does not carry is fatal before the catch can run (`src/net/unified-push.ts`
 * carries the measurement for the native-module case). So "load it if present" is not available on
 * this platform, and the honest design is the one where absence is a build failure.
 *
 * ── AND THE NODE-SIDE SUITE NEVER IMPORTS THIS FILE ───────────────────────────────────────
 *
 * The `-native` suffix is this app's existing rule (`servers-native.ts`, `local-engine-native.ts`):
 * a module the suite cannot load lives in a twin the suite does not import. The artifact leaves two
 * `require`s behind for the app's bundler — `react-native-tcp-socket` and
 * `react-native-quick-crypto` — so loading it under Node needs those two answered, which is exactly
 * what `test/engine-bundle-loads.test.ts` does, over the same file at the same path. That suite
 * boots the artifact and watches it dial; this file only hands it to the registry.
 */
import { registerPhoneEngine } from "./engine-artifact";
import type { StartPhoneEngine } from "./standalone-door";

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment */
/**
 * The generated module, at the path `scripts/bundle-engine.mjs` writes and
 * `apps/mobile/.gitignore` keeps out of the repository. Its shape is declared beside it in
 * `generated/phone-engine.d.ts`, and asserted against the loaded artifact by the packaging test.
 */
const artifact = require("../../generated/phone-engine.js") as {
  startPhoneEngine: StartPhoneEngine;
};
/* eslint-enable */

/**
 * REGISTER, AND SAY WHETHER THIS CALL IS THE LIVE ENGINE.
 *
 * A function rather than a bare module side effect, so the composition root's import ORDER is
 * visible where it matters: `engine-artifact.ts` requires the registration to happen before the
 * first render, because the chooser reads the registry at render time and holds no subscription.
 * `app/_layout.tsx` calls this above the router.
 *
 * The answer is the registry's own: `false` means a different engine was already registered, which
 * cannot happen in a build carrying one artifact and is not made into an exception here — a throw
 * inside `src/engine/` is quoted verbatim into a translated refusal (`test/refusal.test.ts`).
 */
export function registerBundledPhoneEngine(): boolean {
  return registerPhoneEngine(artifact.startPhoneEngine);
}
