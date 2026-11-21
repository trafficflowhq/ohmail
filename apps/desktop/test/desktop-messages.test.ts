import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import desktopConfig, { SHELL_MESSAGE_KEYS, SHELL_MESSAGE_NAMESPACES, WINDOW_ONLY_NAMESPACES } from "../vite.config.js";

/**
 * The desktop binary must not contain the marketing site's copy.
 *
 * `apps/webapp/messages/en.json` serves two products from one file — it holds the
 * landing page's nav, pricing table and FAQ as well as the app's own strings —
 * and `apps/desktop/src/main.tsx` imports it whole. So the shipped
 * `v0.2.0-preview` Linux binary answered `strings` with `$9 a month`: a price, inside
 * a build that has no account and cannot be subscribed to, which also silently dates
 * the artifact the moment the price changes.
 *
 * `vite.config.ts`'s `shellMessagesOnly()` filters the module at build time to the
 * namespaces the shell reads. That list is the thing this file guards, and it guards
 * it in the only direction that actually breaks: a namespace the UI STARTS reading
 * without anyone updating the filter, which is not a build error — `use-intl` renders
 * the raw key. So the list is re-derived here from the sources and compared.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

/**
 * ── THE SCAN ROOTS ARE DERIVED FROM THE PAYLOAD, NOT RESTATED HERE ─────────────────────────
 *
 * They used to be four paths written out by hand. The list was right the day it was written
 * and did not move when the payload did: `apps/webapp/app/components` was added to
 * `scripts/publish-desktop.mjs` afterwards — its entry there says "Found by the import-
 * resolvability gate, not by a reader" — and this scan never followed it. So the two
 * components the reading pane is composed from, `AttachmentStrip` and `MessageBody`, sat
 * outside every check in this file. Same shape as the list behind the v0.7.2 blank screen:
 * correct when written, silently stale afterwards, and nothing in between says so.
 *
 * The roots are the bundle's own directories, written out once below — and where the payload
 * config is present, every root is proven to be PUBLISHED (equal to a `.tsx`-admitting payload
 * entry or inside one). Deriving the roots from `PAYLOAD` itself was this file's original
 * design, and it stopped being right when the payload grew past the bundle: the mirror
 * publishes the whole web application, while the desktop compiles three of its directories.
 * The proof that survives is coverage, not equality.
 *
 * The walk still takes `.ts` as well as `.tsx`, so a root published as `.tsx`-only is
 * over-scanned by its `.ts` siblings. That is the safe direction: over-scanning can only put
 * a spare namespace in the binary, under-scanning is what renders a raw key to a reader.
 *
 * ── WHY THE ARRAY IS PARSED AND NOT IMPORTED ──
 *
 * `publish-desktop.mjs` has no main guard — it works at the top level, and importing it runs
 * the generated-stub check and the engine gates, which is a publish's preflight and not a
 * test's. So the literal is extracted as source text and evaluated in a `node:vm` context
 * with no globals: the entries are strings and plain objects and need nothing from outside.
 * `test/desktop-mirror-excludes-the-engine.test.ts` reads the same array by the same route,
 * for the same reason.
 *
 * EVERY WAY THE EXTRACTION CAN FAIL THROWS, and that is the point rather than caution. A scan
 * over zero directories reads zero files and finds zero namespaces, and the comparison below
 * would then pass against an empty set — the guard reporting success at precisely the moment
 * it lost the ability to look. That is the defect being fixed here, so the fix must not
 * reintroduce it one layer down.
 *
 * ── AND ONE PLACE WHERE THE PUBLISHER GENUINELY IS NOT THERE ──
 *
 * This file is itself published, and this repository's own README says to run it. The publisher
 * is workspace machinery and is not published, so in a public checkout the extraction has
 * nothing to read — which is a different state from "the extraction broke", and must not be
 * reported as one. The roots in {@link MIRROR_SOURCE_DIRS} below work in both checkouts; the
 * coverage case runs only where the publisher IS present, so a root the payload stops
 * publishing is caught in the checkout that can fix it. A file is missing is an answer, a
 * file is missing and the guard shrugged is not.
 */
const PUBLISHER = "scripts/publish-desktop.mjs";
const HAVE_PUBLISHER = fs.existsSync(path.join(REPO, PUBLISHER));

/**
 * The roots a checkout without the publisher uses, and the copy the case below holds the
 * derivation to. Written out ONCE, in one place, checked on every run that can check it —
 * rather than the four-path list this file used to open with, which nothing compared to
 * anything and which is how `apps/webapp/app/components` stayed missing.
 */
