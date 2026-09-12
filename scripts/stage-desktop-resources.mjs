#!/usr/bin/env node
/**
 * stage-desktop-resources.mjs — assemble EXACTLY what the desktop app carries in its resources, and
 * refuse to stage anything half-built.
 *
 *     node scripts/build-engine.mjs      # → build/engine
 *     node scripts/vendor-node.mjs       # → build/vendor
 *     node scripts/stage-desktop-resources.mjs
 *
 * ── WHY A STAGING STEP AND NOT `bundle.resources` STRAIGHT AT `build/` ────────────────────
 *
 * Tauri copies a resource DIRECTORY wholesale, preserving its tree. That is the behaviour this
 * layout wants, and it is also why the source of the copy has to be a directory that contains
 * nothing but the app's runtime needs: `build/engine` is a BUILD output, and a build output grows
 * things — a metafile, a source map, a stray `.tsbuildinfo` — each of which would silently become
 * part of a hundreds-of-megabytes download that people are invited to audit. Staging makes the
 * shipped set a written list rather than a side effect of what the last build happened to leave
 * behind.
 *
 * It also gives the three refusals below somewhere to live. Every one of them is a failure that
 * otherwise surfaces as a packaged app that installs cleanly and cannot start its engine — the
 * worst place to find out, because the artifact looks finished.
 *
 * ── THE LAYOUT, WHICH IS A CONTRACT WITH `engine.rs` ──────────────────────────────────────
 *
 *     <resources>/engine/bin/ohmail-engine.mjs       the engine
 *     <resources>/engine/bin/node_modules/…          the storage layer it loads off disk
 *     <resources>/engine/drizzle/…                   its migration journal, ONE LEVEL UP
 *     <resources>/runtime/node[.exe]                 the Node runtime it is spawned with
 *     <resources>/runtime/node.LICENSE               that runtime's licence
 *
 * `engine.rs` composes the first and the fourth of those from `app.path().resource_dir()`
 * (`engine_path_in` / `vendored_node_in`), and `the_packaged_layout_is_the_one_the_bundler_stages`
 * pins them from the Rust side. The journal's position is not a choice: the bundle resolves it as
 * `dirname(import.meta.url)/../drizzle`, so it sits beside `bin/` and not inside it.
 *
 * The staged tree is what `apps/desktop/src-tauri/tauri.engine.conf.json` names, and that overlay is
 * the only config that names it — the preview artifact has no engine and must stay buildable without
 * one, which it cannot be if the base config demands a resource that is not there.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ENGINE_BUILD = join(ROOT, "build", "engine");
export const VENDOR_BUILD = join(ROOT, "build", "vendor");
export const STAGED = join(ROOT, "build", "desktop-resources");

const say = (m) => process.stdout.write(`${m}\n`);
function die(m) {
  process.stderr.write(`\nstage-desktop-resources: ${m}\n`);
  process.exit(1);
}

/** `node` on Unix, `node.exe` on Windows. The same rule `engine.rs::node_file_name` applies. */
const NODE = process.platform === "win32" ? "node.exe" : "node";

/* ── The three things that must be there, and what their absence actually means ───────────── */
const REQUIRED = [
  {
    from: join(ENGINE_BUILD, "bin", "ohmail-engine.mjs"),
    why: "the engine bundle — run `node scripts/build-engine.mjs`",
  },
  {
    from: join(ENGINE_BUILD, "drizzle"),
    why: "the engine's migration journal. Without it the app starts, spawns its engine, and the " +
      "engine dies in migrate() with ENOENT — a failure that looks like a crash loop and is a " +
      "missing directory",
  },
  {
    from: join(VENDOR_BUILD, NODE),
    why: `the vendored Node runtime — run \`node scripts/vendor-node.mjs\`. Without it the app ` +
      `falls back to whatever Node is on the user's PATH, and a desktop launch has none`,
  },
];

for (const { from, why } of REQUIRED) {
  if (!existsSync(from)) die(`${relative(ROOT, from)} is not there.\n  It is ${why}.`);
}

/* The storage layer is loaded from disk relative to the bundle, so it is vendored beside it rather
 * than inlined — a bundle with it inlined cannot find its own database. Checked separately because
 * its absence is the one that produces a running engine which fails on first query. */
const PGLITE = join(ENGINE_BUILD, "bin", "node_modules", "@electric-sql", "pglite");
if (!existsSync(PGLITE)) {
  die(`${relative(ROOT, PGLITE)} is not there.\n` +
      `  It is the storage layer the engine loads off disk; the engine would start and then fail on\n` +
      `  its first query. Re-run \`node scripts/build-engine.mjs\`.`);
}

rmSync(STAGED, { recursive: true, force: true });
mkdirSync(join(STAGED, "engine"), { recursive: true });
mkdirSync(join(STAGED, "runtime"), { recursive: true });

/* NAMED ENTRIES, not a copy of `build/engine`. See the header: the point of staging is that the
 * shipped set is a list somebody wrote down. `dereference` because the storage package may be a
 * symlink into a package store, and a symlink inside an application bundle points at a path that
 * does not exist on the machine that downloads it. */
cpSync(join(ENGINE_BUILD, "bin"), join(STAGED, "engine", "bin"), { recursive: true, dereference: true });
cpSync(join(ENGINE_BUILD, "drizzle"), join(STAGED, "engine", "drizzle"), { recursive: true, dereference: true });
cpSync(join(VENDOR_BUILD, NODE), join(STAGED, "runtime", NODE), { dereference: true });
if (existsSync(join(VENDOR_BUILD, "node.LICENSE"))) {
  cpSync(join(VENDOR_BUILD, "node.LICENSE"), join(STAGED, "runtime", "node.LICENSE"));
} else {
  die("build/vendor/node.LICENSE is not there — refusing to ship someone else's binary unlicensed");
}

/* A build record is not a runtime need. It is written beside `build/engine` rather than inside it
 * for exactly this reason, so finding one here means the bundler changed and this script did not. */
const strays = readdirSync(join(STAGED, "engine", "bin")).filter((n) => n.endsWith(".meta.json"));
if (strays.length) die(`the staged tree contains a build record: ${strays.join(", ")}`);

/* THE EXECUTE BIT, RE-ASSERTED RATHER THAN ASSUMED. `cpSync` preserves mode, and this line is not
 * about `cpSync` — it is about every path that reaches this directory, including a checkout on a
 * filesystem with no modes and an archive somebody unpacked by hand. The shell holds the runtime to
 * "runnable, not merely present", so a lost bit is reported to the user as "this build has no Node
 * in it", which reads as a broken install rather than as a broken package. */
if (process.platform !== "win32") chmodSync(join(STAGED, "runtime", NODE), 0o755);

function bytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? bytes(p) : statSync(p).size;
  }
  return total;
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
say(`stage-desktop-resources: ${relative(ROOT, STAGED)}`);
say(`  engine/bin      ${mib(bytes(join(STAGED, "engine", "bin")))}`);
say(`  engine/drizzle  ${mib(bytes(join(STAGED, "engine", "drizzle")))}`);
say(`  runtime         ${mib(bytes(join(STAGED, "runtime")))}`);
say(`  total           ${mib(bytes(STAGED))}`);
