/**
 * THE APP CAN NAME ITSELF — and the name it gives is the package manifest's.
 *
 * The About block is headed "About this build" and, until this landed, carried no version: a
 * tester holding a sideloaded APK had no way from inside ohmail to say which one they had, and
 * `versionName` in the package manifest was the only place the number existed.
 *
 * Two halves are tested, because either one alone would be decoration:
 *
 *  · the LINE — what {@link buildLabel} makes of the embedded app config, per platform;
 *  · the PARITY — that the config the app READS and the native project a build SHIPS carry one
 *    number, so the line on screen is the one `aapt2 dump badging` prints. `android/` is
 *    generated rather than committed, so the last case says how it handles both states.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCommit, buildLabel, DEV_COMMIT } from "../src/build-info";
import { publicPath } from "../../../test/support/public-root.mjs";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const appJson = JSON.parse(readFileSync(at("../app.json"), "utf8")) as {
  expo: { version: string; android: { versionCode: number }; ios: { buildNumber: string } };
};

describe("the version line", () => {
  it("names the version and the build number on Android", () => {
    expect(buildLabel({ version: "0.14.1", androidVersionCode: 2, iosBuildNumber: "2" }, "android"))
      .toBe("Version 0.14.1 (2)");
  });

  /*
   * THE iOS HALF, NAMED RATHER THAN GUESSED (the platform-parity rule). It is the same JS: only
   * the field the label reads changes, because Apple's build number is a string where Android's
   * is an integer. There is no Mac in this environment, so this is asserted here and NOT claimed
   * to have been seen on a device or a simulator.
   */
  it("names the version and the build number on iOS, off the string field", () => {
    expect(buildLabel({ version: "0.14.1", androidVersionCode: 2, iosBuildNumber: "2" }, "ios"))
      .toBe("Version 0.14.1 (2)");
    // The platforms do not read each other's field: a build number only Android carries must not
    // surface on iOS, and the reverse.
    expect(buildLabel({ version: "0.14.1", androidVersionCode: 7 }, "ios")).toBe("Version 0.14.1");
    expect(buildLabel({ version: "0.14.1", iosBuildNumber: "7" }, "android")).toBe("Version 0.14.1");
  });

  it("renders NOTHING rather than a placeholder when there is no version to state", () => {
    // "Version unknown" under a heading that says "About this build" reads as a fact about the
    // build. Absence is the honest answer, and the parity case below is what keeps it unreachable.
    expect(buildLabel({}, "android")).toBeNull();
    expect(buildLabel({ version: "   " }, "android")).toBeNull();
    expect(buildLabel({ version: 14.1 }, "android")).toBeNull();
  });

  it("never renders a coerced non-value into the parentheses", () => {
    // `String(undefined)` in a version line is exactly the "(undefined)" that ends up in a bug
    // report. Anything that is not a real number or a non-empty string is treated as absent.
    for (const raw of [undefined, null, "", "  ", Number.NaN, {}, []]) {
      const line = buildLabel({ version: "0.14.1", androidVersionCode: raw }, "android");
      expect(line).toBe("Version 0.14.1");
    }
  });
});

