/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  HOW THE PHONE'S ENGINE SHIPS — the packaged path, what is in it, how big, and the refusal
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The fourth door runs an engine the app carries as a pre-bundled file. `engine-artifact.ts` makes
 * the door FOLLOW the registration, so the packaging question and the product question are the same
 * one: a build that does not carry the artifact is a build that shows three doors. This file holds
 * the four properties that make that state unbuildable rather than unlikely.
 *
 *  1. THE PATH. `scripts/bundle-engine.mjs` writes `generated/phone-engine.js` inside the app,
 *     because Metro has to resolve it — `src/engine/engine-bundle-native.ts` requires it by path.
 *  2. NO BUILD MACHINE IN IT. The bundle labels every module with a path comment. Written without
 *     `absWorkingDir` those are absolute, and the builder's home directory ends up inside the app's
 *     own tree; `stripBuildPaths` rewrites them and the census below is what proves it worked. This
 *     is the measurement the artifact was previously kept OUT of the app tree to avoid.
 *  3. A SIZE CEILING, as a ratchet that may only fall. The bundle rides inside every APK and IPA;
 *     nothing else in this repository would notice it doubling.
 *  4. THE REFUSAL. A build without the artifact stops while Metro's configuration is being read,
 *     with a sentence naming the generator, instead of at a module resolution naming a path.
 *
 * `engine-bundle-loads.test.ts` is the fifth property and the one that costs the most: it BOOTS
 * this artifact, from this path, and watches it dial a mail server.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BUNDLE,
  MACHINE_PATH_PREFIXES,
  PACKAGED_DIR,
  REPO,
  TYPES,
  buildPhoneEngine,
  pdfFrameSource,
  stripBuildPaths,
} from "../scripts/bundle-engine.mjs";
import { ARTIFACT, assertPhoneEngineArtifact } from "../src/engine/artifact-present.js";
import { publicPath } from "../../../test/support/public-root.mjs";

const APP = join(REPO, "apps", "mobile");
/** The generator, as the refusal names it and the phone workflow runs it: by its file, from the root. */
const GENERATE = "node apps/mobile/scripts/bundle-engine.mjs";

/** The published tree's resolution (every workspace subpath to source): the engine people install. */
let published = "";

beforeAll(async () => {
  // Built rather than found. Every case below is about what the generator PRODUCES, and a stale
  // artifact from an earlier tree would answer all four questions about code that is not here.
  await buildPhoneEngine();
  published = ((await buildPhoneEngine({ write: false, workspaceSources: true })) as { text: string }).text;
}, 300_000);

describe("the artifact carries the app version as the engine's build label", () => {
  it("bakes app.json's version, so a build with no commit still re-reads a write-off on the next release", () => {
    /* `engineBuildLabel`'s fallback (apps/sidecar/src/engine.ts): without it a phone built with no
       commit labels every write-off `dev`, on every release alike, and the backstop's hold and a
       deterministic write-off would never be read again (VERIFY-026-PHONE-ONE-MESSAGE-B L2). */
    const version = (JSON.parse(readFileSync(join(APP, "app.json"), "utf8")) as { expo: { version: string } }).expo.version;
    const text = readFileSync(BUNDLE, "utf8");
    expect(text).not.toContain("__OHMAIL_ENGINE_VERSION__");
    expect(text).toContain(`BAKED_ENGINE_VERSION = true ? ${JSON.stringify(version)} : void 0`);
  });
});

