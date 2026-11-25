// The tagged build reads the same dynamic configuration as prebuild, without needing npm installed.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const appJson = new URL("../app.json", import.meta.url);
const config = require("../app.config.js");

export function releaseApp(app) {
  if (app !== "ohmail" && app !== "ohcal") throw new Error("Use the ohmail or ohcal release app.");
  return app;
}

export function releaseIdentity(app) {
  releaseApp(app);
  const previous = process.env.OHMAIL_VARIANT;
  process.env.OHMAIL_VARIANT = app;
  let resolved;
  try {
    resolved = config({ config: require("../app.json").expo });
  } finally {
    if (previous === undefined) delete process.env.OHMAIL_VARIANT;
    else process.env.OHMAIL_VARIANT = previous;
  }
  const identity = {
    app,
    version: resolved.version,
    androidPackage: resolved.android?.package,
    androidVersionCode: String(resolved.android?.versionCode),
    iosBundleId: resolved.ios?.bundleIdentifier,
    iosBuildNumber: resolved.ios?.buildNumber,
    iosScheme: resolved.name,
    iosWorkspace: resolved.name + ".xcworkspace",
  };
  if (identity.androidPackage !== "app." + app || identity.iosBundleId !== "app." + app ||
      identity.iosScheme !== app || !/^\d+\.\d+\.\d+$/.test(identity.version) ||
      !/^[1-9]\d*$/.test(identity.androidVersionCode) || !/^[1-9]\d*$/.test(identity.iosBuildNumber)) {
    throw new Error("Invalid Expo release identity for " + app);
  }
  return identity;
}

export function taggedIdentity(platform, tag) {
  const app = tag.startsWith("ohcal-") ? "ohcal" : "ohmail";
  const identity = releaseIdentity(app);
  const prefix = platform === "android" ? "android-v" : platform === "ios" ? "v" : null;
  if (!prefix) throw new Error("Use the android or ios release platform.");
  const stem = (app === "ohcal" ? "ohcal-" + platform + "-v" : prefix) + identity.version;
  const matches = app === "ohmail" && platform === "android" ? tag.startsWith(stem) : tag === stem;
  if (!matches) {
    throw new Error("Release tag " + tag + " does not match " + stem + " for " + app);
  }
  return identity;
}

function overrideIosBuild(build) {
  if (!/^[1-9]\d{0,5}$/.test(build)) throw new Error("Use a positive iOS build number of up to six digits.");
  const document = require("../app.json");
  document.expo.ios.buildNumber = build;
  writeFileSync(appJson, JSON.stringify(document, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, value, build, ...extra] = process.argv.slice(2);
    if (!value || extra.length || (build && command !== "ios-tag")) {
      throw new Error("Use android-tag <tag>, ios-tag <tag> [build], or app <app>.");
    }
    let identity;
    if (command === "app") identity = releaseIdentity(value);
    else if (command === "android-tag") identity = taggedIdentity("android", value);
    else if (command === "ios-tag") {
      identity = taggedIdentity("ios", value);
      if (build && build !== identity.iosBuildNumber) {
        if (identity.app === "ohcal") {
          throw new Error("The calendar release must use the shared iOS build number from app.json.");
        }
        overrideIosBuild(build);
        identity = releaseIdentity("ohmail");
      }
    } else throw new Error("Unknown release identity command.");
    console.log(JSON.stringify(identity));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
