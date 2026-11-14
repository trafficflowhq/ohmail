/**
 * EVERY NAME SOMETHING IS KEPT UNDER HAS A ROW, AND EVERY ROW IS A NAME THE TREE STILL SPELLS.
 *
 * A stored name is a promise in the words themselves: another install, a device or a mailbox
 * still holds what was written under it, so it never changes and never goes missing unnoticed.
 * The registry (`packages/client-engine/src/stored-keys.ts`) lists each one with what the next
 * major version does with it. This holds the list to the tree, both ways:
 *
 *  · rows → tree: each row's spelling stands in every file the row names. A file that moved, or a
 *    name that was respelled, turns this red and names the row.
 *  · tree → rows: every spelling the walk reads as a stored name is a row that names its file,
 *    or is listed below as naming nothing stored. A new key without a row turns this red and
 *    names the file and line; so does a known key kept from a file no row of it names, which is
 *    how a second store for one name (the phone's beside the browser's) gets its own row.
 *
 * The names are spelled in TypeScript, Rust, Kotlin, Swift, a service worker and two manifests,
 * and most web keys are composed at run time from a prefix and an account; no type sees them
 * all. That is why this is a reading of the words and not a type. A spelling is read as a
 * stored name in five forms (`candidatesIn`):
 *
 *  1. it starts as the product names things, anywhere;
 *  2. it is the first argument of a call that reads or writes a store;
 *  3. it is assigned to a constant named as a key, a file, a folder or a channel, in a file that
 *     touches a store;
 *  4. it ends a path that is joined in a file that touches the file system;
 *  5. it is what a Rust function named as a file's or a folder's name answers.
 *
 * WHAT THIS CANNOT SEE: a name that reaches a store through a variable whose own name says
 * nothing (`const fallback = "Sent"`), one built by `format!` or by adding strings, and one
 * passed in from a file outside the walk. Rows → tree still holds such a row to its file; only
 * a new one of that kind arrives unseen. As storage is rewired through one typed door, a file's
 * keys become a compile error instead and leave this walk.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { STORED_KEYS, type StoredKeyRow } from "../packages/client-engine/src/stored-keys.js";

/** The repository's root, which the suite runs from; from anywhere else the walk below finds no tree and throws. */
const ROOT = process.cwd();

/** Where a spelling may be a stored name: the clients with their native halves, the engine and the servers. */
const TREES = [
  "apps/webapp/app", "apps/webapp/public", "apps/webapp/middleware.ts",
  "apps/desktop/src", "apps/desktop/src-tauri/src", "apps/desktop/src-tauri/tauri.conf.json",
  "apps/mobile/src", "apps/mobile/app", "apps/mobile/app.json", "apps/mobile/plugins", "apps/mobile/modules",
  "apps/sidecar/src", "apps/server/src", "apps/worker/src", "apps/api-vercel/src",
  "packages/client-engine/src", "packages/ui/src", "packages/api/src", "packages/core/src",
  "packages/services/src", "packages/db/src", "packages/app-logic/src",
];
const KINDS = /\.(?:ts|tsx|js|mjs|rs|json|kt|swift)$/;
const SKIPPED = /(^|\/)(node_modules|generated|target|dist|build|\.next|test|__tests__)(\/|$)|_tests\.rs$|\.test\.tsx?$|\.d\.ts$|stored-keys\.ts$|(^|\/)testing[\w-]*\.ts$/;

/**
 * SPELLINGS THE WALK MEETS THAT NAME NOTHING STORED, each with what it is. A thread, a class, a
 * release asset, a lock, a label a digest is taken under. Adding a line here is a claim that
 * nothing is kept under the name; a kept name gets a row instead.
 */
