/**
 * THE CALENDAR OUTSIDE THE APP, PER APP: what `plugins/calendar-native.js` makes of each row of `variants.json`,
 * read from the configuration Expo's own pipeline resolves (as the switch's cases read theirs) and from the Xcode
 * project of the app template the build makes (its own `project.pbxproj`, taken whole from
 * `expo-template-bare-minimum@57.0.9`).
 *
 *  · the calendar's app carries the widget: on the iPhone its shared group (one name per app) in the app's
 *    entitlements and Info.plist, and the widget's extension as a target embedded in the app;
 *  · the mail app carries none of it: its configuration is what it was.
 *
 * Only a simulator shows the extension built and drawn.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);
const APP = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/ios/project.template-57.pbxproj", import.meta.url));
const plugin = req("../plugins/calendar-native.js") as {
  TARGET: string;
  carriesWidget(row: { app: string }): boolean;
  groupOf(row: { id: string }): string;
  addWidgetTarget(project: unknown, row: unknown, at: { version: string; build: string }): unknown;
  writeExtension(iosRoot: string, row: unknown, name: string): string;
};
const VARIANTS = req("../variants.json") as Record<string, { app: string; id: string; name: string }>;

const saved = process.env.OHMAIL_VARIANT;
afterEach(() => {
  if (saved === undefined) delete process.env.OHMAIL_VARIANT;
  else process.env.OHMAIL_VARIANT = saved;
});

type Resolved = {
  manifest: { manifest: Record<string, unknown> };
  infoPlist: Record<string, unknown>;
  entitlements: Record<string, unknown>;
};

/** Expo's own prebuild pipeline over the project, as `expo prebuild` runs it, under `OHMAIL_VARIANT=said`. */
async function prebuilt(said: string | undefined): Promise<Resolved> {
  if (said === undefined) delete process.env.OHMAIL_VARIANT;
  else process.env.OHMAIL_VARIANT = said;
  const { getPrebuildConfigAsync } = req("@expo/prebuild-config");
  const { exp } = await getPrebuildConfigAsync(APP, { platforms: ["ios", "android"] });
  const { compileModsAsync } = req("expo/config-plugins");
  const out = await compileModsAsync(exp, {
    projectRoot: APP, introspect: true, platforms: ["ios", "android"], assertMissingModProviders: false,
  });
  return {
    manifest: out._internal?.modResults?.android?.manifest,
    infoPlist: (out.ios?.infoPlist ?? {}) as Record<string, unknown>,
    entitlements: (out.ios?.entitlements ?? {}) as Record<string, unknown>,
  };
}

const GROUPS = "com.apple.security.application-groups";

describe("which app carries the calendar's widget", () => {
  it("the calendar preview carries widgets, and each calendar app has its own group", () => {
    for (const [variant, row] of Object.entries(VARIANTS)) {
      expect(plugin.carriesWidget(row), variant).toBe(variant === "ohcal-preview");
      if (row.app === "ohcal") expect(plugin.groupOf(row)).toBe(`group.${row.id}`);
    }
  });

  it("on the iPhone: the calendar's app names its group in its entitlements and its Info.plist; the mail app none", async () => {
    const ohcal = await prebuilt("ohcal");
    expect(ohcal.entitlements[GROUPS]).toEqual(["group.app.ohcal"]);
    expect(ohcal.infoPlist.OhcalGroup).toBe("group.app.ohcal");
    const preview = await prebuilt("ohcal-preview");
    expect(preview.entitlements[GROUPS]).toEqual(["group.app.ohcal.preview"]);
    for (const mail of [undefined, "ohmail-preview"]) {
      const app = await prebuilt(mail);
      expect(app.entitlements, String(mail)).not.toHaveProperty(GROUPS);
      expect(app.infoPlist, String(mail)).not.toHaveProperty("OhcalGroup");
    }
  }, 120_000);
});

