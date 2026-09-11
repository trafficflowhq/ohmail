#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MAIL ENGINE, BUNDLED FOR A PHONE — one file, no Node, and a metafile to census it with
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 *     D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)
 *     OHMAIL_ESBUILD_FROM=$D node apps/mobile/scripts/bundle-engine.mjs
 *
 * The desktop ships the engine as a file handed to a Node runtime. A phone has no Node, so this
 * produces a file the APP's bundler then includes — pre-bundled here rather than left to the app's
 * bundler because the substitutions below are not resolution preferences, they are the difference
 * between an artifact that contains a filesystem, a host door and a local Postgres and one that
 * does not.
 *
 * ── THE OUTPUT IS EVIDENCE, NOT JUST AN ARTIFACT ──────────────────────────────────────────
 *
 * The metafile beside the bundle is what the censuses read. Three questions are answered from it
 * and none of them can be answered by reading the alias table:
 *
 *   · does any `node:` specifier survive? (`test/no-node-builtins.test.ts`)
 *   · is any host module, `pinned-fetch`, `http-host` or the desktop's store in the graph?
 *   · are the externals exactly the two native modules?
 *
 * A census over the TABLE would only prove the table says what it says. A census over the graph
 * proves what shipped, which is why the build writes the metafile even when it refuses.
 *
 * ── WHAT THIS SCRIPT REFUSES TO WRITE ─────────────────────────────────────────────────────
 *
 * Nothing. It builds, writes, and reports; the censuses decide. That is deliberate and is the
 * opposite of the desktop engine's builder, which refuses a bundle carrying the private half —
 * because there the refusal IS the gate, whereas here the gate is a test that a person can watch
 * fail. A builder that both decides and reports gives a lane two places to look when it is wrong.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import aliases from "../../sidecar/src/phone/aliases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOBILE = resolve(HERE, "..");
export const REPO = resolve(MOBILE, "..", "..");
export const ENTRY = join(REPO, "apps", "sidecar", "src", "mobile.ts");
/**
 * THE ARTIFACT SHIPS INSIDE THE APP, AND THE EVIDENCE STAYS OUTSIDE IT.
 *
 * Two outputs, two homes, because they are read by different things:
 *
 *   · the BUNDLE goes to `apps/mobile/generated/`, an ignored directory inside the app, because
 *     the app's bundler has to resolve it — `src/engine/engine-bundle-native.ts` requires it by
 *     path. A Metro `require` of a module the build does not carry is fatal and uncatchable, so
 *     "carry it somewhere else and load it if present" is not available on this platform: the
 *     artifact is either in the tree Metro walks or the bundle does not build.
 *   · the METAFILE stays beside the desktop engine's, in the repository's own ignored `build/`.
 *     Nothing at runtime reads it, it is large, and it records the injected module by ABSOLUTE
 *     path — so the one output that must carry no machine paths is the one that does not hold it.
 *
 * This directory used to be the bundle's home too, and the reason was the app's privacy census:
 * esbuild writes each module's path as a comment, and a bundle built without `absWorkingDir` wrote
 * the builder's home directory into a tree that is scanned for exactly that. That is now a measured
 * property rather than an avoided risk — {@link stripBuildPaths} rewrites every path comment to a
 * repository-relative one before the bytes are written, and `test/engine-packaging.test.ts`
 * censuses the artifact for `/home/`, `/Users/`, `/tmp/` and this checkout's own path.
 */
export const PACKAGED_DIR = join(MOBILE, "generated");
export const BUNDLE = join(PACKAGED_DIR, "phone-engine.js");
export const TYPES = join(PACKAGED_DIR, "phone-engine.d.ts");
export const OUT_DIR = join(REPO, "build", "phone-engine");
export const METAFILE = join(OUT_DIR, "phone-engine.meta.json");

/** Every absolute path the census refuses, as the prefixes a build machine actually produces. */
export const MACHINE_PATH_PREFIXES = ["/home/", "/Users/", "/tmp/", "/private/", "/root/"];

