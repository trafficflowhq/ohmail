/**
 * THE APP'S CONFIGURATION AS A FUNCTION OF THE VARIANT, as Expo resolves it. ohmail's is today's `app.json`, untouched;
 * ohcal's carries its own name, scheme, identifier, look and sentences and leaves out what only mail needs; the
 * version and the build numbers are one across every app; a word outside the table is a build error. The resolved
 * manifest, Info.plist and entitlements are read from Expo's own pipeline, and ohmail's are the same with and
 * without the plugins the variants add.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL("..", import.meta.url));
const req = createRequire(`${APP}package.json`);
const { resolveVariant, variantIdOf, VARIANTS } = req("./variant-config.js") as {
  resolveVariant: (base: Expo, said: string | undefined) => Expo;
  variantIdOf: (said: unknown) => string;
  VARIANTS: Record<string, { id: string; name: string; scheme: string; app: string }>;
};
const modules = req("./plugins/variant-modules.js") as {
  excludeInSettings: (contents: string, modules: string[]) => string;
  excludeInPodfile: (contents: string, modules: string[]) => string;
  guardBuild: (contents: string, variant: string) => string;
};

type Plugin = string | [string, Record<string, unknown>];
type Expo = {
  name: string; slug: string; scheme: string; version: string; icon: string; plugins: Plugin[];
  ios: { bundleIdentifier: string; buildNumber: string; icon: string };
  android: { package: string; versionCode: number; adaptiveIcon: Record<string, string> };
  locales: Record<string, string>;
};
const appJson = () => (JSON.parse(readFileSync(`${APP}app.json`, "utf8")) as { expo: Expo }).expo;
const nameOf = (p: Plugin) => (Array.isArray(p) ? p[0] : p);
const optionsOf = (exp: Expo, name: string) =>
  (exp.plugins.find((p) => nameOf(p) === name) as [string, Record<string, unknown>] | undefined)?.[1];

/** The variant plugins: what the configuration adds for the two apps, read away in the "without" arm. */
const VARIANT_PLUGINS = ["./plugins/variant-modules", "./plugins/app-switch"];

type Element = { $?: Record<string, string>; package?: Element[] } & Record<string, unknown>;
type Manifest = { manifest: Record<string, Element[] | Record<string, string>> & { $: Record<string, string> } };

/** The switch's provider class, in the switch module's own package. */
const PROVIDER = "app.ohmail.appswitch.SwitchProvider";

/**
 * The manifest with the switch's own lines taken out: its permission and the use of it, the `<queries>` entry that
 * names the sibling and the store's app, the line naming the sibling, the guarded alias and the provider. Exactly
 * what the switch adds, so what is left must be the manifest without it.
 */
function withoutSwitch(resolved: Manifest, permission: string): Manifest {
  const out = structuredClone(resolved);
  const root = out.manifest as unknown as Record<string, Element[] | undefined>;
  const drop = (key: string, keep: (e: Element) => boolean) => {
    const kept = (root[key] ?? []).filter(keep);
    if (kept.length > 0) root[key] = kept;
    else delete root[key];
  };
  const name = (e: Element) => e.$?.["android:name"];
  drop("permission", (e) => name(e) !== permission);
  drop("uses-permission", (e) => name(e) !== permission);
  drop("queries", (q) => !(q.package ?? []).some((pkg) => ["app.ohcal", "app.ohmail", "com.android.vending"].includes(name(pkg)!)));
  const app = (root.application as Element[])[0]! as Record<string, Element[] | undefined>;
  app["meta-data"] = (app["meta-data"] ?? []).filter((m) => name(m) !== "switch.sibling");
  const aliases = (app["activity-alias"] ?? []).filter((a) => name(a) !== ".SwitchOpen");
  if (aliases.length > 0) app["activity-alias"] = aliases;
  else delete app["activity-alias"];
  const providers = (app.provider ?? []).filter((p) => name(p) !== PROVIDER);
  if (providers.length > 0) app.provider = providers;
  else delete app.provider;
  return out;
}

const saved = process.env.OHMAIL_VARIANT;
afterEach(() => {
  if (saved === undefined) delete process.env.OHMAIL_VARIANT;
  else process.env.OHMAIL_VARIANT = saved;
});

