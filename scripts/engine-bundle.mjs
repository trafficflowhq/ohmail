#!/usr/bin/env node
/**
 * engine-bundle.mjs — the desktop mail engine as ONE file, plus the two things it reads off disk. The
 * shell hands this file to a Node runtime by name on all three platforms; run it directly or import
 * {@link buildEngine}. (`node scripts/engine-bundle.mjs`, or `OHMAIL_ESBUILD_FROM=<dir> node …` to build
 * from anywhere.) A bundle not a `dist/` tree: a shipped app has no package manager or workspace, the
 * compiled entry reaches TypeScript-only modules, and one file makes the artifact enumerable so a stranger
 * can check the published source against the download. TWO things cannot be bundled: the mail migration
 * journal (the db package composes it from `import.meta.url`, which the bundler rewrites to the OUTPUT URL,
 * so it sits at `<dirname(bundle)>/../drizzle` — the reason the output has a `bin/`; only the MAIL journal
 * is copied) and the database engine's WebAssembly (loaded relative to its module, vendored beside the bundle). A banner defines `require` for the MIME parser's runtime charset lookups. `.mjs` makes the ESM module type a fact when handed to a runtime by name; the shebang/execute bit are now a convenience, since the shell spawns `<node> <bundle>` (the only shape that works on Windows). */
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE ONE esbuild THIS ENGINE IS BUILT WITH, asserted rather than assumed. esbuild's output is
 * deterministic for a GIVEN version but NOT stable across versions — a later esbuild lays the same graph out
 * differently. The engine bundle is meant to be reproducible from the published source (a public runner and
 * a local build must produce byte-equal output, which needs the same esbuild), so bump it deliberately in
 * ONE place; a silent drift is the "absent config picks a version" hazard the whole lockfile-and-pin story
 * closes. EXACT, not a range: layout can move within a minor and "byte-equal" is the whole claim. The root
 * manifest pins the same string, so the two cannot disagree without this refusing.
 */
export const EXPECTED_ESBUILD = "0.24.0";

/**
 * esbuild, from two places in one order. `OHMAIL_ESBUILD_FROM` names a directory that has one installed and
 * is tried FIRST — it lets a checkout build the engine without esbuild in its own module tree. The
 * workspace is tried second, for a tree that declares it: resolving the bundler from installed dependencies
 * needs no network at run time, the only way a sandboxed packaging build can produce this artifact.
 * `NODE_PATH` is deliberately not the mechanism: node ignores it for ESM `import`, a pleasant half-hour to
 * discover from `ERR_MODULE_NOT_FOUND` alone.
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
    `esbuild was not found, and the engine is built with exactly ${EXPECTED_ESBUILD}. Either install ` +
    "it in this tree, or install it somewhere harmless and point at it:\n\n" +
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
    /* PINNED TO THE WORKSPACE ROOT, so the artifact does not depend on where the build was STARTED —
     * measured. The bundle is not minified, so esbuild writes each module's path as a comment above it (831
     * in the current artifact), relative to its working directory (defaults to `process.cwd()`). Building
     * the same commit from the workspace root and from anywhere else produces two DIFFERENT files, the
     * second embedding the checkout's absolute location in every comment — a reproducibility break and a
     * detail of the builder's machine that has no business in a published download. Setting it makes the
     * paths a function of the tree alone (verified byte-for-byte: root, a scratch dir and `/` produce the
     * same file, identical to what the previous root build produced). `scripts/verify-engine-repro.mjs` watches it hold. */
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
/* Through realpath: `import.meta.url` is the resolved file, so a script reached through a symlink
 * compared unequal, ran nothing and exited 0. */
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { inputs, bundleText } = await buildEngine();
  console.log(`\nengine: ${inputs.length} bundled inputs, ${(bundleText.length / 1024 / 1024).toFixed(1)} MiB`);
  console.log("NOTE: the engine is a node script. The app that ships it carries its own Node "
    + "runtime (scripts/vendor-node.mjs) and spawns `<node> <bundle>`; the shebang is for running "
    + "it by hand from a checkout.");
}