describe("the artifact is where the app can resolve it", () => {
  it("is written inside the app, at the path the loader requires", () => {
    expect(relative(APP, BUNDLE)).toBe("generated/phone-engine.js");
    expect(relative(APP, PACKAGED_DIR)).toBe("generated");
    expect(statSync(BUNDLE).isFile()).toBe(true);
  });

  it("the loader requires exactly that path, and the composition root calls it before render", () => {
    /**
     * The wiring, read rather than rendered: there is no React Native renderer in this workspace
     * (`fourth-door.test.ts` records the measurement), so "the door appears" is asserted on a
     * device and the chain that leads to it is asserted here. Three links, and each one has been
     * the missing one at some point in this app's history.
     */
    const loader = readFileSync(join(APP, "src/engine/engine-bundle-native.ts"), "utf8");
    expect(loader).toContain(["require", '("../../generated/phone-engine.js")'].join(""));
    expect(loader).toContain("registerPhoneEngine(artifact.startPhoneEngine)");

    const layout = readFileSync(join(APP, "app/_layout.tsx"), "utf8");
    expect(layout).toContain('from "../src/engine/engine-bundle-native"');
    // At MODULE scope. Inside a component it would run after the chooser had already read the
    // registry, which `engine-artifact.ts` states as the requirement and the reason for it.
    const call = layout.indexOf("registerBundledPhoneEngine();");
    const firstComponent = layout.indexOf("export default function RootLayout");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(firstComponent);
  });

  it("the engine is NOT imported as source anywhere in the app", () => {
    // `local-engine.ts` states the rule and the reason: importing the engine's source would make
    // the app's own bundler resolve the whole graph again, with none of the substitutions. The
    // artifact is the only route in, so the specifier below must appear in exactly one file.
    const importers = [
      "src/engine/engine-bundle-native.ts",
      "src/engine/local-engine.ts",
      "src/engine/engine-artifact.ts",
      "app/_layout.tsx",
    ].filter((p) => readFileSync(join(APP, p), "utf8").includes("generated/phone-engine.js"));
    expect(importers).toEqual(["src/engine/engine-bundle-native.ts"]);
  });
});

/* ── 2. no build machine inside the app's tree ───────────────────────────────────────────── */

/**
 * THE CENSUS ITSELF, over TEXT, so the control below can run it on a planted copy.
 *
 * `MACHINE_PATH_PREFIXES` is the generator's own list — the prefixes a build machine's absolute
 * paths start with — and this checkout's own root is added, because a repository outside `/home`
 * or `/Users` would leak its layout past a prefix list alone.
 */
function machinePathsIn(text: string): string[] {
  const needles = [...MACHINE_PATH_PREFIXES, `${REPO}/`];
  const hits: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    for (const needle of needles) {
      if (line.includes(needle)) hits.push(`line ${i + 1}: ${line.slice(0, 120)}`);
    }
  }
  return hits;
}

describe("nothing in the packaged directory names the machine that built it", () => {
  it("censuses every file that ships in it, not only the bundle", () => {
    // The declaration and the module-kind marker ride in the same ignored directory inside the
    // app; a path in either of them is the same leak as a path in the bundle.
    for (const file of [BUNDLE, TYPES, join(PACKAGED_DIR, "package.json")]) {
      expect(machinePathsIn(readFileSync(file, "utf8")), basename(file)).toEqual([]);
    }
  });

  it("REFUSES a planted absolute path — the census can fire", () => {
    /**
     * The control. A census that has never been watched fail is not evidence, and this one is
     * green by construction on a correct build, so its only proof is a subject that has the
     * property. The plant is the exact form the failure took: esbuild's own module comment,
     * absolute, with a home directory in it.
     */
    const real = readFileSync(BUNDLE, "utf8");
    const planted = `// /home/somebody/checkouts/ohmail/packages/core/src/mail.ts\n${real}`;
    const hits = machinePathsIn(planted);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("/home/somebody/checkouts");
  });

  it("the strip rewrites a path comment and leaves every other line alone", () => {
    /**
     * The mechanism behind the census, driven directly — the generator applies it to output that
     * has no absolute path in it today, so this is the only place its two branches run. Narrowness
     * is the property under test: a blanket replace would rewrite a path a module MEANS, and that
     * failure is a phone doing the wrong thing rather than a census going red.
     */
    const inside = `${REPO}/packages/core/src/mail.ts`;
    const out = stripBuildPaths(
      [
        `// ${inside}`,
        "// /elsewhere/on/this/machine/node_modules/x/index.js",
        `const kept = "${inside}";`,
        `  // ${inside}`,
      ].join("\n"),
      REPO,
    );
    const lines = out.split("\n");
    expect(lines[0], "a path under the repository becomes relative").toBe("// packages/core/src/mail.ts");
    expect(lines[1], "a path outside it becomes a marker, not a ../.. walk")
      .toBe("// (a module outside the repository)");
    expect(lines[2], "a path a module MEANS is untouched").toBe(`const kept = "${inside}";`);
    expect(lines[3], "only a line that is ONLY a path comment is rewritten").toBe(`  // ${inside}`);
  });
});

