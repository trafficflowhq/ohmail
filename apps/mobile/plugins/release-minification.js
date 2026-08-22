const { withGradleProperties, withDangerousMod, createRunOncePlugin } = require("expo/config-plugins");
const path = require("node:path");
const fs = require("node:fs");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  R8 IS ON FOR RELEASE — to get a device secret out of logcat, and to shrink the binary
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE LEAK THIS EXISTS FOR ───────────────────────────────────────────────────────────────────
 *
 * `expo-unified-push`'s `ExpoUPService` logs the push registration at DEBUG level:
 *
 *     override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
 *         val data = Bundle()
 *         data.putString("url",    endpoint.url)
 *         data.putString("pubKey", endpoint.pubKeySet?.pubKey)
 *         data.putString("auth",   endpoint.pubKeySet?.auth)
 *         data.putString("instance", instance)
 *         Log.d(TAG, "sending \"registered\" action with data: $data")   // ← here
 *
 * `auth` is the device's RFC 8291 authentication secret and `url` is its distributor endpoint.
 * A `Bundle`'s `toString()` prints its contents, so all three went to logcat on every
 * registration — and into any bug report taken afterwards. `onMessage` has the same shape and
 * logs the DECRYPTED payload.
 *
 * The library is consumed from npm and the release APK is built with `npm ci`, which ignores
 * `pnpm.patchedDependencies` — so a `pnpm patch` would apply in this workspace and silently NOT
 * apply to the shipped binary, which is the worst available outcome. Stripping the call at build
 * time is npm-independent.
 *
 * ── HONEST SCOPE, BECAUSE THE RULE CANNOT BE SCOPED THE WAY YOU WOULD WANT ─────────────────────
 *
 * `-assumenosideeffects` is declared on the CALLEE. There is no ProGuard/R8 syntax that strips
 * `Log.d` inside `ExpoUPService` and leaves it alone everywhere else — the rule names
 * `android.util.Log`, not the caller. So "scope it to the connector" is not available, and
 * pretending otherwise in a comment would be worse than saying so.
 *
 * What IS scopeable is the LEVEL, and that is the narrowing this file makes: `d` and `v` are
 * stripped, `i`, `w`, `e` and `wtf` are kept. Consequences, both directions:
 *
 *  · every leaking call site is `Log.d` (four of them in `ExpoUPService`), so the leak is closed;
 *  · every warning, error and crash diagnostic in the app — ours, React Native's, Expo's — still
 *    reaches logcat, which is the half a blanket `class android.util.Log { *; }` would have
 *    thrown away for nothing;
 *  · DEBUG and VERBOSE logging from OTHER libraries is stripped too. That is the cost, it is
 *    accepted deliberately, and in a release build it is close to what one wants anyway: this app
 *    ships no `Log.d` of its own (the only Kotlin it contributes is `MainActivity`,
 *    `MainApplication` and the no-op renderer, none of which log).
 *
 * One real footgun, recorded because it is the thing that would bite a future edit: R8 removes the
 * argument computation along with the call. `Log.d(TAG, "… $data")` is a pure string concat, so
 * that is exactly what we want here — it is also what makes the STRING disappear from the dex,
 * which is what the release guard asserts. But a `Log.d(TAG, thing.consume())` anywhere in the
 * graph would lose the `consume()`. Nothing in this tree does that; a dependency could.
 *
 * ── AND THE SECOND REASON: SIZE ────────────────────────────────────────────────────────────────
 *
 * Whole-app minification was the price of the strip and it is also worth having on its own. This
 * APK is sideloaded from a release page over whatever connection the person has.
 *
 * Resource shrinking is deliberately NOT turned on with it. That is a separate risk axis — it
 * removes drawables and strings reached only by name — and one changed axis at a time is the
 * whole reason this landed as its own change with an on-device smoke.
 *
 * ── WHY A CONFIG PLUGIN AND NOT AN EDITED `android/` TREE ──────────────────────────────────────
 *
 * `android/` is build output: `expo prebuild` regenerates it on every run, in CI included. A rules
 * file committed there would be deleted by the next prebuild and the minified APK would ship with
 * no keep rules at all — renamed renderer, silent fallback to the connector's default renderer,
 * every check still green. So the rules live here, in source, and are written into the generated
 * project at prebuild time. Same mechanism, and same reasoning, as `silent-push-renderer.js`.
 *
 * It APPENDS to the generated rules file rather than replacing it: the template already carries
 * `react-native-reanimated`'s keeps, and overwriting them would strip the animation library's
 * reflective surface. It fails LOUD if that file is not where it is expected, rather than skipping
 * and shipping a minified APK with none of the keeps below.
 */