type Resolved = {
  exp: Expo;
  manifest: { manifest: { $: Record<string, string>; application?: { "meta-data"?: { $: Record<string, string> }[] }[] } };
  infoPlist: Record<string, unknown>;
  entitlements: Record<string, unknown>;
};

/** Expo's own prebuild pipeline over the project, as `expo prebuild` runs it, under `OHMAIL_VARIANT=said`. */
async function prebuilt(said: string | undefined): Promise<Resolved> {
  if (said === undefined) delete process.env.OHMAIL_VARIANT;
  else process.env.OHMAIL_VARIANT = said;
  const { getPrebuildConfigAsync } = req("@expo/prebuild-config");
  const { exp } = await getPrebuildConfigAsync(APP, { platforms: ["ios", "android"] });
  return introspect(exp);
}

/** The same pipeline over a configuration given whole: `drop` leaves plugins out of the list before they apply. */
async function prebuiltFrom(base: Expo, drop: readonly string[]): Promise<Resolved> {
  const { withConfigPlugins } = req("@expo/config/build/plugins/withConfigPlugins");
  const defaults = req("@expo/prebuild-config/build/plugins/withDefaultPlugins");
  const { getAutolinkedPackagesAsync } = req("@expo/prebuild-config/build/getAutolinkedPackages");
  let exp = { ...structuredClone(base), plugins: base.plugins.filter((p) => !drop.includes(nameOf(p))) } as Record<string, unknown>;
  exp._internal = { projectRoot: APP, autolinkedModules: await getAutolinkedPackagesAsync(APP, ["ios", "android"]) };
  exp = withConfigPlugins(exp, false);
  exp = defaults.withVersionedExpoSDKPlugins(exp);
  exp = defaults.withLegacyExpoPlugins(exp);
  exp = defaults.withIosExpoPlugins(exp, { bundleIdentifier: base.ios.bundleIdentifier });
  exp = defaults.withAndroidExpoPlugins(exp, { package: base.android.package, projectRoot: APP });
  return introspect(exp as unknown as Expo);
}

async function introspect(exp: Expo): Promise<Resolved> {
  const { compileModsAsync } = req("expo/config-plugins");
  const out = await compileModsAsync(exp, {
    projectRoot: APP, introspect: true, platforms: ["ios", "android"], assertMissingModProviders: false,
  });
  return {
    exp,
    manifest: out._internal?.modResults?.android?.manifest,
    infoPlist: (out.ios?.infoPlist ?? {}) as Record<string, unknown>,
    entitlements: (out.ios?.entitlements ?? {}) as Record<string, unknown>,
  };
}

const metaNames = (r: Resolved) =>
  (r.manifest.manifest.application?.[0]?.["meta-data"] ?? []).map((m) => m.$["android:name"]);
const schemesOf = (r: Resolved) =>
  ((r.infoPlist.CFBundleURLTypes ?? []) as { CFBundleURLSchemes: string[] }[]).flatMap((t) => t.CFBundleURLSchemes);

describe("the variant a build is asked for", () => {
  it("is ohmail when unset, empty or named, a row of the table when named, and a build error otherwise", () => {
    for (const said of [undefined, null, "", "ohmail"]) expect(variantIdOf(said)).toBe("ohmail");
    for (const said of ["ohcal", "ohmail-preview", "ohcal-preview"]) expect(variantIdOf(said)).toBe(said);
    for (const said of ["OHCAL", "ohcal ", "calendar", "app.ohcal", "screens", "toString", 1]) {
      expect(() => variantIdOf(said), String(said)).toThrow(/OHMAIL_VARIANT/);
    }
  });
});

