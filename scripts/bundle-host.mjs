#!/usr/bin/env node
/**
 * bundle-host.mjs — one server host as ONE file, plus the journals it reads off disk
 * (`node scripts/bundle-host.mjs server|worker` → `build/host-server|host-worker/`). The engine bundle's
 * arrangement (`scripts/engine-bundle.mjs`) applied to the two long-running hosts (`apps/server`,
 * `apps/worker`): the generated manifests' `exports` point at SOURCE, so a compiled `dist/` cannot resolve
 * its workspace imports at runtime, and one bundled file has none left to resolve; a container is better
 * off with no package manager or module tree. WHAT CANNOT BE BUNDLED: the migration journals — the db
 * packages compose them from `import.meta.url`, which the bundler rewrites to the OUTPUT file's URL, so they
 * must sit one level ABOVE (`build/host-<app>/drizzle` for mail, `.../drizzle-cloud` for cloud). Both hosts
 * get both; `packages/db/drizzle` (the pre-split journal) is NOT copied. Each image's build context is an allow-list, so an import reaching outside it fails the bundle at build time. esbuild loads as the engine build loads it (pinned, `OHMAIL_ESBUILD_FROM` first); `@electric-sql/pglite` stays external, unused today, and a future import would fail LOUDLY at boot. */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEsbuild } from "./engine-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* THE WORKER'S ENTRY STUB, and why the two hosts differ. `apps/server/src/index.ts` calls its `main()`
 * unconditionally, so bundling it directly is the whole story. The worker's package holds FIVE
 * `isCliEntry(import.meta.url)` main guards (the supervisor and four cron CLIs), and a bundle folds every
 * module's `import.meta.url` into ONE value — invoke that file directly and all five are true at once, the
 * crons run their single pass and `exit(0)` cleanly, killing the supervisor mid-boot (measured as a restart
 * loop with exit code 0 and nothing wrong in the logs). So the worker bundles THIS stub as its entry: its
 * first statement blanks `argv[1]` (so `isCliEntry` answers false however the bundle is invoked), then
 * starts the supervisor through the named export the guard would have called, via a dynamic import that
 * keeps the ordering (a static import would evaluate every module's guard first). Written to a FIXED path
 * under build/ (never a mkdtemp), because the bundle records module paths relative to the workspace root and a per-run temp path would break reproducibility. */
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
/* A COMMIT WINS OVER A RELEASE NUMBER, when the build was given one. The version alone cannot tell
 * two builds of one release apart — the trap the released 0.20.0 images walked into — so the image
 * recipes pass the tagged commit as `TF_BUILD_VERSION` and it becomes the label. Read here, at the
 * moment the file is written, and written INTO the layout, so the label can never name a build this
 * bundle was not made from. Absent (a local build from a working tree), the workspace version is
 * still the honest answer and the refusal above still guards it. */
const label = String(process.env.TF_BUILD_VERSION ?? "").trim() || version;
writeFileSync(join(out, "BUILD_VERSION"), `${label}\n`);

const inputs = Object.keys(result.metafile.inputs).length;
console.log(`\nhost ${name}: ${inputs} bundled inputs → ${bundlePath}`);