/** Idempotency marker AND the greppable proof that the block landed in the generated project. */
const MARKER = "# ohmail: release minification — see apps/mobile/plugins/release-minification.js";

const PROPERTY = "android.enableMinifyInReleaseBuilds";

/**
 * The FQCN the AndroidManifest names and R8 cannot see. Exported so a test compares values
 * instead of two copies of a string, exactly as `silent-push-renderer.js` does.
 */
const RENDERER_FQCN = "app.ohmail.push.SilentPushPayloadRenderer";

/**
 * The connector's `Log.d` literals. These are the strings the release guard asserts are ABSENT
 * from the minified dex, and the reason the guard can be red rather than decorative: they are
 * present in an unminified build of the same tree (measured, not assumed) and gone once the
 * `assumenosideeffects` rules above take the calls — and with them the string concatenations that
 * feed them — out.
 *
 * Exported so the guard's expectations and this plugin's rules cannot drift apart silently.
 */
const CONNECTOR_LOG_STRINGS = [
  'sending "registered" action with data: ',
  'sending "message" action with data: ',
  'sending "unregistered" action with data: ',
  'sending "registrationFailed" action with data: ',
];

const RULES = `
${MARKER}

# ── 1 · THE STRIP ─────────────────────────────────────────────────────────────────────────────
#
# DEBUG and VERBOSE only. \`i\`, \`w\`, \`e\` and \`wtf\` are deliberately NOT here: a release build
# that cannot report its own errors is a worse trade than a release build that cannot chat.
#
# This closes expo-unified-push's ExpoUPService.onNewEndpoint, which Log.d's a Bundle holding the
# device's endpoint url, p256dh pubKey and — the one that matters — its RFC 8291 \`auth\` secret,
# and onMessage, which Log.d's the decrypted payload.
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
}

# ── 2 · WHAT MINIFICATION MUST NOT TOUCH ──────────────────────────────────────────────────────
#
# The no-op payload renderer. The connector finds it by FQCN read from an AndroidManifest
# meta-data STRING and instantiates it with Class.forName. A string is not a code reference, so
# R8 cannot see the link: without this rule the class is renamed or dropped as unused,
# resolvePayloadRenderer() returns null, and the service falls back to its DEFAULT renderer —
# which draws a notification from server-supplied title/body/image with a server-supplied
# ACTION_VIEW tap target. The failure is SILENT: the app keeps working and the phishing surface
# that renderer exists to close quietly reopens.
-keep class ${RENDERER_FQCN} { *; }

# Its interface and its return type, both named across that reflective boundary:
# \`Class.forName(...) as? PushPayloadRenderer\` needs the interface identity to survive the
# rename, and the service reads NotificationContent's members.
-keep interface dev.djara.expounifiedpush.PushPayloadRenderer { *; }
-keep class dev.djara.expounifiedpush.NotificationContent { *; }

# The Expo module and the UnifiedPush connector. expo-modules-core resolves module classes
# through its generated package list and its own reflection; the connector discovers distributors
# and its own receiver through the package manager, by name.
-keep class dev.djara.expounifiedpush.** { *; }
-keep class org.unifiedpush.android.connector.** { *; }

# ── 3 · MINIFICATION MUST NOT BLIND THE RELEASE GUARDS ────────────────────────────────────────
#
# THIS IS THE NON-OBVIOUS ONE, and it is the reason turning minification on is a security change
# and not just a size change.
#
# \`assert-no-fcm.sh\` proves "no Google push code in this binary" by searching the dex for TYPE
# DESCRIPTORS — \`Lcom/google/android/gms/cloudmessaging/\`, \`Lcom/google/firebase/…\`. Renaming
# defeats that completely: obfuscated, those classes are spelled \`La/b/c;\`, the grep finds
# nothing, and an ABSENCE check that cannot see its subject PASSES. Enabling minification would
# therefore have converted the central checks of that script into vacuous ones — green while the
# thing they ban walks in under a new name. Nothing would have failed.
#
# \`-keepnames\` is the right strength, and the distinction is the point: it forbids RENAMING while
# still allowing SHRINKING. So genuinely unreachable code — today an inert Firebase DI container
# and its encoders, which an AndroidX/Expo transitive drags along and which the guard's allow-list
# enumerates — is still deleted from the binary, which is a real improvement. Anything REACHABLE
# keeps the name the guard looks for.
-keepnames class com.google.firebase.** { *; }
-keepnames class com.google.android.gms.** { *; }
-keepnames class org.unifiedpush.android.embedded_fcm_distributor.** { *; }

# ── 4 · READABLE CRASHES ──────────────────────────────────────────────────────────────────────
#
# A minified stack trace with no line numbers is unactionable, and this APK is sideloaded with no
# crash reporting behind it — a person reading logcat is the only reporter there is.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
`;