const NOT_STORED: Readonly<Record<string, string>> = {
  "ohmail-engine": "a thread's name in the desktop shell",
  "ohmail-leave": "a thread's name in the desktop shell",
  "ohmail-quit": "a thread's name in the desktop shell",
  "ohmail-leave-save": "a thread's name in the desktop shell",
  "ohmail-quitwait": "a thread's name in the desktop shell",
  "ohmail-restart-ask": "a thread's name in the desktop shell",
  "ohmail-engine.mjs": "the engine bundle's file name inside the app, part of the build",
  "ohmail.app.tar.gz": "a release asset's name",
  "ohmail-linux-x86_64.AppImage": "a release asset's name",
  "ohmail-linux-aarch64.AppImage": "a release asset's name",
  "ohmail-windows-setup.exe": "a release asset's name",
  "ohmail-{version}-setup-{n}.exe": "a downloaded installer's name pattern",
  "ohmail-diagnostics": "the kind word inside a diagnostic file",
  "ohmail-diagnostics:v1:": "the label a diagnostic file's digest is taken under",
  "ohmail-csrf:v1:": "the label the CSRF token is derived under",
  "ohmail-staff-enroll:v1:": "the label a staff enrolment's signature is taken under",
  "ohmail-api": "the issuer word of a staff assertion",
  "ohmail-cloud": "the prefix of a hosted organizer's install id",
  "ohmail-desktop": "a user-agent word",
  "ohmail-": "a user-agent word's prefix",
  "ohmail-desktop-host.invalid": "the name on the local door's own certificate",
  "ohmail-organizer": "the phone's background task name",
  "ohmail-new-mail": "a notification's tag",
  "ohmail-omarchy-live": "a style element's id",
  "ohmail-hear-probe": "a message type a letter's frame is asked with",
  "ohmail-link:": "the scheme a letter's links are rewritten to inside its frame",
  "ohmail-lr": "a class name of the last-resort page",
  "ohmail-lr-card": "a class name of the last-resort page",
  "ohmail-lr-copy": "a class name of the last-resort page",
  "ohmail-lr-fact": "a class name of the last-resort page",
  "ohmail-lr-go": "a class name of the last-resort page",
  "ohmail-recovery-codes.txt": "the name offered for a downloaded file of recovery codes",
  "ohmail-settings-": "the name offered for a downloaded settings export",
  "ohmail.app": "the product's domain",
  "app.ohmail.app": "a host name that redirects to the product's domain",
  "ohmail.example.com": "a placeholder host in a form",
  "ohmail.desktop": "the tail of the desktop identifier inside a longer literal",
  "ohmail://link?code=": "the desktop's link scheme with its one parameter",
  "ohmail:wake": "a message type between the service worker and its page",
  "ohmail:durability-lost": "a window event's name",
  "ohmail:session-refresh": "a lock's name: tabs take turns under it and nothing is stored",
  "ohmail.engine.": "a lock's name per window of a device copy: nothing is stored",
  "ohmail.host.rotate": "a lock's name on the paired page: nothing is stored",
  "ohmail.node-absent.reached": "a symbol's description in a shim",
  "ohmail.releaseGate": "a symbol's description on a send's options",
  "ohmail_{}": "a generated name for a portal request",
  "ohmail_ingest_": "a prepared statement's name prefix",
  "ohmail_page_letter": "a savepoint's name",
  "app.ohmail.push.WakePayloadRenderer": "a class name in the phone's configuration",
  "tf_csrf=": "the head of a cookie line the server writes; the cookie is a row",
  "tf_refresh=": "the head of a cookie line the server writes; the cookie is a row",
  "tf_session=": "the head of a cookie line the server writes; the cookie is a row",
  "idb:ohmail-mirror": "a label in a log line for the device copy's store",
  "__gen": "a key inside the device copy's own meta store; the copy is a row",
  "__owner": "a key inside the device copy's own meta store; the copy is a row",
  "cursor": "a key inside the device copy's own meta store; the copy is a row",
  "attempt": "an object store's name inside a database that is a row",
  "owed": "an object store's name inside a database that is a row",
  "compose": "the one name the compose surface's send state is held under in memory",
  "approve": "a query parameter's name in the desktop's link",
  "code": "a query parameter's name in the desktop's link",
  "link-desktop": "a query parameter's name in the desktop's link",
  "server-mailboxes": "a query parameter's name in the desktop's link",
  "credential-manager": "the name of a platform's keystore in a log line",
  "keychain": "the name of a platform's keystore in a log line",
  "secret-service": "the name of a platform's keystore in a log line",
  "ohmail-ImageProxy/1.0": "a user-agent word",
  "ohmail-Unsubscribe/1.0": "a user-agent word",
  "ohmail/scheduled-file/1\\n": "the label a scheduled file's seal is taken under",
  "ohmail_admin": "a database role's name and the brand word of its handle",
  "ohmail_change_log": "the database's notification channel for the feed",
  "ohmail.db.dialect": "a symbol's description on a database handle",
  "ohmail.db.dialect.txWrapped": "a symbol's description on a database handle",
  "ohmail.db.inTransaction": "a symbol's description on a database handle",
  "ohmail.db.erasureFence": "a symbol's description on a database handle",
  "ohmail_sqlite_migrations": "a table's name inside a device's store; the store is a row",
  "ohmail-backup-exclusions": "a build plugin's name in the phone app",
  "ohmail-host-pinning-install": "a build plugin's name in the phone app",
  "ohmail-live-text-size": "a build plugin's name in the phone app",
  "ohmail-release-minification": "a build plugin's name in the phone app",
  "ohmail-wake-push-renderer": "a build plugin's name in the phone app",
  "ohmail-ios-scene-lifecycle": "a build plugin's name in the phone app",
  "ohmail-without-embedded-fcm": "a build plugin's name in the phone app",
  "ohmail_backup_rules": "a resource's name in the phone app: what a backup leaves out",
  "ohmail_data_extraction_rules": "a resource's name in the phone app: what a backup leaves out",
  "ohmail_wake_title": "a string resource's name in the phone app",
  "ohmail_wake_channel": "a string resource's name in the phone app",
  "ohmail_wake_strings.xml": "a resource file's name in the phone app's build",
  "app.ohmail.push": "the package of the phone's push renderer",
  "app.ohmail.backupexclusion.BackupExclusionModule": "a class name in the phone's configuration",
  "app.ohmail.enginelog.EngineLogSinkModule": "a class name in the phone's configuration",
  "app.ohmail.hostpinning.HostPinningModule": "a class name in the phone's configuration",
  "app.ohmail.posture.OhmailPostureModule": "a class name in the phone's configuration",
  "app.ohmail.organizer.OrganizerServiceModule": "a class name in the phone's configuration",
  "app.ohmail.organizer.STOP": "an intent's action word inside the phone app",
  "ohmail.engine": "a log tag on the phone",
  "app.ohmail.engine": "a log subsystem's name on the phone",
  "app.ohmail.network": "a queue's label on the phone",
};

