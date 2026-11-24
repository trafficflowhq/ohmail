/**
 * THE NOTICES' NATIVE MODULE ON ANDROID, read as the Kotlin it is built from: no Kotlin runs in this suite, and only
 * a phone shows a notice drawn or closed. What is held here is what the code says:
 *
 *  · the module is built for Android alone (nothing is posted on the iPhone), and exposes only the port's count, preview and pairing commands;
 *  · the file that says which pairing is signed in is spelled once, by the gate, and one store reads and writes it,
 *    the way the wake's renderer reads it;
 *  · keeping a pairing, or none, takes back what is shown for any other pairing, and nothing is ever closed wholesale;
 *  · the poster checks the pairing before posting. Count notices use catalogue sentences, and opted-in preview
 *    text may appear only in the private notification. No caller input names a channel or enters a log;
 *  · nothing is logged, printed or sent.
 *
 * The store and the take-back's choice also ran on a JVM in the change that made them, and the poster was compiled
 * there; the Gradle build and the emulator's legs are owed proofs of that change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { NoticesNative } from "../src/notices/notices-port";

const MODULE = fileURLToPath(new URL("../modules/ohmail-notices/", import.meta.url));
const SOURCES = join(MODULE, "android/src/main/java/app/ohmail/notices");
const MESSAGES = fileURLToPath(new URL("../../../packages/app/messages/", import.meta.url));

/** The Kotlin without its comments, so what is asserted is what the code does. */
const code = (kotlin: string): string => kotlin.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const kotlin = (name: string): string => code(readFileSync(join(SOURCES, name), "utf8"));

/** The text from `head` to the brace that closes the block it opens. */
function block(text: string, head: string): string {
  const at = text.indexOf(head);
  if (at < 0) return "";
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}

/** The statements of a block, one a line, without blank lines. */
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** The words a `when` block's own arms name, not those of a `when` inside one of its arms. */
function armsOf(text: string, head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of block(text, head).split("\n")) {
    const arm = depth === 1 ? /^"(\w+)" ->/.exec(line.trim()) : null;
    if (arm) out.push(arm[1]!);
    for (const c of line) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
  }
  return out;
}

