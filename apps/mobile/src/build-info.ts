/**
 * Which build is this — the one fact a sideloaded tester could not get out of the app: the
 * About block carried no version, so the only place it existed was the package manifest.
 * `expo-constants` (already a dependency) serves the config `expo prebuild` embeds in the
 * artifact. Both that config and `android/app/build.gradle`'s `versionName`/`versionCode` are
 * generated from one source, `app.json`, and `build-info.test.ts` asserts the two agree — a
 * number a screen shows about itself has to be checked against the thing it describes, or it
 * is decoration. No expo import here: the composition hands in `Constants.expoConfig` and
 * `Platform.OS`; this module is the pure part, so the node suite drives the rule itself.
 */

/** The two platform halves of one question, as the embedded app config spells them. */
/* The word "Version" is on the About block, so it is copy. The NUMBERS are not — they come
   from the artifact's own config and are the same in every language. */
import { Copy } from "./copy";

export interface BuildConfig {
  /** `expo.version` — the marketing version, both platforms. */
  version?: unknown;
  /** `expo.android.versionCode` — Android's build number. */
  androidVersionCode?: unknown;
  /** `expo.ios.buildNumber` — the same fact on iOS, where it is a string. */
  iosBuildNumber?: unknown;
}

/**
 * `Version 0.14.1 (2)` — or `Version 0.14.1` where the platform has no build number, or `null`
 * where there is no version to state. `null` rather than a placeholder: "Version unknown" on a
 * screen headed "About this build" reads as a fact about the build instead of a missing read,
 * and a tester would report it. It is unreachable in anything this repo ships (`app.json`
 * always carries a version; the test beside this file pins that) — the arm keeps the function
 * total. The build number is narrowed, not coerced: Android's is a number, iOS's a string, and
 * anything else is treated as absent — `String(undefined)` in a version line is exactly the
 * kind of "(undefined)" that gets screenshotted into a bug report.
 */
/**
 * WHAT A BUILD NOBODY STAMPED CALLS ITSELF. A word, not a blank: "this came off somebody's
 * machine" is a fact a tester should read, and an empty line reads as a failed lookup.
 */
export const DEV_COMMIT = "dev";

/**
 * WHICH COMMIT this artifact was built from — the one thing `versionName (versionCode)` cannot
 * say. A rig refuses a run whose build is not the candidate, and two builds of one release carry
 * the same version line. The value is `EXPO_PUBLIC_COMMIT`, baked by the android workflow and
 * inlined by Expo; the composition reads `process.env` and hands it here.
 *
 * Exactly 40 lower-case hex or {@link DEV_COMMIT} — never the raw string. A half-baked value
 * renders as an identity that matches nothing, which is worse than a word.
 */
export function buildCommit(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[0-9a-f]{40}$/.test(value) ? value : DEV_COMMIT;
}

export function buildLabel(config: BuildConfig, os: "android" | "ios" | string): string | null {
  const version = typeof config.version === "string" && config.version.trim() !== ""
    ? config.version.trim()
    : null;
  if (version === null) return null;
  const raw = os === "ios" ? config.iosBuildNumber : config.androidVersionCode;
  const build =
    typeof raw === "number" && Number.isFinite(raw) ? String(raw)
      : typeof raw === "string" && raw.trim() !== "" ? raw.trim()
        : null;
  return build === null ? Copy.buildVersion(version) : Copy.buildVersionWithCode(version, build);
}
