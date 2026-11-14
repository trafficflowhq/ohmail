/**
 * THE CALENDAR'S NATIVE MODULE, read as what it is built from: no Kotlin or Swift runs in this suite, and only a phone
 * shows an alert ringing or a widget drawn. What is held here is what the module declares and says:
 *
 *  · it is built for both systems, and declares on Android exactly its two receivers: the alarms' (this app's own)
 *    and the restart's (the system's two broadcasts that drop an app's alarms), and no exact alarm of its own;
 *  · it reads who is signed in through the gate's one text, held equal to the wake plugin's;
 *  · an alert's words are the catalogue's, in both languages, chosen by closed values: nothing of the record but the
 *    label reaches a notice, and nothing is logged, printed or sent;
 *  · a tapped alert opens the app at the event only under the pairing it was set for (the unlock rule).
 *
 * The rules themselves (the record read closed, the ringer's book, the slots, the check at firing, the lead's words,
 * the title's line) ran on a JVM over the shared tables in the change that made them; the Gradle build, the
 * emulator's legs and the Swift are owed proofs of that change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWidgetTarget, widgetGeneration } from "../src/calendar/opened";

const MODULE = fileURLToPath(new URL("../modules/ohmail-calendar/", import.meta.url));
const ANDROID = join(MODULE, "android/src/main");
const SOURCES = join(ANDROID, "java/app/ohmail/calendar");
const MESSAGES = fileURLToPath(new URL("../../../packages/app/messages/", import.meta.url));

/** The Kotlin without its comments, so what is asserted is what the code does. */
const code = (kotlin: string): string => kotlin.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const kotlin = (name: string): string => code(readFileSync(join(SOURCES, name), "utf8"));

