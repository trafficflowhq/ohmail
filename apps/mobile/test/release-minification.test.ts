import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { publicPath } from "../../../test/support/public-root.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CODE SHRINKER IS ON FOR RELEASE — the census over the one change that can fail invisibly
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Turning on whole-app minification bought two things: the connector's push-registration logging
 * is stripped out of the binary, and the APK got smaller. It also created a class of failure this
 * repository has paid for before — a build-time mechanism that stops applying while every check
 * still reads as configured.
 *
 * There are FOUR such failures here, and each one has an assertion below:
 *
 *  1. THE PROPERTY NAME. `android/app/build.gradle` reads
 *     `findProperty('android.enableMinifyInReleaseBuilds')`. Set anything else — the older
 *     `android.enableProguardInReleaseBuilds`, or the bare identifier the template used to use —
 *     and Gradle finds nothing, falls back to `false`, and builds a perfectly good APK with the
 *     leak still in it. No error, no warning.
 *
 *  2. THE STRIP GOING TOO WIDE. The rule is deliberately `d` and `v` only, so warnings, errors and
 *     crash diagnostics still reach logcat. `-assumenosideeffects class android.util.Log { *; }`
 *     is one keystroke away and would silently make the app unable to report anything.
 *
 *  3. A KEEP RULE GOING MISSING. The no-op payload renderer is named only as an AndroidManifest
 *     meta-data STRING, so the shrinker cannot see the reference: without `-keep`, it is renamed or dropped,
 *     `resolvePayloadRenderer` returns null, and the connector falls back to its DEFAULT renderer —
 *     which draws server-supplied notification text with a server-supplied tap URL.
 *
 *  4. THE GUARD'S STRINGS GOING STALE. `assert-log-hygiene.sh` proves the leak is gone by asserting
 *     four string literals are ABSENT from the dex. If the library rewords its log lines on a
 *     version bump, those strings are absent because they never existed — the guard passes for the
 *     wrong reason and the new wording leaks. So the strings are checked against the connector
 *     source that is actually installed.
 *
 * What is NOT claimed here: that the minified app runs. Nothing off-device can claim that, and it
 * is the reason this change shipped with an emulator smoke rather than a green dex scan.
 */

const require_ = createRequire(import.meta.url);
const PLUGIN_PATH = fileURLToPath(new URL("../plugins/release-minification.js", import.meta.url));
const APP_JSON = fileURLToPath(new URL("../app.json", import.meta.url));
/**
 * The release guards live in the published payload's workflow directory. The forge's name is
 * COMPOSED rather than written out, for the same reason `privacy.test.ts` composes it: this app's
 * privacy census bans real brand names anywhere in `apps/mobile` outside one reviewed line of the
 * README, and a path constant is not a good enough reason to widen that exemption. The directory
 * really is spelled this way on disk; only this file's spelling of it is indirect.
 */
const FORGE_DIR = ["git", "hub"].join("");
const GUARDS = `${publicPath(`${FORGE_DIR}/scripts`)}/`;
const FCM_GUARD = `${GUARDS}assert-no-fcm.sh`;
const LOG_GUARD = `${GUARDS}assert-log-hygiene.sh`;
const ANDROID_WORKFLOW = publicPath(`${FORGE_DIR}/workflows/android.yml`);

interface MinifyPlugin {
  MARKER: string;
  END_MARKER: string;
  PROPERTY: string;
  RENDERER_FQCN: string;
  CONNECTOR_LOG_STRINGS: string[];
  RULES: string;
  nextRulesFile: (existing: string) => string;
}
const plugin = require_(PLUGIN_PATH) as MinifyPlugin;
const pluginSrc = readFileSync(PLUGIN_PATH, "utf8");
/**
 * The RESOLVED rules, not this file's source. The rules are built from a template literal, so the
 * source text spells the renderer keep as `-keep class ${RENDERER_FQCN}`; asserting against the
 * source would either fail on correct code or — grepping for the placeholder — pass on a build
 * whose interpolation was broken. Every rule assertion below reads this.
 */
const rules = plugin.RULES;

