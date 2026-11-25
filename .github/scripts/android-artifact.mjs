import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { taggedIdentity } from "../../apps/mobile/scripts/release-identity.mjs";

export function parseApkBadging(text) {
  const packages = text.split(/\r?\n/).filter((line) => line.startsWith("package: "));
  const match = packages.length === 1 &&
    /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'(?: |$)/.exec(packages[0]);
  if (!match) throw new Error("aapt2 did not report one APK package and version.");
  return { package: match[1], versionCode: match[2], versionName: match[3] };
}

export function readAndroidArtifact(file, tool) {
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  switch (extname(file)) {
    case ".apk":
      return parseApkBadging(run(tool, ["dump", "badging", file]));
    case ".aab": {
      const manifest = (attribute) => run("java", [
        "-jar", tool, "dump", "manifest", "--bundle=" + file, "--module=base", "--xpath=/manifest/@" + attribute,
      ]).trim();
      return { package: manifest("package"), versionCode: manifest("android:versionCode"), versionName: manifest("android:versionName") };
    }
    default:
      throw new Error("Use an Android APK or App Bundle.");
  }
}

export function assertAndroidIdentity(artifact, expected) {
  for (const [field, value, label] of [
    ["package", expected.androidPackage, "package"],
    ["versionCode", expected.androidVersionCode, "version code"],
    ["versionName", expected.version, "version name"],
  ]) {
    if (artifact[field] !== value) throw new Error("Android artifact " + label + " does not match the release.");
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, file, tool] = process.argv.slice(2);
    if (!tag || !file || !tool) throw new Error("Use android-artifact.mjs <tag> <apk or aab> <aapt2 or bundletool jar>.");
    console.log(JSON.stringify(assertAndroidIdentity(readAndroidArtifact(file, tool), taggedIdentity("android", tag))));
  } catch (error) {
    console.error(error.status === undefined ? error.message : "Could not parse the Android artifact manifest.");
    process.exitCode = 1;
  }
}