const MIRROR_SOURCE_DIRS = [
  "apps/desktop/src",
  "apps/paired-page/src",
  "apps/webapp/app/components",
  "packages/letter-body/src",
  "apps/webapp/app/shell",
  "apps/webapp/app/views",
  "packages/app-logic/src",
  // The frame and its text reader (`@ohmail/app/text`): the window draws it, so what it reads ships.
  "packages/app/src",
  "packages/ui/src",
];

function payloadTsxDirs(): string[] {
  const src = fs.readFileSync(path.join(REPO, PUBLISHER), "utf8");
  const m = src.match(/const PAYLOAD = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error(`could not extract PAYLOAD from ${PUBLISHER}`);
  const payload = vm.runInNewContext(`[${m[1]}]`) as { from: string; ext?: string[] }[];
  if (!Array.isArray(payload) || payload.length < 20) {
    throw new Error(
      `PAYLOAD parsed to ${Array.isArray(payload) ? `${payload.length} entries` : typeof payload} — ` +
        "the extraction is broken, not the payload",
    );
  }
  // Test directories are published (their .tsx joined the payload when the desktop grew a
  // component test) but they are not SOURCES — this scan asks what the shipped interface
  // reads, and a test's key literals are fixtures, not reads. Without this filter a test
  // that mentions `t("a.b")` as an example mints an "a" namespace nothing serves.
  const dirs = payload
    .filter((e) => e.ext?.includes(".tsx") && !e.from.endsWith("/test"))
    .map((e) => e.from);
  /* This used to be a count floor (`< 4` threw). The payload widening consolidated the shared
   * shell/views/components entries into the one whole-directory `apps/webapp/app` entry, so the
   * count legitimately FELL while coverage grew — a floor cannot tell that apart from the filter
   * breaking. The bundle's source roots are pinned by name instead: losing any of them from the
   * .tsx-admitting set means the scan below silently skips shipped interface sources, which is
   * the regression this guard exists to catch, whatever the entry count does. */
  for (const root of ["apps/desktop/src", "apps/webapp/app", "packages/ui/src"]) {
    if (!dirs.includes(root)) {
      throw new Error(
        `the .tsx extension filter no longer matches ${root} — the desktop bundle is built from ` +
          "it, so the key scan would silently skip shipped interface sources",
      );
    }
  }
  return dirs;
}

/**
 * The scan roots are the BUNDLE'S OWN, not the payload's, and the two stopped being the same
 * set when the payload widened: the mirror publishes the whole web application (marketing and
 * account pages included, under the one `apps/webapp/app` entry), while the desktop bundle is
 * built from three of its subdirectories plus its own entry point and the design system. A
 * scan over the payload's roots would read pages the bundle never ships and mint their
 * namespaces into a comparison about the DESKTOP interface. So the written-out roots are the
 * primary everywhere, and the payload case below holds the anti-drift property in the form
 * that is still true: every root this scan reads is published — equal to a payload entry or
 * inside one — so the mirror's copy of this test can always find its sources.
 */
const SOURCE_DIRS = MIRROR_SOURCE_DIRS;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = path.join(REPO, dir);
    // A missing scan root THROWS. It used to be skipped, which meant a root that had been
    // renamed or removed contributed nothing and every case below went on passing over
    // whatever was left — the vacuous-scan failure, one directory at a time.
    if (!fs.existsSync(abs)) throw new Error(`scan root ${dir} does not exist`);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of SOURCE_DIRS) walk(d);
  return out;
}

/**
 * The namespaces the shell reads, from THREE call shapes:
 *  · `useTranslations("ohbox")` → the namespace is the argument;
 *  · `useTranslations()` unscoped (AppShell.tsx) → the namespace is the first
 *    segment of every dotted key passed to the returned `t`;
 *  · `liveCopy("mailBody", …)` / `activeTranslator("place")` → the NON-HOOK read;
 *  · `bodyCopy("mailBody", …)` → the body package's own non-hook read (`packages/letter-body/src/words.ts`).
 *
 * The second shape is the one a reader misses, and missing it renders key names.
 *
 * ── WHY THE THIRD SHAPE IS HERE, AND WHY IT IS NOT A LOOPHOLE ───────────────────────────────────
 *
 * Three surfaces cannot call a hook and still have words on screen. `format.ts` is a function
 * library — `screener-state.ts` reads its view-name table from inside a reducer and `AppShell` from
 * inside a toast callback — and the reading pane's `MessageBody`, `AttachmentStrip` and
 * `AttachmentPreview` are each rendered bare, with no intl provider above them, in a dozen unit
 * tests. `app/shell/locale.ts`'s `liveCopy`/`activeTranslator` is how those four read the SAME
 * catalogue through the SAME ICU implementation without a React context.
 *
 * They are counted for precisely the reason the other two shapes are: a namespace a source READS
 * and this filter omits is a raw key in front of a user. Leaving them out would have made the
 * German translation of the whole reading pane invisible to this guard — the shape of failure the
 * header above describes ("correct when written, silently stale afterwards").
 */