describe("the configuration as a function of the variant", () => {
  it("hands ohmail back exactly as app.json states it", () => {
    const base = appJson();
    expect(resolveVariant(base, undefined)).toBe(base);
    expect(resolveVariant(base, "ohmail")).toBe(base);
    expect(resolveVariant(base, "")).toEqual(appJson());
  });

  it("makes the calendar's app with its own names, look and sentences, and leaves out what only mail needs", () => {
    const base = appJson();
    const ohcal = resolveVariant(base, "ohcal");
    expect([ohcal.name, ohcal.scheme, ohcal.ios.bundleIdentifier, ohcal.android.package]).toEqual(["ohcal", "ohcal", "app.ohcal", "app.ohcal"]);
    expect(ohcal.icon).toBe("./assets/ohcal/icon-ios.png");
    expect(ohcal.android.adaptiveIcon.foregroundImage).toBe("./assets/ohcal/android-icon-foreground.png");
    expect(ohcal.locales).toEqual({ en: "./locales/ohcal.en.json", de: "./locales/ohcal.de.json" });
    const names = ohcal.plugins.map(nameOf);
    expect(names).not.toContain("expo-unified-push");
    expect(names).not.toContain("./plugins/wake-push-renderer");
    expect(names).toEqual(base.plugins.map(nameOf).filter((n) => n !== "expo-unified-push" && n !== "./plugins/wake-push-renderer"));
    expect(optionsOf(ohcal, "expo-camera")?.cameraPermission).toBe("ohcal uses the camera only to scan a pairing QR code.");
    expect(optionsOf(ohcal, "expo-image-picker")).toMatchObject({ photosPermission: false });
    expect(optionsOf(ohcal, "expo-splash-screen")).not.toHaveProperty("dark");
    // The base is never written to: ohmail's own configuration stays as it was read.
    expect(base).toEqual(appJson());
  });

  it("gives every app one version and one build number", () => {
    const base = appJson();
    for (const variant of Object.keys(VARIANTS)) {
      const exp = resolveVariant(base, variant);
      expect([exp.version, exp.ios.buildNumber, exp.android.versionCode], variant)
        .toEqual([base.version, base.ios.buildNumber, base.android.versionCode]);
      expect([exp.name, exp.android.package], variant).toEqual([VARIANTS[variant]!.name, VARIANTS[variant]!.id]);
    }
  });

  it("keeps the preview of ohmail a whole mail app under its own names", () => {
    const preview = resolveVariant(appJson(), "ohmail-preview");
    expect([preview.name, preview.scheme, preview.android.package]).toEqual(["ohmail preview", "ohmail-preview", "app.ohmail.preview"]);
    expect(preview.plugins.map(nameOf)).toEqual(appJson().plugins.map(nameOf));
  });
});

