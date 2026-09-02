import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHELL_MESSAGE_KEYS, SHELL_MESSAGE_NAMESPACES, WINDOW_ONLY_NAMESPACES } from "../vite.config.js";

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
  "apps/webapp/app/components",
  "apps/webapp/app/shell",
  "apps/webapp/app/views",
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
 *  · `liveCopy("mailBody", …)` / `activeTranslator("place")` → the NON-HOOK read.
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
function namespacesUsed(): Set<string> {
  const found = new Set<string>();
  for (const rel of sourceFiles()) {
    const src = read(rel);

    for (const m of src.matchAll(/useTranslations\(\s*"([A-Za-z0-9_]+)"/g)) found.add(m[1]!);
    for (const m of src.matchAll(/\b(?:liveCopy|activeTranslator)\(\s*"([A-Za-z0-9_]+)"/g)) {
      found.add(m[1]!);
    }

    // Unscoped: collect dotted keys from `t("a.b")` in files that call useTranslations().
    if (/useTranslations\(\s*\)/.test(src)) {
      for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)\.[A-Za-z0-9_.]+"/g)) found.add(m[1]!);
    }
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
    const used = [...namespacesUsed()].sort();
    /* BOTH LISTS, because both ship. A namespace the shell reads is satisfied by the wholesale
       list or by the subset one, and a namespace on NEITHER is the omission this guard exists
       for — a raw key in front of a user. Concatenated rather than made optional: a subset entry
       for a namespace nobody reads is dead payload and this still catches it. */
    expect(used).toEqual([...SHELL_MESSAGE_NAMESPACES, ...Object.keys(SHELL_MESSAGE_KEYS)].sort());
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
   * host passes it in, and `src/host-client/HostGate.tsx` mounts `AppShell` with no `firstRun`
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