/**
 * A SPELLING THAT NAMES NOTHING STORED IN ONE FILE: `<file> <spelling>`, with what it is there. For
 * a word too plain to be let through everywhere (a file of the system's own, read by its name),
 * and for a row's spelling that is something else in that file. Anywhere else the spelling is
 * still read.
 */
const NOT_STORED_HERE: Readonly<Record<string, string>> = {
  "apps/desktop/src-tauri/src/updater.rs ohmail-install": "a thread's name in the desktop shell; the row is the phone's install marker",
  "apps/desktop/src-tauri/src/engine.rs attachment": "the name a saved attachment gets when its sender gave none a file system takes",
  "apps/desktop/src-tauri/src/engine.rs Downloads": "the person's own Downloads folder, by the platform's name",
  "apps/desktop/src-tauri/src/last_words.rs stat": "a file of the system's own under /proc",
  "apps/desktop/src-tauri/src/vitals.rs stat": "a file of the system's own under /proc",
  "apps/desktop/src-tauri/src/vitals.rs cgroup": "a file of the system's own under /proc",
  "apps/desktop/src-tauri/src/vitals.rs cmdline": "a file of the system's own under /proc",
  "apps/desktop/src-tauri/src/vitals.rs status": "a file of the system's own under /proc",
  "apps/desktop/src-tauri/src/vitals.rs oom_score_adj": "a file of the system's own under /proc",
  "apps/sidecar/src/db.ts pg_wal": "a folder of the database's own inside the store; the store is a row",
  "apps/sidecar/src/db.ts PG_VERSION": "a file of the database's own inside the store; the store is a row",
  "apps/sidecar/src/fresh-store.ts PG_VERSION": "a file of the database's own inside the store; the store is a row",
  "apps/sidecar/src/host-lan-tls.ts 2.5.29.17": "an object identifier in the local door's certificate",
  "packages/services/src/auth/auth-service.ts ack=": "the head of a field inside a row of the server's database",
  "apps/mobile/modules/organizer-service/android/src/main/java/app/ohmail/organizer/OrganizerService.kt channelName": "an intent extra's name inside the phone app",
};

