const { createRunOncePlugin, withAppBuildGradle, withPodfile, withSettingsGradle } = require("expo/config-plugins");
const { variantOfAppId } = require("../variant-config");

/**
 * WHAT AN APP LEAVES OUT OF ITS NATIVE BUILD, AND ONE BUILD FOR ONE APP.
 *
 * A row of `variants.json` names the native modules its app does not carry (the calendar app has no mail push and
 * organizes no mailbox, so neither the push connector nor the organizer's service is in it). Autolinking would link
 * every module the tree holds, with their manifests, so this writes the row's list into the native project where
 * autolinking reads it: `expoAutolinking.exclude` before `useExpoModules()` in `settings.gradle`, and
 * `use_expo_modules!(exclude: …)` in the Podfile. An empty list changes nothing. A missing anchor line is a build
 * error: a template that moved must not quietly link what the app should not carry.
 *
 * The native project is made for the app whose identifier the resolved configuration names. One line in the app's
 * `build.gradle` refuses a Gradle run asked for another app (`OHMAIL_VARIANT`, unset read as ohmail), so a project
 * made for one app is never built under the other's name.
 */
const SETTINGS_ANCHOR = "expoAutolinking.useExpoModules()";
const PODFILE_ANCHOR = /^(\s*)use_expo_modules!\s*$/m;
const BUILD_ANCHOR = 'apply plugin: "com.facebook.react"';
const MARK = "variant-modules";

/** The row the resolved identifier names; an identifier outside the table is a build error. */
function rowOf(id) {
  const found = variantOfAppId(id);
  if (found === null) throw new Error(`variant-modules: the app's identifier "${id}" is in no row of variants.json`);
  return found;
}

const groovyList = (names) => `[${names.map((n) => JSON.stringify(n)).join(", ")}]`;
const rubyList = (names) => `[${names.map((n) => `'${n}'`).join(", ")}]`;

/** `settings.gradle` with the row's exclusions before the modules are linked. */
function excludeInSettings(contents, modules) {
  if (modules.length === 0) return contents;
  if (contents.includes(`// ${MARK}`)) return contents;
  if (!contents.includes(SETTINGS_ANCHOR)) {
    throw new Error(`variant-modules: settings.gradle has no "${SETTINGS_ANCHOR}" line to exclude modules before`);
  }
  return contents.replace(
    SETTINGS_ANCHOR,
    `expoAutolinking.exclude = ${groovyList(modules)} // ${MARK}\n${SETTINGS_ANCHOR}`,
  );
}

/** The Podfile with the row's exclusions handed to the modules' linking. */
function excludeInPodfile(contents, modules) {
  if (modules.length === 0) return contents;
  if (contents.includes(`# ${MARK}`)) return contents;
  if (!PODFILE_ANCHOR.test(contents)) {
    throw new Error("variant-modules: the Podfile has no bare `use_expo_modules!` line to hand the exclusions to");
  }
  return contents.replace(PODFILE_ANCHOR, `$1use_expo_modules!(exclude: ${rubyList(modules)}) # ${MARK}`);
}

/** The app's `build.gradle` with the line that refuses a Gradle run for another app than the one it was made for. */
function guardBuild(contents, variant) {
  if (contents.includes(`// ${MARK}`)) return contents;
  if (!contents.includes(BUILD_ANCHOR)) {
    throw new Error(`variant-modules: build.gradle has no '${BUILD_ANCHOR}' line to put the variant's guard after`);
  }
  const line = `if ((System.getenv("OHMAIL_VARIANT") ?: "ohmail") != "${variant}") throw new GradleException(`
    + `"This native project was made for ${variant}: build it with OHMAIL_VARIANT=${variant}, or make it again.") // ${MARK}`;
  return contents.replace(BUILD_ANCHOR, `${BUILD_ANCHOR}\n${line}`);
}

function withVariantModules(config) {
  config = withSettingsGradle(config, (c) => {
    const { row } = rowOf(c.android?.package);
    c.modResults.contents = excludeInSettings(c.modResults.contents, row.without.modules);
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    const { variant } = rowOf(c.android?.package);
    c.modResults.contents = guardBuild(c.modResults.contents, variant);
    return c;
  });
  return withPodfile(config, (c) => {
    const { row } = rowOf(c.ios?.bundleIdentifier);
    c.modResults.contents = excludeInPodfile(c.modResults.contents, row.without.modules);
    return c;
  });
}

module.exports = createRunOncePlugin(withVariantModules, "variant-modules", "1.0.0");
module.exports.excludeInSettings = excludeInSettings;
module.exports.excludeInPodfile = excludeInPodfile;
module.exports.guardBuild = guardBuild;