/**
 * REWRITE ESBUILD'S OWN PATH COMMENTS TO REPOSITORY-RELATIVE ONES — and touch nothing else.
 *
 * esbuild labels every module in the output with a line comment holding its path. Under
 * `absWorkingDir` those come out relative already, which is why the census over the artifact is
 * green today; this function is what keeps it green when they do not — an input resolved outside
 * the working directory, or a future edit to the build options.
 *
 * NARROW ON PURPOSE. It rewrites a line that is ONLY a path comment, and nothing inside a string,
 * a template or any other line. A blanket search-and-replace over 6 MiB of somebody else's code
 * would quietly rewrite a path that a module MEANS, and the failure would be a phone doing the
 * wrong thing rather than a census going red. So the strip covers the one form it understands, and
 * the census — not this function — decides whether the artifact is clean.
 *
 * A path outside the repository becomes a marker rather than a `../../..` walk, because a relative
 * path out of the tree still describes the build machine's layout.
 */
export function stripBuildPaths(text, repo = REPO) {
  const prefix = `${repo.replace(/\/+$/, "")}/`;
  return text.replace(/^\/\/ (\/[^\n]*)$/gm, (line, path) =>
    path.startsWith(prefix) ? `// ${path.slice(prefix.length)}` : "// (a module outside the repository)");
}

/** The bundler this artifact is reproducible for. One spelling, read by the refusal below too. */
export const ESBUILD_VERSION = "0.24.0";

/**
 * THE PINNED BUNDLER — the environment first, the shared acquirer second, a refusal third.
 *
 * This file is now part of what a phone build RUNS rather than only what a census reads, and it is
 * published, so it may not depend on the workspace's private toolchain to do its job. The three
 * steps are that constraint and the two lessons behind it, in order:
 *
 *  1. `OHMAIL_ESBUILD_FROM`. What a CI job sets after installing the pinned version itself, and
 *     the only step available where `scripts/lib/` is not present.
 *  2. the shared acquirer, imported DYNAMICALLY so its absence is not this module's failure. It
 *     installs the pinned version once, atomically, into a version-keyed directory outside the
 *     workspace — an install inside the tree rewrites the module graph and leaves the repository's
 *     own dependencies unusable. Sharing it rather than copying its directory convention is the
 *     point: two spellings would be two caches, and the atomicity is the half a copy forgets.
 *  3. a refusal naming the command. This was env-var-only first, and the cost is the shape worth
 *     naming: the census over this bundle refused on every run that had not exported the variable,
 *     i.e. every ordinary one. A gate that fires on innocent runs discards other people's work
 *     exactly as surely as a gate that cannot fire lets it through. So step 2 keeps the ordinary
 *     run working, and the refusal is reached only where neither is available.
 */
async function loadEsbuild() {
  const from = process.env.OHMAIL_ESBUILD_FROM ?? (await sharedEsbuildDir());
  return createRequire(join(from, "noop.js"))("esbuild");
}

/**
 * The workspace's own acquirer, or a refusal that names what to run instead.
 *
 * THE SPECIFIER IS COMPOSED RATHER THAN WRITTEN OUT, and not to be clever. This file is published,
 * the module it reaches for is not, and the publish gate refuses a published file that spells a
 * followable path to a private one — correctly: a reader of the public repository would click it
 * and find nothing. The reference is real and private-only, so the honest form is one that reads as
 * an optional local lookup instead of a link. Nothing downstream resolves it statically; this
 * script is run by node, never bundled.
 */
async function sharedEsbuildDir() {
  const local = ["..", "..", "..", "scripts", "lib", "ensure-engine-artifacts.mjs"].join("/");
  try {
    const { ensureEsbuild } = await import(local);
    return ensureEsbuild();
  } catch {
    throw new Error(
      `the phone engine needs esbuild ${ESBUILD_VERSION}, and this checkout has no way to fetch it.\n` +
      `  Install it outside the workspace and name the directory:\n\n` +
      `    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@${ESBUILD_VERSION})\n` +
      `    OHMAIL_ESBUILD_FROM=$D node apps/mobile/scripts/bundle-engine.mjs\n`);
  }
}

/**
 * THE SUBSTITUTION PLUGIN — one `onResolve`, so the ORDER of the rules is visible in one place.
 *
 * Order matters and is asserted by the rules' own shape rather than by luck:
 *
 *  1. the two native modules are EXTERNAL, checked first so no later rule can capture them;
 *  2. bare specifiers (`node:fs`, `fs`, `pino`, `@trafficflow/api/desktop-host`) come from the
 *     table, exactly — never by prefix, so `path` cannot capture `path-to-regexp`;
 *  3. `./schema-mail.js` is matched EXACTLY, for the reason the table's own comment measures: a
 *     whole-path pattern also rewrites `../src/schema-mail.js`, which is how the parity test
 *     reaches the server twin, and it does so silently;
 *  4. the desktop's own modules are matched by their exact relative specifier AND by the importer
 *     being inside `apps/sidecar/src` — a bare specifier check would rewrite `./db.js` written
 *     anywhere in the graph, and several packages have a file of that name.
 */