/** Turn minification on for the release build type. */
function withMinifyProperty(config) {
  return withGradleProperties(config, (cfg) => {
    // Drop any previous copy of OUR comment and OUR property so a prebuild over an existing
    // project neither stacks the comment nor leaves two conflicting values (Gradle takes the
    // last, which makes a stale `false` above a fresh `true` harmless but unreadable — and the
    // reverse order silently disables the strip).
    const kept = cfg.modResults.filter((item) => {
      if (item.type === "property" && item.key === PROPERTY) return false;
      if (item.type === "comment" && item.value === MARKER.replace(/^# /, "")) return false;
      return true;
    });
    kept.push({ type: "comment", value: MARKER.replace(/^# /, "") });
    kept.push({ type: "property", key: PROPERTY, value: "true" });
    cfg.modResults = kept;
    return cfg;
  });
}

/** Append the rules to the generated `android/app/proguard-rules.pro`. */
function withProguardRules(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
      if (!fs.existsSync(file)) {
        throw new Error(
          `release-minification: ${file} does not exist, so the R8 keep rules were NOT written. `
          + "Refusing rather than shipping a MINIFIED APK with no keep rules: the payload renderer "
          + "would be renamed and the connector would fall back to its default renderer, which "
          + "draws server-supplied notification text and tap URLs. The Android template's layout "
          + "has changed; point this plugin at the new one.",
        );
      }
      const existing = fs.readFileSync(file, "utf8");
      if (existing.includes(MARKER)) return cfg;
      fs.writeFileSync(file, `${existing.trimEnd()}\n${RULES}`);
      return cfg;
    },
  ]);
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withReleaseMinification(config) {
  return withProguardRules(withMinifyProperty(config));
}

module.exports = createRunOncePlugin(withReleaseMinification, "ohmail-release-minification", "1.0.0");
module.exports.MARKER = MARKER;
module.exports.PROPERTY = PROPERTY;
module.exports.RENDERER_FQCN = RENDERER_FQCN;
module.exports.CONNECTOR_LOG_STRINGS = CONNECTOR_LOG_STRINGS;
/**
 * The RESOLVED rules text — what actually gets appended to the generated project.
 *
 * Exported because the census must assert on this and not on this file's source: the rules are a
 * template literal, so the source spells the renderer keep as `-keep class ${RENDERER_FQCN}` and a
 * test grepping for the FQCN would fail while the build was correct — or, far worse, a test
 * grepping for the placeholder would pass while the interpolation was broken.
 */
module.exports.RULES = RULES;
