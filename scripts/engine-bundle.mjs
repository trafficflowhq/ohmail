#!/usr/bin/env node
/**
 * engine-bundle.mjs — the desktop mail engine as ONE file, plus the two things it reads off disk.
 *
 * The app's shell hands this file to a Node runtime by name — `<node> <bundle>` — and it does that
 * on all three platforms. This produces the file, and the layout around it, from the workspace. Run
 * it directly, or import {@link buildEngine} to build the same artifact and get its inputs back for
 * inspection.
 *
 *     D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)
 *     OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs
 *
 * ── WHY A BUNDLE AND NOT A `dist/` TREE ───────────────────────────────────────────────────
 *
 * A shipped app has no package manager and no workspace. Running the engine's compiled entry
 * point out of its build directory does not work even on a development machine — it reaches
 * modules that exist only as TypeScript — and an application bundle cannot carry a symlinked
 * dependency tree. One file resolves both, and it makes the artifact's contents enumerable, which
 * is what lets anyone check the published source against the binary they downloaded.
 *
 * ── THE TWO THINGS THAT CANNOT BE BUNDLED, AND THEIR PATHS ────────────────────────────────
 *
 *  1. **The mail migration journal.** The database package composes it as
 *     `join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")`, and the bundler rewrites
 *     `import.meta.url` to the OUTPUT file's own URL. So the journal must sit at
 *     `<dirname(bundle)>/../drizzle` — one level ABOVE the bundle. That is the whole reason the
 *     output has a `bin/` directory at all: the journal sits beside `bin/`, not inside it, and the
 *     packager copies the pair as a unit. This relationship is invisible to every test in the
 *     repository: nothing else runs the engine from anywhere but the workspace root, where the same
 *     expression happens to resolve. `scripts/verify-engine-boot.mjs` is what watches it fail.
 *
 *     Only the MAIL journal is copied, and there is deliberately no second branch here. The engine
 *     builds one database, from one journal, whose own closure rule guarantees it is runnable
 *     first and alone — which is exactly what a local install does on first launch.
 *
 *  2. **The database engine's WebAssembly.** It loads `.wasm` and `.data` relative to its own
 *     module, so the package is vendored beside the bundle rather than inlined. Inlining it would
 *     produce a bundle that cannot find its own storage layer.
 *
 * ── THE BANNER ────────────────────────────────────────────────────────────────────────────
 *
 * The MIME parser calls `require()` at runtime to look up optional character encodings. ESM output
 * has no `require`, so without a shim the bundle dies on the first message carrying a charset it
 * wants to resolve — after a successful launch, a successful mailbox connection and a successful
 * fetch, which is the worst possible place for a module error to surface. The banner defines one.
 *
 * ── `.mjs`, AND WHY THE EXTENSION IS NOT COSMETIC ─────────────────────────────────────────
 *
 * The output is ESM, and it used to have no extension at all — which worked because the shell
 * executed it through its own `#!` line, and because Node 22.7+ turns on module-syntax DETECTION by
 * default. Handed to a runtime BY NAME, an extensionless file's module type is a heuristic over its
 * contents and over whatever `package.json` happens to sit above it. `.mjs` makes it a fact.
 *
 * ── THE SHEBANG AND THE EXECUTE BIT ARE NOW A CONVENIENCE, NOT THE MECHANISM ──────────────
 *
 * They are still set, because running the engine straight off a checkout is a real thing people do.
 * Nothing SHIPPED depends on them any more: the shell resolves a Node runtime explicitly and spawns
 * `<node> <bundle>`, which is the only launch shape that works on Windows — there is no shebang
 * mechanism there, so a text file is not executable by any means the loader has. The previous
 * arrangement also meant a machine with no `node` on PATH could not start the engine at all, and a
 * Finder or launchd launch has neither Homebrew nor nvm on its PATH. The runtime is vendored into
 * the app beside this bundle; see `scripts/vendor-node.mjs`.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE ONE esbuild THIS ENGINE IS BUILT WITH, asserted rather than assumed.
 *
 * esbuild's output is deterministic for a GIVEN version, but it is NOT stable across versions — a
 * later esbuild can lay the same module graph out differently. The engine bundle is meant to be
 * reproducible from the published source: a public runner and a local build must produce byte-equal
 * output, which they can only do if both run the same esbuild. Nothing else pins it — the pin used
 * to live in a comment — so it is checked here. Bump it deliberately, in ONE place, when the engine
 * is meant to move; a silent drift is the "absent config picks a version" hazard the whole
 * lockfile-and-pin story exists to close.
 */