function namespacesRead(src: string): Set<string> {
  const found = new Set<string>();
  for (const m of src.matchAll(/useTranslations\(\s*"([A-Za-z0-9_]+)"/g)) found.add(m[1]!);
  // The one text reader's door reads a namespace the same way (`@ohmail/app/text`).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/\buseText\(\s*"([A-Za-z0-9_]+)"/g)) found.add(m[1]!);
  // Settings menu facts supply this namespace to the host text reader through their label descriptors.
  for (const m of code.matchAll(/\bexport const SETTINGS_MENU_NAMESPACE = "([A-Za-z0-9_]+)"/g)) found.add(m[1]!);
  for (const m of src.matchAll(/\b(?:liveCopy|bodyCopy|activeTranslator)\(\s*"([A-Za-z0-9_]+)"/g)) {
    found.add(m[1]!);
  }

  // Unscoped: collect dotted keys from `t("a.b")` in files that call useTranslations().
  if (/useTranslations\(\s*\)/.test(src)) {
    for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)\.[A-Za-z0-9_.]+"/g)) found.add(m[1]!);
  }
  for (const ns of computedKeyNamespaces(src)) found.add(ns);
  return found;
}

/** Every scanned source file and the namespaces it reads. */
function readsByFile(): Map<string, Set<string>> {
  return new Map(sourceFiles().map((rel) => [rel, namespacesRead(read(rel))]));
}

function namespacesUsed(): Set<string> {
  return new Set([...readsByFile().values()].flatMap((reads) => [...reads]));
}

/**
 * ── THE DOORS' PAGES ARE SCANNED, AND THE DESKTOP MOUNTS NONE OF THEM ──────────────────────────
 *
 * `packages/app/src` is a scan root because the frame and its text reader ship in the window. The doors live in the
 * same package (`packages/app/src/doors`), and only the web's routes under `apps/webapp/app/(product)` mount them:
 * the window opens every page of an account in the system browser (`WEB_PLACES` in `apps/desktop/src/native.ts`),
 * and neither entry imports a door. So a namespace read only by the doors' pages does not ship; each is named here
 * with the door that reads it and why the desktop cannot reach it. An exception covers the doors' pages alone: the
 * same namespace read anywhere else in the bundle's roots is a surface the desktop draws, and is red below.
 */
const DOORS = "packages/app/src/doors/";
const DOOR_ONLY: Record<string, string> = {
  approve: "the approval (/approve) and the words the link, the authorization and the erase share: opened in the browser",
  authorizeDesktop: "the native authorization (/authorize-desktop): a web route, in the browser",
  deleteAccount: "the erase (/account/delete): a web route; the window's Account opens the browser",
  gate: "the doors' sentence for a build with no server (no page, setup, signed out, after paying): web routes",
  joinInvite: "the household invite (/join/invite): a link in a letter, opened in the browser",
  linkDesktop: "the desktop link (/link-desktop): the browser half of the window's sign-in (DoorChooser's openWeb)",
  login: "the sign-in (/login) and the words the link and the authorization share: the window signs in by its own door",
  resume: "the signed-out page (/resume) and the sign-in's reason line: web routes; the window's door is desktopDoor",
  setup: "the server setup (/setup): the window opens it in the browser (WEB_PLACES)",
  stepUp: "the step-up dialog: the web's mailbox and account routes mount it; the window's first run hands no step-up",
  subscribed: "the return after paying (/subscribed): the payment page returns to the browser",
  verify: "the email confirmation (/verify-email): a link in a letter, opened in the browser",
};

/**
 * ── THE ACCOUNT GROUP'S PANES ARE SCANNED, AND THE DESKTOP MOUNTS NONE OF THEM YET ─────────────────────────────────
 *
 * The six panes of Settings' Account group live in the same package (`packages/app/src/account`), built and seated
 * nowhere the window reaches: the window draws its own Devices and Subscription, Storage through the web shell's
 * shared pane, and the browser card for Security and Account (`DesktopWebSection`). So a namespace read only by the
 * account folder does not ship; each is named here with the pane that reads it. As the doors' exception, it covers
 * that folder alone, and a row leaves when the window mounts its pane and ships its words.
 */
const ACCOUNT = "packages/app/src/account/";
const ACCOUNT_ONLY: Record<string, string> = {
  account: "the Account pane's sheet (who is signed in, sign-out, the way to erase): the window's Account is the card",
  accountDevices: "the Devices pane's own words: the window draws its own Devices pane",
  accountInvites: "the Invites pane's own words: a self-hosted web build's pane, never the window's",
  accountLifecycle: "the Subscription pane's standing: the window draws its own Subscription",
  accountOwn: "the Account pane's and the password form's own words: the window's Account is the card",
  accountSecurity: "the Security pane's own words: the window's Security is the card",
  accountStorage: "the Storage pane's own words: the window draws Storage with the web shell's shared pane",
  accountSubscription: "the Subscription pane's own words: the window draws its own Subscription",
  devices: "the Devices pane, and the factor's 'nothing ran' Storage says: the window draws its own Devices pane",
  invites: "the Invites pane: a self-hosted web build's pane, never the window's",
  passwordChange: "the password form: the window's Account is the card, and the wall that mounts it is a web route",
  security: "the Security pane: the window's Security is the card",
};

/**
 * ── THE PHONE'S DOOR PAGE IS SCANNED, AND THE DESKTOP MOUNTS NONE OF IT ─────────────────────────────────────────────
 *
 * The phone's ways in (`packages/app/src/phone-door`) are drawn on the phone's own door page alone
 * (`apps/mobile/web`, by `@ohmail/app/phone-door`); neither of the desktop's entries imports them. As the doors'
 * exception, it covers that folder alone.
 */
const PHONE_DOOR = "packages/app/src/phone-door/";
const PHONE_DOOR_ONLY: Record<string, string> = {
  phoneDoor: "the phone's ways in and its form's words: drawn on the phone's door page, never in the window",
  phoneRefusal: "what the phone's native side refused, said by its code",
};
const PHONE_SETTINGS_ONLY: Record<string, string> = {
  phoneSettings: "the phone's own Settings panes",
  phoneRefusal: PHONE_DOOR_ONLY.phoneRefusal!,
};
const PHONE_SERVERS_ONLY: Record<string, string> = {
  servers: "the phone's organizer roster and connection",
  phoneRefusal: PHONE_DOOR_ONLY.phoneRefusal!,
};

/** Each folder whose namespaces are read and not shipped, with its exceptions. */
const ONLY_IN: readonly (readonly [string, Record<string, string>])[] = [
  [DOORS, DOOR_ONLY],
  [ACCOUNT, ACCOUNT_ONLY],
  [PHONE_DOOR, PHONE_DOOR_ONLY],
  ["packages/app/src/phone-settings/", PHONE_SETTINGS_ONLY],
  ["packages/app/src/servers/", PHONE_SERVERS_ONLY],
];

/**
 * What the shipped lists and the exceptions leave unexplained: a namespace on neither list and not excepted, or an
 * excepted one read outside its folder. Empty is green.
 */
function unexplained(reads: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const shipped = new Set<string>([...SHELL_MESSAGE_NAMESPACES, ...Object.keys(SHELL_MESSAGE_KEYS)]);
  const out = new Set<string>();
  for (const [file, namespaces] of reads) {
    for (const ns of namespaces) {
      if (shipped.has(ns)) continue;
      const owners = ONLY_IN.filter(([, table]) => Object.hasOwn(table, ns));
      if (owners.length === 0) out.add(ns);
      else if (!owners.some(([directory]) => file.startsWith(directory))) out.add(`${ns} in ${file}`);
    }
  }
  return [...out].sort();
}

/**
 * The FOURTH shape: a key computed away from its `t` and handed over in a variable
 * (`mail-send.ts`'s `sentCopySay` returns `` `sentCopy.${…}` `` to `SendingLine`'s unscoped `t`). A quoted
 * or template literal naming an en.json key, an interpolated template opening on an en.json namespace,
 * or a literal "ns." that something is concatenated onto, is a read.
 */
const EN = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
const isKey = (dotted: string): boolean => {
  let at: unknown = EN;
  for (const part of dotted.split(".")) {
    if (at === null || typeof at !== "object" || !(part in at)) return false;
    at = (at as Record<string, unknown>)[part];
  }
  return true;
};
function computedKeyNamespaces(raw: string): Set<string> {
  const found = new Set<string>();
  // Comments name keys in backticks; `//` must follow a space or punctuation so "https://" stays.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
  // A whole key: quoted, or a template with no interpolation.
  for (const m of src.matchAll(/(["'`])([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\1/g)) {
    if (isKey(`${m[2]}.${m[3]}`)) found.add(m[2]!);
  }
  // A namespace prefix the rest is added to: `ns.${…}`, or "ns." + … in any quote.
  for (const m of src.matchAll(/`([A-Za-z0-9_]+)\.[A-Za-z0-9_.]*\$\{|(["'`])([A-Za-z0-9_]+)\.\2\s*\+/g)) {
    const ns = m[1] ?? m[3]!;
    if (typeof EN[ns] === "object") found.add(ns);
  }
  return found;
}

/**
 * ── WHICH ARTIFACT ACTUALLY READS A NAMESPACE, from the import graph rather than from a claim ──
 *
 * The two lists in `vite.config.ts` divide the catalogue between the window and the served host
 * client, and until this walk existed the division was an argument in a comment. It is a fact
 * about the import graph: a namespace is READABLE on a door only if some file reachable from that
 * door's entry point reads it.
 *
 * A source walk follows both relative imports and the desktop build's workspace aliases. Its size floors
 * catch lost sources, which could otherwise leave the assertion about the host's graph passing vacuously.
 */
const ENTRY_WINDOW = "apps/desktop/src/main.tsx";
const ENTRY_HOST = "apps/paired-page/src/main.tsx";

function importGraph(entryRel: string): string[] {
  const seen = new Set<string>();
  const queue = [path.join(REPO, entryRel)];
  const aliases = desktopConfig.resolve?.alias;
  const tryFile = (base: string): string | null => {
    const candidates = [
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".tsx"),
      base,
      ...[".ts", ".tsx"].map((e) => base + e),
      ...[".ts", ".tsx"].map((e) => path.join(base, `index${e}`)),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      const alias = Array.isArray(aliases) ? aliases.find(({ find }) =>
        typeof find === "string" ? spec === find || spec.startsWith(`${find}/`) : find.test(spec),
      ) : undefined;
      const candidate = spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : (
        alias ? spec.replace(alias.find, alias.replacement) : null
      );
      if (candidate === null || !candidate.startsWith(`${REPO}${path.sep}`)) continue;
      const next = tryFile(candidate);
      if (next !== null) queue.push(next);
    }
  }
  return [...seen].map((f) => path.relative(REPO, f));
}

/** Namespaces read by a set of files, by the same call shapes {@link namespacesUsed} counts. */
function namespacesIn(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (ns: string, file: string): void => {
    const at = found.get(ns) ?? [];
    if (!at.includes(file)) at.push(file);
    found.set(ns, at);
  };
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/useTranslations\(\s*"([A-Za-z0-9_]+)"/g)) add(m[1]!, rel);
    for (const m of src.matchAll(/\b(?:liveCopy|bodyCopy|activeTranslator)\(\s*"([A-Za-z0-9_]+)"/g)) {
      add(m[1]!, rel);
    }
    if (/useTranslations\(\s*\)/.test(src)) {
      for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)\.[A-Za-z0-9_.]+"/g)) add(m[1]!, rel);
    }
    for (const ns of computedKeyNamespaces(src)) add(ns, rel);
  }
  return found;
}