describe("on Android", () => {
  type Element = { $?: Record<string, string> } & Record<string, unknown>;
  const usesOf = (r: Resolved) => ((r.manifest.manifest["uses-permission"] ?? []) as Element[]).map((e) => e.$!);
  const receiversOf = (r: Resolved) =>
    (((r.manifest.manifest.application as Record<string, Element[]>[])[0]!.receiver ?? []) as Element[])
      .filter((e) => (e.$?.["android:name"] ?? "").startsWith("app.ohmail.calendar."));

  it("both calendar apps declare exact alarms and the preview has four widget receivers", async () => {
    const ohcal = await prebuilt("ohcal");
    expect(usesOf(ohcal)).toEqual(expect.arrayContaining([
      { "android:name": "android.permission.USE_EXACT_ALARM" },
      { "android:name": "android.permission.SCHEDULE_EXACT_ALARM", "android:maxSdkVersion": "32" },
    ]));
    expect(receiversOf(ohcal)).toEqual([]);
    const preview = await prebuilt("ohcal-preview");
    expect(usesOf(preview)).toEqual(expect.arrayContaining([
      { "android:name": "android.permission.USE_EXACT_ALARM" },
      { "android:name": "android.permission.SCHEDULE_EXACT_ALARM", "android:maxSdkVersion": "32" },
    ]));
    const widgets = receiversOf(preview);
    expect(widgets.map((w) => w.$!["android:name"])).toEqual([
      "app.ohmail.calendar.CalendarWidgetNext", "app.ohmail.calendar.CalendarWidgetMonth",
      "app.ohmail.calendar.CalendarWidgetToday", "app.ohmail.calendar.CalendarWidgetWeek",
    ]);
    for (const [i, kind] of ["next", "month", "today", "week"].entries()) {
      // Reached by the system's widget updates alone, described by its own info.
      expect(widgets[i]!["intent-filter"], kind).toEqual([{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }]);
      expect(widgets[i]!["meta-data"], kind).toEqual([{ $: {
        "android:name": "android.appwidget.provider", "android:resource": `@xml/ohcal_widget_${kind}_info`,
      } }]);
    }
    for (const mail of [undefined, "ohmail-preview"]) {
      const app = await prebuilt(mail);
      expect(usesOf(app).map((u) => u["android:name"]), String(mail)).not.toEqual(expect.arrayContaining([expect.stringMatching(/EXACT_ALARM/)]));
      expect(receiversOf(app), String(mail)).toEqual([]);
    }
  }, 120_000);
});