export const EXPECTED_ESBUILD = "0.24.0";

/**
 * esbuild, WITHOUT adding it to the workspace.
 *
 * A bundler is a build-time tool rather than something the product ships, and in a monorepo every
 * dependency install risks leaving the module tree half-written for whoever else is working in it.
 * So the resolution is explicit: `OHMAIL_ESBUILD_FROM` names a directory that has one installed,
 * and the workspace is tried as well for the case where somebody has legitimately added it.
 *
 * `NODE_PATH` is deliberately not the mechanism: node ignores it for ESM `import`, which is a
 * pleasant half-hour to discover from `ERR_MODULE_NOT_FOUND` alone.
 */
export async function loadEsbuild(root = ROOT) {
  const from = process.env.OHMAIL_ESBUILD_FROM;
  const paths = [root, ...(from ? [from] : [])];
  for (const base of paths.reverse()) {
    let mod;
    try {
      mod = await import(pathToFileURL(createRequire(join(base, "noop.js")).resolve("esbuild")).href);
    } catch { continue; /* try the next one, and fail with the message below if none works */ }
    /* Found one — it MUST be the pinned version, or the bundle it produces is not the reproducible
     * one. A wrong version is a hard stop, not a fallback to the next path: continuing would build a
     * silently different artifact from a tool that is present and working. */
    if (mod.version !== EXPECTED_ESBUILD) {
      throw new Error(
        `esbuild ${mod.version} is installed, but the engine is pinned to ${EXPECTED_ESBUILD}.\n` +
        `  The bundle is only reproducible for a fixed esbuild version, so this is refused rather\n` +
        `  than built. Install the pinned version:\n\n` +
        `    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@${EXPECTED_ESBUILD})\n` +
        `    OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs\n`);
    }
    return mod;
  }
  throw new Error(
    "esbuild was not found. It is not a workspace dependency on purpose — install it somewhere " +
    "harmless and point at it:\n\n" +
    `    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@${EXPECTED_ESBUILD})\n` +
    "    OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs\n",
  );
}

/**
 * The bundler options, as a function rather than a constant, so a second pass over the SAME module
 * graph can be built from them.
 *
 * Anything that changes what the artifact contains has to change here and nowhere else. A caller
 * that re-bundles with different options is measuring a different program from the one that ships.
 */