/**
 * NAMES A MAILBOX MAY STILL HOLD FROM AN EARLIER RELEASE, each with the row it is rewritten into.
 * Listed here and not in the registry, because product source may spell the news folder's earlier
 * name only in its resolver (`test/news-folder-literal-census.test.ts`) and the registry is
 * product source. The folder holds a person's mail, so it is read and renamed, never dropped.
 */
const EARLIER_NAMES: Readonly<Record<string, string>> = { "ohmail/Reads": "ohmail/News" };

/** Form 1. A spelling that starts as the product names things. */
const PRODUCT = /^(?:ohmail[._:/-]|tf_|__Host-|io\.ohmail|app\.ohmail)/;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** Form 2. The first argument of a call that reads or writes a store, whatever it is called. */
const USED = new RegExp(
  "(?:\\b(?:getItem|setItem|removeItem|getItemAsync|setItemAsync|deleteItemAsync"
  + "|durableSet|durableRemove|durableSessionSet|durableSessionRemove|durableProbe"
  + "|openDatabase(?:Async|Sync)?|deleteDatabase(?:Async|Sync)?|getSharedPreferences|NotificationChannel|mailboxCreate)"
  + "|\\bindexedDB\\.(?:open|deleteDatabase)|\\bcaches\\.(?:open|delete|has)|\\bnew BroadcastChannel"
  + "|\\bkv\\??\\.(?:get|set|remove))"
  + "\\(\\s*([\"'`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1", "g");

/** Form 3. A file that touches a store: there, a constant named as a key, a file, a folder or a channel is read too. */
const TOUCHES_A_STORE = new RegExp([
  "\\blocalStorage\\b", "\\bsessionStorage\\b", "\\bindexedDB\\b", "\\bcaches\\.(?:open|delete|keys|match)\\b",
  "document\\.cookie", "Set-Cookie", "\\bSecureStore\\b", "openDatabase(?:Async|Sync)?\\b", "keyring::",
  "\\bBroadcastChannel\\b", "\\bdurable(?:Local|Session)?(?:Set|Get|Remove)\\b", "navigator\\.locks",
  "_FILE(?:_NAME)?\\b[^=\\n]*=\\s*\"", "_FILE(?:_NAME)?: &str",
  "\\bNotificationChannel\\b", "\\bSharedPreferences\\b", "\\bUserDefaults\\b", "\\bmailboxCreate\\b",
  "\\bkv\\??\\.(?:get|set|remove)\\(", "\\bSecureKV\\b",
].join("|"));
const NAMED = new RegExp(
  "\\b((?:[A-Za-z_][A-Za-z0-9_]*)?(?:_KEY|KEY|_FILE|_FILE_NAME|_DB|COOKIE|_CACHE|_PREFIX|_DIR_NAME|_SUBDIR|_STORE"
  + "|_NAME|_SEAL|_SUFFIX|_MARKER|_SERVICE|_ENTRY|CHANNEL_ID))\\b[^=\\n;]{0,40}=\\s*([\"'`])([^\"'`\\n]+)\\2", "g");

