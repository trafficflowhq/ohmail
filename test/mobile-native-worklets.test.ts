import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE ANDROID BUILD'S C++ CONTRACT, ASSERTED HERE INSTEAD OF IN A SEVEN-MINUTE CI JOB.
 *
 * `expo-modules-core` ships Android C++ that calls into `react-native-worklets` directly:
 * `WorkletJSCallInvoker.cpp` invokes methods on `worklets::WorkletRuntime`. Neither package
 * is one this app imports — Expo Router's drawer pulls `react-native-reanimated`, and
 * reanimated's peer range is what decides which `react-native-worklets` gets installed. So
 * the app's manifest used to say nothing about either, and the pair was whatever resolved.
 *
 * That is not a hygiene point. `react-native-worklets` 0.12.0 REMOVED
 * `WorkletRuntime::executeSync`, which `expo-modules-core` still calls, so the pair
 * (worklets 0.12.x, expo-modules-core 57.x) does not compile at all:
 *
 *     WorkletJSCallInvoker.cpp:27:21: error: no member named 'executeSync' in
 *     'worklets::WorkletRuntime'
 *
 * The path from a floating range to that error ran through a peer with no upper bound:
 * `react-native-drawer-layout` peers `react-native-reanimated: >= 2.0.0`, npm satisfies an
 * unbounded REQUIRED peer with the registry's latest, reanimated 4.6.0 peers
 * `react-native-worklets: 0.12.x`, and the C++ stops compiling. Nothing in the tree
 * expressed a preference, so the Android job's result depended on the day it ran — and it
 * did: the same week produced green, red and green again with no change to either
 * dependency, because the lockfile the job installed from was regenerated from the manifests
 * and re-resolved those unbounded peers each time.
 *
 * Both packages are declared and exact-pinned now, and this file is why the pin can be
 * trusted rather than hoped over. Three things are checked, and the split matters:
 *
 *   1. the DECLARED specifiers are exact — a range is the float itself;
 *   2. the COMMITTED lockfile (`package-lock.json`) installs exactly one copy of each,
 *      nested copies included — the resolution is read from the committed artifact and not
 *      from a directory listing, which can hold what an earlier install left behind (a
 *      directory scan once reported "two copies" against a lockfile that held one, which is
 *      a guard that cries wolf until someone weakens it);
 *   3. the INSTALLED pair satisfies the C++ contract, followed along the SAME resolution
 *      chain Gradle autolinking follows — `apps/mobile` → `expo` → `expo-modules-core` →
 *      `react-native-worklets` — so what is asserted is what compiles.
 *
 * (3) is deliberately a SYMBOL check and not a version allow-list: a version list says
 * "these two numbers were fine once", while the symbols say what the compile actually
 * needs, so the guard keeps working across bumps that remove nothing.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * The package directory `name` resolves to from `fromDir`, walking up `node_modules` the way
 * Node and Metro do and following symlinks to the real path. Returns null when
 * the package is not reachable — callers assert on that rather than skipping.
 */
/**
 * Every C++ source and header under `dir`, recursively. Used for both halves of the symbol
 * check — the calls expo-modules-core makes, and the declarations react-native-worklets
 * publishes — because neither lives in a single file.
 */
const cppSourcesUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (/\.(cpp|cc|h|hpp)$/.test(e.name)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
};

/**
 * The C++ text with COMMENTS AND LITERALS removed, so both searches below read code and only code.
 *
 * A regex that strips comment delimiters is wrong in both directions, and the directions are
 * different failures. A delimiter inside a string literal makes it erase real declarations, which
 * turns the guard RED on a compatible pair; and a signature-shaped STRING — an error message
 * quoting a function's spelling, say — survives a comment strip and reads as a declaration, which
 * turns the guard GREEN on an incompatible one. One pass that knows about line comments, block
 * comments, character constants, ordinary strings and raw strings answers both. A literal becomes
 * an empty pair of quotes rather than vanishing, so nothing on either side of one is joined into a
 * token that was not there.
 */