export function buildOptionsFor(root = ROOT) {
  return {
    entryPoints: [join(root, "apps", "sidecar", "src", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    /* PINNED TO THE WORKSPACE ROOT, so the artifact does not depend on where the build was
     * STARTED from — and this was measured, not assumed.
     *
     * The bundle is not minified, so esbuild writes each module's path as a comment above it:
     * 831 of them in the current artifact. Those paths are relative to esbuild's working
     * directory, which defaults to `process.cwd()`. Building the same commit from the workspace
     * root and from anywhere else therefore produces two DIFFERENT files — and the second one
     * embeds the checkout's absolute location in every one of those comments, which is both a
     * reproducibility break and a detail of the builder's machine that has no business in a
     * published download.
     *
     * Setting it makes the paths a function of the tree alone. Verified byte-for-byte: with this
     * option the bundle built from the workspace root, from a scratch directory and from `/` are
     * the same file, and that file is identical to what the previous behaviour produced from the
     * root — so nothing about the shipped artifact changes, one way it could vary just stops
     * existing. `scripts/verify-engine-repro.mjs` is what watches this hold. */
    absWorkingDir: root,
    // Vendored rather than inlined: the storage layer reads its own `.wasm`/`.data` off disk
    // relative to the module, so inlining it would produce a bundle that cannot find its database.
    external: ["@electric-sql/pglite"],
    banner: {
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __ohmailCreateRequire } from 'node:module';",
        "const require = __ohmailCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "info",
  };
}

/** The installed root of the storage package, resolved through whatever layout is in use. */
function pgliteDir(root) {
  const entry = createRequire(join(root, "noop.js"))
    .resolve("@electric-sql/pglite", { paths: [join(root, "apps", "sidecar")] });
  // …/@electric-sql/pglite/dist/index.js → …/@electric-sql/pglite
  return resolve(dirname(entry), "..");
}

/**
 * Build the engine and lay out the two files it reads at runtime.
 *
 * @param {object} [o]
 * @param {string} [o.root]     workspace root
 * @param {string} [o.outRoot]  where the layout is written; the bundle lands in `bin/`
 * @returns {Promise<{ build: Function, buildOptions: object, metafile: object, inputs: string[],
 *                     bundlePath: string, bundleText: string, outRoot: string,
 *                     metafilePath: string }>}
 */
export async function buildEngine({ root = ROOT, outRoot } = {}) {
  const out = outRoot ?? process.env.OHMAIL_ENGINE_OUT ?? join(root, "build", "engine");
  /* The bundle lives here and the journal one level up — see the header. `bin/` and not `MacOS/`,
   * which is what this directory was called while one platform's application bundle was the only
   * consumer: that name would now be copied verbatim into every Linux `.deb` and every Windows
   * install directory, describing nothing. */
  const binDir = join(out, "bin");
  const bundlePath = join(binDir, "ohmail-engine.mjs");

  const { build } = await loadEsbuild(root);
  const buildOptions = buildOptionsFor(root);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });

  const result = await build({ ...buildOptions, outfile: bundlePath, metafile: true });
  /* BESIDE the layout rather than inside it. `out` is copied WHOLESALE into the app's resources, so
   * anything in it ships; the metafile is a build record — the measured list of sources that became
   * this artifact, which the publisher expands into the licence's corresponding source — and has no
   * business inside a download. `metafilePath` is returned so no caller has to re-derive it. */
  const metafilePath = `${out}.meta.json`;
  writeFileSync(metafilePath, JSON.stringify(result.metafile));

  // To match the shebang — see the header. Without it the spawn is EACCES.
  chmodSync(bundlePath, 0o755);

  // The mail journal, at the path the bundle's own `import.meta.url` will compose.
  cpSync(join(root, "packages", "db-mail", "drizzle"), join(out, "drizzle"), { recursive: true });

  // The storage package, beside the bundle, where a bare-specifier import will find it.
  cpSync(pgliteDir(root), join(binDir, "node_modules", "@electric-sql", "pglite"), {
    recursive: true, dereference: true,
  });

  const bundleText = readFileSync(bundlePath, "utf8");
  return {
    build, buildOptions,
    metafile: result.metafile,
    inputs: Object.keys(result.metafile.inputs),
    bundlePath, bundleText, outRoot: out, metafilePath,
  };
}

/* Run directly — build the artifact and say what it contains. Importers get the function above and
 * decide for themselves what to check; see `scripts/build-engine.mjs`, which is the entry point
 * this workspace actually uses. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { inputs, bundleText } = await buildEngine();
  console.log(`\nengine: ${inputs.length} bundled inputs, ${(bundleText.length / 1024 / 1024).toFixed(1)} MiB`);
  console.log("NOTE: the engine is a node script. The app that ships it carries its own Node "
    + "runtime (scripts/vendor-node.mjs) and spawns `<node> <bundle>`; the shebang is for running "
    + "it by hand from a checkout.");
}
