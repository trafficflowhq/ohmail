#!/usr/bin/env node
/**
 * bundle-host.mjs — one server host as ONE file, plus the journals it reads off disk.
 *
 *     node scripts/bundle-host.mjs server     → build/host-server/
 *     node scripts/bundle-host.mjs worker     → build/host-worker/
 *
 * This is the engine bundle's arrangement (see scripts/engine-bundle.mjs) applied to the two
 * long-running host processes the self-host images ship: the standalone API server
 * (apps/server) and the sync organizer (apps/worker). The same reasons hold, one for one:
 *
 *   · This repository's manifests are generated for npm and their `exports` point at SOURCE,
 *     so a compiled `dist/` tree cannot resolve its own workspace imports at runtime. One
 *     bundled file has no imports left to resolve.
 *   · A container is better off without a package manager or a module tree in it: the bundle
 *     makes the artifact's contents enumerable, which is what lets anyone check a published
 *     image against the source it claims to be built from.
 *
 * ── WHAT CANNOT BE BUNDLED: THE MIGRATION JOURNALS ────────────────────────────────────────
 *
 * The database packages compose their journal folders with
 * `join(dirname(fileURLToPath(import.meta.url)), "..", <folder>)`, and the bundler rewrites
 * `import.meta.url` to the OUTPUT file's own URL. So the journals must sit one level ABOVE
 * the bundle — the same reason the engine's layout has a `bin/` directory:
 *
 *   build/host-<app>/bin/ohmail-<app>.mjs      the process
 *   build/host-<app>/drizzle/                  the mail journal (packages/db-mail/drizzle —
 *                                              `MAIL_MIGRATIONS_DIR` resolves here)
 *   build/host-<app>/drizzle-cloud/            the cloud journal (packages/db/drizzle-cloud)
 *
 * Both hosts get both journals: the server runs them at boot, and a uniform layout means one
 * set of assertions in the image recipes. `packages/db/drizzle` (the pre-split journal) is
 * deliberately NOT copied — no code migrates from it; it is the adoption oracle its own
 * header describes, read by tests and by nothing else.
 *
 * ── THE BOUNDARY THE BUILD CONTEXT ENFORCES ───────────────────────────────────────────────
 *
 * Each image's build context is an allow-list (`/.dockerignore`,
 * `apps/server/Dockerfile.dockerignore`) admitting exactly that host's compile closure. An
 * import that reaches outside it — the organizer importing `@trafficflow/services`, say —
 * resolves to a workspace symlink whose target directory holds only a manifest, and the
 * bundle FAILS to build. That is the same fail-at-build-time property the old filtered
 * `pnpm install` bought, enforced by what the context contains rather than by what the
 * package manager installed.
 *
 * esbuild is loaded exactly as the engine build loads it: pinned version, resolved from
 * `OHMAIL_ESBUILD_FROM`, never a project dependency. `@electric-sql/pglite` stays external
 * for the engine's reason (it reads its own `.wasm` off disk); neither host imports it today,
 * so nothing is vendored — if either ever grows the import, the missing module fails the
 * container LOUDLY at boot rather than silently shipping a broken storage layer.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEsbuild } from "./engine-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── THE WORKER'S ENTRY STUB, and why the two hosts differ ─────────────────────────────────
 *
 * `apps/server/src/index.ts` calls its `main()` unconditionally, so bundling it directly is
 * the whole story. The worker's package is different: it holds FIVE
 * `isCliEntry(import.meta.url)` main guards — the supervisor and four cron CLIs — and a
 * bundle folds every module's `import.meta.url` into ONE value. Invoke that file directly
 * and all five guards are true at once: the crons run their single pass and exit(0)
 * CLEANLY, killing the supervisor mid-boot. Measured on the bundled organizer's first
 * compose boot as a restart loop with exit code 0 and nothing wrong in the logs.
 *
 * So the worker bundles THIS stub as its entry. Its first statement blanks `argv[1]`
 * — `isCliEntry` answers false to a process with no script path, so no in-bundle guard can
 * ever match, HOWEVER the bundle is invoked — and then it starts the supervisor explicitly
 * through the named export the guard would have called. The dynamic import is what keeps
 * the ordering true: a static import would evaluate every module (guards included) before
 * the first statement of this stub runs.
 *
 * Written to a FIXED path under build/ (never a mkdtemp): the bundle records each module's
 * path relative to the workspace root, so a per-run temp path would make the same source
 * produce a different artifact — the reproducibility the engine bundle already defends. */
const WORKER_STUB = `/* the organizer's bundle entry — see scripts/bundle-host.mjs for why this exists */
process.argv[1] = "";
const { runWorkerCli } = await import("../apps/worker/src/index.ts");
await runWorkerCli();
`;

/** The two hosts this script knows how to lay out. An unknown name is a hard stop. */
const HOSTS = {
  server: { entry: "apps/server/src/index.ts" },
  worker: { entry: "build/host-stub-worker.mjs", stub: WORKER_STUB },
};

const name = process.argv[2];
if (!HOSTS[name]) {
  console.error(`usage: node scripts/bundle-host.mjs <${Object.keys(HOSTS).join("|")}>`);
  process.exit(1);
}

const out = join(ROOT, "build", `host-${name}`);
const binDir = join(out, "bin");
const bundlePath = join(binDir, `ohmail-${name}.mjs`);

const { build } = await loadEsbuild(ROOT);

rmSync(out, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

if (HOSTS[name].stub) {
  writeFileSync(join(ROOT, HOSTS[name].entry), HOSTS[name].stub);
}

const result = await build({
  entryPoints: [join(ROOT, HOSTS[name].entry)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Paths in the output are a function of the tree alone, not of where the build started —
  // the engine bundle's reproducibility argument, verbatim.
  absWorkingDir: ROOT,
  external: ["@electric-sql/pglite"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // The MIME parser calls require() at runtime for optional charset lookups; ESM output
      // has no require without this shim, and the failure would surface on the first message
      // carrying an unusual charset — after a successful boot and connect.
      "import { createRequire as __ohmailCreateRequire } from 'node:module';",
      "const require = __ohmailCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  outfile: bundlePath,
  metafile: true,
  logLevel: "info",
});

// Beside the layout, never inside it — the layout is copied wholesale into the image.
writeFileSync(`${out}.meta.json`, JSON.stringify(result.metafile));
chmodSync(bundlePath, 0o755);

// The journals, at the paths the bundle's own `import.meta.url` composes — see the header.
cpSync(join(ROOT, "packages", "db-mail", "drizzle"), join(out, "drizzle"), { recursive: true });
cpSync(join(ROOT, "packages", "db", "drizzle-cloud"), join(out, "drizzle-cloud"), { recursive: true });

/* The build label, one directory above the bundle — exactly the file
 * `apps/worker/src/build-version.ts` reads (`../BUILD_VERSION` from the module, which is the
 * bundle after folding): an input to the image, never a committed file. The organizer's
 * durable-failure retry is woken by a CHANGE of build and by nothing else, so a container
 * that always answers "dev" is a container whose failed messages are never retried across
 * releases. The tree's own version is what a from-source image is a build of. */
const version = String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "").trim();
if (!version) {
  console.error("the workspace root declares no version — the image's build label cannot be written");
  process.exit(1);
}
writeFileSync(join(out, "BUILD_VERSION"), `${version}\n`);

const inputs = Object.keys(result.metafile.inputs).length;
console.log(`\nhost ${name}: ${inputs} bundled inputs → ${bundlePath}`);
