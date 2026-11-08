import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * WHAT THE BUILT APP ASKS THE SYSTEM FOR, read from Expo's own config pipeline over `app.json`
 * (the plugins it applies by itself included), not from the file's text: expo-image-picker is
 * applied even when it is not listed, and with its defaults it ships a generic photos prompt and
 * Android's RECORD_AUDIO for an app that records nothing.
 */
const APP = fileURLToPath(new URL("..", import.meta.url));
const req = createRequire(`${APP}package.json`);

type Permission = { $: Record<string, string> };
async function resolved() {
  const { getPrebuildConfigAsync } = req("@expo/prebuild-config");
  const { compileModsAsync } = req("expo/config-plugins");
  const { exp } = await getPrebuildConfigAsync(APP, { platforms: ["ios", "android"] });
  const out = await compileModsAsync(exp, {
    projectRoot: APP, introspect: true, platforms: ["ios", "android"], assertMissingModProviders: false,
  });
  const permissions = (out._internal?.modResults?.android?.manifest?.manifest?.["uses-permission"] ?? []) as Permission[];
  return { infoPlist: (out.ios?.infoPlist ?? {}) as Record<string, unknown>, permissions };
}
const locale = (lang: string) =>
  (JSON.parse(readFileSync(`${APP}locales/${lang}.json`, "utf8")) as { ios: Record<string, string> }).ios;

describe("the photo library and the microphone, as the build resolves them", () => {
  it("asks for photos with a sentence of its own, in English and German", async () => {
    const { infoPlist } = await resolved();
    const said = String(infoPlist.NSPhotoLibraryUsageDescription);
    expect(said).not.toContain("$(PRODUCT_NAME)");
    expect(said).toMatch(/attach/);
    expect(locale("en").NSPhotoLibraryUsageDescription).toBe(said);
    expect(locale("de").NSPhotoLibraryUsageDescription).toMatch(/anzuhängen/);
  }, 30_000);

  it("keeps the camera prompt the QR scanner's", async () => {
    const { infoPlist } = await resolved();
    expect(infoPlist.NSCameraUsageDescription).toBe("ohmail uses the camera only to scan a pairing QR code.");
  }, 30_000);

  it("asks for no microphone on either platform, and blocks RECORD_AUDIO from every library", async () => {
    const { infoPlist, permissions } = await resolved();
    expect(infoPlist).not.toHaveProperty("NSMicrophoneUsageDescription");
    const audio = permissions.filter((p) => p.$["android:name"] === "android.permission.RECORD_AUDIO");
    expect(audio.map((p) => p.$["tools:node"])).toEqual(["remove"]);
    /* The camera stays: the pairing scan needs it, and a blocked CAMERA would break it. */
    const camera = permissions.filter((p) => p.$["android:name"] === "android.permission.CAMERA");
    expect(camera.map((p) => p.$["tools:node"] ?? "asked")).toEqual(["asked"]);
  }, 30_000);
});

/**
 * The privacy manifest the build writes (PrivacyInfo.xcprivacy) must name, type for type, what the
 * App Privacy answers declare for the Cloud-paired phone. All linked to the account, none tracking,
 * App Functionality only. Apple compares the two at review.
 */
const COLLECTED = [
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypeName",
  "NSPrivacyCollectedDataTypeEmailsOrTextMessages",
  "NSPrivacyCollectedDataTypePhotosorVideos",
  "NSPrivacyCollectedDataTypeOtherUserContent",
  "NSPrivacyCollectedDataTypeSearchHistory",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypeDeviceID",
  "NSPrivacyCollectedDataTypeOtherDataTypes",
];
async function privacyInfo() {
  const { getPrebuildConfigAsync } = req("@expo/prebuild-config");
  const { IOSConfig } = req("expo/config-plugins");
  const plist = req("@expo/plist").default;
  const { exp } = await getPrebuildConfigAsync(APP, { platforms: ["ios"] });
  const merged = IOSConfig.PrivacyInfo.mergePrivacyInfo({}, exp.ios?.privacyManifests ?? {});
  return plist.parse(plist.build(merged)) as {
    NSPrivacyTracking: boolean;
    NSPrivacyAccessedAPITypes: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }[];
    NSPrivacyCollectedDataTypes: {
      NSPrivacyCollectedDataType: string; NSPrivacyCollectedDataTypeLinked: boolean;
      NSPrivacyCollectedDataTypeTracking: boolean; NSPrivacyCollectedDataTypePurposes: string[];
    }[];
  };
}

describe("the iOS privacy manifest, as the build writes it", () => {
  it("declares the collected data types of the App Privacy answers, linked, not tracking, for app functionality", async () => {
    const info = await privacyInfo();
    const types = info.NSPrivacyCollectedDataTypes;
    expect(types.map((t) => t.NSPrivacyCollectedDataType).sort()).toEqual([...COLLECTED].sort());
    for (const t of types) {
      expect(t.NSPrivacyCollectedDataTypeLinked).toBe(true);
      expect(t.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(t.NSPrivacyCollectedDataTypePurposes).toEqual(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]);
    }
    expect(info.NSPrivacyTracking).toBe(false);
  }, 30_000);

  it("keeps the required-reason API declarations", async () => {
    const info = await privacyInfo();
    const api = info.NSPrivacyAccessedAPITypes;
    expect(api.map((t) => t.NSPrivacyAccessedAPIType).sort()).toEqual([
      "NSPrivacyAccessedAPICategoryDiskSpace",
      "NSPrivacyAccessedAPICategoryFileTimestamp",
      "NSPrivacyAccessedAPICategorySystemBootTime",
      "NSPrivacyAccessedAPICategoryUserDefaults",
    ]);
    for (const t of api) expect(t.NSPrivacyAccessedAPITypeReasons).toHaveLength(1);
  }, 30_000);
});
