const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig, createRunOncePlugin, withAndroidManifest, withDangerousMod, withEntitlementsPlist, withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");
const { variantOfAppId } = require("../variant-config");

/**
 * THE CALENDAR OUTSIDE THE APP, AS EACH APP DECLARES IT. Read from the app's own row of `variants.json`, found by the
 * identifier the resolved configuration names; which app carries what is the architecture's (OHCAL 5.1 to 5.3): the
 * widget belongs to the calendar's app alone.
 *
 * iPhone, the calendar's app: the shared group (one name, `group.` and the app's identifier: a working name until the
 * group is registered, which is the release's signing step and not this build's) in the app's entitlements and in its
 * Info.plist (`OhcalGroup`, which the module's store reads); and the widget's extension, `OhcalWidget`, as a target of
 * the Xcode project by the installed config plugins' own `xcode` (no dependency is added): its sources (the
 * extension's own and the three files it shares with the module, copied at prebuild), its Info.plist (the widget
 * extension point, the group's name), its entitlements (the group), its identifier (the app's, `.widget`), its version
 * the app's, and embedded in the app. No identifier, profile or signing file is made here. The mail app gets none of it.
 *
 * Android, the calendar's app: the exact alarm a calendar app that shows notifications for upcoming events may declare
 * (`USE_EXACT_ALARM`, from Android 13, granted at install, a store declaration; `SCHEDULE_EXACT_ALARM` up to Android
 * 12L, where it stands for the same), and its four widgets as receivers of the system's widget updates, each with its
 * widget's description. The mail app declares neither: its alerts ring by the plain alarm, and it has no widget.
 */
const TARGET = "OhcalWidget";
const MODULE = path.join(__dirname, "../modules/ohmail-calendar");
/** The extension's own sources, and the three it compiles with the module. */
const WIDGET_SOURCES = ["OhcalWidget.swift"];
const SHARED_SOURCES = ["CalendarSnapshot.swift", "CalendarStore.swift", "CalendarWords.swift"];
const GROUP_KEY = "com.apple.security.application-groups";

function rowOf(id) {
  const found = variantOfAppId(id);
  if (found === null) throw new Error(`calendar-native: the app's identifier "${id}" is in no row of variants.json`);
  return found.row;
}

/** Whether an app carries the calendar's widget: the calendar's app. */
const carriesWidget = (row) => row.app === "ohcal";
/** The shared group's one name, for an app that carries the widget. */
const groupOf = (row) => `group.${row.id}`;
const widgetIdOf = (row) => `${row.id}.widget`;

/** The app's entitlements with its shared group, where it carries the widget. */
function calendarEntitlements(entitlements, row) {
  if (!carriesWidget(row)) return entitlements;
  const groups = entitlements[GROUP_KEY] ?? [];
  if (!groups.includes(groupOf(row))) entitlements[GROUP_KEY] = [...groups, groupOf(row)];
  return entitlements;
}

