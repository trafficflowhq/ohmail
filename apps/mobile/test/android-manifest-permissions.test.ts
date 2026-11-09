import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Android manifest prebuild writes, from app.json and every config plugin, as `expo config
 * --type introspect` computes it. A permission in `android.blockedPermissions` is written as
 * `tools:node="remove"`, which also strips it from the libraries' manifests at the Gradle merge.
 *
 * Storage: expo-image-picker and expo-file-system both declare READ/WRITE_EXTERNAL_STORAGE
 * (maxSdkVersion 32). Nothing here needs them on any Android the app runs on (minSdk 24):
 * photos come from the system photo picker (`launchImageLibraryAsync`, no permission asked),
 * files from the document picker (ACTION_OPEN_DOCUMENT) copied into the app's cache, and a
 * saved attachment leaves through the share sheet from that cache. The camera route that does
 * want WRITE_EXTERNAL_STORAGE below Android 10 (`launchCameraAsync`) is not used.
 */

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(MOBILE, "package.json"));

type Perm = { $: Record<string, string> };

async function introspectedPermissions(): Promise<Perm[]> {
  const { getPrebuildConfigAsync } = req("@expo/prebuild-config") as {
    getPrebuildConfigAsync: (root: string, o: { platforms: string[] }) => Promise<{ exp: Record<string, any> }>;
  };
  const { compileModsAsync } = req("@expo/config-plugins/build/plugins/mod-compiler.js") as {
    compileModsAsync: (exp: Record<string, any>, o: Record<string, unknown>) => Promise<Record<string, any>>;
  };
  const config = await getPrebuildConfigAsync(MOBILE, { platforms: ["android"] });
  const exp = await compileModsAsync(config.exp, {
    projectRoot: MOBILE,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest["uses-permission"] as Perm[];
}

describe("the Android manifest's permissions", () => {
  it("removes the permissions nothing in the app uses, storage included", async () => {
    const perms = await introspectedPermissions();
    const removed = perms.filter((p) => p.$["tools:node"] === "remove").map((p) => p.$["android:name"]);
    const requested = perms.filter((p) => p.$["tools:node"] !== "remove").map((p) => p.$["android:name"]);
    for (const name of [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.RECORD_AUDIO",
    ]) {
      expect(removed, `${name} is not removed`).toContain(name);
      expect(requested, `${name} is still requested`).not.toContain(name);
    }
    /* The ones the app does use stay: the pairing scanner, the organizer's notification. */
    expect(requested).toContain("android.permission.CAMERA");
    expect(requested).toContain("android.permission.POST_NOTIFICATIONS");
  }, 60_000);
});
