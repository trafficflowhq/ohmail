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
