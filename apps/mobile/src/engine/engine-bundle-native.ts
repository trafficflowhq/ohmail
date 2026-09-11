/**
 * The packaging half — the pre-bundled engine, required by path and registered before render.
 * `engine-artifact.ts` holds the registry; this is the one file that registers. A static `require`:
 * Metro resolves the specifier at bundle time, so a build that does not carry the artifact cannot be
 * produced at all (`metro.config.js` refuses first with a sentence naming the generator; even without
 * that check the resolution fails). Not wrapped in try/catch — a Metro `require` of a module the build
 * does not carry is fatal before the catch can run (`src/net/unified-push.ts` carries the measurement).
 * The `-native` suffix keeps the node suite from importing this; `test/engine-bundle-loads.test.ts`
 * boots the same artifact at the same path, answering its two leftover `require`s, and watches it dial.
 */
import { registerPhoneEngine, registerPhoneEngineReopen } from "./engine-artifact";
import type { StartPhoneEngine, StartPhoneEngineFromSealed } from "./standalone-door";

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment */
/**
 * The generated module, at the path `scripts/bundle-engine.mjs` writes and
 * `apps/mobile/.gitignore` keeps out of the repository. Its shape is declared beside it in
 * `generated/phone-engine.d.ts`, and asserted against the loaded artifact by the packaging test.
 */
const artifact = require("../../generated/phone-engine.js") as {
  startPhoneEngine: StartPhoneEngine;
  startPhoneEngineFromSealed: StartPhoneEngineFromSealed;
};
/* eslint-enable */

/**
 * Register, and say whether this call is the live engine. A function rather than a bare module
 * side effect, so the composition root's import order is visible where it matters:
 * `engine-artifact.ts` requires registration before the first render, because the chooser
 * reads the registry at render time and holds no subscription — `app/_layout.tsx` calls this
 * above the router. The answer is the registry's own: `false` means a different engine was
 * already registered, which cannot happen in a build carrying one artifact and is not made an
 * exception — a throw inside `src/engine/` is quoted verbatim into a translated refusal.
 */
export function registerBundledPhoneEngine(): boolean {
  /* BOTH ENTRIES OF ONE ARTIFACT, from one `require`. The door's registration is what the chooser
     reads; the relaunch's is what a cold launch over a stored row reaches. Registered together so a
     build cannot offer the door and then be unable to re-open what it opened. */
  const reopen = registerPhoneEngineReopen(artifact.startPhoneEngineFromSealed);
  return registerPhoneEngine(artifact.startPhoneEngine) && reopen;
}