describe("the calendar's module", () => {
  it("is built for both systems, as one module", () => {
    const config = JSON.parse(readFileSync(join(MODULE, "expo-module.config.json"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      platforms: ["android", "apple"],
      android: { modules: ["app.ohmail.calendar.OhmailCalendarModule"] },
      apple: { modules: ["OhmailCalendarModule"] },
    });
    expect(readFileSync(join(MODULE, "android/build.gradle"), "utf8")).toContain('namespace "app.ohmail.calendar"');
  });

  it("declares its two receivers, the alarms' its own, and asks for no exact alarm itself", () => {
    const manifest = readFileSync(join(ANDROID, "AndroidManifest.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const receivers = [...manifest.matchAll(/<receiver\b([^>]*)>/g)].map((m) => m[1]!);
    expect(receivers.map((r) => /android:name="([^"]+)"/.exec(r)![1])).toEqual([
      "app.ohmail.calendar.CalendarAlertReceiver", "app.ohmail.calendar.CalendarRestartReceiver",
    ]);
    expect(receivers[0]).toContain('android:exported="false"');
    const actions = [...manifest.matchAll(/<action android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual(["android.intent.action.BOOT_COMPLETED", "android.intent.action.MY_PACKAGE_REPLACED"]);
    expect([...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "android.permission.RECEIVE_BOOT_COMPLETED",
    ]);
    expect(manifest).not.toMatch(/<service|<provider|<activity|EXACT_ALARM/);
    // The restart's receiver does nothing for any other action.
    expect(kotlin("CalendarRestartReceiver.kt")).toContain(
      "if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return",
    );
  });

  it("reads who is signed in through the gate's one text", () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../plugins/wake-push-renderer.js") as { gateSource(pkg: string): string };
    expect(readFileSync(join(SOURCES, "LiveInstanceGate.kt"), "utf8")).toBe(plugin.gateSource("app.ohmail.calendar"));
    const store = kotlin("CalendarStore.kt");
    expect(store).toContain("File(context.noBackupFilesDir, GENERATION_FILE)");
    expect(store).toContain("if (snapshot.hasTitles() || generation(context) != marker) return@locked null");
    expect(store).toContain("if (snapshot.hasTitles()) return false");
    expect(store).toContain("base.listFiles() ?: return false");
    const live = kotlin("CalendarLive.kt");
    expect(live).toContain("if (admitted != pairing || publication == null || writable != publication) return@locked false");
    const cleanup = live.slice(live.indexOf("private fun clean("), live.indexOf("fun keep("));
    const revoke = cleanup.indexOf("val revoked = CalendarStore.revoke(context)");
    expect(revoke).toBeGreaterThan(-1);
    expect(cleanup.indexOf("CalendarAlarms.cancelAll(context)")).toBeGreaterThan(revoke);
    expect(cleanup.indexOf("CalendarWidgets.redrawAll(context, showTarget = false)")).toBeGreaterThan(revoke);
    const restart = live.slice(live.indexOf("fun cancelBeforeAdmission("), live.indexOf("fun allows("));
    expect(restart).toContain("if (admitted == null) CalendarAlarms.cancelAll(context)");
    expect(restart).not.toMatch(/CalendarAlarms\.arm|CalendarWidgets\.redrawAll/);
  });

  it("asks at firing before anything is drawn, and draws for the pairing the alarm was set for", () => {
    const receiver = kotlin("CalendarAlertReceiver.kt");
    const ask = receiver.indexOf("if (current.generation != generation) return@locked");
    const decide = receiver.indexOf("CalendarRing.decide(");
    const post = receiver.indexOf("CalendarAlertPoster.post(");
    expect(ask).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(ask);
    expect(post).toBeGreaterThan(decide);
    expect(kotlin("CalendarRing.kt")).toContain("if (!LiveInstanceGate.mayDraw(kept, pairing) || record == null) return null");
  });

  it("logs, prints and sends nothing", () => {
    const names = readdirSync(SOURCES).filter((n) => n.endsWith(".kt"));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      expect(kotlin(name), name).not.toMatch(/\bLog\.|println|System\.out|URL\(|HttpURLConnection|Socket\(|setAlarmClock/);
    }
  });
});

/** A resource file's strings and plurals, by name. */
function resources(xml: string) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, "");
  const unescape = (s: string) => s.replace(/\\(['"])/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const strings = Object.fromEntries([...text.matchAll(/<string name="(\w+)">([^<]*)<\/string>/g)].map((m) => [m[1]!, unescape(m[2]!)]));
  const plurals = Object.fromEntries([...text.matchAll(/<plurals name="(\w+)">([\s\S]*?)<\/plurals>/g)].map((m) => [
    m[1]!, Object.fromEntries([...m[2]!.matchAll(/<item quantity="(\w+)">([^<]*)<\/item>/g)].map((i) => [i[1]!, unescape(i[2]!)])),
  ]));
  return { strings, plurals };
}

/** An ICU plural's arms, each with the number written as Android writes it. */
const arms = (icu: string): Record<string, string> =>
  Object.fromEntries([...icu.matchAll(/(\w+) \{([^{}]*)\}/g)].map((m) => [m[1]!, m[2]!.replaceAll("#", "%d")]));

describe("an alert's words, one for one the catalogue's", () => {
  const json = (name: string) => JSON.parse(readFileSync(join(MESSAGES, name), "utf8")) as Record<string, Record<string, unknown>>;
  for (const [language, dir] of [["en", "values"], ["de", "values-de"]] as const) {
    it(`${language}: the channel's name, the label's two words and every lead's sentence`, () => {
      const said = (json(`frame.${language}.json`).frame as Record<string, Record<string, string>>).systemNotice!;
      const { strings, plurals } = resources(readFileSync(join(ANDROID, "res", dir, "strings.xml"), "utf8"));
      const pick = (icu: string) => { const a = arms(icu); return { one: a.one!, other: a.other! }; };
      expect(strings).toMatchObject({
        ohcal_alert_channel: (json(`calendar.${language}.json`).calendar as Record<string, string>).landmark,
        ohcal_alert_busy: said.alertBusy, ohcal_alert_event: said.alertEvent, ohcal_alert_now: said.alertNow,
        ohcal_alert_today: said.alertToday, ohcal_alert_tomorrow: said.alertTomorrow,
        ohcal_alert_all_days: said.alertAllDays!.replace("{count}", "%d"),
      });
      expect(plurals).toMatchObject({
        ohcal_alert_minutes: pick(said.alertMinutes!), ohcal_alert_hours: pick(said.alertHours!),
        ohcal_alert_days: pick(said.alertDays!), ohcal_alert_weeks: pick(said.alertWeeks!),
        ohcal_alert_all_weeks: pick(said.alertAllWeeks!),
      });
    });
  }

  it("both languages hold the same names, and the alert's poster asks for those alone, by closed words", () => {
    const en = resources(readFileSync(join(ANDROID, "res/values/strings.xml"), "utf8"));
    const de = resources(readFileSync(join(ANDROID, "res/values-de/strings.xml"), "utf8"));
    expect(Object.keys(de.strings).sort()).toEqual(Object.keys(en.strings).sort());
    expect(Object.keys(de.plurals).sort()).toEqual(Object.keys(en.plurals).sort());
    const poster = kotlin("CalendarAlertPoster.kt");
    const asked = new Set([...poster.matchAll(/\bR\.(string|plurals)\.(ohcal_alert_\w+)/g)].map((m) => `${m[1]}.${m[2]}`));
    expect(asked).toEqual(new Set(["string.ohcal_alert_channel"]));
    const post = poster.slice(poster.indexOf("fun post("));
    expect(post).not.toMatch(/"[^"\n]*\$|"\s*\+|\+\s*"|String\.format|\.format\(/);
    expect(post.match(/setContentText\(calendar\)/g)).toHaveLength(2);
    expect(post.match(/setShowWhen\(false\)/g)).toHaveLength(2);
    expect(post).not.toMatch(/setContentTitle|startMs|eventId|alert\.label|alert\.leadMin/);
    expect(poster).not.toMatch(/setContentText\([^)]*label|setSubText|setContentInfo|setTicker|addAction|setLargeIcon/);
  });
});

describe("the calendar app's widget on Android", () => {
  const RES = join(ANDROID, "res");
  const layout = (name: string) => readFileSync(join(RES, "layout", `${name}.xml`), "utf8").replace(/<!--[\s\S]*?-->/g, "");

  it("is drawn with the system's own parts only: the views an app widget may hold", () => {
    for (const name of readdirSync(join(RES, "layout"))) {
      const elements = new Set([...layout(name.replace(/\.xml$/, "")).matchAll(/<(\w+)[\s>]/g)].map((m) => m[1]!));
      expect([...elements].filter((e) => !["LinearLayout", "FrameLayout", "TextView", "xml"].includes(e)), name).toEqual([]);
    }
    expect(readdirSync(join(RES, "layout")).sort()).toEqual([
      "ohcal_widget_month.xml", "ohcal_widget_next.xml", "ohcal_widget_today.xml", "ohcal_widget_week.xml",
    ]);
  });

  it("is the studio's four: two small (2 x 2) and two medium (4 x 2), never resized, never on a lock screen", () => {
    const sizes: Record<string, [string, string]> = {
      next: ["2", "2"], month: ["2", "2"], today: ["4", "2"], week: ["4", "2"],
    };
    for (const [kind, [w, h]] of Object.entries(sizes)) {
      const info = readFileSync(join(RES, "xml", `ohcal_widget_${kind}_info.xml`), "utf8");
      expect(info, kind).toContain(`android:initialLayout="@layout/ohcal_widget_${kind}"`);
      expect(info, kind).toContain(`android:targetCellWidth="${w}"`);
      expect(info, kind).toContain(`android:targetCellHeight="${h}"`);
      expect(info, kind).toContain('android:resizeMode="none"');
      expect(info, kind).toContain('android:widgetCategory="home_screen|not_keyguard"');
    }
  });

  it("speaks the catalogue's words, in both languages, and one language at a time", () => {
    const json = (name: string) => JSON.parse(readFileSync(join(MESSAGES, name), "utf8")) as Record<string, Record<string, unknown>>;
    for (const [language, dir] of [["en", "values"], ["de", "values-de"]] as const) {
      const { strings } = resources(readFileSync(join(RES, dir, "strings.xml"), "utf8"));
      const agenda = json(`agenda.${language}.json`).agenda as Record<string, string>;
      const calmail = json(`calmail.${language}.json`).calmail as Record<string, string>;
      const month = json(`month.${language}.json`).month as Record<string, string>;
      const view = (json(`calsettings.${language}.json`).calsettings as Record<string, Record<string, string>>).view!;
      expect(strings, language).toMatchObject({
        ohcal_widget_language: language,
        ohcal_widget_now: calmail.now, ohcal_widget_to_answer: calmail.toAnswer,
        ohcal_widget_until: agenda.until!.replace("{time}", "%1$s"), ohcal_widget_nothing: agenda.nothing,
        ohcal_widget_more: month.more!.replace("{count}", "%d"),
        ohcal_widget_month: agenda.month, ohcal_widget_today: (json(`calendar.${language}.json`).calendar as Record<string, string>).today,
        ohcal_widget_week: view.week,
      });
    }
  });

  it("draws from the signed-in pairing's record alone, and is drawn again whenever that changes", () => {
    const widgets = kotlin("CalendarWidgets.kt");
    const draw = widgets.slice(widgets.indexOf("fun redrawAll("), widgets.indexOf("private fun open("));
    expect(draw).toContain("if (showTarget) proposed ?: CalendarStore.active(context)?.generation else null");
    expect(draw).toContain("category == AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN");
    expect(draw).not.toMatch(/eventId|label|snapshot|startMs|toAnswer/);
    expect(widgets).not.toMatch(/OhmailEngine|fetch\(|http|token|SecureStore|SQLite/i);
    expect(kotlin("CalendarLive.kt")).toContain("CalendarWidgets.redrawAll(context, showTarget = false)");
    const publishing = kotlin("CalendarLive.kt");
    const drawReplacement = publishing.indexOf("CalendarWidgets.redrawAll(context, proposed = generation)");
    expect(drawReplacement).toBeGreaterThan(-1);
    expect(publishing.indexOf("CalendarStore.activate(context, generation)")).toBeGreaterThan(drawReplacement);
    expect(publishing).toContain("if (!published) clean(context, pairing)");
    expect(kotlin("CalendarLive.kt")).toContain("if (admitted != null) CalendarWidgets.redrawAll(context)");
    expect(widgets).toContain("CalendarLive.redrawAdmitted(context)");
    expect(widgets).toContain("override fun onAppWidgetOptionsChanged(");
    expect(draw).toContain("success = false");
  });
});

/** The Swift without its comments. */
const swift = (name: string): string =>
  readFileSync(join(MODULE, "ios", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the iPhone's alerts", () => {
  it("set ahead whole: the calendar's pending requests removed first, then the set's alerts still ahead, at most 64", () => {
    const alerts = swift("CalendarAlerts.swift");
    const arm = alerts.slice(alerts.indexOf("static func arm("), alerts.indexOf("static func mayShow("));
    expect(alerts).toContain("center.removePendingNotificationRequests(withIdentifiers: ours(");
    expect(alerts).toContain("center.getPendingNotificationRequests { remaining in");
    expect(arm).toContain("active.snapshot.alerts.filter { $0.atMs > now }.prefix(pendingMax)");
    expect(arm).toContain("guard CalendarStore.readLive()?.generation == expected");
    expect(alerts).toContain("static let pendingMax = 64");
    expect(arm).toContain('content.body = CalendarWords.widget("calendar")');
    expect(arm).not.toMatch(/eventId|alert\.label|alert\.leadMin|content\.title|subtitle|attachments|categoryIdentifier/);
    const module = swift("OhmailCalendarModule.swift");
    const clean = module.slice(module.indexOf("private func clean("));
    const revoke = clean.indexOf("CalendarStore.revoke()");
    expect(revoke).toBeGreaterThan(-1);
    expect(clean.indexOf("CalendarAlerts.clear")).toBeGreaterThan(revoke);
    expect(clean).toContain("completed(revoked && cancelled && erased && CalendarStore.finishCleanup())");
    const store = swift("CalendarStore.swift");
    expect(store).toContain("!cleanupPending(local)");
    expect(store).toContain("!snapshot.hasTitles, marker(local) == before, marker(group) == id");
    expect(store).toContain("guard !snapshot.hasTitles, isInstance(pairing)");
    expect(store).toContain(".completeFileProtectionUntilFirstUserAuthentication");
    expect(store).not.toContain("if root == nil");
  });

  it("asks again where the system lets it (the app in front), and clears pending and delivered alike", () => {
    const delegate = swift("CalendarNoticeSubscriber.swift");
    expect(delegate).toContain("done(CalendarAlerts.mayShow(request.content) ? [.banner, .list, .sound] : [])");
    const alerts = swift("CalendarAlerts.swift");
    expect(alerts).toContain("CalendarStore.readLive()?.generation.id == generation");
    expect(alerts).toContain("CalendarStore.readLive()?.generation == expected");
    expect(alerts).toContain("ours(visible.map { $0.request.identifier }).isEmpty");
    expect(alerts).toContain("center.removeDeliveredNotifications(withIdentifiers: ours(shown.map { $0.request.identifier }))");
    // No mail notice on the iPhone: the module posts nothing but the calendar's own requests, all under one head.
    expect(alerts.match(/UNNotificationRequest\(/g)).toHaveLength(1);
    const config = JSON.parse(readFileSync(join(MODULE, "expo-module.config.json"), "utf8")) as { apple: { appDelegateSubscribers: string[] } };
    expect(config.apple.appDelegateSubscribers).toEqual(["CalendarNoticeSubscriber"]);
  });

  it("speaks the catalogue's words, the same as Android's", () => {
    const text = swift("CalendarWords.swift");
    const tableOf = (language: string) => {
      const at = text.indexOf(`"${language}": [`);
      const body = text.slice(at, text.indexOf("],", at));
      return Object.fromEntries([...body.matchAll(/"([\w.]+)": "([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    };
    for (const [language, dir] of [["en", "values"], ["de", "values-de"]] as const) {
      const { strings, plurals } = resources(readFileSync(join(ANDROID, "res", dir, "strings.xml"), "utf8"));
      const table = tableOf(language);
      // The widget's words: Android's, the place of the one text written as Swift writes it.
      expect(Object.fromEntries(Object.entries(table).filter(([k]) => k.startsWith("widget.")))).toEqual({
        "widget.now": strings.ohcal_widget_now, "widget.until": strings.ohcal_widget_until!.replace("%1$s", "%@"),
        "widget.more": strings.ohcal_widget_more, "widget.toAnswer": strings.ohcal_widget_to_answer,
        "widget.nothing": strings.ohcal_widget_nothing, "widget.calendar": strings.ohcal_alert_channel,
        "widget.month": strings.ohcal_widget_month, "widget.today": strings.ohcal_widget_today,
        "widget.week": strings.ohcal_widget_week,
      });
      expect(Object.fromEntries(Object.entries(table).filter(([k]) => !k.startsWith("widget."))), language).toEqual({
        busy: strings.ohcal_alert_busy, event: strings.ohcal_alert_event, now: strings.ohcal_alert_now,
        "minutes.one": plurals.ohcal_alert_minutes!.one, "minutes.other": plurals.ohcal_alert_minutes!.other,
        "hours.one": plurals.ohcal_alert_hours!.one, "hours.other": plurals.ohcal_alert_hours!.other,
        "days.one": plurals.ohcal_alert_days!.one, "days.other": plurals.ohcal_alert_days!.other,
        "weeks.one": plurals.ohcal_alert_weeks!.one, "weeks.other": plurals.ohcal_alert_weeks!.other,
        today: strings.ohcal_alert_today, tomorrow: strings.ohcal_alert_tomorrow, allDays: strings.ohcal_alert_all_days,
        "allWeeks.one": plurals.ohcal_alert_all_weeks!.one, "allWeeks.other": plurals.ohcal_alert_all_weeks!.other,
      });
    }
  });

  it("asks the system for the calendar's alerts only where the page asks, and Android keeps its own way", async () => {
    const { askNoticePermission, noticePermission } = await import("../src/shell/doors");
    const asked: string[] = [];
    const host = (platform: string) => ({
      platform, apiLevel: platform === "android" ? 34 : 0,
      permissionGranted: async () => false, switchOn: async () => null,
      request: async () => (asked.push(`${platform} host`), "granted" as const),
      readAsked: async () => false, writeAsked: async () => {},
    });
    const local = {
      permission: async () => (asked.push("local read"), "default" as const),
      request: async () => (asked.push("local ask"), "granted" as const),
    };
    expect(await noticePermission(host("ios"), local)).toBe("default");
    expect(asked).toEqual(["local read"]);
    expect(await askNoticePermission(host("ios"), local)).toBe("granted");
    expect(asked).toEqual(["local read", "local ask"]);
    expect(await noticePermission(host("ios"), null)).toBe("unsupported");
    expect(await noticePermission(host("ios"), {})).toBe("unsupported");
    expect(await askNoticePermission(host("android"), local)).toBe("granted");
    expect(asked).toEqual(["local read", "local ask", "android host"]);
  });
});

describe("a tapped calendar widget", () => {
  it("accepts exactly the event and occurrence returned through the native door", () => {
    const target = { event: "ev-weekly", startMs: 1700000000000 };
    expect(readWidgetTarget(target)).toEqual(target);
    for (const raw of [
      null, undefined, "ev-weekly", [target.event, target.startMs], { event: target.event },
      { startMs: target.startMs }, { ...target, event: "ev weekly" }, { ...target, event: "e".repeat(129) },
      { ...target, pairing: "foreign" }, { ...target, event: 7 }, { ...target, startMs: -1 },
      { ...target, startMs: 0.5 }, Object.create(target),
    ]) expect(readWidgetTarget(raw)).toBeNull();
  });

  it("exposes only the opaque generation in a URL of this app", () => {
    const id = "00000001-0000-4000-8000-000000000000";
    expect(widgetGeneration(`ohcal://calendar-widget/${id}`, "ohcal")).toBe(id);
    expect(widgetGeneration(`ohcal://calendar-widget/${id}`, "ohcal-preview")).toBeNull();
    expect(widgetGeneration(`ohcal://calendar-widget/${id}/different`, "ohcal")).toBeNull();
    expect(widgetGeneration(`ohcal://calendar-widget/${id}?event=different`, "ohcal")).toBeNull();
    expect(widgetGeneration(null, "ohcal")).toBeNull();
  });
});

describe("private calendar system surfaces", () => {
  it("explicitly excludes all four providers from the keyguard and uses locked-device protection on iOS", () => {
    for (const kind of ["next", "month", "today", "week"]) {
      const xml = readFileSync(join(ANDROID, "res/xml", `ohcal_widget_${kind}_info.xml`), "utf8");
      expect(xml).toContain('android:widgetCategory="home_screen|not_keyguard"');
    }
    const plugin = readFileSync(new URL("../plugins/calendar-native.js", import.meta.url), "utf8");
    expect(plugin).toContain("com.apple.developer.default-data-protection");
    expect(plugin).toContain("NSFileProtectionComplete");
  });

  it("keeps event details out of system-scheduled notifications and WidgetKit", () => {
    const widget = readFileSync(join(MODULE, "ios-widget/OhcalWidget.swift"), "utf8");
    expect(widget).not.toMatch(/CalendarStore\.readLive|CalendarWords\.title|toAnswer|startMs/);
    expect(swift("CalendarAlerts.swift")).not.toMatch(/content\.title\s*=\s*CalendarWords\.title|content\.body\s*=\s*body/);
    expect(kotlin("CalendarAlertPoster.kt")).not.toMatch(/setContentTitle\(title|setContentText\(body\)|setWhen\(alert/);
  });

  it("uses an immutable occurrence shortcut on both platforms", () => {
    const widget = readFileSync(join(MODULE, "ios-widget/OhcalWidget.swift"), "utf8");
    expect(widget).toContain(".widgetURL(");
    expect(kotlin("CalendarWidgets.kt")).toContain("PendingIntent.FLAG_IMMUTABLE");
    expect(kotlin("CalendarWidgets.kt")).not.toContain("FLAG_UPDATE_CURRENT");
  });

  it("reads through the admitted facade without adding an importer exception", () => {
    const shim = readFileSync(new URL("../src/calendar/record.ts", import.meta.url), "utf8");
    const guards = readFileSync(new URL("./privacy.test.ts", import.meta.url), "utf8");
    expect(shim).toContain('from "../state/surface"');
    expect(guards).not.toContain('"src/calendar/record.ts"');
  });
});

it("does not re-arm or redraw from the Android restart broadcast before the profile is checked", () => {
  const receiver = kotlin("CalendarRestartReceiver.kt");
  expect(receiver).not.toMatch(/CalendarLive\.recover|CalendarAlarms\.arm|CalendarWidgets\.redrawAll/);
});

it("delivers the immutable generation as an explicit Android VIEW intent to the app activity", () => {
  const widgets = kotlin("CalendarWidgets.kt");
  expect(widgets).toContain("Intent(Intent.ACTION_VIEW, target)");
  expect(widgets).toContain(".setComponent(activity)");
  expect(widgets).toContain('authority("calendar-widget").appendPath(generation)');
  expect(widgets).toContain("getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE)");
});
