#!/usr/bin/env node
/**
 * verify-engine-repro.mjs — build the engine twice and refuse if the two results differ
 * (`OHMAIL_ESBUILD_FROM=<dir> node scripts/verify-engine-repro.mjs`). The download offers a claim anyone can
 * check: the engine inside it was built from the source here — worth making only if building the same source
 * twice gives the same bytes, so this is the gate under that claim (same commit, tree, bundler, two builds,
 * byte-identical, or fail). It compares the WHOLE shipped layout (the one-file engine in `bin/`, the journal
 * beside it, the vendored storage under `bin/node_modules/`), where a dependency-tree drift or lost file
 * mode shows up. What it does NOT claim: reproducible for a FIXED environment, not every one — the bundle is
 * not minified (a stack trace is worth more), so it carries a path comment per module and two package
 * managers lay a tree out differently, so the honest statement is environment-qualified (`npm ci` then the pinned bundler, the way its CI does). The metafile (written beside the layout) and modification times are outside the comparison by construction. It refuses on an EMPTY layout (two empty dirs compare equal): a three-item floor and a file count, and both output roots passed explicitly and asserted different. */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { buildEngine, ROOT } from "./engine-bundle.mjs";

/**
 * The layout is a claim about a directory tree, so the manifest is one entry per file: its path,
 * the sha256 of its contents, and its permission bits — the executable bit on the engine is part
 * of what ships, and a mode that silently stopped being set is a difference worth failing on.
 *
 * The path is kept as its own field rather than parsed back out of a formatted line, because a
 * path is the one part of an entry that can contain anything at all.
 *
 * @returns {{ path: string, line: string }[]} sorted by path
 */
function manifest(root) {
  const rows = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      /* A symlink whose TARGET hashes clean would hide a change in the layout itself, and the
       * layout is copied wholesale into the app — so anything that is not a plain file is a
       * refusal rather than something to follow. */
      if (!st.isFile()) {
        console.error(`REFUSED: ${relative(root, abs)} is not a regular file (mode ${st.mode.toString(8)})`);
        process.exit(1);
      }
      const rel = relative(root, abs).split(sep).join("/");
      const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      rows.push({ path: rel, line: `${sha}  ${mode}  ${rel}` });
    }
  };
  walk(root);
  return rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/* The floor. Named individually rather than as a count alone, because the failure this guards
 * against is a build that produced a plausible-looking partial tree — and each of these three is
 * a different part of the layout: the artifact, the data it reads one level up, and the vendored
 * package beside it. */
const ANCHORS = [
  "bin/ohmail-engine.mjs",
  "drizzle/",
  "bin/node_modules/@electric-sql/pglite/",
];
const MIN_FILES = 20;

function floorOrDie(rows, label) {
  const paths = rows.map((r) => r.path);
  const missing = ANCHORS.filter((a) =>
    a.endsWith("/") ? !paths.some((p) => p.startsWith(a)) : !paths.includes(a));
  if (missing.length || rows.length < MIN_FILES) {
    console.error(`REFUSED: the ${label} layout is not a complete engine build.`);
    if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
    if (rows.length < MIN_FILES) console.error(`  ${rows.length} files, fewer than the ${MIN_FILES} a real layout has`);
    console.error("  Comparing two incomplete trees would pass by not looking.");
    process.exit(1);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "ohmail-engine-repro-"));
try {
  const outA = join(scratch, "a");
  const outB = join(scratch, "b");
  /* Explicit, and asserted — see the header. Passing no output root makes `buildEngine` read an
   * environment variable, and both builds landing in one directory is a comparison that can only
   * ever pass. */
  if (outA === outB) { console.error("REFUSED: both builds would write to one directory"); process.exit(1); }

  console.log(`building twice from ${ROOT}`);
  await buildEngine({ root: ROOT, outRoot: outA });
  await buildEngine({ root: ROOT, outRoot: outB });

  const a = manifest(outA);
  const b = manifest(outB);
  floorOrDie(a, "first");
  floorOrDie(b, "second");

  /* The differences, all of them, named — a gate that says only "they differ" over a tree of a
   * thousand files leaves the reader to rebuild it themselves to find out what moved. */
  const byPath = (rows) => new Map(rows.map((r) => [r.path, r.line]));
  const [ma, mb] = [byPath(a), byPath(b)];
  const differences = [];
  for (const [p, line] of ma) {
    if (!mb.has(p)) differences.push(`only in the first build:  ${p}`);
    else if (mb.get(p) !== line) differences.push(`differs:  ${p}\n    first:  ${line}\n    second: ${mb.get(p)}`);
  }
  for (const p of mb.keys()) if (!ma.has(p)) differences.push(`only in the second build: ${p}`);

  const digest = createHash("sha256").update(a.map((r) => r.line).join("\n")).digest("hex");
  console.log(`\nengine layout: ${a.length} files`);
  console.log(`engine layout manifest sha256: ${digest}`);

  if (differences.length) {
    console.error(`\nREFUSED: two builds of the same source produced ${differences.length} difference(s).`);
    for (const d of differences) console.error(`  ${d}`);
    console.error("\nThe published engine cannot be checked against this source until this is fixed:");
    console.error("a rebuild that does not match proves nothing if a rebuild never matches.");
    process.exit(1);
  }
  console.log("\nthe engine builds byte-identically from the same source");
} finally {
  rmSync(scratch, { recursive: true, force: true });
  /* The bundler writes its build record beside the output root, so the two scratch roots leave
   * two files one level up from themselves — inside `scratch`, which has just gone. */
}