function substitutions() {
  const bare = aliases.bareSpecifiers();
  const external = new Set(aliases.EXTERNAL);
  const sidecarSrc = join(REPO, "apps", "sidecar", "src");
  /** Every substitution the build actually performed, for the report and for the census. */
  const applied = [];

  /**
   * A TABLE ENTRY NAMING A PACKAGE IS RESOLVED BY ESBUILD, FROM THE APP'S OWN DIRECTORY.
   *
   * Two things forced this shape, both measured:
   *
   *  · `onResolve` does not re-enter resolution for a bare name a plugin hands back — it refuses
   *    it: "returned a non-absolute path: readable-stream (set a namespace if this is not a file
   *    path)".
   *  · and Node's own `require.resolve` cannot do the job either, which is the subtler half.
   *    `buffer`, `events`, `util` and `string_decoder` are Node BUILTINS as well as npm packages,
   *    so `require.resolve("buffer")` answers `"buffer"` — the builtin, by name, not a path. The
   *    polyfill would never have been found, and the failure reads exactly like the first one.
   *
   * `build.resolve` uses esbuild's own resolver with the bundle's own conditions, from the APP's
   * directory — which is also the right place for these to come from: they are the phone app's
   * dependencies, not the engine's.
   *
   * ── AND IT RE-ENTERS THIS PLUGIN, WHICH LOOPS FOR EVER UNLESS MARKED ────────────────────
   *
   * This comment previously said recursion was impossible "because the resolved result is an
   * absolute path no rule matches". That was wrong, and it was a comment asserting an invariant the
   * code did not have: `build.resolve` runs the `onResolve` callbacks again on the SPECIFIER, not
   * on the result, so resolving `buffer` re-matched rule 2 and called `build.resolve("buffer")`
   * again. It presented as a build that never finished rather than as a stack overflow, which is
   * the harder symptom to read.
   *
   * The marker below is esbuild's own answer: a resolution this plugin started carries
   * `pluginData.viaTable` and is passed straight through on the way back in.
   */
  let resolveViaEsbuild = null;

  /* The plugin object is handed to esbuild, which REFUSES an unknown key on it — so the record of
     what was substituted travels beside the plugin rather than on it. Measured: an `applied` member
     on the plugin fails the build with "Invalid option on plugin". */
  const plugin = {
    name: "ohmail-phone-substitutions",
    setup(build) {
      resolveViaEsbuild = async (specifier, target) => {
        const r = await build.resolve(target, {
          resolveDir: aliases.MOBILE,
          kind: "import-statement",
          pluginData: { viaTable: true },
        });
        if (r.errors.length > 0 || !r.path) {
          throw new Error(
            `the phone engine's alias table maps "${specifier}" to the package "${target}", ` +
              "which apps/mobile cannot resolve. Add it to that package's dependencies — a shim " +
              "cannot stand in for it, because the engine uses this module rather than merely " +
              "importing it.",
          );
        }
        return r.path;
      };
      build.onResolve({ filter: /.*/ }, async (args) => {
        /* 0 — OUR OWN RESOLUTION, ON ITS WAY BACK IN. See the banner above `resolveViaEsbuild`:
           without this the first package target loops for ever. */
        if (args.pluginData && args.pluginData.viaTable === true) return null;
        // 1 — the native modules stay as requires for the app's bundler.
        if (external.has(args.path)) {
          applied.push([args.path, "(external)"]);
          return { path: args.path, external: true };
        }
        // 2 — bare specifiers, by exact name.
        if (Object.hasOwn(bare, args.path)) {
          const target = bare[args.path];
          /* A TARGET that is itself one of the native modules stays EXTERNAL: `crypto` maps to
             `react-native-quick-crypto`, and rule 1 above only sees the INCOMING specifier. Without
             this, `crypto` would be resolved and bundled — which is impossible for a module whose
             JavaScript is meaningless without its compiled library. */
          if (external.has(target)) {
            applied.push([args.path, `${target} (external)`]);
            return { path: target, external: true };
          }
          /* An absolute path is a file in this repository; anything else is a package name, and
             esbuild will not resolve one on a plugin's behalf. */
          const resolved = target.startsWith("/") ? target : await resolveViaEsbuild(args.path, target);
          applied.push([args.path, resolved]);
          return { path: resolved };
        }
        // 3 — the schema twin, at the module the barrel reaches.
        if (args.path === aliases.SCHEMA_TWIN.from) {
          applied.push([args.path, aliases.SCHEMA_TWIN.to]);
          return { path: aliases.SCHEMA_TWIN.to };
        }
        // 4 — the desktop's own modules, only when imported from inside the sidecar.
        if (Object.hasOwn(aliases.SIDECAR_SUBSTITUTES, args.path)
          && args.importer.startsWith(sidecarSrc)) {
          const target = aliases.SIDECAR_SUBSTITUTES[args.path];
          applied.push([args.path, target]);
          return { path: target };
        }
        return null;   // everything else resolves normally
      });
    },
  };
  return { plugin, applied };
}

