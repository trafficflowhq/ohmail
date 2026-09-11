/**
 * The bundle-time refusal — a build without the phone's engine stops here, by name. Required by
 * `metro.config.js` while the bundler's configuration is being read, the one moment every phone build passes
 * through. `src/engine/engine-bundle-native.ts` requires the artifact by path, so a build without it cannot
 * be produced either way; what Metro says is "Unable to resolve module ../../generated/phone-engine.js" — a
 * path, no hint that a generator writes it. This turns that into a sentence naming the command. The message,
 * not the enforcement: the resolution failure is the enforcement, and deleting this file would not make a
 * three-door release buildable. Plain CommonJS with no dependencies, so `test/engine-packaging.test.ts`
 * drives both arms without loading `expo/metro-config`.
 */
const { existsSync } = require("node:fs");
const { join } = require("node:path");

/** The generated module, relative to the app. One spelling, shared with the test. */
const ARTIFACT = join("generated", "phone-engine.js");

/**
 * Throw unless the app carries its engine.
 *
 * @param {string} projectRoot `apps/mobile`, as `metro.config.js` knows it (`__dirname`).
 * @param {(p: string) => boolean} [exists] seam, so the absent arm is driven without moving files.
 */
function assertPhoneEngineArtifact(projectRoot, exists = existsSync) {
  if (exists(join(projectRoot, ARTIFACT))) return;
  throw new Error(
    "the phone's mail engine is missing, so this build would have no fourth door.\n" +
    `  Expected: apps/mobile/${ARTIFACT}\n` +
    "  It is generated — build it first, and before every phone build:\n\n" +
    "    pnpm -C apps/mobile run build:engine\n\n" +
    "  (that runs apps/mobile/scripts/bundle-engine.mjs; CI runs the same script, and the\n" +
    "  Mac's iOS build runs it through the same package script before `expo prebuild`.)\n",
  );
}

module.exports = { ARTIFACT, assertPhoneEngineArtifact };