describe("the resolved native configuration, through Expo's own pipeline", () => {
  it("is today's for ohmail plus exactly the switch's lines, and no entitlement", async () => {
    const withThem = await prebuilt(undefined);
    expect(withThem.exp.android.package).toBe("app.ohmail");
    expect(schemesOf(withThem)).toContain("ohmail");
    const without = await prebuiltFrom(appJson(), VARIANT_PLUGINS);
    expect(withoutSwitch(withThem.manifest as unknown as Manifest, "app.ohmail.permission.SWITCH"))
      .toEqual(without.manifest);
    const { OhmailSwitch, ...plist } = withThem.infoPlist;
    expect(plist).toEqual(without.infoPlist);
    expect(OhmailSwitch).toEqual({ ownHost: "ohmail.app", ownPath: "/switch", siblingHost: "ohcal.app", siblingPath: "/switch" });
    expect(withThem.entitlements).toEqual(without.entitlements);
    expect(withThem.entitlements).not.toHaveProperty("com.apple.developer.associated-domains");
  }, 60_000);

  it("guards the switch's door by the pair's signature permission, and names only the sibling and the store", async () => {
    const ohcal = await prebuilt("ohcal");
    const root = ohcal.manifest.manifest as unknown as Record<string, Element[]>;
    const named = (list: Element[] | undefined) => (list ?? []).map((e) => e.$?.["android:name"]);
    expect(root.permission?.find((e) => e.$?.["android:name"] === "app.ohmail.permission.SWITCH")?.$)
      .toEqual({ "android:name": "app.ohmail.permission.SWITCH", "android:protectionLevel": "signature" });
    expect(named(root["uses-permission"])).toContain("app.ohmail.permission.SWITCH");
    expect(root.queries?.flatMap((q) => named(q.package))).toEqual(expect.arrayContaining(["app.ohmail", "com.android.vending"]));
    expect(root.queries?.flatMap((q) => named(q.package))).not.toContain("app.ohcal");
    const app = (root.application as unknown as Record<string, Element[]>[])[0]!;
    const alias = app["activity-alias"]?.find((a) => a.$?.["android:name"] === ".SwitchOpen");
    // Exported for the call that names it, guarded, and reached by nothing else: no intent filter.
    expect(alias).toEqual({ $: {
      "android:name": ".SwitchOpen", "android:targetActivity": ".MainActivity", "android:exported": "true",
      "android:permission": "app.ohmail.permission.SWITCH",
    } });
    expect(app["meta-data"]?.find((m) => m.$?.["android:name"] === "switch.sibling")?.$?.["android:value"]).toBe("app.ohmail");
    const preview = await prebuilt("ohcal-preview");
    expect(named((preview.manifest.manifest as unknown as Record<string, Element[]>).permission))
      .toContain("app.ohmail.preview.permission.SWITCH");
    expect(JSON.stringify(preview.manifest)).not.toContain("app.ohmail.permission.SWITCH");
  }, 60_000);

  it("answers the sibling's one question at the row's authority: a provider exported under the pair's permission", async () => {
    const providerOf = (r: Resolved) => ((r.manifest.manifest as unknown as Record<string, Record<string, Element[]>[]>)
      .application![0]!.provider ?? []).filter((p) => p.$?.["android:name"] === PROVIDER);
    for (const [variant, authority, permission] of [
      [undefined, "app.ohmail.switch", "app.ohmail.permission.SWITCH"],
      ["ohcal", "app.ohcal.switch", "app.ohmail.permission.SWITCH"],
      ["ohcal-preview", "app.ohcal.preview.switch", "app.ohmail.preview.permission.SWITCH"],
    ] as const) {
      // One provider, at the authority the row names, and nothing a link or a stranger's grant could reach it by.
      expect(providerOf(await prebuilt(variant)), String(variant)).toEqual([{ $: {
        "android:name": PROVIDER, "android:authorities": authority, "android:exported": "true", "android:permission": permission,
      } }]);
    }
    for (const row of Object.values(VARIANTS) as unknown as { id: string; authority: string }[]) {
      expect(row.authority, row.id).toBe(`${row.id}.switch`);
    }
  }, 60_000);

  it("declares the associated domain only where the simulator rig asks for it", async () => {
    process.env.OHMAIL_IOS_ASSOCIATED = "1";
    try {
      const ohcal = await prebuilt("ohcal");
      expect(ohcal.entitlements["com.apple.developer.associated-domains"]).toEqual(["applinks:ohcal.app"]);
    } finally {
      delete process.env.OHMAIL_IOS_ASSOCIATED;
    }
    expect((await prebuilt("ohcal")).entitlements).not.toHaveProperty("com.apple.developer.associated-domains");
  }, 60_000);

  it("is the calendar's under OHMAIL_VARIANT=ohcal: its scheme and sentences, no photo purpose and no push", async () => {
    const ohcal = await prebuilt("ohcal");
    expect(ohcal.exp.android.package).toBe("app.ohcal");
    expect(ohcal.exp.ios.bundleIdentifier).toBe("app.ohcal");
    expect(schemesOf(ohcal)).toContain("ohcal");
    expect(schemesOf(ohcal)).not.toContain("ohmail");
    expect(ohcal.infoPlist.NSCameraUsageDescription).toBe("ohcal uses the camera only to scan a pairing QR code.");
    expect(ohcal.infoPlist).not.toHaveProperty("NSPhotoLibraryUsageDescription");
    expect(metaNames(ohcal).some((n) => /unifiedpush/i.test(n))).toBe(false);
    expect(metaNames(await prebuilt(undefined)).some((n) => /unifiedpush/i.test(n))).toBe(true);
  }, 60_000);

  it("refuses a build asked for an app the table does not know", async () => {
    await expect(prebuilt("ohcalendar")).rejects.toThrow(/OHMAIL_VARIANT is "ohcalendar"/);
  }, 60_000);
});