/* ── 3. the size ceiling ─────────────────────────────────────────────────────────────────── */

/**
 * A RATCHET THAT MAY ONLY FALL. The artifact's size as measured, pinned a small margin above it.
 *
 * This file rides inside every APK and every IPA, and it is the only thing in this repository big
 * enough to change a download size on its own. Nothing else would notice it doubling: the metafile
 * censuses read the GRAPH, and a graph can gain a megabyte of one dependency without gaining a
 * module anybody reviews.
 *
 * Raising this number is not a fix. It is a decision about what the app costs somebody on a phone,
 * and it belongs in a diff that says so.
 */
// The ceiling since the check for a name claiming a company runs in the phone's own ingest: the size
// measured at that tip plus a fixed headroom, rounded up; it stood lower before that check.
const SIZE_CEILING = 6_533_000;

/** The whole reading, so the control below runs it over a file rather than over arithmetic. */
const withinCeiling = (path: string): boolean => statSync(path).size <= SIZE_CEILING;

/**
 * Both resolutions, each by bytes: the artifact built here (through each package's exports) and
 * the source-table resolution (`test/published-phone-engine-parity.test.ts` compares the two). A
 * ceiling read over one alone guards a bundle nobody installs or lets the installed one grow
 * unread; every resolution over it is named with its size.
 */
const overCeiling = (readings: Record<string, string>): string[] =>
  Object.entries(readings).map(([name, path]) => [name, statSync(path).size] as const)
    .filter(([, bytes]) => bytes > SIZE_CEILING).map(([name, bytes]) => `${name}: ${bytes} bytes`);

const publishedFile = (pad = 0): string => {
  const f = join(tmpdir(), `phone-engine-published-${process.pid}-${pad}.js`);
  writeFileSync(f, published);
  if (pad > 0) appendFileSync(f, Buffer.alloc(pad));
  return f;
};

