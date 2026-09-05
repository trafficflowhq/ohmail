/**
 * WHICH BUILD IS THIS — the one fact a sideloaded tester could not get out of the app.
 *
 * The About block named what is live and what is not and carried no version anywhere, so the
 * only place `0.14.1` existed was the package manifest: a tester holding an APK somebody sent
 * them had no way, from inside ohmail, to say which one they were looking at. Nothing else in
 * this app read a version at all.
 *
 * ── WHERE THE NUMBERS COME FROM, AND WHY THAT IS THE NATIVE MANIFEST'S NUMBER ───────────────
 *
 * `expo-constants` — already a dependency, so no new native module and no lockfile churn — serves
 * the app config that `expo prebuild` EMBEDS in the artifact. `expo-application` would read the
 * platform manifest directly and was considered; it is not here because it would add a dependency
 * for a difference this repo does not have, and because the difference is closable by a check
 * instead. Both the embedded config and `android/app/build.gradle`'s `versionName` /
 * `versionCode` are generated from ONE source, `app.json` — and `build-info.test.ts` asserts the
 * two agree, so a hand-edit of the committed `android/` tree cannot make this line say one thing
 * while `aapt2 dump badging` says another. A number a screen shows about itself has to be checked
 * against the thing it claims to describe, or it is decoration.
 *
 * ── NO EXPO IMPORT HERE ─────────────────────────────────────────────────────────────────────
 *
 * The composition reads the platform (`app/settings.tsx` hands in `Constants.expoConfig` and
 * `Platform.OS`); this module is the pure part. That is the `sql-queue.ts` / `native.ts` split
 * and it exists for the same reason: the node suite drives the rule, not a mock of it.
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
 * where there is no version to state.
 *
 * `null` RATHER THAN A PLACEHOLDER. "Version unknown" on a screen headed "About this build" is
 * worse than saying nothing: it reads as a fact about the build instead of as a missing read, and
 * a tester would report it. It is also unreachable in anything this repo ships — `app.json`
 * always carries a version, and the test beside this file pins that — so the arm exists to keep
 * the function total, not because a build is expected to hit it.
 *
 * The build number is narrowed rather than coerced: Android's is a number and iOS's is a string,
 * and anything else (a config a later Expo writes differently, an absent key) is treated as
 * absent. `String(undefined)` in a version line is exactly the kind of "(undefined)" that gets
 * screenshotted into a bug report.
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