/** Form 4. A file that writes files: there, the literal a joined path ends in is read too. */
const WRITES_FILES = new RegExp([
  "\\b(?:writeFile|appendFile|rename|mkdir|copyFile|rm|unlink)Sync\\b", "\\bcreateWriteStream\\b",
  "\\bfs::(?:write|rename|copy|create_dir|create_dir_all|remove_file|remove_dir_all)\\b", "\\bFile::create\\b", "\\bOpenOptions\\b",
].join("|"));
const FILE_NAME = "([\"'`])([A-Za-z0-9._@+-]*[A-Za-z][A-Za-z0-9._@+-]*)\\1\\s*\\)";
const JOINED = new RegExp("(?<![.\\w])(?:join|resolve)\\((?:[^()\"'`\\n]|\\([^()\\n]*\\))*," + "\\s*" + FILE_NAME, "g");
const JOINED_RUST = new RegExp("\\.(?:join|with_file_name|with_extension|push)\\(\\s*" + FILE_NAME, "g");

/** Form 5. A Rust function named as a file's or a folder's name: the literals it answers. */
const NAMING_FN = /\bfn\s+\w*(?:dir_name|file_name)\s*\([^)]*\)\s*->\s*&'static str\s*\{([\s\S]*?)\n {4}\}/g;
const ARM = /=>\s*"([^"\n]+)"/g;

/** Comments blanked, line for line, so a name in prose is not a name in code. */
const withoutComments = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, a: string) => a + " ".repeat(m.length - a.length));

interface Found { spelling: string; at: string }

/** Every candidate spelling of one file, in the five forms. A composed name counts as its fixed head. */
function candidatesIn(file: string, raw: string): Found[] {
  const text = file.endsWith(".json") ? raw : withoutComments(raw);
  const out: Found[] = [];
  /** A sentence is no name, except where it stands as a store call's own argument. */
  const note = (spelling: string, index: number, sentences = false): void => {
    const head = spelling.includes("${") ? spelling.slice(0, spelling.indexOf("${")) : spelling;
    if (head === "" || (!sentences && /\s/.test(head))) return;
    out.push({ spelling: head, at: `${file}:${text.slice(0, index).split("\n").length}` });
  };
  for (const m of text.matchAll(LITERAL)) if (PRODUCT.test(m[2]!)) note(m[2]!, m.index!);
  for (const m of text.matchAll(USED)) note(m[2]!, m.index!, true);
  if (TOUCHES_A_STORE.test(raw) || file.endsWith(".json")) for (const m of text.matchAll(NAMED)) note(m[3]!, m.index!);
  if (WRITES_FILES.test(raw)) for (const m of text.matchAll(file.endsWith(".rs") ? JOINED_RUST : JOINED)) note(m[2]!, m.index!);
  if (file.endsWith(".rs")) for (const f of text.matchAll(NAMING_FN)) for (const m of f[1]!.matchAll(ARM)) note(m[1]!, f.index!);
  return [...new Map(out.map((c) => [`${c.at} ${c.spelling}`, c])).values()];
}

/** The file of a `file:line`. */
const fileOf = (at: string): string => at.slice(0, at.lastIndexOf(":"));

/** A mailbox's folder and an app's identifier travel through the code as values; their rows name the files that write them. */
const TRAVELS: ReadonlySet<StoredKeyRow["store"]> = new Set(["mailbox", "identifier"]);

/**
 * The candidates that are not accounted for: no row, no family's row and neither listed as
 * unstored nor as an earlier name; or the name of a device's or a cookie's row, met in a file
 * that no row of that name names.
 */
function unregistered(
  found: readonly Found[], rows: readonly StoredKeyRow[],
  notStored: Readonly<Record<string, string>>, notStoredHere: Readonly<Record<string, string>> = {},
): string[] {
  const earlier = new Set(Object.keys(EARLIER_NAMES));
  const out: string[] = [];
  for (const { spelling, at } of found) {
    if (earlier.has(spelling) || spelling in notStored || `${fileOf(at)} ${spelling}` in notStoredHere) continue;
    const mine = rows.filter((r) => r.key === spelling || (r.family === true && spelling.startsWith(r.key)));
    if (mine.length === 0) out.push(`${at} ${spelling}`);
    else if (!mine.some((r) => TRAVELS.has(r.store) || r.at.includes(fileOf(at)))) out.push(`${at} ${spelling}: a row, and none of its rows names this file`);
  }
  return out;
}