describe("the notices' module on Android", () => {
  it("is built for Android alone, as one module", () => {
    const config = JSON.parse(readFileSync(join(MODULE, "expo-module.config.json"), "utf8")) as Record<string, unknown>;
    expect(config).toEqual({ platforms: ["android"], android: { modules: ["app.ohmail.notices.OhmailNoticesModule"] } });
    const manifest = readFileSync(join(MODULE, "android/src/main/AndroidManifest.xml"), "utf8");
    // No permission and no component of its own: posting is the app's own, asked by the app.
    expect(manifest).not.toMatch(/<uses-permission|<service|<receiver|<provider|<activity/);
    expect(readFileSync(join(MODULE, "android/build.gradle"), "utf8")).toContain('namespace "app.ohmail.notices"');
  });

  it("spells the file of the signed-in pairing once, by the gate, and one store reads and writes it", () => {
    const store = kotlin("LiveInstanceStore.kt");
    expect(store).toContain("File(context.noBackupFilesDir, LiveInstanceGate.FILE)");
    // The renderer's read: bounded, two lines through the gate, anything unreadable is nobody.
    expect(store).toContain("file.length() > LiveInstanceGate.MOST");
    expect(store).toContain("LiveInstanceGate.keptOf(file.readLines(Charsets.US_ASCII))");
    expect(store).toContain("LiveInstanceGate.linesOf(instance)");
    // Written whole: a part file, then the rename over the kept one.
    expect(store).toMatch(/\.renameTo\(file\)/);
    expect(store).not.toMatch(/["'`]ohmail/);
    // No other file of the module reaches the no-backup folder or names the file.
    for (const name of readdirSync(SOURCES).filter((n) => n !== "LiveInstanceStore.kt" && n !== "LiveInstanceGate.kt")) {
      expect(kotlin(name), name).not.toMatch(/noBackupFilesDir|LiveInstanceGate\.FILE|File\(/);
    }
  });

  it("keeps the pairing first, then takes back what is shown for any other, and never closes everything", () => {
    const module = kotlin("OhmailNoticesModule.kt");
    const setLive = lines(block(module, 'AsyncFunction("setLive")'));
    expect(setLive).toEqual([
      'AsyncFunction("setLive") { instance: String? ->',
      "val ctx = context ?: return@AsyncFunction false",
      "val was = LiveInstanceStore.kept(ctx)",
      "val ok = LiveInstanceStore.keep(ctx, instance)",
      "takeBack(ctx, was, LiveInstanceStore.kept(ctx))",
      "ok",
      "}",
    ]);
    // What is closed is chosen by tag and id, one at a time; the organizing notice and every other is the app's own.
    const takeBack = block(module, "private fun takeBack(");
    expect(takeBack).toContain("NoticeTakeBack.closing(shown, was, now)");
    expect(takeBack).toMatch(/manager\.cancel\(tag, id\)/);
    expect(takeBack).toMatch(/catch \(t: Throwable\)/);
    const choice = kotlin("NoticeTakeBack.kt");
    // What is closed: every notice of another pairing than the kept one, and the untagged new mail when it changed.
    expect(choice).toContain("if (tag != null && LiveInstanceGate.isInstance(tag)) tag != now else tag == null && id == NoticePoster.NEW_MAIL_ID && changed");
    expect(choice).toContain("LiveInstanceGate.isInstance(tag)");
    expect(choice).not.toMatch(/^import /m);
  });

  it("logs, prints and sends nothing, and closes nothing wholesale", () => {
    const names = readdirSync(SOURCES).filter((n) => n.endsWith(".kt"));
    expect(names).toEqual(expect.arrayContaining([
      "LiveInstanceGate.kt", "LiveInstanceStore.kt", "NoticePoster.kt", "NoticeTakeBack.kt", "OhmailNoticesModule.kt",
    ]));
    for (const name of names) {
      const text = kotlin(name);
      expect(text, name).not.toMatch(/\bLog\.|println|System\.out|URL\(|HttpURLConnection|Socket\(|cancelAll\(/);
    }
  });
});

/** The arguments of each call whose name matches `name`, as written between its parentheses. */
function argumentsOf(text: string, name: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`(?:${name.source})\\(`, "g"))) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")" && (depth -= 1) === 0) { out.push(text.slice(open + 1, i)); break; }
    }
  }
  return out;
}

