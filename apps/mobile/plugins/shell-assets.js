const {
  withAndroidManifest, withDangerousMod, withXcodeProject, createRunOncePlugin, AndroidConfig,
} = require("expo/config-plugins");
const path = require("node:path");
const fs = require("node:fs");

/**
 * THE SHELL'S PAGE GOES INTO THE APP, OR THE APP IS NOT BUILT.
 *
 * `scripts/build-shell.mjs` writes the page into `generated/shell/` with a manifest that lists every
 * file and states the page's policy. This plugin copies that folder into the Android app's assets
 * (`assets/shell/`, which the shell module's asset door serves) and into the iOS bundle (a folder
 * named `shell`, which its scheme door serves). With no manifest it refuses the build in a sentence
 * that names the generator: an app whose shell has no page would show nothing, and a page from a
 * forgotten earlier build would show the wrong one.
 *
 * It also writes the web view's two lines into the app's own manifest, where the build can be read
 * for them: no metrics about the web view's use to its maker, and no Safe Browsing look-ups (the
 * shell loads nothing from the network, so no address of it may leave the phone).
 */
const MANIFEST = "shell.manifest.json";

/**
 * The page the app is built with. A page built with the emulator bench's door (`--bench`) is refused unless this
 * build says it is the bench's (`OHMAIL_SHELL_BENCH=1`), so no other build ever carries it.
 */
function generated(projectRoot, env = process.env) {
  const dir = path.join(projectRoot, "generated", "shell");
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) {
    throw new Error(
      `shell-assets: ${path.join("generated", "shell", MANIFEST)} is missing. ` +
        "Run `node apps/mobile/scripts/build-shell.mjs` before the native build; it writes the shell's page.",
    );
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.bench !== false && env.OHMAIL_SHELL_BENCH !== "1") {
    throw new Error(
      "shell-assets: the shell's page was built for the emulator bench (`--bench`). " +
        "Run `node apps/mobile/scripts/build-shell.mjs` without it, or set OHMAIL_SHELL_BENCH=1 for a bench build.",
    );
  }
  return dir;
}

function copyInto(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

const WEB_VIEW_LINES = [
  ["android.webkit.WebView.MetricsOptOut", "true"],
  ["android.webkit.WebView.EnableSafeBrowsing", "false"],
];

function withShellAndroid(config) {
  config = withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    for (const [name, value] of WEB_VIEW_LINES) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, name, value);
    }
    return c;
  });
  return withDangerousMod(config, [
    "android",
    (c) => {
      const from = generated(c.modRequest.projectRoot);
      copyInto(from, path.join(c.modRequest.platformProjectRoot, "app", "src", "main", "assets", "shell"));
      return c;
    },
  ]);
}

function withShellIos(config) {
  config = withDangerousMod(config, [
    "ios",
    (c) => {
      const from = generated(c.modRequest.projectRoot);
      copyInto(from, path.join(c.modRequest.platformProjectRoot, c.modRequest.projectName, "shell"));
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    const group = project.findPBXGroupKey({ name: c.modRequest.projectName });
    const folder = `${c.modRequest.projectName}/shell`;
    if (!project.hasFile(folder)) {
      project.addResourceFile(folder, { lastKnownFileType: "folder" }, group);
    }
    return c;
  });
}

const withShellAssets = (config) => withShellIos(withShellAndroid(config));

module.exports = createRunOncePlugin(withShellAssets, "shell-assets", "1.0.0");
module.exports.WEB_VIEW_LINES = WEB_VIEW_LINES;
module.exports.shellPageOf = generated;