/** The rows whose spelling is not in a file they name. */
function strayRows(rows: readonly StoredKeyRow[], read: (file: string) => string | null): string[] {
  const out: string[] = [];
  for (const r of rows) for (const f of r.at) {
    const text = read(f);
    if (text === null) out.push(`${r.key}: ${f} is not a file`);
    else if (!text.includes(r.key)) out.push(`${r.key}: not spelled in ${f}`);
  }
  return out;
}

/** What is wrong with the rows among themselves. */
function malformed(rows: readonly StoredKeyRow[]): string[] {
  const keys = new Set(rows.map((r) => r.key));
  const out: string[] = [];
  for (const r of rows) {
    if (r.at.length === 0) out.push(`${r.key}: names no file`);
    if (r.holds.trim() === "") out.push(`${r.key}: does not say what it holds`);
    if (typeof r.mark === "object" && "rewritten" in r.mark && !keys.has(r.mark.rewritten)) out.push(`${r.key}: rewritten into ${r.mark.rewritten}, which is no row`);
    if (typeof r.mark === "object" && "dropped" in r.mark) {
      if (r.mark.dropped.trim() === "") out.push(`${r.key}: dropped without a reason`);
      if (r.words) out.push(`${r.key}: holds a person's words and is dropped`);
    }
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.key} in ${r.store}`;
    if (seen.has(id)) out.push(`${id}: twice`);
    seen.add(id);
  }
  return out;
}

const files: string[] = [];
const walk = (p: string): void => {
  if (statSync(p).isDirectory()) { for (const e of readdirSync(p)) walk(join(p, e)); return; }
  const rel = relative(ROOT, p).split(sep).join("/");
  if (KINDS.test(rel) && !SKIPPED.test(rel)) files.push(rel);
};
for (const t of TREES) walk(join(ROOT, t));
const read = (file: string): string | null => {
  try { return readFileSync(join(ROOT, file), "utf8"); } catch { return null; }
};

describe("the registry of stored keys", () => {
  const found = files.flatMap((f) => candidatesIn(f, read(f)!));

  it("walked the clients with their native halves, the engine and the servers, and has its rows", () => {
    expect(files.length).toBeGreaterThan(1500);
    for (const kind of [".rs", ".kt", ".swift", ".js", ".json"]) expect(files.some((f) => f.endsWith(kind)), kind).toBe(true);
    expect(new Set(STORED_KEYS.map((r) => r.key)).size).toBeGreaterThanOrEqual(160);
  });

  it("every row's spelling stands in each file the row names", () => {
    expect(strayRows(STORED_KEYS, read)).toEqual([]);
  });

  it("every spelling read as a stored name is a row that names its file, or is listed as unstored", () => {
    expect(found.length).toBeGreaterThan(400);
    expect(unregistered(found, STORED_KEYS, NOT_STORED, NOT_STORED_HERE)).toEqual([]);
  });

  it("no line of the unstored lists is dead, and none hides a row", () => {
    const met = new Set(found.map((c) => c.spelling));
    const metAt = new Set(found.map((c) => `${fileOf(c.at)} ${c.spelling}`));
    const keys = new Set<string>(STORED_KEYS.map((r) => r.key));
    expect(Object.keys(NOT_STORED).filter((s) => !met.has(s)), "listed, met nowhere").toEqual([]);
    expect(Object.keys(NOT_STORED).filter((s) => keys.has(s)), "listed as unstored and a row").toEqual([]);
    expect(Object.keys(NOT_STORED_HERE).filter((s) => !metAt.has(s)), "listed for a file, not met there").toEqual([]);
    expect(Object.keys(NOT_STORED_HERE).filter((s) => s.slice(s.indexOf(" ") + 1) in NOT_STORED), "listed for a file and for everywhere").toEqual([]);
  });

  it("the rows are whole: a file each, a reason for a drop, a target that is a row, no words dropped", () => {
    expect(malformed(STORED_KEYS)).toEqual([]);
  });

  it("an earlier name is still met in the tree, is no row, and becomes one that holds mail", () => {
    const met = new Set(found.map((c) => c.spelling));
    const rows = new Map<string, StoredKeyRow>(STORED_KEYS.map((r) => [r.key, r]));
    for (const [earlier, now] of Object.entries(EARLIER_NAMES)) {
      expect(met.has(earlier), `${earlier}: met nowhere`).toBe(true);
      expect(rows.has(earlier), `${earlier}: also a row`).toBe(false);
      expect(rows.get(now), `${earlier}: becomes ${now}, which is no row`).toMatchObject({ store: "mailbox", words: true, mark: "kept" });
    }
  });

  const known: StoredKeyRow = {
    key: "ohmail.known.", family: true, store: "localStorage", owner: "web", at: ["planted.ts"],
    holds: "a thing", words: false, erased: "never", mark: "kept",
  };
  /** What the census says of one planted file, beside the one known row. */
  const refused = (file: string, lines: readonly string[], rows: readonly StoredKeyRow[] = [known]): string[] =>
    unregistered(candidatesIn(file, lines.join("\n")), rows, NOT_STORED);

  it("REFUSES an unregistered key that starts as the product names things, wherever it is spelled", () => {
    expect(refused("planted.ts", [
      'localStorage.setItem("ohmail.planted", "1");',
      "const OWNED = `ohmail.known.${owner}`;",
      "// a comment may say \"ohmail.in-prose\" freely",
      'const label = "ohmail-lr";',
    ])).toEqual(["planted.ts:1 ohmail.planted"]);
  });

  it("REFUSES one that is the first argument of a store's call, whatever it is called", () => {
    expect(refused("planted.ts", [
      'localStorage.setItem("textSizeBackup", "1");',
      'sessionStorage.getItem("tab");',
      'durableSet("draft backup", body, "compose");',
      'await SecureStore.setItemAsync("appearance.backup", raw);',
      'await this.kv.set("pairing.backup", raw);',
      'const db = await SQLite.openDatabaseAsync("side.db");',
      'indexedDB.open("side-copy", 1);',
      'await caches.open("pages-v2");',
      'new BroadcastChannel("tabs");',
      'await client.mailboxCreate("Archive/Old");',
      'map.setItem(key, "a value is not a name");',
    ])).toEqual([
      "planted.ts:1 textSizeBackup", "planted.ts:2 tab", "planted.ts:3 draft backup", "planted.ts:4 appearance.backup",
      "planted.ts:5 pairing.backup", "planted.ts:6 side.db", "planted.ts:7 side-copy", "planted.ts:8 pages-v2", "planted.ts:9 tabs",
      "planted.ts:10 Archive/Old",
    ]);
  });

  it("REFUSES one assigned to a constant named as a key, a file, a folder or a channel, in a file that touches a store", () => {
    expect(refused("planted.ts", [
      "const SIDE_FILE = \"side-notes.json\"; // beside localStorage",
      'const PLANTED_NAME = "appearance.backup";',
      'export const SESSION_SEAL = "planted-tokens.seal";',
      'const ASIDE_SUFFIX = ".aside";',
    ])).toEqual([
      "planted.ts:1 side-notes.json", "planted.ts:2 appearance.backup", "planted.ts:3 planted-tokens.seal", "planted.ts:4 .aside",
    ]);
    expect(refused("Planted.kt", [
      'const val CHANNEL_ID = "reminders"',
      "val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)",
    ])).toEqual(["Planted.kt:1 reminders"]);
    expect(refused("planted.rs", [
      'pub const KEYSTORE_SERVICE: &str = "planted";',
      "let entry = keyring::Entry::new(KEYSTORE_SERVICE, KEYSTORE_ENTRY);",
    ])).toEqual(["planted.rs:1 planted"]);
    // The same constant where nothing is stored is a word and no name.
    expect(refused("plain.ts", ['const PLANTED_NAME = "appearance.backup";'])).toEqual([]);
  });

  it("REFUSES one that ends a joined path in a file that writes files", () => {
    expect(refused("planted.ts", [
      'import { join } from "node:path";',
      'const sealPath = join(dataDir, "planted-tokens.seal");',
      'writeFileSync(join(dirname(sealPath), "planted.json"), body);',
      'const line = words.join("and");',
    ])).toEqual(["planted.ts:2 planted-tokens.seal", "planted.ts:3 planted.json"]);
    expect(refused("planted.rs", [
      'let dir = root.join("planted-dir");',
      'name.push(".planted");',
      'let old = path.with_extension("log.planted");',
      "fs::create_dir_all(&dir)?;",
    ])).toEqual(["planted.rs:1 planted-dir", "planted.rs:2 .planted", "planted.rs:3 log.planted"]);
    // A path that is only read is another program's file as often as ours.
    expect(refused("reads.ts", ['const text = readFileSync(join(root, "theirs.toml"), "utf8");'])).toEqual([]);
  });

  it("REFUSES what a Rust function named as a folder's or a file's name answers", () => {
    expect(refused("planted.rs", [
      "    pub fn dir_name(self) -> &'static str {",
      "        match self {",
      '            Mode::Local => "planted-local",',
      '            Mode::Cloud => "planted-cloud",',
      "        }",
      "    }",
      "    pub fn as_str(self) -> &'static str {",
      "        match self {",
      '            Mode::Local => "local",',
      "        }",
      "    }",
    ])).toEqual(["planted.rs:1 planted-local", "planted.rs:1 planted-cloud"]);
  });

  it("REFUSES a known key kept from a file that no row of it names, and lets a mailbox's folder travel", () => {
    const folder: StoredKeyRow = { ...known, key: "ohmail/Planted", family: undefined, store: "mailbox", at: ["writer.ts"] } as StoredKeyRow;
    expect(refused("phone.ts", [
      'const PLANTED_KEY = "ohmail.known.face";',
      'if (path === "ohmail/Planted") return;',
    ], [known, folder])).toEqual(["phone.ts:1 ohmail.known.face: a row, and none of its rows names this file"]);
    expect(unregistered(
      [{ spelling: "ohmail.known.face", at: "phone.ts:1" }], [known], NOT_STORED, { "phone.ts ohmail.known.face": "a word there" },
    )).toEqual([]);
  });

  it("REFUSES a row whose file no longer spells it, and rows that are not whole", () => {
    const base = { store: "localStorage", owner: "web", holds: "a thing", erased: "never" } as const;
    const rows: StoredKeyRow[] = [
      { ...base, key: "ohmail.here", at: ["a.ts"], words: false, mark: "kept" },
      { ...base, key: "ohmail.moved", at: ["a.ts", "gone.ts"], words: false, mark: "kept" },
      { ...base, key: "ohmail.old", at: ["a.ts"], words: false, mark: { rewritten: "ohmail.nowhere" } },
      { ...base, key: "ohmail.words", at: ["a.ts"], words: true, mark: { dropped: "" } },
      { ...base, key: "ohmail.here", at: [], words: false, mark: "kept" },
    ];
    const tree: Record<string, string> = { "a.ts": 'x("ohmail.here"); y("ohmail.old"); z("ohmail.words");' };
    expect(strayRows(rows, (f) => tree[f] ?? null)).toEqual([
      "ohmail.moved: not spelled in a.ts",
      "ohmail.moved: gone.ts is not a file",
    ]);
    expect(malformed(rows)).toEqual([
      "ohmail.old: rewritten into ohmail.nowhere, which is no row",
      "ohmail.words: dropped without a reason",
      "ohmail.words: holds a person's words and is dropped",
      "ohmail.here: names no file",
      "ohmail.here in localStorage: twice",
    ]);
  });
});