describe("what the module answers, and what the poster is handed", () => {
  const module = kotlin("OhmailNoticesModule.kt");
  const poster = kotlin("NoticePoster.kt");
  const post = block(poster, "fun post(");
  /** What the poster is handed: the port's own names. */
  const HANDED = ["instance", "kind", "count", "change", "device"];

  it("answers the count and preview commands with their port parameters and declares no events or constants", () => {
    expect(module.match(/\bName\("[^"]*"\)/g)).toEqual(['Name("OhmailNotices")']);
    expect([...module.matchAll(/\b(?:Async)?Function\("(\w+)"\)/g)].map((m) => m[0])).toEqual([
      'AsyncFunction("setLive")', 'AsyncFunction("postDetails")', 'AsyncFunction("post")',
    ]);
    expect(module).not.toMatch(/\b(?:Events|Constants|Property|Prop|View|OnCreate|OnDestroy|OnNewIntent|OnActivity\w*)\s*[({]/);
    expect(lines(block(module, 'AsyncFunction("setLive")'))[0]).toBe('AsyncFunction("setLive") { instance: String? ->');
    expect(lines(block(module, 'AsyncFunction("post")'))[0]).toBe(
      'AsyncFunction("post") { instance: String, kind: String, count: Int, change: String?, device: String? ->',
    );
    // The same lists, as the page's side of the port types them.
    expectTypeOf<Parameters<NoticesNative["setLive"]>>().toEqualTypeOf<[string | null]>();
    expectTypeOf<Parameters<NoticesNative["post"]>>().toEqualTypeOf<[string, string, number, string | null, string | null]>();
    expectTypeOf<Parameters<NonNullable<NoticesNative["postDetails"]>>>().toEqualTypeOf<[string, string, string]>();
    expect(lines(block(module, 'AsyncFunction("postDetails")'))).toEqual([
      'AsyncFunction("postDetails") { instance: String, sender: String, subject: String ->',
      "val ctx = context ?: return@AsyncFunction false",
      "if (sender.length !in 1..160 || subject.length !in 1..160 ||",
      "sender.any { it.isISOControl() } || subject.any { it.isISOControl() }) return@AsyncFunction false",
      'NoticePoster.post(ctx, instance, "ohbox", 1, null, null, sender, subject)',
      "}",
    ]);
    expect(lines(block(module, 'AsyncFunction("post")'))).toEqual([
      'AsyncFunction("post") { instance: String, kind: String, count: Int, change: String?, device: String? ->',
      "val ctx = context ?: return@AsyncFunction false",
      "NoticePoster.post(ctx, instance, kind, count, change, device)",
      "}",
    ]);
  });

  it("asks for whom before anything else, and posts once, after that, tagged with the pairing", () => {
    const body = lines(post);
    expect(body.slice(0, 5)).toEqual([
      "fun post(",
      "context: Context, instance: String, kind: String, count: Int, change: String?, device: String?,",
      "sender: String? = null, subject: String? = null,",
      "): Boolean {",
      "if (!LiveInstanceGate.mayDraw(LiveInstanceStore.kept(context), instance)) return false",
    ]);
    expect(poster.split(".notify(").length - 1).toBe(1);
    expect(post.indexOf(".notify(")).toBeGreaterThan(post.indexOf("LiveInstanceGate.mayDraw("));
    // The pairing reaches the gate and the notice's tag, and nothing a person reads.
    expect(poster.split("\n").filter((l) => /\binstance\b/.test(l)).map((l) => l.trim())).toEqual([
      body[1], body[4], "manager.notify(instance, words.id, builder.build())",
    ]);
  });

  it("puts nothing it is handed into a notice's words, a channel's name or a log", () => {
    const calls = argumentsOf(poster, /\bsetContent\w*|\bsetTicker|\bsetSubText|\bsetStyle|\bsetGroup|\bNotificationChannel|\bLog\.\w+/);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const said of calls) for (const name of HANDED) expect(new RegExp(`\\b${name}\\b`).test(said), `${name} in (${said})`).toBe(false);
    // Only the unlocked notification's title and body may take the opted-in preview.
    expect(calls.filter((said) => /\b(sender|subject)\b/.test(said))).toEqual([
      "sender ?: words.title", "subject ?: words.body",
    ]);
    // No sentence is made in code: no string template and no glued string anywhere in the poster.
    expect(poster).not.toMatch(/"[^"\n]*\$|"\s*\+|\+\s*"|String\.format|\.format\(/);
    // The default words are resources selected by the bridge's three closed kinds.
    expect(poster).toMatch(/getQuantityString\(R\.plurals\./);
    expect(armsOf(poster, "when (kind) {")).toEqual(["ohbox", "screener", "pairing"]);
    expect(poster).not.toMatch(/"scheduled"/);
  });

  it("shows a locked screen the title alone, opens the app on a tap, and carries no action and no extra", () => {
    expect(post).toContain(".setVisibility(NotificationCompat.VISIBILITY_PRIVATE)");
    const hidden = post.slice(post.indexOf("val hidden = "), post.indexOf("val builder = "));
    expect(hidden).toContain(".setContentTitle(words.title)");
    expect(hidden).not.toMatch(/setContentText|setContentInfo|setSubText/);
    expect(post).toContain(".setPublicVersion(hidden.build())");
    expect(post).toContain("getLaunchIntentForPackage(context.packageName)");
    expect(post).toContain("PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT");
    expect(poster).not.toMatch(/addAction|putExtra|setExtras|addExtras|setDeleteIntent|setFullScreenIntent|setLargeIcon/);
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
  const elements = [...text.matchAll(/<(\w[\w-]*)\b/g)].map((m) => m[1]!);
  return { strings, plurals, elements };
}

/** An ICU choice's arms, `{n, plural|select, a {…} b {…}}`: each arm's words, the number written as Android writes it. */
const arms = (icu: string): Record<string, string> =>
  Object.fromEntries([...icu.matchAll(/(\w+) \{([^{}]*)\}/g)].map((m) => [m[1]!, m[2]!.replaceAll("#", "%d")]));

describe("the notices' words, one for one the catalogue's", () => {
  const require = createRequire(import.meta.url);
  const wake = (require("../plugins/wake-push-renderer.js") as { NOTIFICATION_STRINGS: Record<string, { channel: string }> })
    .NOTIFICATION_STRINGS;
  const json = (name: string) => JSON.parse(readFileSync(join(MESSAGES, name), "utf8")) as Record<string, Record<string, Record<string, string>>>;
  const words = (dir: string) => resources(readFileSync(join(MODULE, "android/src/main/res", dir, "strings.xml"), "utf8"));

  for (const [language, dir, platform] of [["en", "values", ""], ["de", "values-de", "de"]] as const) {
    it(`${language}: every title, sentence and channel name is the catalogue's own`, () => {
      const said = json(`frame.${language}.json`).frame!.systemNotice!;
      const ohbox = arms(said.ohboxBody!);
      const screener = arms(said.screenerBody!);
      const paired = arms(said.pairedBody!);
      const revoked = arms(said.revokedBody!);
      const { strings, plurals, elements } = words(dir);
      expect(strings).toEqual({
        ohmail_notice_channel_new_mail: wake[platform]!.channel,
        ohmail_notice_channel_screener: said.screenerTitle,
        ohmail_notice_channel_devices: json(`account.${language}.json`).devices!.title,
        ohmail_notice_ohbox_title: said.ohboxTitle,
        ohmail_notice_screener_title: said.screenerTitle,
        ohmail_notice_paired_title: said.pairedTitle,
        ohmail_notice_paired_desktop: paired.desktop,
        ohmail_notice_paired_phone: paired.phone,
        ohmail_notice_paired_browser: paired.browser,
        ohmail_notice_paired_other: paired.other,
        ohmail_notice_revoked_title: said.revokedTitle,
        ohmail_notice_revoked_desktop: revoked.desktop,
        ohmail_notice_revoked_phone: revoked.phone,
        ohmail_notice_revoked_browser: revoked.browser,
        ohmail_notice_revoked_other: revoked.other,
      });
      expect(plurals).toEqual({
        ohmail_notice_ohbox_body: { one: ohbox.one, other: ohbox.other },
        ohmail_notice_screener_body: { one: screener.one, other: screener.other },
      });
      // Nothing else in the file: no sentence of a scheduled send, no array, no other value.
      expect(new Set(elements)).toEqual(new Set(["resources", "string", "plurals", "item"]));
    });
  }

  it("both languages hold the same names, and every name the poster asks for", () => {
    const en = words("values");
    const de = words("values-de");
    expect(Object.keys(de.strings).sort()).toEqual(Object.keys(en.strings).sort());
    expect(Object.keys(de.plurals).sort()).toEqual(Object.keys(en.plurals).sort());
    const asked = [...kotlin("NoticePoster.kt").matchAll(/\bR\.(string|plurals)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
    const held = [...Object.keys(en.strings).map((n) => `string.${n}`), ...Object.keys(en.plurals).map((n) => `plurals.${n}`)];
    expect(new Set(asked)).toEqual(new Set(held));
  });
});