describe("desktop message filter", () => {
  /**
   * The scan looked at something. Every other case here compares one derived set against
   * another, and both derivations are empty-safe: an extraction that stopped matching, or a
   * walk over roots that are no longer there, produces `[]` on both sides and agrees with
   * itself. So the harness is asserted before its findings are trusted.
   *
   * `apps/webapp/app/components` is named rather than counted because it is the directory
   * whose absence was the defect: it holds the paperclip strip and the HTML body, the two
   * surfaces every real message goes through.
   */
  it("the scan roots are real directories and the walk found real files", () => {
    expect(SOURCE_DIRS).toContain("apps/webapp/app/components");
    expect(SOURCE_DIRS.length).toBeGreaterThanOrEqual(5);
    for (const d of SOURCE_DIRS) {
      expect(fs.statSync(path.join(REPO, d)).isDirectory(), `${d} is not a directory`).toBe(true);
    }
    expect(sourceFiles().length).toBeGreaterThan(40);
    expect(namespacesUsed().size).toBeGreaterThan(10);
  });

  /** A key computed in one file and translated in another is seen where it is computed, in every shape. */
  it.each([
    ["quoted key", `const k = "sentCopy.missing";`],
    ["single-quoted key", `const k = 'sentCopy.missing';`],
    ["plain template key", "const k = `sentCopy.missing`;"],
    ["interpolated template", "const k = `sentCopy.${reason}`;"],
    ["quoted prefix concatenated", `const k = "sentCopy." + reason;`],
    ["single-quoted prefix concatenated", `const k = 'sentCopy.' + reason;`],
    ["template prefix concatenated", "const k = `sentCopy.` + reason;"],
  ])("a computed key read counts its namespace: %s", (_shape, src) => {
    expect([...computedKeyNamespaces(src)]).toEqual(["sentCopy"]);
  });

  it("a dotted string that is not a catalogue namespace counts nothing", () => {
    expect([...computedKeyNamespaces(`a = "noSuchNs." + x; b = \`noSuchNs.\${x}\`; c = \`noSuchNs.k\`;`)]).toEqual([]);
  });

  it("a key named in a comment is not a read, and a URL does not hide the code after it", () => {
    expect([...computedKeyNamespaces("/** reads `sentCopy.missing` */\n// or `sentCopy.missing`\nx = 1;")]).toEqual([]);
    expect([...computedKeyNamespaces(`u = "https://x"; k = "sentCopy." + r;`)]).toEqual(["sentCopy"]);
  });

  /**
   * Every scan root is still published. Equality with the payload's .tsx directories was the
   * original form of this case, and it was right while the two sets coincided; the payload
   * widening broke the coincidence in the harmless direction (the mirror now publishes MORE of
   * the web application than the bundle reads, under one whole-directory entry). What must
   * never break is coverage: a scan root the payload stops carrying means the published copy
   * of this very test reads directories the mirror does not have. It runs wherever the
   * publisher is present, which is every checkout where the payload can be edited.
   */
  it.runIf(HAVE_PUBLISHER)("every written-out root is covered by a payload .tsx entry", () => {
    const payloadDirs = payloadTsxDirs();
    for (const root of MIRROR_SOURCE_DIRS) {
      const covered = payloadDirs.some((d) => root === d || root.startsWith(`${d}/`));
      expect(covered, `${root} is read by this scan but no payload .tsx entry publishes it`).toBe(true);
    }
  });

  it("SHELL_MESSAGE_NAMESPACES is exactly what the sources read", () => {
    const reads = readsByFile();
    const used = [...new Set([...reads.values()].flatMap((r) => [...r]))].sort();
    /* BOTH LISTS, because both ship. A namespace the shell reads is satisfied by the wholesale
       list or by the subset one, and a namespace on NEITHER is the omission this guard exists
       for — a raw key in front of a user. Concatenated rather than made optional: a subset entry
       for a namespace nobody reads is dead payload and this still catches it. The doors' own
       namespaces, the account panes' and the phone door's are read and not shipped ({@link DOOR_ONLY},
       {@link ACCOUNT_ONLY}, {@link PHONE_DOOR_ONLY}); an exception nobody reads is red here as well, and one read outside
       its folder is red by `unexplained`. */
    expect(unexplained(reads)).toEqual([]);
    expect(used).toEqual(
      [...new Set([
        ...SHELL_MESSAGE_NAMESPACES,
        ...Object.keys(SHELL_MESSAGE_KEYS),
        ...Object.keys(DOOR_ONLY),
        ...Object.keys(ACCOUNT_ONLY),
        ...Object.keys(PHONE_DOOR_ONLY),
        ...Object.keys(PHONE_SETTINGS_ONLY),
        ...Object.keys(PHONE_SERVERS_ONLY),
      ])].sort(),
    );
  });

  it("a namespace neither shipped nor excepted is red, and so is a door's namespace read outside the doors", () => {
    const reads = readsByFile();
    expect(unexplained(reads)).toEqual([]);
    const planted = (file: string, ns: string) => new Map([...reads, [file, new Set([ns])]]);
    expect(unexplained(planted(`${DOORS}sign-in/Planted.tsx`, "plantedDoor"))).toEqual(["plantedDoor"]);
    expect(unexplained(planted("apps/desktop/src/Planted.tsx", "plantedDoor"))).toEqual(["plantedDoor"]);
    expect(unexplained(planted("apps/desktop/src/Planted.tsx", "login"))).toEqual([
      "login in apps/desktop/src/Planted.tsx",
    ]);
    expect(unexplained(planted("apps/webapp/app/shell/Planted.tsx", "stepUp"))).toEqual([
      "stepUp in apps/webapp/app/shell/Planted.tsx",
    ]);
    // The account panes' exception is the account folder's alone, as the doors' is theirs.
    expect(unexplained(planted(`${ACCOUNT}devices/Planted.tsx`, "plantedPane"))).toEqual(["plantedPane"]);
    expect(unexplained(planted("apps/desktop/src/Planted.tsx", "accountDevices"))).toEqual([
      "accountDevices in apps/desktop/src/Planted.tsx",
    ]);
    expect(unexplained(planted(`${DOORS}sign-in/Planted.tsx`, "security"))).toEqual([
      `security in ${DOORS}sign-in/Planted.tsx`,
    ]);
  });

  it("every listed namespace exists in en.json", () => {
    const all = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
    for (const ns of SHELL_MESSAGE_NAMESPACES) expect(all, ns).toHaveProperty(ns);
    // A NARROWED namespace is checked to the KEY: a renamed key is as blank on screen as a
    // renamed namespace, and the wholesale check cannot tell the two apart.
    for (const [ns, keys] of Object.entries(SHELL_MESSAGE_KEYS)) {
      for (const key of keys) expect(all, `${ns}.${key}`).toHaveProperty(`${ns}.${key}`);
    }
  });

  /**
   * ── THE SERVED CLIENT MAY NOT CARRY THE LOCAL-MODEL SURFACE ──────────────────────────────
   *
   * `scan-artifact.mjs` enforces this on the built artifact and is the real gate; this case
   * enforces it on the CATALOGUE, which is where the leak actually lived and which fails in
   * seconds instead of after a platform build.
   *
   * The leak was copy, not code. The served bundle contains no provider component — the desktop
   * host passes it in, and `apps/paired-page/src/HostGate.tsx` mounts `AppShell` with no `firstRun`
   * host at all — but `shellMessagesOnly()` filters by NAMESPACE and both artifacts asked for the
   * same namespaces, so `aiProvider`'s `choiceOllama` / `choiceAnthropicWhy` and `onboarding`'s
   * self-host fact screens ("the operator has set an Anthropic key on this server") shipped to a
   * phone that can never use them.
   *
   * Asserted against BOTH catalogues, because the German twins carry the same vendor names and a
   * check on English alone would have passed the day the leak was in `de.json` only.
   */
  it("no window-only namespace reaches the served client's catalogue", () => {
    const hostClientNamespaces = SHELL_MESSAGE_NAMESPACES
      .filter((ns) => !(WINDOW_ONLY_NAMESPACES as readonly string[]).includes(ns));
    // The split is real: the window list is strictly larger, or this guard is measuring nothing.
    expect(WINDOW_ONLY_NAMESPACES.length).toBeGreaterThan(0);
    expect(hostClientNamespaces.length).toBeLessThan(SHELL_MESSAGE_NAMESPACES.length);

    // The markers `scan-artifact.mjs` refuses, in its own words.
    const MARKERS = ["local/ai", "anthropic", "ollama", "Set up a model"];
    for (const file of ["apps/webapp/messages/en.json", "apps/webapp/messages/de.json"]) {
      const all = JSON.parse(read(file)) as Record<string, unknown>;
      const served = JSON.stringify({
        ...Object.fromEntries(hostClientNamespaces.map((ns) => [ns, all[ns]])),
        ...Object.fromEntries(Object.entries(SHELL_MESSAGE_KEYS).map(([ns, keys]) => [
          ns,
          Object.fromEntries(
            keys.map((k) => [k, (all[ns] as Record<string, unknown> | undefined)?.[k]]),
          ),
        ])),
      }).toLowerCase();
      for (const m of MARKERS) {
        expect(served.includes(m.toLowerCase()), `${file} serves the marker "${m}"`).toBe(false);
      }
    }
  });

  /**
   * ── `desktopDoor` IS THE STANDALONE WINDOW'S OWN CHROME, AND THE GRAPH SAYS SO ────────────
   *
   * The namespace holds the door chooser, the gate's apology, the boot line, Settings → Desktop,
   * Settings → About and the mailto ask — 153 keys that were English literals in a German install
   * until the window was translated.
   *
   * Two assertions, and each catches a different mistake:
   *
   *  1. NOT ONE FILE the served host client can reach reads it. That is what makes it window-only
   *     rather than a preference, and it goes red the day a served-door surface starts reading the
   *     namespace — at which point the entry belongs on the base list instead, and shipping it as
   *     window-only would render raw keys on a phone.
   *  2. It is ON the window-only list and NOT on the base one. Red the other way: moving it to the
   *     base list would put a desktop app's "Sign out of this mailbox?" into the bundle served over
   *     somebody's tailnet — payload nothing there can render, which is the rule `desktopScreener`
   *     established and `onboarding` before it.
   *
   * The window half needs no case of its own: `SHELL_MESSAGE_NAMESPACES is exactly what the
   * sources read` already fails if the namespace is on neither list, which is the shape that broke
   * the first build after `columns` landed — the filter drops the namespace, the code keeps
   * reading it, and `useTranslations` throws `MISSING_MESSAGE` on the window's first render.
   */
  it("`desktopDoor` is the window's own, and the served client's graph never reads it", () => {
    const windowFiles = importGraph(ENTRY_WINDOW);
    const hostFiles = importGraph(ENTRY_HOST);
    // The walk found a real graph. Both floors are far below the measured sizes (208 and 165):
    // they catch a resolver that stopped following, not a refactor.
    expect(windowFiles.length).toBeGreaterThan(100);
    expect(hostFiles.length).toBeGreaterThan(100);
    expect(hostFiles).toContain("apps/paired-page/src/HostGate.tsx");
    const phoneNamespaces = new Set([...Object.keys(PHONE_DOOR_ONLY), ...Object.keys(PHONE_SETTINGS_ONLY), ...Object.keys(PHONE_SERVERS_ONLY)]);
    expect([...namespacesIn([...windowFiles, ...hostFiles]).keys()].filter((ns) => phoneNamespaces.has(ns))).toEqual([]);

    /* EXACTLY ONE READER, and that is the design rather than an accident: `door-copy.ts` holds
       the whole namespace as one `liveCopy` table and every pane imports `DOOR_COPY` from it.
       Asserted as an equality so a second reader — a pane calling `useTranslations("desktopDoor")`
       for one label — is caught: it would be a second place the namespace's keys are named, and
       `desktop-door-copy.test.ts`'s key-set equality could not see it. */
    const readsInWindow = namespacesIn(windowFiles).get("desktopDoor") ?? [];
    expect(readsInWindow).toEqual(["apps/desktop/src/door-copy.ts"]);
    /* …and the panes that render those words are genuinely in this graph and not the other. */
    for (const pane of ["DoorChooser", "DesktopSettings", "DesktopAbout", "GateNotice"]) {
      expect(windowFiles, pane).toContain(`apps/desktop/src/${pane}.tsx`);
      expect(hostFiles, pane).not.toContain(`apps/desktop/src/${pane}.tsx`);
    }

    const readsInHost = namespacesIn(hostFiles).get("desktopDoor") ?? [];
    expect(
      readsInHost,
      "a served-door source reads `desktopDoor`, so it is no longer window-only — move it to "
        + "BASE_MESSAGE_NAMESPACES or those surfaces render raw keys on the phone",
    ).toEqual([]);

    expect(WINDOW_ONLY_NAMESPACES as readonly string[]).toContain("desktopDoor");
    const base = SHELL_MESSAGE_NAMESPACES
      .filter((ns) => !(WINDOW_ONLY_NAMESPACES as readonly string[]).includes(ns));
    expect(base, "desktopDoor is on the base list — the served client would carry it").not
      .toContain("desktopDoor");
  });

  it("the marketing namespaces are excluded", () => {
    // Named rather than derived: these are the ones whose presence in a binary was
    // the defect. `pricing` carries the prices; `faq`/`compare` discuss Cloud.
    for (const ns of ["pricing", "faq", "compare", "hero", "nav", "footer", "signup", "trial"]) {
      expect(SHELL_MESSAGE_NAMESPACES as readonly string[]).not.toContain(ns);
      // The narrowing lane is not a way back in for one of them: a subset of `pricing` is still
      // pricing. Only namespaces the shell reads ONE line out of belong there.
      expect(Object.keys(SHELL_MESSAGE_KEYS)).not.toContain(ns);
    }
  });

  it("no price survives the filter", () => {
    const all = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
    const kept = JSON.stringify({
      ...Object.fromEntries(SHELL_MESSAGE_NAMESPACES.map((ns) => [ns, all[ns]])),
      /* THE NARROWED NAMESPACES ARE SCANNED TOO, and this is what makes the lane safe rather
         than a hole in this guard: `join` is admitted for one line and holds the sign-up
         funnel's prices in the other 94, so a subset that grew a priced key would come through
         here exactly as a whole namespace would. */
      ...Object.fromEntries(Object.entries(SHELL_MESSAGE_KEYS).map(([ns, keys]) => [
        ns,
        Object.fromEntries(
          keys.map((k) => [k, (all[ns] as Record<string, unknown> | undefined)?.[k]]),
        ),
      ])),
    });
    // The three Cloud prices, and the metering vocabulary that only Cloud has.
    expect(kept).not.toMatch(/\$\s?(9|15|29)\b/);
    // SINGULAR TOO. This read `/AI actions/i` and two shipped strings walked straight
    // through it — `screener.suggest.autoCost` ("one AI action from your plan") and
    // `draftReply.offerBody` ("1 AI action from your plan"). A ban on the plural of a
    // metering unit is not a ban on the unit: copy that prices ONE of something is
    // exactly the copy that names it in the singular. Both are now worded against the
    // budget rather than the purchasable unit, and the pattern is anchored so the next
    // one cannot slip through the same gap.
    expect(kept).not.toMatch(/AI actions?/i);
    // …and the filter is not vacuous: the app's own copy is still there.
    expect(kept).toMatch(/[A-Za-z]{40,}|\w+\s+\w+\s+\w+/);
  });
});