/** The app's Info.plist with the group's name for the module's store, where it carries the widget. */
function calendarInfoPlist(plist, row) {
  if (carriesWidget(row)) plist.OhcalGroup = groupOf(row);
  return plist;
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The extension's own Info.plist and entitlements, as files: plist XML without its document type, which Xcode reads alike. */
function extensionFiles(row, name) {
  return {
    [`${TARGET}-Info.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED at prebuild by apps/mobile/plugins/calendar-native.js. Do not edit here. -->
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>${xmlEscape(name)}</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>OhcalGroup</key><string>${xmlEscape(groupOf(row))}</string>
  <key>OhcalWidgetScheme</key><string>${xmlEscape(row.scheme)}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`,
    [`${TARGET}.entitlements`]: `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED at prebuild by apps/mobile/plugins/calendar-native.js. Do not edit here. -->
<plist version="1.0">
<dict>
  <key>${GROUP_KEY}</key>
  <array><string>${xmlEscape(groupOf(row))}</string></array>
  <key>com.apple.developer.default-data-protection</key><string>NSFileProtectionComplete</string>
</dict>
</plist>
`,
  };
}

/** The build settings of the app's own target that the extension takes as they are. */
function appSetting(project, name) {
  const configs = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const value = configs[key]?.buildSettings?.[name];
    if (value !== undefined && configs[key].buildSettings.PRODUCT_NAME !== `"${TARGET}"`) return value;
  }
  return undefined;
}

/**
 * The widget's extension as a target of `project`, once: its group and files, its sources, its settings, embedded in
 * the app (the `xcode` package's own app extension: the copy phase into the app's plug-ins and the dependency).
 */
function addWidgetTarget(project, row, { version, build }) {
  // The `xcode` package keeps a target's name quoted.
  if (!carriesWidget(row) || project.pbxTargetByName(TARGET) || project.pbxTargetByName(`"${TARGET}"`)) return project;
  // The package adds the app's dependency on the extension only into sections that exist: a project of one target
  // has neither, so they are made first (empty), or the app would embed a product it does not build first.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};
  const target = project.addTarget(TARGET, "app_extension", TARGET, widgetIdOf(row));
  const sources = [...WIDGET_SOURCES, ...SHARED_SOURCES];
  const group = project.addPbxGroup([...sources, `${TARGET}-Info.plist`, `${TARGET}.entitlements`], TARGET, TARGET);
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  const configs = project.pbxXCBuildConfigurationSection();
  for (const { value } of list.buildConfigurations) {
    Object.assign(configs[value].buildSettings, {
      SWIFT_VERSION: "5.0",
      IPHONEOS_DEPLOYMENT_TARGET: appSetting(project, "IPHONEOS_DEPLOYMENT_TARGET") ?? "16.4",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      CODE_SIGN_STYLE: "Automatic",
      MARKETING_VERSION: `"${version}"`,
      CURRENT_PROJECT_VERSION: `"${build}"`,
      APPLICATION_EXTENSION_API_ONLY: "YES",
      GENERATE_INFOPLIST_FILE: "NO",
      SKIP_INSTALL: "YES",
    });
  }
  return project;
}

/** Whether an app declares exact alarms: the calendar's app. */
const declaresExactAlarms = (row) => row.app === "ohcal";

/** The four widgets, by their receiver's class in the module and their description's name. */
const WIDGETS = [
  ["app.ohmail.calendar.CalendarWidgetNext", "next"],
  ["app.ohmail.calendar.CalendarWidgetMonth", "month"],
  ["app.ohmail.calendar.CalendarWidgetToday", "today"],
  ["app.ohmail.calendar.CalendarWidgetWeek", "week"],
];
/** The names a widget is listed under, the catalogue's words (the module's strings); Next has none and takes the app's. */
const WIDGET_LABELS = { month: "@string/ohcal_widget_month", today: "@string/ohcal_widget_today", week: "@string/ohcal_widget_week" };

const named = (list, name) => (list ?? []).some((e) => e?.$?.["android:name"] === name);

/** The manifest with the calendar's exact alarm and widgets, each written once, for the calendar's app alone. */
function calendarManifest(manifest, row) {
  const root = manifest.manifest;
  if (declaresExactAlarms(row)) {
    root["uses-permission"] = root["uses-permission"] ?? [];
    if (!named(root["uses-permission"], "android.permission.USE_EXACT_ALARM")) {
      root["uses-permission"].push({ $: { "android:name": "android.permission.USE_EXACT_ALARM" } });
    }
    if (!named(root["uses-permission"], "android.permission.SCHEDULE_EXACT_ALARM")) {
      root["uses-permission"].push({ $: { "android:name": "android.permission.SCHEDULE_EXACT_ALARM", "android:maxSdkVersion": "32" } });
    }
  }
  if (!carriesWidget(row)) return manifest;
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.receiver = app.receiver ?? [];
  for (const [name, kind] of WIDGETS) {
    if (named(app.receiver, name)) continue;
    app.receiver.push({
      $: { "android:name": name, "android:exported": "true", ...(WIDGET_LABELS[kind] ? { "android:label": WIDGET_LABELS[kind] } : {}) },
      "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
      "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": `@xml/ohcal_widget_${kind}_info` } }],
    });
  }
  return manifest;
}

/** The extension's files at prebuild: its own sources, the three it shares with the module, its plist and entitlements. */
function writeExtension(iosRoot, row, name) {
  const dir = path.join(iosRoot, TARGET);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of WIDGET_SOURCES) fs.copyFileSync(path.join(MODULE, "ios-widget", f), path.join(dir, f));
  for (const f of SHARED_SOURCES) fs.copyFileSync(path.join(MODULE, "ios", f), path.join(dir, f));
  for (const [f, text] of Object.entries(extensionFiles(row, name))) fs.writeFileSync(path.join(dir, f), text, "utf8");
  return dir;
}

function withCalendarNative(config) {
  config = withAndroidManifest(config, (c) => {
    c.modResults = calendarManifest(c.modResults, rowOf(c.android?.package));
    return c;
  });
  config = withEntitlementsPlist(config, (c) => {
    c.modResults = calendarEntitlements(c.modResults, rowOf(c.ios?.bundleIdentifier));
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults = calendarInfoPlist(c.modResults, rowOf(c.ios?.bundleIdentifier));
    return c;
  });
  config = withDangerousMod(config, ["ios", (c) => {
    const row = rowOf(c.ios?.bundleIdentifier);
    if (carriesWidget(row)) writeExtension(c.modRequest.platformProjectRoot, row, c.name);
    return c;
  }]);
  return withXcodeProject(config, (c) => {
    c.modResults = addWidgetTarget(c.modResults, rowOf(c.ios?.bundleIdentifier), {
      version: c.version ?? "1.0.0", build: c.ios?.buildNumber ?? "1",
    });
    return c;
  });
}

module.exports = createRunOncePlugin(withCalendarNative, withCalendarNative.name, "1.0.0");
module.exports.TARGET = TARGET;
module.exports.carriesWidget = carriesWidget;
module.exports.declaresExactAlarms = declaresExactAlarms;
module.exports.calendarManifest = calendarManifest;
module.exports.WIDGETS = WIDGETS;
module.exports.groupOf = groupOf;
module.exports.calendarEntitlements = calendarEntitlements;
module.exports.calendarInfoPlist = calendarInfoPlist;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.writeExtension = writeExtension;
module.exports.extensionFiles = extensionFiles;