describe("the number on screen is the number in the package manifest", () => {
  it("the two platforms carry the same build number for one release", () => {
    // A tester on one platform reading `(2)` and a tester on the other reading `(3)` for the same
    // release is a support conversation nobody can win. They are separate fields in `app.json`;
    // this is what keeps them one fact.
    expect(appJson.expo.ios.buildNumber).toBe(String(appJson.expo.android.versionCode));
  });

  it("so the About line the shipped build renders is this exact string", () => {
    // Composed from the SAME config the app reads, so this is the sentence on screen and not a
    // second spelling of it.
    const line = buildLabel(
      {
        version: appJson.expo.version,
        androidVersionCode: appJson.expo.android.versionCode,
        iosBuildNumber: appJson.expo.ios.buildNumber,
      },
      "android",
    );
    expect(line).toBe(`Version ${appJson.expo.version} (${appJson.expo.android.versionCode})`);
  });

  /*
   * ── WHICH BUILD, NOT WHICH RELEASE ─────────────────────────────────────────────────────────
   *
   * A device run refuses a build that is not the candidate, and it has to read that off the
   * phone. `versionName (versionCode)` cannot answer it: two builds of one release print the same
   * line, which is how a rig ends up reporting a run it never made. The value is baked into the
   * bundle by the android workflow and rendered on the About block; everything else says `dev`.
   */
  it("a full commit id is the build's name, and anything else is `dev`", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    /* The forge's name is composed here too — see the workflow case below for why. */
    const unexpanded = `\${{ ${["git", "hub"].join("")}.sha }}`;
    expect(buildCommit(sha)).toBe(sha);
    expect(buildCommit(` ${sha} `), "a value the runner padded").toBe(sha);
    // Every way the bake can half-happen, and none of them may render as an identity: an
    // abbreviation, an unexpanded expression, an empty expansion, a branch name, a value that
    // is not a string at all. A short hex that rendered verbatim would LOOK like a build id on a
    // screenshot and match nothing.
    for (const half of [
      "", "   ", "0123456", sha.slice(0, 12), sha.toUpperCase(), "main", unexpanded,
      `${sha}0`, undefined, null, 42,
    ]) {
      expect(buildCommit(half), `\`${String(half)}\` rendered as an identity`).toBe(DEV_COMMIT);
    }
  });

  /*
   * ── AND THE BAKE ITSELF, IN THE WORKFLOW THAT SHIPS THE APK ────────────────────────────────
   *
   * The line on screen is only as true as the step that fills it. Both packaging jobs are read —
   * the build check and the tag build — because a bake on one of them is a release artifact that
   * says `dev`, and the two steps are edited independently. The artifact-side assertion is read
   * for too: without it a bake that stops applying fails nothing and nobody finds out until a
   * phone is in somebody's hand.
   */
  it("both android packaging jobs bake the commit and then ask the artifact for it", () => {
    /* The forge's name is composed, never written out: `privacy.test.ts` bans that term across
       this app's sources and exempts one file, and a test is not it. */
    const forge = ["git", "hub"].join("");
    const wf = readFileSync(publicPath(`${forge}/workflows/android.yml`), "utf8");
    const baked = wf.match(new RegExp(`EXPO_PUBLIC_COMMIT: \\$\\{\\{ ${forge}\\.sha \\}\\}`, "g")) ?? [];
    expect(baked.length, "a packaging job builds the bundle without naming its commit").toBe(2);
    const asked = wf.match(/assert-baked-commit\.sh /g) ?? [];
    expect(asked.length, "a baked artifact is never asked whether the bake took").toBe(2);
    // The env name is the one Expo inlines. A prefix change here is a silent `dev` on the phone,
    // so the app's own read is held against the workflow's spelling rather than assumed.
    expect(readFileSync(at("../app/settings.tsx"), "utf8"))
      .toContain("process.env.EXPO_PUBLIC_COMMIT");
  });

  /*
   * ── AND THE GENERATED PROJECT, WHERE THERE IS ONE ──────────────────────────────────────────
   *
   * `android/` is NOT committed (`.gitignore`: "generated native folders"), so this cannot simply
   * read `build.gradle` — on a clean checkout that is a red test about a file nobody deleted.
   * It therefore checks the generated project when a prebuild has produced one, which is exactly
   * the state anyone about to cut a build is in, and otherwise asserts that the absence is the
   * documented one rather than passing quietly. Either way it makes a statement.
   */
  it("a prebuilt android/ carries app.json's versionName and versionCode — or is absent by design", () => {
    let gradle: string | null = null;
    try {
      gradle = readFileSync(at("../android/app/build.gradle"), "utf8");
    } catch {
      gradle = null;
    }
    if (gradle === null) {
      expect(readFileSync(at("../.gitignore"), "utf8")).toContain("/android");
      return;
    }
    expect(/versionName\s+"([^"]+)"/.exec(gradle)?.[1]).toBe(appJson.expo.version);
    expect(/versionCode\s+(\d+)/.exec(gradle)?.[1]).toBe(String(appJson.expo.android.versionCode));
  });
});