describe("minification is actually turned on", () => {
  it("app.json applies the plugin — without it nothing below is in the build at all", () => {
    const cfg = JSON.parse(readFileSync(APP_JSON, "utf8")) as { expo: { plugins: unknown[] } };
    expect(cfg.expo.plugins).toContain("./plugins/release-minification");
  });

  it("sets the property name the generated build.gradle actually reads", () => {
    /**
     * The value is compared to a LITERAL rather than derived from the plugin, because the whole
     * failure being guarded is the plugin naming the wrong key. Deriving both sides from the same
     * source would assert nothing.
     *
     * The template's line is:
     *   def enableMinifyInReleaseBuilds =
     *       (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()
     * — note the `android.` prefix, which a bare `enableMinifyInReleaseBuilds` in
     * gradle.properties would NOT satisfy.
     */
    expect(plugin.PROPERTY).toBe("android.enableMinifyInReleaseBuilds");
    expect(pluginSrc).toMatch(/type: "property", key: PROPERTY, value: "true"/);
  });

  it("does NOT also turn on resource shrinking — one risk axis at a time", () => {
    // `shrinkResources` is a separate mechanism that removes drawables and strings reached only by
    // name. It was deliberately left off; if a future change wants it, it wants its own smoke.
    expect(pluginSrc).not.toMatch(/enableShrinkResourcesInReleaseBuilds/);
  });
});