describe("what an app leaves out of its native build", () => {
  const SETTINGS = "plugins {\n  id(\"expo-autolinking-settings\")\n}\nexpoAutolinking.useExpoModules()\n\nrootProject.name = 'x'\n";
  const PODFILE = "target 'x' do\n  use_expo_modules!\n\n  config = use_native_modules!(config_command)\nend\n";
  const BUILD = 'apply plugin: "com.android.application"\napply plugin: "com.facebook.react"\n\nreact {\n}\n';

  it("excludes the row's modules where autolinking reads them, before they are linked", () => {
    const settings = modules.excludeInSettings(SETTINGS, ["organizer-service", "expo-unified-push"]);
    const at = settings.indexOf('expoAutolinking.exclude = ["organizer-service", "expo-unified-push"]');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(settings.indexOf("expoAutolinking.useExpoModules()"));
    expect(modules.excludeInSettings(settings, ["organizer-service"])).toBe(settings);
    expect(modules.excludeInPodfile(PODFILE, ["organizer-service"])).toContain("  use_expo_modules!(exclude: ['organizer-service'])");
  });

  it("changes nothing for an app that leaves nothing out, and refuses a template without its anchor", () => {
    expect(modules.excludeInSettings(SETTINGS, [])).toBe(SETTINGS);
    expect(modules.excludeInPodfile(PODFILE, [])).toBe(PODFILE);
    expect(() => modules.excludeInSettings("rootProject.name = 'x'\n", ["a"])).toThrow(/useExpoModules/);
    expect(() => modules.excludeInPodfile("target 'x' do\nend\n", ["a"])).toThrow(/use_expo_modules!/);
  });

  it("refuses a Gradle run asked for another app than the one the project was made for", () => {
    const build = modules.guardBuild(BUILD, "ohcal");
    const line = build.split("\n").find((l) => l.includes("OHMAIL_VARIANT"));
    expect(line).toContain('(System.getenv("OHMAIL_VARIANT") ?: "ohmail") != "ohcal"');
    expect(line).toContain("throw new GradleException");
    expect(build.indexOf(line!)).toBeGreaterThan(build.indexOf('apply plugin: "com.facebook.react"'));
    expect(modules.guardBuild(build, "ohcal")).toBe(build);
    expect(() => modules.guardBuild("android {\n}\n", "ohmail")).toThrow(/com\.facebook\.react/);
  });
});

describe("the built APK held to its row", () => {
  type Judge = (bytes: Buffer, variant: string, opts?: { withSwitch?: boolean }) => [boolean, string][];
  const load = async () => (await import("../scripts/assert-variant.mjs")) as unknown as {
    judgeManifest: Judge; ORGANIZER_AND_PUSH: string[];
  };
  // A binary manifest's string pool, as either encoding the format allows.
  const pool = (strings: string[], encoding: "utf8" | "utf16le") => Buffer.concat(strings.map((s) => Buffer.from(`\0${s}\0`, encoding)));
  const failures = (checks: [boolean, string][]) => checks.filter(([ok]) => !ok).map(([, line]) => line);

  it("passes the calendar's APK that carries neither the organizer nor the push connector", async () => {
    const { judgeManifest } = await load();
    for (const encoding of ["utf8", "utf16le"] as const) {
      expect(failures(judgeManifest(pool(["app.ohcal"], encoding), "ohcal", { withSwitch: false })), encoding).toEqual([]);
    }
  });

  it("fails the calendar's APK that carries either, or another app's package", async () => {
    const { judgeManifest, ORGANIZER_AND_PUSH } = await load();
    for (const name of ORGANIZER_AND_PUSH) {
      expect(failures(judgeManifest(pool(["app.ohcal", name], "utf16le"), "ohcal", { withSwitch: false }))).toEqual([`no ${name}`]);
    }
    expect(failures(judgeManifest(pool(["app.ohmail"], "utf8"), "ohcal", { withSwitch: false }))).toEqual(["package app.ohcal"]);
    // The mail app may carry both: it organizes and wakes by push.
    expect(failures(judgeManifest(pool(["app.ohmail", ...ORGANIZER_AND_PUSH], "utf8"), "ohmail", { withSwitch: false }))).toEqual([]);
  });

  it("finds the switch's door, its permission, the sibling and the provider at the row's authority, or names what is missing", async () => {
    const { judgeManifest } = await load();
    const whole = ["app.ohcal", "app.ohmail.permission.SWITCH", ".SwitchOpen", "app.ohmail", PROVIDER, "app.ohcal.switch"];
    expect(failures(judgeManifest(pool(whole, "utf16le"), "ohcal"))).toEqual([]);
    expect(failures(judgeManifest(pool(whole.filter((s) => s !== PROVIDER), "utf16le"), "ohcal")))
      .toEqual([`the switch's provider ${PROVIDER}`]);
    expect(failures(judgeManifest(pool(whole.filter((s) => s !== "app.ohcal.switch"), "utf8"), "ohcal")))
      .toEqual(["the provider's authority app.ohcal.switch"]);
  });
});
