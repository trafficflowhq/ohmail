const { withProjectBuildGradle, createRunOncePlugin } = require("expo/config-plugins");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  KEEP FIREBASE CLOUD MESSAGING OUT OF THE APK — the whole point of using UnifiedPush
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `expo-unified-push` declares TWO Android dependencies:
 *
 *     implementation('org.unifiedpush.android:connector:3.0.9')
 *     implementation('org.unifiedpush.android:embedded-fcm-distributor:3.0.0')
 *
 * The first is the connector — the part that talks to whichever distributor the user chose, and
 * the only part this app uses. The second is an EMBEDDED DISTRIBUTOR that carries a Firebase Cloud
 * Messaging client, so that an app with no distributor installed can fall back to Google's push
 * service. That is a reasonable default for most apps and it is the exact thing this product exists
 * not to do.
 *
 * ── WHY THIS IS A BUILD-LEVEL EXCLUSION AND NOT A RUNTIME CHOICE ──────────────────────────────
 *
 * Filtering the embedded distributor out of the list the user picks from would leave the Firebase
 * client IN the shipped binary: a Google push SDK inside an app whose entire claim is that no
 * Google or Apple push service stands between a person's mailbox and their phone. The app's own
 * privacy census bans `expo-notifications` for precisely that reason and calls the ban permanent by
 * ruling — an FCM client arriving through a transitive Gradle dependency instead of through an npm
 * import is the same code and the same claim, and a rule that can be walked around by changing the
 * import path is not a rule.
 *
 * So the artifact is what is policed. `allprojects { configurations.all { exclude … } }` reaches the
 * `expo-unified-push` Gradle module too, which is what makes this work: the exclusion has to apply
 * to the configuration of the project that DECLARED the dependency, not to ours.
 *
 * ── WHY THIS IS SAFE, MEASURED RATHER THAN ASSUMED ────────────────────────────────────────────
 *
 * Both of the module's Kotlin sources were read in full before adopting this. `ExpoUnifiedPushModule.kt`
 * and `ExpoUPService.kt` import from `org.unifiedpush.android.connector.*` and NOTHING from the
 * embedded distributor's package — the embedded arm is discovered at runtime through the package
 * manager (it registers a receiver under the app's own package name, which is how the module labels
 * it "internal"), not linked against. Removing the artifact therefore removes a receiver and leaves
 * no unresolved symbol. The proof that this stayed true is not this comment: the release workflow
 * scans the built APK's dex for `Lcom/google/firebase/` and for the embedded distributor's
 * descriptors, and requires the CONNECTOR's descriptors to be present so an empty scan cannot pass.
 *
 * ── IT FAILS LOUD ─────────────────────────────────────────────────────────────────────────────
 *
 * If Expo's template ever ships `build.gradle.kts` instead of Groovy, this throws rather than
 * quietly applying nothing. A plugin that silently no-ops would put Firebase back in the binary
 * while every check still read as configured, which is the worst of the available failures.
 */

/** The marker that makes this idempotent AND greppable in the generated project. */
const MARKER = "// ohmail: the embedded FCM distributor is excluded — see plugins/without-embedded-fcm.js";

const BLOCK = `
${MARKER}
allprojects {
  configurations.all {
    exclude group: 'org.unifiedpush.android', module: 'embedded-fcm-distributor'
  }
}
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withoutEmbeddedFcm(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(
        "without-embedded-fcm: android/build.gradle is "
        + `${cfg.modResults.language}, not groovy, so the Firebase exclusion was NOT applied. `
        + "Refusing rather than shipping an APK with an FCM client in it. Port the exclusion to "
        + "the new template language before building.",
      );
    }
    // `prebuild` regenerates the project, but a repeated run over an existing one must not stack
    // the block — and a second copy would be harmless yet make the workflow's greps ambiguous.
    if (cfg.modResults.contents.includes(MARKER)) return cfg;
    cfg.modResults.contents += BLOCK;
    return cfg;
  });
}

module.exports = createRunOncePlugin(withoutEmbeddedFcm, "ohmail-without-embedded-fcm", "1.0.0");