describe("the widget's extension in the Xcode project", () => {
  const xcode = req("xcode") as { project(path: string): { parseSync(): XcodeProject } };
  type XcodeProject = {
    pbxTargetByName(name: string): Record<string, unknown> | null;
    pbxNativeTargetSection(): Record<string, Record<string, unknown>>;
    pbxXCConfigurationList(): Record<string, { buildConfigurations: { value: string }[] }>;
    pbxXCBuildConfigurationSection(): Record<string, { buildSettings: Record<string, string> }>;
    hash: { project: { objects: Record<string, Record<string, Record<string, unknown>>> } };
    writeSync(): string;
  };
  const parsed = () => xcode.project(FIXTURE).parseSync();
  const preview = VARIANTS["ohcal-preview"]!;

  it("is added to the calendar's app as an app extension, embedded in the app, once", () => {
    const project = parsed();
    plugin.addWidgetTarget(project, preview, { version: "1.0.12", build: "122" });
    plugin.addWidgetTarget(project, preview, { version: "1.0.12", build: "122" });
    const targets = Object.entries(project.pbxNativeTargetSection()).filter(([k]) => !k.endsWith("_comment"));
    const widget = targets.filter(([, t]) => t.name === `"${plugin.TARGET}"` || t.name === plugin.TARGET);
    expect(widget).toHaveLength(1);
    expect(widget[0]![1].productType).toBe('"com.apple.product-type.app-extension"');
    // The app's target depends on it and copies its product into the app's plug-ins.
    const app = targets.find(([, t]) => t.name === "HelloWorld")![1];
    expect((app.dependencies as unknown[]).length).toBe(1);
    const copies = project.hash.project.objects.PBXCopyFilesBuildPhase!;
    const embed = Object.entries(copies).filter(([k]) => !k.endsWith("_comment")).map(([, v]) => v);
    expect(embed).toHaveLength(1);
    expect(embed[0]!.dstSubfolderSpec).toBe(13);
    expect((app.buildPhases as { value: string }[]).map((p) => p.value)).toContain(
      Object.keys(copies).find((k) => !k.endsWith("_comment")),
    );
  });

  it("compiles its own source with the three it shares with the module, under the app's version and its own name", () => {
    const project = parsed();
    plugin.addWidgetTarget(project, preview, { version: "1.0.12", build: "122" });
    const text = project.writeSync();
    for (const f of ["OhcalWidget.swift", "CalendarSnapshot.swift", "CalendarStore.swift", "CalendarWords.swift"]) {
      expect(text, f).toContain(`${f} in Sources`);
    }
    const target = (project.pbxTargetByName(plugin.TARGET) ?? project.pbxTargetByName(`"${plugin.TARGET}"`))!;
    const list = project.pbxXCConfigurationList()[target.buildConfigurationList as string]!;
    const settings = list.buildConfigurations.map(({ value }) => project.pbxXCBuildConfigurationSection()[value]!.buildSettings);
    expect(settings).toHaveLength(2);
    for (const s of settings) {
      expect(s).toMatchObject({
        PRODUCT_BUNDLE_IDENTIFIER: '"app.ohcal.preview.widget"', MARKETING_VERSION: '"1.0.12"', CURRENT_PROJECT_VERSION: '"122"',
        CODE_SIGN_ENTITLEMENTS: '"OhcalWidget/OhcalWidget.entitlements"', INFOPLIST_FILE: '"OhcalWidget/OhcalWidget-Info.plist"',
        IPHONEOS_DEPLOYMENT_TARGET: "16.4", APPLICATION_EXTENSION_API_ONLY: "YES",
      });
      // No team, no profile: signing is the release's own step.
      expect(s).not.toHaveProperty("DEVELOPMENT_TEAM");
      expect(s).not.toHaveProperty("PROVISIONING_PROFILE_SPECIFIER");
    }
  });

  it("is absent from both store apps", () => {
    const project = parsed();
    const before = project.writeSync();
    plugin.addWidgetTarget(project, VARIANTS.ohcal!, { version: "1.0.0", build: "1" });
    plugin.addWidgetTarget(project, VARIANTS.ohmail!, { version: "1.0.12", build: "122" });
    expect(project.writeSync()).toBe(before);
  });

  it("brings its files at prebuild: its source, the three shared ones as the module has them, its plist and entitlements", () => {
    const root = mkdtempSync(join(tmpdir(), "ohcal-widget-"));
    try {
      const dir = plugin.writeExtension(root, preview, "ohcal");
      expect(readdirSync(dir).sort()).toEqual([
        "CalendarSnapshot.swift", "CalendarStore.swift", "CalendarWords.swift", "OhcalWidget-Info.plist",
        "OhcalWidget.entitlements", "OhcalWidget.swift",
      ]);
      for (const f of ["CalendarSnapshot.swift", "CalendarStore.swift", "CalendarWords.swift"]) {
        expect(readFileSync(join(dir, f), "utf8"), f).toBe(readFileSync(join(APP, "modules/ohmail-calendar/ios", f), "utf8"));
      }
      const info = readFileSync(join(dir, "OhcalWidget-Info.plist"), "utf8");
      expect(info).toContain("<string>com.apple.widgetkit-extension</string>");
      expect(info).toContain("<key>OhcalGroup</key><string>group.app.ohcal.preview</string>");
      expect(readFileSync(join(dir, "OhcalWidget.entitlements"), "utf8")).toContain("<string>group.app.ohcal.preview</string>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