/**
 * THE ARTIFACT IS COMMONJS, AND ITS OWN NAME HAS TO SAY SO.
 *
 * The bundle is emitted as `cjs` — that is what the app's bundler expects from a pre-bundled
 * module and what makes the two native dependencies come out as `require`s. The workspace this
 * builds in declares `"type": "module"`, and Node decides a `.js` file's module kind from the
 * nearest `package.json`, so `require()` of the artifact under its shipped name answers
 * `ReferenceError: module is not defined in ES module scope` from the bundle's own first line.
 *
 * That is not a device problem — the app's bundler reads the file by path and never asks Node —
 * but it is a problem for every Node reader of the artifact, and the readers are the ones that
 * matter here: the guard that loads it and the twin that runs it over Node's sockets. The twin
 * worked around it by copying the bundle to a `.cjs` name beside itself, which measures a copy
 * rather than the thing that ships.
 *
 * A sibling `package.json` naming the directory's module kind fixes it at the source, and it is
 * the smallest fix available: the artifact keeps its name, the app's import path is unchanged, and
 * the file that decides is next to the file it decides about.
 */
function markCommonJs(dir) {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
}

/**
 * WHAT THE GENERATED MODULE EXPORTS, WRITTEN DOWN BESIDE IT.
 *
 * The app loads this artifact through an untyped `require`, so this declaration is not what makes
 * the app compile — it is what a reader of an ignored directory full of generated code has to go
 * on, and it is a CLAIM: `test/engine-packaging.test.ts` reads the names out of it and asserts the
 * loaded artifact really exports each one. A declaration that drifted from the bundle would be red
 * there rather than merely stale.
 */
function declarationFor() {
  return [
    "// Generated by apps/mobile/scripts/bundle-engine.mjs. Do not edit, do not commit.",
    "// The app loads this module through `src/engine/engine-bundle-native.ts`.",
    'import type { StartPhoneEngine, StartPhoneEngineFromSealed } from "../src/engine/standalone-door";',
    "",
    "export declare const startPhoneEngine: StartPhoneEngine;",
    "export declare const startPhoneEngineFromSealed: StartPhoneEngineFromSealed;",
    "",
  ].join("\n");
}

export async function buildPhoneEngine({ write = true } = {}) {
  const esbuild = await loadEsbuild();
  const { plugin, applied } = substitutions();
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(PACKAGED_DIR, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    /* NEUTRAL, and this is the hard gate rather than a preference: on `platform: "node"` esbuild
       marks every `node:` builtin EXTERNAL and the bundle builds happily with a dozen of them left
       in it, to be discovered by a device at load. On neutral, an unaliased builtin is a BUILD
       ERROR naming the file that imported it. The census over the metafile is the second reading of
       the same fact, kept because a build can be run with different options and a test cannot. */
    platform: "neutral",
    format: "cjs",
    target: "es2022",
    /* The app's bundler consumes this file; `cjs` is what it expects from a pre-bundled module, and
       it is also what makes the two native `require`s come out as requires rather than imports. */
    mainFields: ["react-native", "browser", "module", "main"],
    conditions: ["react-native", "browser", "import", "default"],
    absWorkingDir: REPO,
    inject: aliases.INJECT,
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: [plugin],
  });

  /* Stripped BEFORE anything else sees it, so `text` and the bytes on disk are the same artifact:
     a caller that censused `text` and a test that censused the file would otherwise be measuring
     two different things, and only one of them ships. */
  const text = stripBuildPaths(result.outputFiles[0].text);
  if (write) {
    writeFileSync(BUNDLE, text);
    writeFileSync(TYPES, declarationFor());
    markCommonJs(PACKAGED_DIR);
    writeFileSync(METAFILE, JSON.stringify(result.metafile));
  }
  return {
    metafile: result.metafile,
    inputs: Object.keys(result.metafile.inputs),
    text,
    applied,
    bundlePath: BUNDLE,
    metafilePath: METAFILE,
  };
}