const codeOnly = (rawText: string): string => {
  /* LINE SPLICING FIRST, because that is the order the language does it in: a backslash before a
   * newline is removed before comments and tokens are recognised at all. It matters here in one
   * direction — a `//` comment whose last character is a backslash continues onto the next
   * physical line, so a declaration sitting there is COMMENTED OUT and must not count. The
   * worklets headers use exactly that idiom (a multi-line `#endif` condition), so this is a
   * construct the guard will meet rather than a hypothetical. */
  const s = rawText.replace(/\\\r?\n/g, "");
  let out = "";
  let i = 0;
  const ident = /[A-Za-z0-9_]/;
  const digit = /[0-9A-Fa-f]/;
  while (i < s.length) {
    const c = s[i]!;
    const d = s[i + 1];
    if (c === "/" && d === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    /* A raw string, with its optional encoding prefix. An `R` that follows an ordinary
       identifier character is just a letter in a name, not a prefix. */
    if (c === "R" && d === '"' && !(i > 0 && ident.test(s[i - 1]!) && !/[uUL8]/.test(s[i - 1]!))) {
      let j = i + 2;
      let delim = "";
      while (j < s.length && s[j] !== "(" && delim.length < 16) delim += s[j++];
      const end = `)${delim}"`;
      const k = s.indexOf(end, j);
      i = k < 0 ? s.length : k + end.length;
      out += ' "" ';
      continue;
    }
    /* A digit separator, not a character literal: C++ writes `1'000` and `0x1'F`, and reading the
     * apostrophe as a quote would swallow everything up to the next one — across declarations,
     * and across the file joins on the call-site side. */
    if (c === "'" && i > 0 && digit.test(s[i - 1]!) && digit.test(s[i + 1] ?? "")) {
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === "\\") i++;
        i++;
      }
      i++;
      out += ' "" ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const resolvePkgDir = (name: string, fromDir: string): string | null => {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = `${dir}/node_modules/${name}`;
    if (existsSync(`${candidate}/package.json`)) return realpathSync(candidate);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
};

const versionOf = (pkgDir: string): string =>
  (JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8")) as { version: string }).version;

const MOBILE = `${ROOT}/apps/mobile`;
const mobilePkg = JSON.parse(readFileSync(`${MOBILE}/package.json`, "utf8")) as {
  dependencies: Record<string, string>;
};
const lockPackages = (JSON.parse(readFileSync(`${ROOT}/package-lock.json`, "utf8")) as {
  packages: Record<string, { version?: string }>;
}).packages;

/** The two native packages the Android C++ contract runs between. */
const PINNED = ["react-native-reanimated", "react-native-worklets"] as const;

/** A specifier with no range operator at all — one version, the same one everywhere. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("the mobile app pins the worklets pair it compiles against", () => {
  it.each(PINNED)("%s is declared at one exact version", (name) => {
    const declared = mobilePkg.dependencies[name];
    expect(
      declared,
      `apps/mobile does not declare ${name}. No app source imports it, but the Android build ` +
        `COMPILES it: leaving it undeclared hands the version choice to whatever an unbounded ` +
        `transitive peer resolves to on the day`,
    ).toBeDefined();
    expect(
      EXACT.test(declared!),
      `apps/mobile declares "${name}": "${declared}" — a range here is the float this pin ` +
        `exists to close: the next lockfile refresh would resolve a version the Android job ` +
        `never built`,
    ).toBe(true);
  });

  it.each(PINNED)("the committed lockfile resolves %s to exactly the pinned version", (name) => {
    const declared = mobilePkg.dependencies[name]!;
    // Every entry, not a set of versions: two copies at one version are two directories too.
    const found = Object.entries(lockPackages)
      .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
      .map(([, e]) => e.version ?? "(no version)")
      .sort();
    expect(
      found,
      `package-lock.json installs ${name} as ${found.join(", ") || "nothing"}. Two copies of a ` +
        `NATIVE module is not a hoisting detail: autolinking builds one of them and the C++ ` +
        `include paths point at one directory, so the version checked here and the version ` +
        `Gradle compiles can differ`,
    ).toEqual([declared]);
  });
});

describe("every WorkletRuntime member expo-modules-core calls still exists", () => {
  it("the pair on the app's own resolution chain compiles the Android call sites", () => {
    /* The chain Gradle autolinking walks, followed link by link rather than scanned for: the
     * app resolves `expo`, expo resolves its own `expo-modules-core`, and THAT copy's
     * `react-native-worklets` is the one whose headers its CMake include path points at. */
    const expoDir = resolvePkgDir("expo", MOBILE);
    expect(expoDir, `apps/mobile cannot resolve expo — install the workspace's dependencies`).not.toBeNull();
    const emcDir = resolvePkgDir("expo-modules-core", expoDir!);
    expect(
      emcDir,
      `expo@${versionOf(expoDir!)} cannot resolve expo-modules-core, so the pair the Android ` +
        `build compiles cannot be identified`,
    ).not.toBeNull();
    const workletsDir = resolvePkgDir("react-native-worklets", emcDir!);
    expect(
      workletsDir,
      `expo-modules-core@${versionOf(emcDir!)} cannot resolve react-native-worklets — the ` +
        `include path its CMake adds would not exist`,
    ).not.toBeNull();

    const emcVersion = versionOf(emcDir!);
    const workletsVersion = versionOf(workletsDir!);

    /**
     * THE WHOLE COMPILED TREE, NOT THE ONE FILE THAT HAPPENED TO FAIL FIRST.
     *
     * This read `WorkletJSCallInvoker.cpp` alone, because that is the translation unit whose
     * error started the investigation. It is not the only one Gradle compiles against the
     * worklets headers, and a guard scoped to the file that broke last time is a guard that
     * goes green on the next removal: `worklets/Worklet.cpp` calls `schedule` and `runSync`,
     * `worklets/WorkletNativeRuntime.cpp` and `installers/WorkletRuntimeInstaller.cpp` reach
     * the runtime through STATIC and FREE functions that no `workletRuntime->` pattern can
     * see, and `types/FrontendConverter.cpp` calls `worklets::extractSerializableOrThrow`.
     * A worklets release that kept `executeSync` and dropped any of those would have passed
     * the narrow form while Gradle failed — the vacuous green this whole file exists against.
     *
     * Three arms, because the C++ has three ways of naming the dependency, and each asserts
     * separately that it found something to check.
     */
    const cppRoot = `${emcDir}/android/src/main/cpp`;
    expect(
      existsSync(cppRoot),
      `expo-modules-core@${emcVersion} has no android/src/main/cpp — the tree whose compile ` +
        `failed. If upstream moved it this guard must follow it; finding nothing to check is ` +
        `not evidence that the contract holds`,
    ).toBe(true);

    const sources = cppSourcesUnder(cppRoot);
    expect(
      sources.length,
      `expo-modules-core@${emcVersion} ships no C++ sources under android/src/main/cpp`,
    ).toBeGreaterThan(0);
    /* Code only on this side too: a comment or an error string in expo's sources that happens to
     * name a worklets function would otherwise be collected as a REQUIRED symbol, and the guard
     * would go red over a call that is not made. */
    const cppText = codeOnly(sources.map((f) => readFileSync(f, "utf8")).join("\n"));

    const header = `${workletsDir}/Common/cpp/worklets/WorkletRuntime/WorkletRuntime.h`;
    expect(
      existsSync(header),
      `react-native-worklets@${workletsVersion} has no WorkletRuntime.h where ` +
        `expo-modules-core's CMake include path expects it (Common/cpp)`,
    ).toBe(true);
    const headerText = readFileSync(header, "utf8");
    /**
     * HEADERS ONLY, and that restriction is the assertion rather than a tidy-up.
     *
     * The free functions are spread across several headers, so the haystack has to be the whole
     * published tree and not one file. But it must be the DECLARATIONS: a function removed from
     * its header while its definition stays in the matching `.cpp` — which is exactly the shape
     * of a deprecation, and how `Compat/StableApi` is laid out today — leaves the caller's
     * translation unit with no visible declaration and a failing compile, while a search that
     * read `.cpp` files too would still find the name and report green.
     */
    const workletsCommon = `${workletsDir}/Common/cpp`;
    const commonHeaders = cppSourcesUnder(workletsCommon).filter((f) => /\.(h|hpp)$/.test(f));
    expect(
      commonHeaders.length,
      `react-native-worklets@${workletsVersion} publishes no C++ HEADERS under Common/cpp, so ` +
        `nothing declares the API expo-modules-core compiles against`,
    ).toBeGreaterThan(0);

    const uniq = (re: RegExp): string[] =>
      [...new Set([...cppText.matchAll(re)].map((m) => m[1]!))].sort();

    /**
     * A DECLARATION, NOT THE NAME APPEARING SOMEWHERE.
     *
     * `name(` anywhere in a header is not evidence that a caller can see a declaration of it,
     * and on this very tree it is measurably not: `WorkletRuntime.h` CALLS
     * `extractSerializableOrThrow` from three inline bodies and mentions it in a doc comment,
     * while the declaration lives in `SharedItems/Serializable.h`. A token search over the
     * headers therefore stayed green for a symbol whose declaration had been deleted, which is
     * the failure this file is written against — one level in from where it was last found.
     *
     * The discriminator is what sits immediately before the name once comments are gone. A
     * declaration is preceded by the end of a RETURN TYPE — an identifier character, `>`, `&`
     * or `*` — where a call is preceded by `=`, `(`, `,`, `::` or `->`. Verified against this
     * package rather than assumed: the four `WorkletRuntime` members and the two `StableApi`
     * free functions all read as declarations, and `extractSerializableOrThrow` reads as a
     * declaration in `Serializable.h` and NOT in `WorkletRuntime.h`.
     *
     * WHAT THIS STILL DOES NOT PROVE, recorded rather than left to be rediscovered: it asks
     * whether SOME published header declares the name, not whether the header this call site
     * actually includes does. An upstream release that MOVED a declaration to a header the call
     * site does not reach would fail the compile and still pass here. Closing that needs the
     * include graph or a real preprocessor — a C++ toolchain this suite has not got and the
     * Android job has. So the bound is deliberate: this turns a long remote build failure into a
     * local second for the case that has actually happened twice, a symbol REMOVED, and the
     * build stays the authority for the rest.
     */
    const declares = (text: string, name: string): boolean => {
      const src = codeOnly(text);
      const re = new RegExp(`\\b${name}\\s*\\(`, "g");
      for (let m = re.exec(src); m; m = re.exec(src)) {
        let i = m.index - 1;
        while (i >= 0 && /\s/.test(src[i]!)) i--;
        if (i < 0) continue;
        const before = src[i]!;
        if (before === ">" && src[i - 1] === "-") continue; // obj->name(
        if (!/[A-Za-z0-9_>&*]/.test(before)) continue; // = name(  (name(  ::name(  ,name(
        const word = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(src.slice(0, i + 1));
        if (word && ["return", "new", "delete", "if", "while", "for", "switch"].includes(word[1]!)) {
          continue;
        }
        return true;
      }
      return false;
    };
    const declaringHeader = (name: string): string | null =>
      commonHeaders.find((f) => declares(readFileSync(f, "utf8"), name)) ?? null;

    // ARM 1 — instance calls on a WorkletRuntime, wherever in the tree they are made.
    const members = uniq(/workletRuntime->([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
    expect(
      members.length,
      `expo-modules-core@${emcVersion} makes no workletRuntime-> calls anywhere under ` +
        `android/src/main/cpp, so arm 1 is asserting nothing`,
    ).toBeGreaterThan(0);

    // ARM 2 — statics reached through the class name, which arm 1 cannot see.
    const statics = uniq(/worklets::WorkletRuntime::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
    expect(
      statics.length,
      `expo-modules-core@${emcVersion} calls no worklets::WorkletRuntime:: statics, so arm 2 ` +
        `is asserting nothing — the installer used to call getWeakRuntimeFromJSIRuntime`,
    ).toBeGreaterThan(0);

    for (const member of [...members, ...statics]) {
      expect(
        declares(headerText, member),
        `expo-modules-core@${emcVersion} calls WorkletRuntime::${member}, which ` +
          `react-native-worklets@${workletsVersion} does not declare. This is exactly the ` +
          `Android CXX failure — "no member named '${member}' in 'worklets::WorkletRuntime'" — ` +
          `and the two must not be installed together`,
      ).toBe(true);
    }

    /* ARM 3 — free functions in the `worklets` namespace. Lowercase initial only: the same
     * `worklets::Name(` shape is also how a TYPE is constructed or cast to, and a type is not
     * a function this can look up. The C++ convention upstream keeps — types capitalised,
     * functions not — is what makes the split reliable, and arm 3's own emptiness check is
     * what would catch it changing. */
    const frees = uniq(/worklets::([a-z][A-Za-z0-9_]*)\s*\(/g);
    expect(
      frees.length,
      `expo-modules-core@${emcVersion} calls no free worklets:: functions, so arm 3 is ` +
        `asserting nothing — the converter used to call extractSerializableOrThrow`,
    ).toBeGreaterThan(0);
    for (const fn of frees) {
      expect(
        declaringHeader(fn) !== null,
        `expo-modules-core@${emcVersion} calls worklets::${fn}(), which ` +
          `react-native-worklets@${workletsVersion} declares in no HEADER under Common/cpp — a ` +
          `definition left behind in a .cpp does not make it visible to the caller. The ` +
          `Android CXX step fails with "no member named '${fn}' in namespace 'worklets'"`,
      ).toBe(true);
    }
  });
});