describe("the artifact stays small enough to ship", () => {
  it("is under the ceiling in both resolutions: the one built here and the one the published tree ships", () => {
    const f = publishedFile();
    try {
      expect(overCeiling({ "built here": BUNDLE, published: f }), `ceiling ${SIZE_CEILING}`).toEqual([]);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("REFUSES a published resolution that grew while the one built here did not", () => {
    const f = publishedFile(SIZE_CEILING);
    try {
      const over = overCeiling({ "built here": BUNDLE, published: f });
      expect(over.filter((r) => r.startsWith("published: ")), "a grown published resolution passed")
        .toEqual([`published: ${statSync(f).size} bytes`]);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("REFUSES a padded artifact — the ceiling can fire", () => {
    /**
     * The control, over a REAL padded file and the same reading the case above makes. Asserting
     * that `size + ceiling > ceiling` would have proved arithmetic: the question is whether the
     * measurement path refuses a bundle that grew, so a bundle that grew is what it is given.
     */
    const padded = join(tmpdir(), `phone-engine-padded-${process.pid}.js`);
    writeFileSync(padded, readFileSync(BUNDLE));
    appendFileSync(padded, Buffer.alloc(SIZE_CEILING));
    try {
      expect(withinCeiling(padded), "a padded bundle passed the ceiling").toBe(false);
    } finally {
      rmSync(padded, { force: true });
    }
  });

  it("the ceiling is still a ceiling and not a floor with room to spare", () => {
    /**
     * The pin's own health. A ratchet that has drifted to three times the artifact stops measuring
     * anything, and the failure mode is silent: every run passes. So the headroom is bounded too —
     * a build that comes in far UNDER the pin is a signal that the pin should fall, and this case
     * is where that gets noticed instead of never.
     */
    expect(statSync(BUNDLE).size).toBeGreaterThan(SIZE_CEILING * 0.6);
  });
});

/* ── 4. the refusal, both arms ───────────────────────────────────────────────────────────── */

describe("a build without the artifact stops, by name", () => {
  it("admits the ordinary case — the artifact is there", () => {
    // Every refusal rule ships a positive control. Without this, a check that threw unconditionally
    // would pass the case below and break every phone build.
    expect(() => assertPhoneEngineArtifact(APP)).not.toThrow();
  });

  it("refuses when it is missing, and names the generator", () => {
    // Driven through the seam rather than by moving a 6 MiB file: the question is what the sentence
    // SAYS, and somebody reading it has to learn the command, not the path.
    let message = "";
    try {
      assertPhoneEngineArtifact(APP, () => false);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("no fourth door");
    expect(message).toContain(GENERATE);
    expect(message).toContain(`apps/mobile/${ARTIFACT}`);
  });

  it("refuses when the preview's pdf.js is missing, and names the generator", () => {
    let message = "";
    try {
      assertPhoneEngineArtifact(APP, (p) => !p.endsWith("pdf-frame.js"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("pdf.js is missing");
    expect(message).toContain(GENERATE);
  });

  it("the preview's pdf.js is the web app's pinned build, byte for byte, licence notices included", () => {
    const mod = { exports: {} as Record<string, string> };
    new Function("module", pdfFrameSource())(mod);
    const dist = dirname(createRequire(join(REPO, "apps", "webapp", "package.json")).resolve("pdfjs-dist/package.json"));
    const pinned = (JSON.parse(readFileSync(join(REPO, "apps", "webapp", "package.json"), "utf8")) as { dependencies: Record<string, string> })
      .dependencies["pdfjs-dist"];
    expect(mod.exports.PDFJS_VERSION).toBe(pinned);
    expect(mod.exports.PDF_LIB).toBe(readFileSync(join(dist, "legacy", "build", "pdf.min.mjs"), "utf8"));
    expect(mod.exports.PDF_WORKER).toBe(readFileSync(join(dist, "legacy", "build", "pdf.worker.min.mjs"), "utf8"));
    expect(mod.exports.PDF_LIB).toContain("Mozilla Foundation");
  });

  it("metro.config.js runs the check before it configures anything", () => {
    /**
     * The wiring. The assertion is reachable in a test because it is a dependency-free module, and
     * that is exactly what would let it sit there uncalled. So its one caller is read, and the
     * ORDER is asserted: after `getDefaultConfig` the bundler has already been handed a project.
     */
    const metro = readFileSync(join(APP, "metro.config.js"), "utf8");
    const call = metro.indexOf("assertPhoneEngineArtifact(projectRoot)");
    const configure = metro.indexOf("getDefaultConfig(projectRoot)");
    expect(call).toBeGreaterThan(0);
    expect(configure).toBeGreaterThan(0);
    expect(call).toBeLessThan(configure);
  });

  it("every build path spells the generator the same way: the command the sentence names", () => {
    // The sentence tells somebody to run the generator by its file from the repository root; the
    // phone workflow's bundle step runs exactly that, so the advice is the build's own command.
    const wf = readFileSync(publicPath(`${["git", "hub"].join("")}/workflows/android.yml`), "utf8");
    const runs = wf.split("\n").filter((l) => l.trim() === GENERATE);
    expect(runs.length, "the phone workflow no longer runs the generator the sentence names").toBeGreaterThan(0);
    expect(wf.split("\n").filter((l) => /bundle-engine\.mjs\s*$/.test(l) && l.trim() !== GENERATE), "another spelling").toEqual([]);
  });

  it("the generator runs as a command, not only as an import", () => {
    // The package script invokes the file; a module whose CLI arm had rotted would still pass every
    // case above, because they all call `buildPhoneEngine()` directly.
    const out = execFileSync(process.execPath, [join(APP, "scripts/bundle-engine.mjs")], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(out).toContain("apps/mobile/generated/phone-engine.js");
    expect(out).toContain("node: specifiers surviving: 0");
  }, 300_000);
});