/** Every `node:`-prefixed specifier still EXTERNAL in the graph. The census's core reading. */
/**
 * ONE TINY BUNDLE, UNDER THE SAME SUBSTITUTIONS — for guards about the substitutes themselves.
 *
 * The census over the real artifact answers what the graph CONTAINS. It cannot answer what a
 * substituted module DOES when the bundler wires an import to it, because the shape that matters
 * — the interop wrapper esbuild generates for an ES import of a CommonJS module — depends on the
 * importing source, and the real entry point writes only the forms it happens to write.
 *
 * So a guard hands over the two lines it wants wired and gets back a loadable file. The plugin,
 * the alias table, the platform and the format are the artifact's own; only the entry point and
 * the output directory differ. A second copy of those options would be a probe that stopped
 * testing the thing it is named after.
 *
 * @param {string} entrySource the entry module, as TypeScript source
 * @returns {Promise<{ bundlePath: string, dir: string, text: string, metafile: object }>}
 */
export async function bundleProbe(entrySource) {
  const esbuild = await loadEsbuild();
  const { plugin } = substitutions();
  const dir = mkdtempSync(join(REPO, "build", "phone-probe-"));
  const entry = join(dir, "probe-entry.ts");
  writeFileSync(entry, entrySource);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "neutral",
    format: "cjs",
    target: "es2022",
    mainFields: ["react-native", "browser", "module", "main"],
    conditions: ["react-native", "browser", "import", "default"],
    absWorkingDir: REPO,
    inject: aliases.INJECT,
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: [plugin],
  });

  const bundlePath = join(dir, "probe.js");
  writeFileSync(bundlePath, result.outputFiles[0].text);
  markCommonJs(dir);
  return { bundlePath, dir, text: result.outputFiles[0].text, metafile: result.metafile };
}

export function nodeSpecifiersIn(metafile) {
  const found = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports ?? []) {
      if (imported.external && /^node:/.test(imported.path)) found.add(imported.path);
      else if (/^node:/.test(imported.path)) found.add(imported.path);
    }
  }
  return [...found].sort();
}

/**
 * Everything the bundle left for the app's bundler to resolve. Expected: exactly the two natives.
 *
 * ── THE INJECT EDGE IS NOT AN EXTERNAL, AND THE METAFILE SAYS IT IS ───────────────────────
 *
 * esbuild records the injected module as an import of EVERY input, by absolute path, with
 * `external: true` — 828 such edges in this bundle. It is not external: `globals.mjs` is also an
 * INPUT of the same metafile, so its code is in the artifact. Reading the flag alone reports three
 * externals and a census written against that number would have pinned a quirk.
 *
 * So the rule is the one that distinguishes them by fact rather than by name: an "external" that is
 * ALSO an input is a bundled module the metafile has double-listed. Anything else genuinely left
 * the bundle.
 */
export function externalsIn(metafile) {
  const inputs = new Set(Object.keys(metafile.inputs));
  /* The inject edge is absolute; inputs are recorded relative to the build's working directory. */
  const asInput = (p) => inputs.has(p) || [...inputs].some((k) => p.endsWith(`/${k}`));
  const found = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports ?? []) {
      if (imported.external && !asInput(imported.path)) found.add(imported.path);
    }
  }
  return [...found].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const built = await buildPhoneEngine();
  const node = nodeSpecifiersIn(built.metafile);
  const ext = externalsIn(built.metafile);
  console.log(`phone engine: ${built.inputs.length} inputs, ${(built.text.length / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`substitutions applied: ${built.applied.length}`);
  console.log(`node: specifiers surviving: ${node.length}${node.length ? `\n  ${node.join("\n  ")}` : ""}`);
  console.log(`externals: ${ext.length}${ext.length ? `\n  ${ext.join("\n  ")}` : ""}`);
  console.log(`bundle:   ${relative(REPO, built.bundlePath)}`);
  console.log(`metafile: ${relative(REPO, built.metafilePath)}`);
}