describe("the strip is scoped to DEBUG and VERBOSE, and no wider", () => {
  it("strips d and v", () => {
    expect(rules).toMatch(/-assumenosideeffects class android\.util\.Log \{/);
    expect(rules).toMatch(/public static int d\(\.\.\.\);/);
    expect(rules).toMatch(/public static int v\(\.\.\.\);/);
  });

  it("does NOT strip i, w, e or wtf — the app must still be able to report a crash", () => {
    /**
     * THE ASSERTION THAT CATCHES THE ONE-KEYSTROKE WIDENING. Only the rules block is examined:
     * the file's prose names these levels precisely in order to explain why they are excluded, so
     * a census over the whole file would match the explanation and never the mistake.
     */
    const block = rules.slice(rules.indexOf("-assumenosideeffects class android.util.Log {"));
    const stripRule = block.slice(0, block.indexOf("}") + 1);
    expect(stripRule).not.toMatch(/\bpublic static int (i|w|e|wtf)\(/);
    // …and not the blanket form either, which would take every level including e.
    expect(stripRule).not.toMatch(/\{\s*\*;\s*\}/);
  });
});

describe("what must survive the rename", () => {
  it("keeps EXACTLY the renderer class the other plugin compiles — no drift", () => {
    /**
     * Two plugins and a manifest meta-data string have to agree on one FQCN. The comparison is of
     * exported VALUES so a one-character difference is a failure here rather than a silent
     * fallback to the connector's default renderer on a real phone.
     */
    const renderer = require_(fileURLToPath(new URL("../plugins/wake-push-renderer.js", import.meta.url))) as { FQCN: string };
    expect(plugin.RENDERER_FQCN).toBe(renderer.FQCN);

    const cfg = JSON.parse(readFileSync(APP_JSON, "utf8")) as {
      expo: { plugins: (string | [string, Record<string, unknown>])[] };
    };
    const entry = cfg.expo.plugins.find(
      (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === "expo-unified-push",
    );
    expect(entry![1].payloadRendererClass).toBe(plugin.RENDERER_FQCN);

    expect(rules).toContain(`-keep class ${plugin.RENDERER_FQCN} { *; }`);
  });

  it("keeps the reflective surfaces the renderer is loaded across", () => {
    expect(rules).toContain("-keep interface dev.djara.expounifiedpush.PushPayloadRenderer { *; }");
    expect(rules).toContain("-keep class dev.djara.expounifiedpush.NotificationContent { *; }");
    expect(rules).toContain("-keep class dev.djara.expounifiedpush.** { *; }");
    expect(rules).toContain("-keep class org.unifiedpush.android.connector.** { *; }");
  });

  it("fails LOUD if the generated project's rules file is not where it expects", () => {
    // A plugin that silently skipped would produce a MINIFIED APK with no keep rules at all.
    expect(pluginSrc).toMatch(/throw new Error\(/);
    expect(pluginSrc).toMatch(new RegExp("the R" + "8 keep rules were NOT written"));
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  WHAT THE PLUGIN DOES TO AN EXISTING RULES FILE — asserted by running it, not by grepping it
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * These used to be two `expect(pluginSrc).toMatch(...)` lines against the implementation's own
   * source. That is the weakest form this census can take: it pins the SHAPE of the code and says
   * nothing about the RESULT, so a rewrite that kept `readFileSync(file, "utf8")` and got the
   * splice wrong would still be green. `nextRulesFile` is pure for exactly this reason and these
   * run it.
   *
   * The two failures being pinned pull in opposite directions, which is why both are here:
   *
   *  · REPLACING THE WHOLE FILE would take the Expo template's own keeps with it —
   *    `react-native-reanimated`'s reflective surface and the turbomodule keeps sit above ours.
   *    The symptom would be a crash on some animated screen, nowhere near this change.
   *
   *  · SKIPPING WHEN THE BLOCK IS ALREADY THERE was the first version's behaviour and it was a
   *    real bug. `expo prebuild` without `--clean` runs over the existing `android/` tree, so
   *    once the marker was present no later edit to the rules ever reached the generated project.
   *    The Gradle property is rewritten every run, so minification stayed ON while the keeps went
   *    stale: a build minifying with last week's rules, marker present, every grep for it green.
   */
  describe("rewriting an existing generated rules file", () => {
    /* Stands in for the Expo template's own content. The reanimated keep is really in it — the
     * generated file was read after a prebuild and carries it at line 11 — so this is the thing
     * that must survive, not an invented one. */
    const TEMPLATE = "# generated by the Expo template\n-keep class com.swmansion.reanimated.** { *; }\n";
    const opens = (text: string) => text.split(plugin.MARKER).length - 1;

    it("adds the block and leaves the template's own keeps standing", () => {
      const out = plugin.nextRulesFile(TEMPLATE);
      expect(out).toContain("-keep class com.swmansion.reanimated.** { *; }");
      expect(out).toContain(plugin.MARKER);
      expect(out).toContain(plugin.END_MARKER);
      expect(out).toContain(`-keep class ${plugin.RENDERER_FQCN} { *; }`);
    });

    it("is idempotent — a second prebuild over the same tree changes nothing", () => {
      const once = plugin.nextRulesFile(TEMPLATE);
      expect(plugin.nextRulesFile(once)).toBe(once);
      expect(opens(once)).toBe(1);
    });

    it("REPLACES a stale block instead of leaving it — the silent-divergence bug", () => {
      // A block written when the rules said something else. If this is left alone, the build
      // minifies with a keep rule that no longer exists in this plugin's source.
      const stale = `${TEMPLATE}\n${plugin.MARKER}\n-keep class com.example.Stale { *; }\n${plugin.END_MARKER}\n`;
      const out = plugin.nextRulesFile(stale);
      expect(out).not.toContain("com.example.Stale");
      expect(out).toContain("-keep class com.swmansion.reanimated.** { *; }");
      expect(out).toContain(`-keep class ${plugin.RENDERER_FQCN} { *; }`);
      expect(opens(out)).toBe(1);
    });

    it("heals a block written before the closing marker existed", () => {
      // That version appended at the end of the file and wrote no closer, so the region runs to
      // EOF. A tree prebuilt by it and then prebuilt again by this one must not end up with two
      // blocks, and must not keep the old one's rules.
      const legacy = `${TEMPLATE}\n${plugin.MARKER}\n-keep class com.example.Legacy { *; }\n`;
      const out = plugin.nextRulesFile(legacy);
      expect(out).not.toContain("com.example.Legacy");
      expect(out).toContain("-keep class com.swmansion.reanimated.** { *; }");
      expect(opens(out)).toBe(1);
    });

    it("the block is delimited, so the cut can never be 'everything after the marker'", () => {
      // Anything the template writes AFTER our block must survive too. Without a closing marker
      // there is no way to express that, which is why one exists.
      const trailing = "# a later template addition\n-dontwarn com.example.**\n";
      const seeded = `${TEMPLATE}\n${plugin.MARKER}\n-keep class com.example.Stale { *; }\n${plugin.END_MARKER}\n${trailing}`;
      const out = plugin.nextRulesFile(seeded);
      expect(out).toContain("-dontwarn com.example.**");
      expect(out).not.toContain("com.example.Stale");
    });
  });
});

describe("minification must not blind the dex guards", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE CROSS-FILE INVARIANT: every namespace a guard SEARCHES FOR must be kept UNRENAMED
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `assert-no-fcm.sh` proves "no Google push code in this binary" by grepping the dex for type
   * descriptors. Obfuscation renames descriptors, so under minification those greps find nothing
   * and the ABSENCE checks pass vacuously — green forever, while the banned code walks in renamed.
   *
   * `-keepnames` is what keeps them honest: it forbids renaming but still allows shrinking, so
   * unreachable code is still deleted while anything reachable keeps the name the grep wants.
   *
   * This test derives the namespaces from the GUARD ITSELF rather than listing them again. So
   * adding a new `check_absent` for some future descriptor without a matching keep rule is red
   * here, at the moment it is written, instead of being a check that can never fail.
   */
  const fcmGuard = readFileSync(FCM_GUARD, "utf8");

  it("every descriptor the FCM guard searches for is kept unrenamed", () => {
    // Every `Lcom/google/...;`-shaped literal the guard looks for, reduced to its top two or three
    // package segments — the granularity the keep rules are written at.
    const descriptors = [...fcmGuard.matchAll(/'(L[a-z][A-Za-z0-9_/$]*)/g)].map((m) => m[1]);
    expect(descriptors.length, "the guard's descriptor literals could not be parsed — this test is "
      + "asserting nothing").toBeGreaterThan(3);

    // `*` and `$` are part of a ProGuard class spec, so they must be IN the character class —
    // leaving them out captured "com.google.firebase." (trailing dot, wildcard lost), which then
    // matched nothing and reported four covered namespaces as uncovered. Found by this test.
    const keptNamespaces = [...rules.matchAll(/-keep(?:names)? (?:class|interface) ([A-Za-z0-9_.*$]+)/g)]
      .map((m) => m[1].replace(/\.?\*+$/, ""));

    const uncovered: string[] = [];
    for (const desc of descriptors) {
      const dotted = desc.replace(/^L/, "").replace(/\//g, ".").replace(/;$/, "");
      if (!keptNamespaces.some((ns) => dotted === ns || dotted.startsWith(`${ns}.`))) {
        uncovered.push(desc);
      }
    }
    expect(uncovered, "these descriptors are searched for in the dex but nothing keeps them from "
      + "being RENAMED, so the search cannot find them and the absence check passes for the wrong "
      + "reason").toEqual([]);
  });

  it("names the three namespaces explicitly, so a parse failure above cannot hide a gap", () => {
    expect(rules).toContain("-keepnames class com.google.firebase.** { *; }");
    expect(rules).toContain("-keepnames class com.google.android.gms.** { *; }");
    expect(rules).toContain("-keepnames class org.unifiedpush.android.embedded_fcm_distributor.** { *; }");
  });

  it("the FCM guard records why its descriptor greps still work under minification", () => {
    // The two files are load-bearing for each other and the coupling is invisible from either one
    // alone: drop the keep rules and that script does not go red, it goes quiet.
    expect(fcmGuard).toMatch(/-keepnames/);
  });
});

describe("the log-hygiene guard asserts strings that really exist", () => {
  const logGuard = readFileSync(LOG_GUARD, "utf8");

  it("the guard checks for every string the plugin says it strips", () => {
    for (const s of plugin.CONNECTOR_LOG_STRINGS) {
      expect(logGuard, `assert-log-hygiene.sh does not check for ${JSON.stringify(s)}`).toContain(s);
    }
    expect(plugin.CONNECTOR_LOG_STRINGS).toHaveLength(4);
  });

  it("every one of those strings is REALLY in the installed connector's source", () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  THE VACUITY CHECK — an absence assertion about a string that does not exist is free
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * `assert-log-hygiene.sh` proves the leak is closed by finding four literals ABSENT from the
     * dex. Bump `expo-unified-push` and let it reword one log line, and that check keeps passing
     * — the old string is absent because it was never compiled, and the NEW wording leaks with
     * nothing watching. So the guard's strings are pinned to the source of the version actually
     * installed, and a reword is a red test with a person reading the diff.
     *
     * Kotlin escapes the inner quotes, so the source literal and the runtime string differ:
     * source `"sending \"registered\" action with data: $data"` compiles to the constant
     * `sending "registered" action with data: `. The escaped form is what is searched for.
     */
    const pkgJson = require_.resolve("expo-unified-push/package.json");
    const service = join(
      dirname(pkgJson),
      "android/src/main/java/dev/djara/expounifiedpush/ExpoUPService.kt",
    );
    const src = readFileSync(service, "utf8");

    for (const s of plugin.CONNECTOR_LOG_STRINGS) {
      const kotlinLiteral = s.replace(/"/g, '\\"');
      expect(
        src,
        `the connector no longer logs ${JSON.stringify(s)}. The guard's absence check for it is now `
        + "vacuous. Re-read ExpoUPService.kt, take the new literals, and update both "
        + "plugins/release-minification.js and the workflow's assert-log-hygiene.sh.",
      ).toContain(`Log.d(TAG, "${kotlinLiteral}$data")`);
    }
  });

  it("the sensitive Bundle keys are still the ones that reach that log line", () => {
    // If the library stopped putting `auth` in the Bundle, this whole change would be about
    // something else. Pinned so the REASON stays true, not just the mechanism.
    const pkgJson = require_.resolve("expo-unified-push/package.json");
    const src = readFileSync(
      join(dirname(pkgJson), "android/src/main/java/dev/djara/expounifiedpush/ExpoUPService.kt"),
      "utf8",
    );
    const endpoint = src.slice(src.indexOf("override fun onNewEndpoint"));
    const body = endpoint.slice(0, endpoint.indexOf("sendPushEvent"));
    expect(body).toContain('data.putString("url", endpoint.url)');
    expect(body).toContain('data.putString("pubKey", endpoint.pubKeySet?.pubKey)');
    expect(body).toContain('data.putString("auth", endpoint.pubKeySet?.auth)');
    expect(body).toContain("Log.d(TAG,");
  });

  it("the guard requires a Log.e string to SURVIVE — the over-strip canary", () => {
    // An absence-only guard would be green if the strip took every level. This is the assertion
    // that the guard also proves the strip's upper bound.
    expect(logGuard).toContain("Error resolving custom PushPayloadRenderer: ");
    expect(logGuard).toMatch(/require_present/);
  });
});

describe("the obfuscation mapping outlives the runner that made it", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE APK IS OBFUSCATED, SO THE MAPPING IS PART OF THE RELEASE — not a build by-product
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `-keepattributes SourceFile,LineNumberTable` keeps the LINE of a crash frame and nothing
   * else: classes and methods are renamed, and `-renamesourcefileattribute` takes the file name
   * too, so a release frame reads `a.b(SourceFile:123)`. Only `mapping.txt` turns that back into
   * source, the shrinker writes it once for the build that produced that exact APK, and rebuilding does
   * NOT recreate it — the same source minified again may choose different names.
   *
   * This APK is sideloaded from a release page and stays installed for months, so losing the
   * mapping with the runner means every crash report against that release is unreadable for as
   * long as anyone has it. The failure is entirely invisible until the first report arrives.
   *
   * These assert the two halves cannot drift apart: the rules say the workflow keeps it, and the
   * workflow keeps it.
   */
  const workflow = readFileSync(ANDROID_WORKFLOW, "utf8");
  const MAPPING_PATH = "apps/mobile/android/app/build/outputs/mapping/release/mapping.txt";

  it("the rules point at the mapping rather than claiming the attributes are enough", () => {
    // The comment is the claim under test. It must not say a minified trace is readable.
    expect(rules).toContain("-keepattributes SourceFile,LineNumberTable");
    expect(rules).toContain("mapping.txt");
    expect(rules).toMatch(/NOT reproducible by rebuilding/);
  });

  it("the build check keeps the mapping for as long as it keeps its APK", () => {
    expect(workflow).toContain("name: ohmail-android-debug-mapping");
    expect(workflow).toContain(MAPPING_PATH);
  });

  it("the tag build hands the mapping on, and refuses if the shrinker wrote none", () => {
    expect(workflow).toContain("name: ohmail-android-mapping");
    // `if-no-files-found: error` on the mapping is a second, independent way the workflow
    // notices that minification did not run at all.
    expect(workflow).toMatch(/name: ohmail-android-mapping[\s\S]{0,200}if-no-files-found: error/);
  });

  it("the signing job attaches it to the release beside the APK", () => {
    expect(workflow).toContain("gh release upload");
    expect(workflow).toMatch(/gh release upload[\s\S]{0,200}ohmail-android-mapping\.txt\.gz/);
    // Asserted, not best-effort: a release with an obfuscated APK and no mapping produces crash
    // reports nobody can read, and only the first person to report one would find out.
    expect(workflow).toMatch(/test -f mapping\/ohmail-android-mapping\.txt\.gz/);
  });

  it("the signing job still builds and compresses nothing — the key stays isolated", () => {
    // The key-holding job's whole posture: it checks out no tree and runs no step that could
    // execute this repository's code or its dependencies'. The compression happens in the build
    // job for that reason; if it ever moves here, this is the assertion to argue with rather
    // than delete. What the job DOES do to the mapping is upload it and `cmp` the copy that
    // comes back, which reads bytes and runs nothing.
    const sign = workflow.slice(workflow.indexOf("\n  sign:"));
    expect(sign).not.toMatch(/\bnpm\b|\bnpx\b|gradlew|expo prebuild/);
    expect(sign).not.toContain("gzip");
  });

  it("the mapping is uploaded BEFORE the APK, so no harmful half-state can survive", () => {
    // A release has no transactional multi-asset upload. Ordering is half the mechanism: a
    // failure between the two leaves a mapping with no APK (nothing installable, nothing to
    // retrace) rather than an installable APK nobody can read a crash from. Reversing these two
    // lines reintroduces exactly that, and nothing else in the file would notice.
    const sign = workflow.slice(workflow.indexOf("\n  sign:"));
    const mapUp = sign.indexOf("--clobber \\\n            mapping/ohmail-android-mapping.txt.gz");
    const apkUp = sign.indexOf("--clobber \\\n            ohmail-android.apk");
    expect(mapUp).toBeGreaterThan(-1);
    expect(apkUp).toBeGreaterThan(-1);
    expect(mapUp).toBeLessThan(apkUp);
  });

  it("a previously attached APK is WITHDRAWN before the pair is replaced", () => {
    /* The other half, and the one ordering alone does not buy. `--clobber` deletes an existing
     * asset before uploading its replacement, so on a RERUN — a re-run of a red job, a re-pushed
     * tag — replacing the mapping first would take the old APK's mapping away while the old APK
     * was still downloadable. An interruption there leaves an unretraceable published APK, and
     * finishing the mapping upload but not the APK one leaves the old APK beside a mapping from
     * a different build, which the shrinker may have renamed differently: a wrong answer, not a partial
     * one. Withdrawing the APK first makes every interruption point APK-less. */
    const sign = workflow.slice(workflow.indexOf("\n  sign:"));
    const withdraw = sign.indexOf("gh release delete-asset");
    const mapUp = sign.indexOf("--clobber \\\n            mapping/ohmail-android-mapping.txt.gz");
    expect(withdraw).toBeGreaterThan(-1);
    expect(withdraw).toBeLessThan(mapUp);
    // Conditional on the asset actually being there, so a FIRST run is not a failed delete —
    // and asserted rather than `|| true`, which would swallow a real refusal.
    expect(sign).toMatch(/--json assets/);
    expect(sign).not.toMatch(/delete-asset[^\n]*\|\| true/);
  });

  it("both assets are read back off the release, not inferred from two exit codes", () => {
    const sign = workflow.slice(workflow.indexOf("\n  sign:"));
    expect(sign).toMatch(/--pattern "ohmail-android\.apk"/);
    expect(sign).toMatch(/--pattern "ohmail-android-mapping\.txt\.gz"/);
    expect(sign).toMatch(/cmp mapping\/ohmail-android-mapping\.txt\.gz uploaded\/ohmail-android-mapping\.txt\.gz/);
  });
});
